import { spawnSync } from "node:child_process";
import path from "node:path";
import { parse } from "yaml";
import { redactText } from "./redact.js";

export type DiffRiskLevel = "low" | "medium" | "high";

export interface DiffChange {
  source: string;
  before: string | null;
  after: string | null;
}

export interface DiffResult {
  schema: "bootproof/diff-result/v1";
  base: string;
  head: string;
  changedFiles: string[];
  addedServices: string[];
  removedServices: string[];
  addedPorts: string[];
  removedPorts: string[];
  addedEnvVars: string[];
  removedEnvVars: string[];
  changedCommands: DiffChange[];
  changedPackageManagers: DiffChange[];
  riskLevel: DiffRiskLevel;
  proofRequired: boolean;
  suggestedReviewNotes: string[];
  redactionsApplied: string[];
}

interface Snapshot {
  files: Set<string>;
  services: Set<string>;
  ports: Set<string>;
  envVars: Set<string>;
  commands: Map<string, string>;
  packageManagers: Map<string, string>;
  runtimeMarkers: Map<string, string>;
  healthRoutes: Map<string, string>;
}

const MAX_BLOB_BYTES = 1_000_000;
const DIFF_KEYS = new Set([
  "schema",
  "base",
  "head",
  "changedFiles",
  "addedServices",
  "removedServices",
  "addedPorts",
  "removedPorts",
  "addedEnvVars",
  "removedEnvVars",
  "changedCommands",
  "changedPackageManagers",
  "riskLevel",
  "proofRequired",
  "suggestedReviewNotes",
  "redactionsApplied",
]);
const CHANGE_KEYS = new Set(["source", "before", "after"]);
const MANIFEST_FILE = /(?:^|\/)(?:package\.json|Gemfile|requirements(?:\.[^/]+)?\.txt|pyproject\.toml|setup\.py|go\.mod|Cargo\.toml|composer\.json|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/i;
const LOCK_FILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Cargo\.lock|composer\.lock)$/i;
const RUNTIME_FILE = /(?:^|\/)(?:\.nvmrc|\.node-version|\.ruby-version|\.python-version|\.tool-versions|go\.mod|Gemfile|Dockerfile(?:\.[^/]+)?)$/i;
const KNOWN_COMMAND_FILE = /(?:^|\/)(?:package\.json|Makefile|makefile|Procfile|Dockerfile(?:\.[^/]+)?|pyproject\.toml)$/;
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|rb|py|go|java|kt|kts|php|rs|ya?ml|toml|json|properties|conf|config|ini|sh|bash|zsh|fish|env|example|sample|template|dist)$/i;
const SENSITIVE_PATH = /(?:^|\/)(?:\.ssh|\.aws|\.gnupg)(?:\/|$)|(?:^|\/)(?:id_rsa|id_ed25519|credentials|private[_-]?key)(?:$|\/)/i;

function git(
  repo: string,
  args: string[],
  encoding: BufferEncoding | "buffer" = "utf8",
): string | Buffer {
  const result = spawnSync("git", args, {
    cwd: repo,
    shell: false,
    encoding: encoding === "buffer" ? undefined : encoding,
    maxBuffer: MAX_BLOB_BYTES + 64_000,
    env: process.env,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : String(result.stderr ?? "");
    throw new Error(redactText(stderr.trim() || `git ${args[0]} failed`).text);
  }
  return result.stdout ?? (encoding === "buffer" ? Buffer.alloc(0) : "");
}

function safeRef(value: string, label: string): string {
  const ref = value.trim();
  if (!ref || ref.startsWith("-") || /[\0\r\n]/.test(ref)) {
    throw new Error(`invalid ${label} ref`);
  }
  return ref;
}

function resolveCommit(repo: string, ref: string): string {
  return String(git(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

function listFiles(repo: string, commit: string): string[] {
  const output = git(repo, ["ls-tree", "-r", "--name-only", "-z", commit, "--"], "buffer") as Buffer;
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

function changedFiles(repo: string, baseCommit: string, headCommit: string): string[] {
  const output = git(
    repo,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "--no-renames",
      "-z",
      baseCommit,
      headCommit,
      "--",
    ],
    "buffer",
  ) as Buffer;
  return [...new Set(output.toString("utf8").split("\0").filter(Boolean))].sort();
}

function isEnvTemplate(file: string): boolean {
  const base = path.posix.basename(file);
  return (
    /^(?:\.?env)(?:\.[A-Za-z0-9_-]+)*\.(?:example|sample|template|dist)$/i.test(base) ||
    /^(?:example|sample|template)\.env$/i.test(base)
  );
}

function isProtectedEnv(file: string): boolean {
  const base = path.posix.basename(file);
  return /^\.env(?:\.|$)/i.test(base) && !isEnvTemplate(file);
}

function isComposeFile(file: string): boolean {
  const base = path.posix.basename(file);
  return /^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)?\.ya?ml$/i.test(base);
}

function shouldRead(file: string, changed: ReadonlySet<string>): boolean {
  if (SENSITIVE_PATH.test(file) || isProtectedEnv(file)) return false;
  return (
    isComposeFile(file) ||
    isEnvTemplate(file) ||
    MANIFEST_FILE.test(file) ||
    LOCK_FILE.test(file) ||
    RUNTIME_FILE.test(file) ||
    KNOWN_COMMAND_FILE.test(file) ||
    (changed.has(file) && TEXT_FILE.test(file))
  );
}

function readBlob(repo: string, commit: string, file: string): string | null {
  try {
    const size = Number(String(git(repo, ["cat-file", "-s", `${commit}:${file}`])).trim());
    if (!Number.isFinite(size) || size < 0 || size > MAX_BLOB_BYTES) return null;
    const value = git(repo, ["cat-file", "blob", `${commit}:${file}`], "buffer") as Buffer;
    if (value.includes(0)) return null;
    return value.toString("utf8");
  } catch {
    return null;
  }
}

function addEnvNames(target: Set<string>, text: string): void {
  const patterns = [
    /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g,
    /\bprocess\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)\b/g,
    /\b(?:Deno\.env\.get|System\.getenv|os\.getenv|ENV\.fetch)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
    /\bENV\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /\$\{([A-Z][A-Z0-9_]*)(?::[-?][^}]*)?\}/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) target.add(match[1]);
  }
}

function addTemplateEnvNames(target: Set<string>, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
    if (match) target.add(match[1]);
  }
  addEnvNames(target, text);
}

function normalizedPort(
  file: string,
  service: string,
  value: unknown,
): string | null {
  if (typeof value === "number") return `${file}:${service}:*->${value}/tcp`;
  if (typeof value === "object" && value !== null) {
    const item = value as Record<string, unknown>;
    const target = Number(item.target);
    if (!Number.isInteger(target)) return null;
    const published = Number(item.published);
    const protocol = String(item.protocol ?? "tcp");
    return `${file}:${service}:${Number.isInteger(published) ? published : "*"}->${target}/${protocol}`;
  }
  if (typeof value !== "string") return null;
  const withoutVariables = value.replace(/\$\{[^}:]+:-?([^}]+)\}/g, "$1");
  const [mapping, protocol = "tcp"] = withoutVariables.split("/");
  const parts = mapping.split(":").map(part => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const target = parts.at(-1);
  const published = parts.length >= 2 ? parts.at(-2) : "*";
  if (!target || !/^\d+$/.test(target)) return null;
  return `${file}:${service}:${published && /^\d+$/.test(published) ? published : "*"}->${target}/${protocol}`;
}

function commandText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return value.join(" ");
  return null;
}

function detectableHealthPaths(text: string): string[] {
  const paths = new Set<string>();
  const patterns = [
    /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(\/[^\s"'`]*(?:health|ready|status)[^\s"'`]*)/gi,
    /["'](\/[^"']*(?:health|ready|status)[^"']*)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const route = match[1].split(/[?#]/)[0];
      if (route) paths.add(route);
    }
  }
  return [...paths].sort();
}

function inspectCompose(snapshot: Snapshot, file: string, text: string): void {
  try {
    const document = parse(text) as { services?: Record<string, Record<string, unknown>> };
    for (const [name, service] of Object.entries(document?.services ?? {})) {
      const serviceId = `${file}:${name}`;
      snapshot.services.add(serviceId);
      const ports = Array.isArray(service.ports) ? service.ports : [];
      for (const value of ports) {
        const normalized = normalizedPort(file, name, value);
        if (normalized) snapshot.ports.add(normalized);
      }
      const environment = service.environment;
      if (Array.isArray(environment)) {
        for (const value of environment) {
          const match = String(value).match(/^\s*([A-Z][A-Z0-9_]*)\s*(?:=|$)/);
          if (match) snapshot.envVars.add(match[1]);
        }
      } else if (environment && typeof environment === "object") {
        for (const key of Object.keys(environment)) {
          if (/^[A-Z][A-Z0-9_]*$/.test(key)) snapshot.envVars.add(key);
        }
      }
      const command = commandText(service.command);
      if (command) snapshot.commands.set(`${file}:services.${name}.command`, command);
      const healthcheck = service.healthcheck as { test?: unknown } | undefined;
      const health = commandText(healthcheck?.test);
      if (health) {
        const routes = detectableHealthPaths(health);
        if (routes.length) {
          snapshot.healthRoutes.set(`${file}:services.${name}.healthcheck`, routes.join(", "));
        }
      }
    }
  } catch {
    // Invalid YAML remains visible in changedFiles; static extraction fails closed.
  }
}

function packageManagerFromLock(file: string): string | null {
  const base = path.posix.basename(file);
  if (["package-lock.json", "npm-shrinkwrap.json"].includes(base)) return "npm";
  if (base === "pnpm-lock.yaml") return "pnpm";
  if (base === "yarn.lock") return "yarn";
  if (base === "bun.lock" || base === "bun.lockb") return "bun";
  if (base === "Gemfile.lock") return "bundler";
  if (["poetry.lock", "uv.lock", "Pipfile.lock"].includes(base)) return base.replace(/\.lock$/i, "").toLowerCase();
  if (base === "go.sum") return "go";
  if (base === "Cargo.lock") return "cargo";
  if (base === "composer.lock") return "composer";
  return null;
}

function inspectPackageJson(snapshot: Snapshot, file: string, text: string): void {
  try {
    const value = JSON.parse(text) as {
      packageManager?: unknown;
      scripts?: Record<string, unknown>;
      engines?: Record<string, unknown>;
    };
    if (typeof value.packageManager === "string" && value.packageManager.trim()) {
      snapshot.packageManagers.set(`${file}:packageManager`, value.packageManager.trim());
    }
    for (const name of ["dev", "start", "serve", "preview"]) {
      const command = value.scripts?.[name];
      if (typeof command === "string" && command.trim()) {
        snapshot.commands.set(`${file}:scripts.${name}`, command.trim());
      }
    }
    for (const [name, version] of Object.entries(value.engines ?? {})) {
      if (typeof version === "string") snapshot.runtimeMarkers.set(`${file}:engines.${name}`, version);
    }
  } catch {
    // Invalid JSON remains visible in changedFiles.
  }
}

function inspectKnownCommands(snapshot: Snapshot, file: string, text: string): void {
  const base = path.posix.basename(file);
  if (/^Makefile$|^makefile$/.test(base)) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const target = lines[index].match(/^(run|serve|server|start|dev)\s*:/);
      if (!target) continue;
      const recipe = lines.slice(index + 1).find(line => /^\t\S/.test(line));
      if (recipe) snapshot.commands.set(`${file}:target.${target[1]}`, recipe.trim());
    }
  }
  if (base === "Procfile") {
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
      if (match) snapshot.commands.set(`${file}:${match[1]}`, match[2].trim());
    }
  }
  if (/^Dockerfile(?:\..+)?$/.test(base)) {
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const command = line.match(/^\s*(CMD|ENTRYPOINT)\s+(.+)$/i);
      if (command) snapshot.commands.set(`${file}:${command[1].toUpperCase()}.${index + 1}`, command[2].trim());
      const health = line.match(/^\s*HEALTHCHECK\b(.+)$/i);
      if (health) {
        const routes = detectableHealthPaths(health[1]);
        if (routes.length) snapshot.healthRoutes.set(`${file}:HEALTHCHECK.${index + 1}`, routes.join(", "));
      }
      const expose = line.match(/^\s*EXPOSE\s+(.+)$/i);
      if (expose) {
        for (const port of expose[1].trim().split(/\s+/)) {
          if (/^\d+(?:\/(?:tcp|udp))?$/i.test(port)) snapshot.ports.add(`${file}:EXPOSE:${port}`);
        }
      }
      const runtime = line.match(/^\s*FROM\s+([^\s]+)(?:\s+AS\s+\S+)?$/i);
      if (runtime) snapshot.runtimeMarkers.set(`${file}:FROM.${index + 1}`, runtime[1]);
    }
  }
  if (base === "pyproject.toml") {
    let scripts = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*\[project\.scripts\]\s*$/.test(line)) {
        scripts = true;
        continue;
      }
      if (/^\s*\[/.test(line)) scripts = false;
      const match = scripts ? line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"/) : null;
      if (match) snapshot.commands.set(`${file}:project.scripts.${match[1]}`, match[2]);
    }
  }
}

function inspectRuntime(snapshot: Snapshot, file: string, text: string): void {
  const base = path.posix.basename(file);
  if ([".nvmrc", ".node-version", ".ruby-version", ".python-version", ".tool-versions"].includes(base)) {
    snapshot.runtimeMarkers.set(file, text.trim().slice(0, 500));
  }
  if (base === "go.mod") {
    const match = text.match(/^\s*go\s+([^\s]+)\s*$/m);
    if (match) snapshot.runtimeMarkers.set(`${file}:go`, match[1]);
  }
  if (base === "Gemfile") {
    const match = text.match(/^\s*ruby\s+["']([^"']+)["']/m);
    if (match) snapshot.runtimeMarkers.set(`${file}:ruby`, match[1]);
  }
}

function inspectHealthRoutes(snapshot: Snapshot, file: string, text: string): void {
  const routes = new Set(detectableHealthPaths(text));
  const patterns = [
    /\b(?:app|router)\.(?:get|head)\(\s*["'](\/[^"']*(?:health|ready|status)[^"']*)["']/gi,
    /@(?:app|router)\.route\(\s*["'](\/[^"']*(?:health|ready|status)[^"']*)["']/gi,
    /\bget\s+["'](\/[^"']*(?:health|ready|status)[^"']*)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) routes.add(match[1].split(/[?#]/)[0]);
  }
  if (routes.size) snapshot.healthRoutes.set(file, [...routes].sort().join(", "));
}

function buildSnapshot(
  repo: string,
  commit: string,
  files: string[],
  changed: ReadonlySet<string>,
): Snapshot {
  const snapshot: Snapshot = {
    files: new Set(files),
    services: new Set(),
    ports: new Set(),
    envVars: new Set(),
    commands: new Map(),
    packageManagers: new Map(),
    runtimeMarkers: new Map(),
    healthRoutes: new Map(),
  };
  for (const file of files) {
    const lockManager = packageManagerFromLock(file);
    if (lockManager) snapshot.packageManagers.set(`${file}:lockfile`, lockManager);
    if (!shouldRead(file, changed)) continue;
    const text = readBlob(repo, commit, file);
    if (text === null) continue;
    if (isComposeFile(file)) inspectCompose(snapshot, file, text);
    if (isEnvTemplate(file)) addTemplateEnvNames(snapshot.envVars, text);
    else addEnvNames(snapshot.envVars, text);
    if (path.posix.basename(file) === "package.json") inspectPackageJson(snapshot, file, text);
    if (KNOWN_COMMAND_FILE.test(file)) inspectKnownCommands(snapshot, file, text);
    if (RUNTIME_FILE.test(file)) inspectRuntime(snapshot, file, text);
    if (changed.has(file)) inspectHealthRoutes(snapshot, file, text);
  }
  return snapshot;
}

function setDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter(value => !right.has(value)).sort();
}

function mapChanges(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): DiffChange[] {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys
    .filter(key => before.get(key) !== after.get(key))
    .map(source => ({
      source,
      before: before.get(source) ?? null,
      after: after.get(source) ?? null,
    }));
}

function redactChange(change: DiffChange, redactions: Set<string>): DiffChange {
  const redact = (value: string | null): string | null => {
    if (value === null) return null;
    const environmentRedacted = value.replace(
      /\b([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/g,
      "$1=[redacted]",
    );
    const flagRedacted = environmentRedacted.replace(
      /(\B--?(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|private[-_]?key)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[redacted]",
    );
    if (environmentRedacted !== value) redactions.add("command environment values");
    if (flagRedacted !== environmentRedacted) redactions.add("secret command arguments");
    const result = redactText(flagRedacted);
    for (const rule of result.applied) redactions.add(rule);
    return result.text.slice(0, 1000);
  };
  return { source: change.source, before: redact(change.before), after: redact(change.after) };
}

function formatMapChanges(label: string, changes: DiffChange[], redactions: Set<string>): string[] {
  return changes.map(change => {
    const before = redactChange(change, redactions).before ?? "(absent)";
    const after = redactChange(change, redactions).after ?? "(absent)";
    return `${label} changed at ${change.source}: ${before} -> ${after}`;
  });
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

export function validateDiffResult(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["diff result must be an object"];
  const result = value as Partial<DiffResult>;
  const errors = Object.keys(value).filter(key => !DIFF_KEYS.has(key)).map(key => `unsupported field: ${key}`);
  if (result.schema !== "bootproof/diff-result/v1") errors.push("invalid schema");
  for (const key of ["base", "head"] as const) {
    if (typeof result[key] !== "string" || !result[key]) errors.push(`${key} must be a non-empty string`);
  }
  for (const key of [
    "changedFiles",
    "addedServices",
    "removedServices",
    "addedPorts",
    "removedPorts",
    "addedEnvVars",
    "removedEnvVars",
    "suggestedReviewNotes",
    "redactionsApplied",
  ] as const) {
    if (!stringArray(result[key])) errors.push(`${key} must be a string array`);
  }
  for (const key of ["changedCommands", "changedPackageManagers"] as const) {
    const changes = result[key];
    if (!Array.isArray(changes)) {
      errors.push(`${key} must be an array`);
      continue;
    }
    for (const change of changes) {
      if (!change || typeof change !== "object" || Array.isArray(change)) {
        errors.push(`${key} entries must be objects`);
        continue;
      }
      const record = change as Partial<DiffChange>;
      errors.push(...Object.keys(change).filter(name => !CHANGE_KEYS.has(name)).map(name => `${key}: unsupported field: ${name}`));
      if (typeof record.source !== "string" || !record.source) errors.push(`${key}: source must be a non-empty string`);
      if (record.before !== null && typeof record.before !== "string") errors.push(`${key}: before must be string or null`);
      if (record.after !== null && typeof record.after !== "string") errors.push(`${key}: after must be string or null`);
    }
  }
  if (!["low", "medium", "high"].includes(String(result.riskLevel))) errors.push("invalid riskLevel");
  if (typeof result.proofRequired !== "boolean") errors.push("proofRequired must be boolean");
  return [...new Set(errors)];
}

export function diffRefs(
  repoPath: string,
  options: { base?: string; head?: string } = {},
): DiffResult {
  const repo = path.resolve(repoPath);
  const base = safeRef(options.base ?? "HEAD^", "base");
  const head = safeRef(options.head ?? "HEAD", "head");
  const baseCommit = resolveCommit(repo, base);
  const headCommit = resolveCommit(repo, head);
  const files = changedFiles(repo, baseCommit, headCommit);
  const changed = new Set(files);
  const before = buildSnapshot(repo, baseCommit, listFiles(repo, baseCommit), changed);
  const after = buildSnapshot(repo, headCommit, listFiles(repo, headCommit), changed);
  const redactions = new Set<string>();
  const changedCommands = mapChanges(before.commands, after.commands).map(change => redactChange(change, redactions));
  const changedPackageManagers = mapChanges(before.packageManagers, after.packageManagers)
    .map(change => redactChange(change, redactions));
  const runtimeChanges = mapChanges(before.runtimeMarkers, after.runtimeMarkers);
  const healthChanges = mapChanges(before.healthRoutes, after.healthRoutes);
  const addedServices = setDifference(after.services, before.services);
  const removedServices = setDifference(before.services, after.services);
  const addedPorts = setDifference(after.ports, before.ports);
  const removedPorts = setDifference(before.ports, after.ports);
  const addedEnvVars = setDifference(after.envVars, before.envVars);
  const removedEnvVars = setDifference(before.envVars, after.envVars);
  const changedManifests = files.filter(file => MANIFEST_FILE.test(file));
  const changedLocks = files.filter(file => LOCK_FILE.test(file));
  const highRisk = Boolean(
    addedServices.length ||
    removedServices.length ||
    addedPorts.length ||
    removedPorts.length ||
    changedCommands.length ||
    changedPackageManagers.length,
  );
  const mediumRisk = Boolean(
    addedEnvVars.length ||
    removedEnvVars.length ||
    changedManifests.length ||
    changedLocks.length ||
    runtimeChanges.length ||
    healthChanges.length,
  );
  const riskLevel: DiffRiskLevel = highRisk ? "high" : mediumRisk ? "medium" : "low";
  const notes: string[] = [];
  if (addedServices.length || removedServices.length) notes.push("Review Compose service topology and dependency ordering.");
  if (addedPorts.length || removedPorts.length) notes.push("Review exposed ports, conflicts, and health endpoint reachability.");
  if (addedEnvVars.length || removedEnvVars.length) notes.push("Review environment variable names; BootProof did not read protected .env contents or infer values.");
  if (changedCommands.length) notes.push("Review changed start commands before executing the head revision.");
  if (changedPackageManagers.length) notes.push("Review package manager and lockfile changes for reproducibility.");
  if (changedManifests.length) notes.push(`Dependency manifests changed: ${changedManifests.join(", ")}.`);
  if (changedLocks.length) notes.push(`Package manager lockfiles changed: ${changedLocks.join(", ")}.`);
  notes.push(...formatMapChanges("Runtime marker", runtimeChanges, redactions));
  notes.push(...formatMapChanges("Health route", healthChanges, redactions));
  if (riskLevel !== "low") notes.push(`Run BootProof against ${head} to produce fresh observed boot evidence.`);
  else notes.push("No supported infrastructure drift was detected; this static result is not boot proof.");
  const result: DiffResult = {
    schema: "bootproof/diff-result/v1",
    base,
    head,
    changedFiles: files,
    addedServices,
    removedServices,
    addedPorts,
    removedPorts,
    addedEnvVars,
    removedEnvVars,
    changedCommands,
    changedPackageManagers,
    riskLevel,
    proofRequired: riskLevel !== "low",
    suggestedReviewNotes: notes,
    redactionsApplied: [...redactions].sort(),
  };
  const errors = validateDiffResult(result);
  if (errors.length) throw new Error(`invalid diff result: ${errors.join("; ")}`);
  return result;
}
