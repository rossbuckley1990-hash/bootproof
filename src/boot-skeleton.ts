import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { inferRepo } from "./infer.js";
import { redactText } from "./redact.js";
import type {
  BootSkeleton,
  BootSkeletonComponents,
  Inference,
  RunPlan,
} from "./types.js";

const SAFE_ENV_TEMPLATES = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.defaults",
  "example.env",
];

const LOCKFILES: Record<string, string> = {
  "package-lock.json": "package-lock",
  "npm-shrinkwrap.json": "package-lock",
  "pnpm-lock.yaml": "pnpm-lock",
  "yarn.lock": "yarn-lock",
  "bun.lock": "bun-lock",
  "bun.lockb": "bun-lock",
  "composer.lock": "composer-lock",
  "poetry.lock": "poetry-lock",
  "Pipfile.lock": "pipfile-lock",
  "uv.lock": "uv-lock",
  "Cargo.lock": "cargo-lock",
  "go.sum": "go-sum",
  "Gemfile.lock": "gemfile-lock",
};

const SERVICE_TYPES = [
  "postgres",
  "mysql",
  "mariadb",
  "redis",
  "mongodb",
  "elasticsearch",
  "opensearch",
  "mailhog",
  "mailpit",
  "temporal",
  "kafka",
  "rabbitmq",
  "worker",
  "web",
] as const;

function exists(repo: string, relative: string): boolean {
  return fs.existsSync(path.join(repo, relative));
}

function readText(repo: string, relative: string): string {
  try {
    const file = path.join(repo, relative);
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size <= 1024 * 1024
      ? fs.readFileSync(file, "utf8")
      : "";
  } catch {
    return "";
  }
}

function readJson(repo: string, relative: string): Record<string, any> | null {
  try {
    const value = JSON.parse(readText(repo, relative));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function normalizedString(value: string): string {
  return value.replace(/\\/g, "/");
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "string") return normalizedString(value);
  if (Array.isArray(value)) {
    const normalized = value.map(canonicalValue);
    const byJson = new Map(normalized.map(item => [JSON.stringify(item), item]));
    return [...byJson.entries()]
      .sort(([left], [right]) => compareCanonical(left, right))
      .map(([, item]) => item);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCanonical(left, right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function canonicalBootSkeletonJson(components: BootSkeletonComponents): string {
  return JSON.stringify(canonicalValue({
    schema: "bootproof/boot-skeleton/v1",
    components,
  }));
}

export function bootSkeletonFingerprint(components: BootSkeletonComponents): `sha256:${string}` {
  const hex = createHash("sha256")
    .update(canonicalBootSkeletonJson(components))
    .digest("hex");
  return `sha256:${hex}`;
}

const BOOT_SKELETON_KEYS = new Set(["schema", "fingerprint", "components"]);
const COMPONENT_KEYS = new Set([
  "runtimes",
  "packageManagers",
  "frameworks",
  "startCommands",
  "healthCandidates",
  "services",
  "ports",
  "envVars",
  "lockfiles",
  "workspaceTopology",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unsupportedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): string[] {
  return Object.keys(value)
    .filter(key => !allowed.has(key))
    .map(key => `${path}: unsupported field: ${key}`);
}

function duplicateEntries(values: unknown[]): boolean {
  return new Set(values.map(value => JSON.stringify(value))).size !== values.length;
}

function validateStringSet(value: unknown, path: string, pattern?: RegExp): string[] {
  if (!Array.isArray(value)) return [`${path} must be an array`];
  const errors: string[] = [];
  if (duplicateEntries(value)) errors.push(`${path} must not contain duplicates`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !item.trim()) {
      errors.push(`${path}[${index}] must be a non-empty string`);
    } else if (pattern && !pattern.test(item)) {
      errors.push(`${path}[${index}] has an invalid format`);
    }
  }
  return errors;
}

function validateObjectArray(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  validateEntry: (entry: Record<string, unknown>, path: string) => string[],
): string[] {
  if (!Array.isArray(value)) return [`${path} must be an array`];
  const errors: string[] = [];
  if (duplicateEntries(value)) errors.push(`${path} must not contain duplicates`);
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    const entry = record(item);
    if (!entry) {
      errors.push(`${itemPath} must be an object`);
      continue;
    }
    errors.push(...unsupportedKeys(entry, allowed, itemPath));
    for (const key of required) {
      if (!(key in entry)) errors.push(`${itemPath}.${key} is required`);
    }
    errors.push(...validateEntry(entry, itemPath));
  }
  return errors;
}

export function validateBootSkeleton(value: unknown): string[] {
  const skeleton = record(value);
  if (!skeleton) return ["boot skeleton must be an object"];
  const errors = unsupportedKeys(skeleton, BOOT_SKELETON_KEYS, "bootSkeleton");
  for (const key of BOOT_SKELETON_KEYS) {
    if (!(key in skeleton)) errors.push(`bootSkeleton.${key} is required`);
  }
  if (skeleton.schema !== "bootproof/boot-skeleton/v1") errors.push("bootSkeleton.schema is invalid");
  if (typeof skeleton.fingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(skeleton.fingerprint)) {
    errors.push("bootSkeleton.fingerprint must match sha256:<64 lowercase hex characters>");
  }

  const components = record(skeleton.components);
  if (!components) {
    errors.push("bootSkeleton.components must be an object");
    return [...new Set(errors)];
  }
  errors.push(...unsupportedKeys(components, COMPONENT_KEYS, "bootSkeleton.components"));
  for (const key of COMPONENT_KEYS) {
    if (!(key in components)) errors.push(`bootSkeleton.components.${key} is required`);
  }

  const versionedKeys = new Set(["family", "major"]);
  for (const field of ["runtimes", "packageManagers"] as const) {
    errors.push(...validateObjectArray(
      components[field],
      `bootSkeleton.components.${field}`,
      versionedKeys,
      ["family", "major"],
      (entry, itemPath) => [
        ...(typeof entry.family === "string" && entry.family.trim()
          ? []
          : [`${itemPath}.family must be a non-empty string`]),
        ...(entry.major === null || Number.isInteger(entry.major) && Number(entry.major) >= 0
          ? []
          : [`${itemPath}.major must be a non-negative integer or null`]),
      ],
    ));
  }

  errors.push(...validateStringSet(components.frameworks, "bootSkeleton.components.frameworks"));
  errors.push(...validateObjectArray(
    components.startCommands,
    "bootSkeleton.components.startCommands",
    new Set(["source", "shape"]),
    ["source", "shape"],
    (entry, itemPath) => ["source", "shape"].flatMap(key =>
      typeof entry[key] === "string" && entry[key]!.trim()
        ? []
        : [`${itemPath}.${key} must be a non-empty string`]
    ),
  ));
  errors.push(...validateObjectArray(
    components.healthCandidates,
    "bootSkeleton.components.healthCandidates",
    new Set(["protocol", "port", "route"]),
    ["protocol", "port", "route"],
    (entry, itemPath) => [
      ...(["http", "https"].includes(String(entry.protocol)) ? [] : [`${itemPath}.protocol is invalid`]),
      ...(Number.isInteger(entry.port) && Number(entry.port) >= 1 && Number(entry.port) <= 65535
        ? []
        : [`${itemPath}.port must be an integer from 1 to 65535`]),
      ...(typeof entry.route === "string" && entry.route.startsWith("/")
        ? []
        : [`${itemPath}.route must start with /`]),
    ],
  ));
  errors.push(...validateObjectArray(
    components.services,
    "bootSkeleton.components.services",
    new Set(["name", "type"]),
    ["name", "type"],
    (entry, itemPath) => ["name", "type"].flatMap(key =>
      typeof entry[key] === "string" && entry[key]!.trim()
        ? []
        : [`${itemPath}.${key} must be a non-empty string`]
    ),
  ));
  errors.push(...validateObjectArray(
    components.ports,
    "bootSkeleton.components.ports",
    new Set(["service", "containerPort", "publishedPort", "protocol"]),
    ["service", "containerPort", "publishedPort", "protocol"],
    (entry, itemPath) => [
      ...(typeof entry.service === "string" && entry.service.trim()
        ? []
        : [`${itemPath}.service must be a non-empty string`]),
      ...(Number.isInteger(entry.containerPort) && Number(entry.containerPort) >= 1 && Number(entry.containerPort) <= 65535
        ? []
        : [`${itemPath}.containerPort must be an integer from 1 to 65535`]),
      ...(entry.publishedPort === null
        || Number.isInteger(entry.publishedPort) && Number(entry.publishedPort) >= 1 && Number(entry.publishedPort) <= 65535
        ? []
        : [`${itemPath}.publishedPort must be an integer from 1 to 65535 or null`]),
      ...(["tcp", "udp"].includes(String(entry.protocol)) ? [] : [`${itemPath}.protocol is invalid`]),
    ],
  ));
  errors.push(...validateStringSet(
    components.envVars,
    "bootSkeleton.components.envVars",
    /^[A-Z][A-Z0-9_]*$/,
  ));
  errors.push(...validateStringSet(components.lockfiles, "bootSkeleton.components.lockfiles"));
  errors.push(...validateStringSet(components.workspaceTopology, "bootSkeleton.components.workspaceTopology"));

  if (!errors.length) {
    const expected = bootSkeletonFingerprint(components as unknown as BootSkeletonComponents);
    if (skeleton.fingerprint !== expected) {
      errors.push("bootSkeleton.fingerprint does not match its canonical components");
    }
  }
  return [...new Set(errors)];
}

function versionedMarker(value: { family: string; major: number | null }): string {
  return value.major === null ? value.family : `${value.family}@${value.major}`;
}

export function explainBootSkeleton(value: unknown): string[] {
  const errors = validateBootSkeleton(value);
  if (errors.length) {
    return [
      `Boot skeleton: invalid (${errors.join("; ")}).`,
      "Structural details were withheld because this boot skeleton does not satisfy the v1 contract.",
    ];
  }
  const skeleton = value as BootSkeleton;
  const components = skeleton.components;
  const list = (values: string[]) => values.length ? values.join(", ") : "none";
  return [
    `Boot skeleton fingerprint: ${skeleton.fingerprint}`,
    `Runtime markers: ${list(components.runtimes.map(versionedMarker))}`,
    `Package managers: ${list(components.packageManagers.map(versionedMarker))}`,
    `Frameworks: ${list(components.frameworks)}`,
    `Services: ${list(components.services.map(service => `${service.name} (${service.type})`))}`,
    `Environment variable names (${components.envVars.length}): ${list(components.envVars)}`,
    `Health candidates: ${list(components.healthCandidates.map(candidate =>
      `${candidate.protocol}://<host>:${candidate.port}${candidate.route}`
    ))}`,
    "This fingerprint groups structurally similar boot setups; it is not proof of bootability and makes no prediction. Only observed health evidence can prove boot.",
  ];
}

function exactMajor(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(?:v|node-|ruby-|python-)?(\d+)(?:\.\d+){0,3}(?:[-+].*)?$/i);
  return match ? Number(match[1]) : null;
}

function declaredMajor(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const exact = exactMajor(value);
  if (exact !== null) return exact;
  const majors = [...value.matchAll(/(?:^|[^A-Za-z0-9])v?(\d+)(?:\.\d+){0,3}/g)]
    .map(match => Number(match[1]));
  if (!majors.length) return null;
  const unique = [...new Set(majors)];
  if (unique.length === 1) return unique[0];
  const lowest = Math.min(...unique);
  return unique.length === 2
    && Math.max(...unique) === lowest + 1
    && new RegExp(`<\\s*${lowest + 1}(?:\\.0+)*\\b`).test(value)
      ? lowest
      : null;
}

function versionedFamilies(
  markers: Map<string, Set<number>>,
  present: Set<string>,
): Array<{ family: string; major: number | null }> {
  return [...present].map(family => {
    const majors = [...(markers.get(family) ?? [])];
    return { family, major: majors.length === 1 ? majors[0] : null };
  });
}

function runtimeComponents(repo: string, pkg: Record<string, any> | null): Array<{ family: string; major: number | null }> {
  const present = new Set<string>();
  const majors = new Map<string, Set<number>>();
  const add = (family: string, version?: unknown) => {
    present.add(family);
    const major = declaredMajor(version);
    if (major === null) return;
    const values = majors.get(family) ?? new Set<number>();
    values.add(major);
    majors.set(family, values);
  };

  if (pkg) add("node", pkg.engines?.node);
  if (exists(repo, ".nvmrc")) add("node", readText(repo, ".nvmrc").trim());
  if (exists(repo, ".node-version")) add("node", readText(repo, ".node-version").trim());
  if (exists(repo, "composer.json")) {
    const composer = readJson(repo, "composer.json");
    add("php", composer?.require?.php);
  }
  if (exists(repo, "artisan")) add("php");
  if (exists(repo, "Gemfile")) {
    add("ruby", readText(repo, ".ruby-version").trim()
      || readText(repo, "Gemfile").match(/^\s*ruby\s+["']([^"']+)["']/m)?.[1]);
  }
  if (
    exists(repo, "pyproject.toml")
    || exists(repo, "requirements.txt")
    || exists(repo, "setup.py")
    || exists(repo, "manage.py")
  ) {
    const pyproject = readText(repo, "pyproject.toml");
    add("python", readText(repo, ".python-version").trim()
      || pyproject.match(/requires-python\s*=\s*["']([^"']+)["']/i)?.[1]);
  }
  if (exists(repo, "go.mod")) {
    add("go", readText(repo, "go.mod").match(/^\s*go\s+([^\s]+)\s*$/m)?.[1]);
  }
  if (exists(repo, "build.gradle") || exists(repo, "build.gradle.kts") || exists(repo, "pom.xml")) {
    const javaText = [
      readText(repo, "build.gradle"),
      readText(repo, "build.gradle.kts"),
      readText(repo, "pom.xml"),
    ].join("\n");
    add("java",
      javaText.match(/JavaLanguageVersion\.of\(\s*(\d+)\s*\)/)?.[1]
      ?? javaText.match(/(?:sourceCompatibility|targetCompatibility)\s*=\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)/)?.[1]
      ?? javaText.match(/<maven\.compiler\.(?:source|release)>(\d+)</)?.[1]);
  }
  if (exists(repo, "Cargo.toml")) add("rust");

  const toolVersions = readText(repo, ".tool-versions");
  for (const line of toolVersions.split(/\r?\n/)) {
    const match = line.match(/^\s*(nodejs|node|ruby|python|golang|go|java)\s+([^\s#]+)/);
    if (!match) continue;
    const family = ({ nodejs: "node", golang: "go" } as Record<string, string>)[match[1]] ?? match[1];
    add(family, match[2]);
  }

  for (const dockerfile of rootDockerfiles(repo)) {
    for (const match of readText(repo, dockerfile).matchAll(/^\s*FROM\s+([^\s]+)(?:\s+AS\s+\S+)?$/gim)) {
      const image = match[1].toLowerCase();
      const runtime = image.match(/(?:^|\/)(node|php|ruby|python|golang|openjdk|eclipse-temurin)(?::([^@\s]+))?/);
      if (!runtime) continue;
      const family = runtime[1] === "golang"
        ? "go"
        : ["openjdk", "eclipse-temurin"].includes(runtime[1])
          ? "java"
          : runtime[1];
      add(family, runtime[2]?.match(/^v?(\d+(?:\.\d+)*)/)?.[1]);
    }
  }

  return versionedFamilies(majors, present);
}

function packageManagerComponents(
  repo: string,
  inference: Inference,
  pkg: Record<string, any> | null,
): Array<{ family: string; major: number | null }> {
  const present = new Set<string>();
  const majors = new Map<string, Set<number>>();
  const add = (family: string, version?: unknown) => {
    present.add(family);
    const major = exactMajor(version);
    if (major === null) return;
    const values = majors.get(family) ?? new Set<number>();
    values.add(major);
    majors.set(family, values);
  };

  if (inference.packageManager !== "unknown") {
    add(inference.packageManager, pkg?.packageManager?.split("@").at(-1) ?? inference.packageManagerVersion);
  }
  if (exists(repo, "composer.json") || exists(repo, "composer.lock")) add("composer");
  if (exists(repo, "Gemfile") || exists(repo, "Gemfile.lock")) add("bundler");
  if (exists(repo, "poetry.lock") || /\[tool\.poetry\]/i.test(readText(repo, "pyproject.toml"))) add("poetry");
  else if (
    exists(repo, "requirements.txt")
    || exists(repo, "Pipfile")
    || /\[project\]/i.test(readText(repo, "pyproject.toml"))
  ) add("pip");
  if (exists(repo, "Cargo.toml") || exists(repo, "Cargo.lock")) add("cargo");
  if (exists(repo, "go.mod") || exists(repo, "go.sum")) add("go");
  return versionedFamilies(majors, present);
}

function frameworkComponents(repo: string, inference: Inference): string[] {
  const mapped = inference.stack.map(marker => ({
    nextjs: "next",
    "react-frontend": "react",
  } as Record<string, string>)[marker] ?? marker);
  const allowed = new Set([
    "next",
    "vite",
    "laravel",
    "django",
    "flask",
    "react",
    "express",
    "fastify",
    "nestjs",
    "prisma",
  ]);
  const frameworks = mapped.filter(marker => allowed.has(marker));
  if (exists(repo, "Gemfile") && exists(repo, "bin/rails")) frameworks.push("rails");
  return frameworks;
}

function startCommandSource(description: string): string {
  const source = description.match(/\((.+)\)\s*$/)?.[1] ?? "run-plan";
  const script = source.match(/^scripts\.([A-Za-z0-9_.-]+):/);
  if (script) return `package.json:scripts.${script[1]}`;
  const make = source.match(/^Makefile target:\s*([A-Za-z0-9_.-]+)/);
  if (make) return `Makefile:${make[1]}`;
  if (/--command override/.test(source)) return "cli:command_override";
  if (/artisan/i.test(source)) return "artisan";
  if (/manage\.py|Django/i.test(source)) return "manage.py";
  if (/bin\/rails|Rails/i.test(source)) return "bin/rails";
  if (/Go main package:/i.test(source)) {
    return `go:${normalizedString(source.split(":").slice(1).join(":").trim())}`;
  }
  if (/Ollama Go service/i.test(source)) return "go:main.go";
  return normalizedString(source.split(":")[0].trim().toLowerCase().replace(/\s+/g, "-"));
}

function commandShape(command: string, repo: string): string {
  let shape = normalizedString(command);
  const normalizedRepo = normalizedString(path.resolve(repo));
  if (normalizedRepo) shape = shape.split(normalizedRepo).join("<repo>");
  shape = shape.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s;]+)/g,
    "$1=<value>",
  );
  shape = shape.replace(
    /(--(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
    "$1<redacted>",
  );
  shape = redactText(shape).text;
  shape = shape.replace(
    /(^|[\s="'(])(?:[A-Za-z]:\/|\/)(?!\/)(?:[^\s"'()]+)/g,
    "$1<path>",
  );
  return shape.replace(/\s+/g, " ").trim();
}

function startCommandComponents(
  repo: string,
  inference: Inference,
  plan: RunPlan,
): Array<{ source: string; shape: string }> {
  const commands: Array<{ source: string; shape: string }> = [];
  for (const step of plan.steps) {
    if (!step.command || !["start-app", "service"].includes(step.kind)) continue;
    const source = step.kind === "service"
      ? `compose:${normalizedString(inference.repoComposeFile ?? "generated")}`
      : startCommandSource(step.description);
    const selectedScript = step.kind === "start-app"
      && source.startsWith("package.json:scripts.")
      && inference.selectedPackageScriptCommand
      && step.command === inference.appCommand
        ? inference.selectedPackageScriptCommand
        : step.command;
    const shape = commandShape(selectedScript, repo);
    if (shape) commands.push({ source, shape });
  }
  return commands;
}

function normalizedRoute(pathname: string): string {
  const route = pathname
    .split("/")
    .map(segment =>
      /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)
        ? ":id"
        : segment
    )
    .join("/");
  return route || "/";
}

function healthComponent(value: string): {
  protocol: "http" | "https";
  port: number;
  route: string;
} | null {
  try {
    const parsed = new URL(value, "http://localhost");
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return {
      protocol: parsed.protocol === "https:" ? "https" : "http",
      port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
      route: normalizedRoute(parsed.pathname),
    };
  } catch {
    return null;
  }
}

function healthCandidates(
  plan: RunPlan,
  discoveredHealth: string[],
): BootSkeletonComponents["healthCandidates"] {
  return [...plan.healthCandidates, plan.healthUrl, ...discoveredHealth]
    .filter(Boolean)
    .map(healthComponent)
    .filter((candidate): candidate is NonNullable<ReturnType<typeof healthComponent>> => candidate !== null);
}

function composePort(value: unknown): {
  containerPort: number;
  publishedPort: number | null;
  protocol: "tcp" | "udp";
} | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return { containerPort: value, publishedPort: null, protocol: "tcp" };
  }
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    const containerPort = Number(item.target);
    const published = item.published === undefined ? null : Number(item.published);
    const protocol = String(item.protocol ?? "tcp").toLowerCase() === "udp" ? "udp" : "tcp";
    return Number.isInteger(containerPort) && (published === null || Number.isInteger(published))
      ? { containerPort, publishedPort: published, protocol }
      : null;
  }
  if (typeof value !== "string") return null;
  const protocol: "tcp" | "udp" = /\/udp\s*$/i.test(value) ? "udp" : "tcp";
  const normalized = value
    .replace(/\/(?:tcp|udp)\s*$/i, "")
    .replace(/\$\{[^}:]+:-?(\d+)\}/g, "$1");
  if (/\$\{/.test(normalized)) return null;
  const parts = normalized.split(":").map(part => part.trim());
  const containerPort = Number(parts.at(-1));
  const publishedPort = parts.length >= 2 ? Number(parts.at(-2)) : null;
  return Number.isInteger(containerPort) && (publishedPort === null || Number.isInteger(publishedPort))
    ? { containerPort, publishedPort, protocol }
    : null;
}

function serviceType(name: string, service: Record<string, any>): string {
  const evidence = `${name} ${String(service.image ?? "")} ${String(service.command ?? "")}`.toLowerCase();
  for (const type of SERVICE_TYPES) {
    if (type === "web" && (service.build || Array.isArray(service.ports))) continue;
    if (new RegExp(`(?:^|[^a-z])${type}(?:[^a-z]|$)`).test(evidence)) return type;
  }
  if (service.build || Array.isArray(service.ports)) return "web";
  return "service";
}

function environmentNames(environment: unknown): string[] {
  if (Array.isArray(environment)) {
    return environment
      .map(value => String(value).match(/^\s*([A-Z][A-Z0-9_]*)\s*(?:=|$)/)?.[1])
      .filter((value): value is string => Boolean(value));
  }
  if (environment && typeof environment === "object") {
    return Object.keys(environment).filter(key => /^[A-Z][A-Z0-9_]*$/.test(key));
  }
  return [];
}

function serviceName(rawName: string, repo: string, pkg: Record<string, any> | null): string {
  const normalized = rawName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const identities = [
    path.basename(repo),
    typeof pkg?.name === "string" ? pkg.name : "",
    typeof pkg?.name === "string" ? pkg.name.split("/").at(-1) ?? "" : "",
  ]
    .map(value => value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-"))
    .filter(Boolean);
  return identities.includes(normalized) ? "app" : normalized;
}

function composeComponents(
  repo: string,
  composeFile: string | null,
  pkg: Record<string, any> | null,
): {
  services: BootSkeletonComponents["services"];
  ports: BootSkeletonComponents["ports"];
  envVars: string[];
  healthCandidates: string[];
} {
  if (!composeFile) return { services: [], ports: [], envVars: [], healthCandidates: [] };
  const text = readText(repo, composeFile);
  try {
    const document = parse(text) as { services?: Record<string, Record<string, any>> };
    const services: BootSkeletonComponents["services"] = [];
    const ports: BootSkeletonComponents["ports"] = [];
    const envVars = new Set<string>();
    const composeHealth: string[] = [];
    for (const [rawName, service] of Object.entries(document?.services ?? {})) {
      const name = serviceName(rawName, repo, pkg);
      services.push({ name, type: serviceType(name, service) });
      for (const value of Array.isArray(service.ports) ? service.ports : []) {
        const port = composePort(value);
        if (port) ports.push({ service: name, ...port });
      }
      for (const envVar of environmentNames(service.environment)) envVars.add(envVar);
      const healthcheck = Array.isArray(service.healthcheck?.test)
        ? service.healthcheck.test.join(" ")
        : String(service.healthcheck?.test ?? "");
      for (const match of healthcheck.matchAll(/https?:\/\/[^\s"'\\]+/gi)) {
        composeHealth.push(match[0].replace(/[),.;\]}]+$/, ""));
      }
    }
    for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::[-?][^}]*)?\}/g)) envVars.add(match[1]);
    return { services, ports, envVars: [...envVars], healthCandidates: composeHealth };
  } catch {
    return { services: [], ports: [], envVars: [], healthCandidates: [] };
  }
}

function rootDockerfiles(repo: string): string[] {
  try {
    return fs.readdirSync(repo)
      .filter(name => /^Dockerfile(?:\..+)?$/i.test(name))
      .sort();
  } catch {
    return [];
  }
}

function dockerComponents(repo: string): {
  ports: BootSkeletonComponents["ports"];
  envVars: string[];
  healthCandidates: string[];
} {
  const ports: BootSkeletonComponents["ports"] = [];
  const envVars = new Set<string>();
  const health: string[] = [];
  for (const dockerfile of rootDockerfiles(repo)) {
    const text = readText(repo, dockerfile);
    for (const expose of text.matchAll(/^\s*EXPOSE\s+(.+)$/gim)) {
      for (const item of expose[1].trim().split(/\s+/)) {
        const match = item.match(/^(\d+)(?:\/(tcp|udp))?$/i);
        if (match) {
          ports.push({
            service: "app",
            containerPort: Number(match[1]),
            publishedPort: null,
            protocol: match[2]?.toLowerCase() === "udp" ? "udp" : "tcp",
          });
        }
      }
    }
    for (const line of text.split(/\r?\n/)) {
      const arg = line.match(/^\s*ARG\s+([A-Z][A-Z0-9_]*)\b/);
      const env = line.match(/^\s*ENV\s+([A-Z][A-Z0-9_]*)\b/);
      if (arg) envVars.add(arg[1]);
      if (env) envVars.add(env[1]);
    }
    for (const match of text.matchAll(/https?:\/\/[^\s"'\\]+/gi)) {
      if (/health|ready|status/i.test(match[0])) health.push(match[0].replace(/[),.;\]}]+$/, ""));
    }
  }
  return { ports, envVars: [...envVars], healthCandidates: health };
}

function envVarComponents(repo: string, inference: Inference, composeEnv: string[], dockerEnv: string[]): string[] {
  const names = new Set([...inference.requiredEnv, ...composeEnv, ...dockerEnv]);
  for (const template of SAFE_ENV_TEMPLATES) {
    const text = readText(repo, template);
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
      if (match) names.add(match[1]);
    }
  }
  return [...names];
}

function lockfileComponents(repo: string): string[] {
  return Object.entries(LOCKFILES)
    .filter(([file]) => exists(repo, file))
    .map(([, family]) => family);
}

function workspaceComponents(repo: string, pkg: Record<string, any> | null): string[] {
  const topology: string[] = [];
  const npmPatterns = Array.isArray(pkg?.workspaces)
    ? pkg.workspaces
    : Array.isArray(pkg?.workspaces?.packages)
      ? pkg.workspaces.packages
      : [];
  if (npmPatterns.length) {
    topology.push("npm-workspaces");
    for (const pattern of npmPatterns) {
      if (typeof pattern === "string" && pattern.trim()) {
        topology.push(`pattern:${normalizedString(pattern.trim())}`);
      }
    }
  }
  const pnpmWorkspace = readText(repo, "pnpm-workspace.yaml");
  if (pnpmWorkspace) {
    topology.push("pnpm-workspaces");
    let packages = false;
    for (const line of pnpmWorkspace.split(/\r?\n/)) {
      if (/^packages:\s*$/.test(line)) {
        packages = true;
        continue;
      }
      if (packages && /^\S/.test(line)) packages = false;
      const match = packages ? line.match(/^\s+-\s*['"]?([^'"#]+?)['"]?\s*$/) : null;
      if (match) topology.push(`pattern:${normalizedString(match[1].trim())}`);
    }
  }
  return topology.length ? topology : ["single-app"];
}

export function buildBootSkeleton(
  repoPath: string,
  plan: RunPlan,
  providedInference?: Inference,
  observedHealthCandidates: string[] = [],
): BootSkeleton {
  const repo = path.resolve(repoPath);
  const inference = providedInference ?? inferRepo(repo);
  const pkg = readJson(repo, "package.json");
  const compose = composeComponents(repo, inference.repoComposeFile, pkg);
  const docker = dockerComponents(repo);
  const inferredServices = inference.services.map(service => ({
    name: service.kind,
    type: service.kind,
  }));
  const components = canonicalValue({
    runtimes: runtimeComponents(repo, pkg),
    packageManagers: packageManagerComponents(repo, inference, pkg),
    frameworks: frameworkComponents(repo, inference),
    startCommands: startCommandComponents(repo, inference, plan),
    healthCandidates: healthCandidates(plan, [
      ...compose.healthCandidates,
      ...docker.healthCandidates,
      ...observedHealthCandidates,
    ]),
    services: [...compose.services, ...inferredServices],
    ports: [...compose.ports, ...docker.ports],
    envVars: envVarComponents(repo, inference, compose.envVars, docker.envVars),
    lockfiles: lockfileComponents(repo),
    workspaceTopology: workspaceComponents(repo, pkg),
  }) as BootSkeletonComponents;
  const skeleton: BootSkeleton = {
    schema: "bootproof/boot-skeleton/v1",
    fingerprint: bootSkeletonFingerprint(components),
    components,
  };
  const errors = validateBootSkeleton(skeleton);
  if (errors.length) throw new Error(`invalid boot skeleton: ${errors.join("; ")}`);
  return skeleton;
}
