import fs from "node:fs";
import path from "node:path";
import type { Inference, PackageManager, ServiceNeed, WorkspaceCandidate } from "./types.js";

function readJson(p: string): any | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function exists(repo: string, rel: string): boolean {
  return fs.existsSync(path.join(repo, rel));
}

function isDirectory(repo: string, rel: string): boolean {
  try { return fs.statSync(path.join(repo, rel)).isDirectory(); } catch { return false; }
}

function readText(repo: string, rel: string): string {
  try { return fs.readFileSync(path.join(repo, rel), "utf8"); } catch { return ""; }
}

function present(repo: string, paths: string[]): string[] {
  return paths.filter(rel => exists(repo, rel));
}

interface PackageManagerDetection {
  pm: PackageManager;
  evidence: string;
  version: string | null;
  packageDir: string;
}

const REPO_COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yaml",
  "compose.yml",
  "docker-compose.dev.yml",
  "docker-compose.dev.yaml",
  "docker/docker-compose.yml",
  "docker/docker-compose.yaml",
];

function detectRepoComposeFile(repo: string): string | null {
  return REPO_COMPOSE_FILES.find(file => exists(repo, file)) ?? null;
}

function packageManagerFromField(field: string | undefined): { pm: PackageManager; version: string | null } | null {
  if (!field) return null;
  const at = field.lastIndexOf("@");
  const name = (at > 0 ? field.slice(0, at) : field) as PackageManager;
  if (!["npm", "pnpm", "yarn", "bun"].includes(name)) return null;
  return { pm: name, version: at > 0 ? field.slice(at + 1) : null };
}

function detectPackageManager(repo: string, pkg: any, frontendDir: string | null): PackageManagerDetection {
  const rootField = packageManagerFromField(pkg?.packageManager);
  if (rootField) return { ...rootField, evidence: `packageManager field: ${pkg.packageManager}`, packageDir: "." };

  const nestedPkg = frontendDir ? readJson(path.join(repo, frontendDir, "package.json")) : null;
  const nestedField = packageManagerFromField(nestedPkg?.packageManager);
  if (nestedField) {
    return { ...nestedField, evidence: `packageManager field in ${frontendDir}/package.json: ${nestedPkg.packageManager}`, packageDir: frontendDir! };
  }

  const contexts = [".", ...(frontendDir ? [frontendDir] : [])];
  for (const dir of contexts) {
    const prefix = dir === "." ? "" : `${dir}/`;
    if (exists(repo, `${prefix}pnpm-lock.yaml`)) return { pm: "pnpm", evidence: `${prefix}pnpm-lock.yaml present`, version: null, packageDir: dir };
    if (exists(repo, `${prefix}yarn.lock`)) return { pm: "yarn", evidence: `${prefix}yarn.lock present`, version: null, packageDir: dir };
    if (exists(repo, `${prefix}bun.lockb`) || exists(repo, `${prefix}bun.lock`)) return { pm: "bun", evidence: `${prefix}bun lockfile present`, version: null, packageDir: dir };
    if (exists(repo, `${prefix}package-lock.json`)) return { pm: "npm", evidence: `${prefix}package-lock.json present`, version: null, packageDir: dir };
  }
  if (pkg) return { pm: "npm", evidence: "package.json present, no lockfile; assuming npm", version: null, packageDir: "." };
  if (nestedPkg && frontendDir) return { pm: "npm", evidence: `${frontendDir}/package.json present, no lockfile; assuming npm`, version: null, packageDir: frontendDir };
  return { pm: "unknown", evidence: "no package.json found", version: null, packageDir: "." };
}

const APP_SCRIPT_ORDER = ["dev", "start", "serve", "preview"];

function pickAppCommand(pkg: any, pm: PackageManager): { command: string | null; source: string; script: string | null } {
  const scripts = pkg?.scripts ?? {};
  for (const name of APP_SCRIPT_ORDER) {
    if (typeof scripts[name] === "string" && scripts[name].trim()) {
      const runner = pm === "yarn" ? `yarn ${name}` : pm === "pnpm" ? `pnpm ${name}` : pm === "bun" ? `bun run ${name}` : `npm run ${name}`;
      return { command: runner, source: `scripts.${name}: ${scripts[name]}`, script: name };
    }
  }
  return { command: null, source: "no dev/start/serve/preview script found", script: null };
}

function detectNestedFrontend(repo: string): { dir: string; pkg: any } | null {
  const preferred = ["superset-frontend", "frontend", "web", "ui", "client"];
  for (const dir of preferred) {
    const pkg = readJson(path.join(repo, dir, "package.json"));
    if (pkg) return { dir, pkg };
  }
  return null;
}

function detectArchitecture(repo: string, pkg: any, nestedFrontend: { dir: string; pkg: any } | null, repoComposeFile: string | null) {
  const makefile = readText(repo, "Makefile");
  const pyproject = readText(repo, "pyproject.toml");
  const setupPy = readText(repo, "setup.py");
  const compose = repoComposeFile ? readText(repo, repoComposeFile) : "";
  const rootDeps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const nestedDeps = { ...(nestedFrontend?.pkg?.dependencies ?? {}), ...(nestedFrontend?.pkg?.devDependencies ?? {}) };

  const backendMarkers = present(repo, ["pyproject.toml", "setup.py", "go.mod", "go.work", "Gemfile", "config/database.yml", "Makefile", "superset/app.py", "superset/config.py"]);
  if (isDirectory(repo, "pkg")) backendMarkers.push("pkg/");

  const frontendMarkers = present(repo, ["package.json", "yarn.lock", "pnpm-lock.yaml", "nx.json"]);
  if (isDirectory(repo, "public")) frontendMarkers.push("public/");
  if (isDirectory(repo, "packages")) frontendMarkers.push("packages/");
  if (nestedFrontend) frontendMarkers.push(`${nestedFrontend.dir}/package.json`);

  const serviceMarkers = present(repo, [...REPO_COMPOSE_FILES, "docker-compose-light.yml"]);
  const hasPythonBackend =
    (exists(repo, "pyproject.toml") || exists(repo, "setup.py")) &&
    (exists(repo, "superset/app.py") || exists(repo, "superset/config.py") || /\bflask\b/i.test(pyproject + setupPy + makefile));
  const hasFlask = hasPythonBackend && (/\bflask\b/i.test(pyproject + setupPy + makefile) || exists(repo, "superset/app.py"));
  const hasGoBackend = exists(repo, "go.mod") || exists(repo, "go.work");
  const hasRubyBackend = exists(repo, "Gemfile");
  const hasMakeDrivenBackend = exists(repo, "Makefile") && /^\s*(?:run|serve|server|dev|start):/m.test(makefile);
  const hasNodeFrontend = Boolean(pkg) && (isDirectory(repo, "public") || isDirectory(repo, "packages") || exists(repo, "nx.json") || hasGoBackend || hasRubyBackend);
  const hasReact = Boolean(rootDeps.react || nestedDeps.react);
  const hasReactFrontend = Boolean(nestedFrontend && hasReact);
  const hasCelery = /\bcelery\b/i.test(pyproject + setupPy + makefile + compose);
  const hasCompose = serviceMarkers.length > 0;

  const stack: string[] = [];
  if (hasPythonBackend) stack.push("python-backend");
  if (hasFlask) stack.push("flask");
  if (hasGoBackend) stack.push("go-backend");
  if (hasRubyBackend) stack.push("ruby-backend");
  if (hasMakeDrivenBackend && !hasPythonBackend && !hasGoBackend && !hasRubyBackend) stack.push("make-driven");
  if (hasNodeFrontend) stack.push("node-frontend");
  if (hasReactFrontend) stack.push("react-frontend");
  if (hasReact && !hasReactFrontend) stack.push("react");
  if (rootDeps.next) stack.push("nextjs");
  if (rootDeps.vite) stack.push("vite");
  if (rootDeps.express) stack.push("express");
  if (rootDeps.fastify) stack.push("fastify");
  if (rootDeps["@nestjs/core"]) stack.push("nestjs");
  if (rootDeps.prisma || rootDeps["@prisma/client"] || exists(repo, "prisma/schema.prisma")) stack.push("prisma");
  if (hasCompose) stack.push("docker-compose");
  if (hasCelery) stack.push("celery");

  const setupSteps: string[] = [];
  if (/^\s*superset db upgrade\s*$/m.test(makefile)) setupSteps.push("superset db upgrade");
  if (/^\s*superset init\s*$/m.test(makefile)) setupSteps.push("superset init");

  const flaskCommand = makefile.match(/^\s*(flask run[^\n]*)$/m)?.[1].trim() ?? null;
  const frontendMakeCommand = makefile.match(/^\s*(cd\s+[^;\n]+;\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev-server|dev|start)[^\n]*)$/m)?.[1].trim() ?? null;
  const workerCommand = makefile.match(/^\s*(celery\s+--app=[^\n]*\sworker[^\n]*)$/m)?.[1].trim() ?? null;
  const makeRunCommand = hasGoBackend && /^run:\s/m.test(makefile) ? "make run" : null;

  return {
    backendMarkers: [...new Set(backendMarkers)],
    frontendMarkers: [...new Set(frontendMarkers)],
    serviceMarkers: [...new Set(serviceMarkers)],
    stack,
    setupSteps,
    flaskCommand,
    frontendMakeCommand,
    workerCommand,
    makeRunCommand,
    hasPythonBackend,
    hasFlask,
    hasGoBackend,
    hasRubyBackend,
    hasMakeDrivenBackend,
    hasNodeFrontend,
  };
}

function detectPort(pkg: any, repo: string, commands: Array<string | null>): { port: number; evidence: string } {
  const sources = [JSON.stringify(pkg?.scripts ?? {}), readText(repo, "Makefile"), ...commands.filter((v): v is string => Boolean(v))].join("\n");
  const m = sources.match(/(?:-p|--port)(?:=|\s+|[\\"]+)(\d{2,5})/);
  if (m) return { port: Number(m[1]), evidence: `port flag in command evidence: ${m[0].replace(/\\"/g, "").trim()}` };
  const envEx = readText(repo, ".env.example");
  const pm = envEx.match(/^PORT=(\d{2,5})/m);
  if (pm) return { port: Number(pm[1]), evidence: "PORT in .env.example" };
  return { port: 3000, evidence: "default assumption (3000); not evidence-based" };
}

function detectServices(pkg: any, repo: string, repoComposeFile: string | null): ServiceNeed[] {
  const out: ServiceNeed[] = [];
  const envEx = readText(repo, ".env.example") + readText(repo, ".env.sample");
  const schema = readText(repo, "prisma/schema.prisma");
  const compose = repoComposeFile ? readText(repo, repoComposeFile) : "";
  const pyproject = readText(repo, "pyproject.toml");
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (/postgres(ql)?:\/\//i.test(envEx) || /provider\s*=\s*"postgresql"/.test(schema) || deps.pg || /^\s{0,4}postgres:\s*$/m.test(compose))
    out.push({ kind: "postgres", evidence: deps.pg ? "pg dependency" : "postgres evidence in env, schema, or compose" });
  if (/mysql:\/\//i.test(envEx) || /provider\s*=\s*"mysql"/.test(schema) || deps.mysql2 || /^\s{0,4}mysql:\s*$/m.test(compose))
    out.push({ kind: "mysql", evidence: "mysql URL, dependency, or compose service" });
  if (/redis:\/\//i.test(envEx) || deps.ioredis || deps.redis || /^\s{0,4}redis:\s*$/m.test(compose) || /["']redis[<=>~\d]/i.test(pyproject))
    out.push({ kind: "redis", evidence: "redis URL, dependency, pyproject entry, or compose service" });
  if (/mongodb(\+srv)?:\/\//i.test(envEx) || deps.mongoose || /^\s{0,4}mongodb:\s*$/m.test(compose))
    out.push({ kind: "mongodb", evidence: "mongodb URL, dependency, or compose service" });
  return out;
}

const SECRET_KEY_HINT = /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|_KEY$)/;

function detectEnv(repo: string): { required: string[]; noSafeDefault: string[] } {
  const src = readText(repo, ".env.example") || readText(repo, ".env.sample");
  const required: string[] = [];
  const noSafeDefault: string[] = [];
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    required.push(m[1]);
    const hasValue = m[2].trim().length > 0;
    if (!hasValue && SECRET_KEY_HINT.test(m[1])) noSafeDefault.push(m[1]);
  }
  return { required, noSafeDefault };
}

function workspacePatterns(repo: string, pkg: any): string[] {
  const patterns: string[] = Array.isArray(pkg?.workspaces) ? [...pkg.workspaces] : [...(pkg?.workspaces?.packages ?? [])];
  const pnpmLines = readText(repo, "pnpm-workspace.yaml").split(/\r?\n/);
  let inPackages = false;
  for (const line of pnpmLines) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages && /^\S/.test(line)) break;
    const match = inPackages ? line.match(/^\s+-\s*['"]?([^'"#]+?)['"]?\s*$/) : null;
    if (match) patterns.push(match[1].trim());
  }
  return [...new Set(patterns)];
}

function expandWorkspacePattern(repo: string, pattern: string): string[] {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  if (!normalizedPattern.includes("*")) return exists(repo, `${normalizedPattern}/package.json`) ? [normalizedPattern] : [];
  const beforeStar = normalizedPattern.slice(0, normalizedPattern.indexOf("*"));
  const base = beforeStar.replace(/\/$/, "");
  const suffix = normalizedPattern.slice(normalizedPattern.indexOf("*") + 1).replace(/^\//, "");
  const baseAbs = path.join(repo, base);
  try {
    return fs.readdirSync(baseAbs)
      .map(name => path.posix.join(base, name, suffix))
      .filter(dir => exists(repo, `${dir}/package.json`));
  } catch {
    return [];
  }
}

const TEST_PATH = /(^|[-_/])(e2e|tests?|test-plugins|fixtures?|examples?|samples?|demos?|mocks?)([-_/]|$)/i;
const DOCUMENTATION_PATH = /(^|[\/])(storybook|docs?)([\/]|$)/i;
const SCAFFOLD_NAME = /^create-|-(template|example|fixture|sandbox|sample|demo|mock)$/i;

function scoreWorkspace(repo: string, dir: string, wpkg: any, isRoot: boolean): WorkspaceCandidate {
  const { command } = pickAppCommand(wpkg, "npm");
  const deps = { ...(wpkg?.dependencies ?? {}), ...(wpkg?.devDependencies ?? {}) };
  let score = 0;
  const reasons: string[] = [];
  if (command) { score += isRoot ? 6 : 3; reasons.push("has runnable script"); }
  if (deps.next || deps.vite || deps.express || deps.fastify || deps["@nestjs/core"] || deps.react) { score += 3; reasons.push("app framework dependency"); }
  if (isRoot) {
    score += 4;
    reasons.push("root application");
    if (exists(repo, "go.mod") || exists(repo, "go.work")) { score += 4; reasons.push("root Go backend"); }
    if (/^run:\s/m.test(readText(repo, "Makefile"))) { score += 2; reasons.push("Makefile run target"); }
    if (exists(repo, "nx.json") || exists(repo, "project.json")) { score += 2; reasons.push("root project graph"); }
  } else {
    if (/^apps?\//.test(dir)) { score += 3; reasons.push("under apps/"); }
    if (/^packages\//.test(dir) && !TEST_PATH.test(dir)) { score += 1; reasons.push("production-looking package"); }
    if (exists(repo, `${dir}/project.json`)) { score += 2; reasons.push("project.json present"); }
  }
  if (TEST_PATH.test(`${dir}/${wpkg?.name ?? ""}`)) { score -= 10; reasons.push("test/example path downranked"); }
  if (DOCUMENTATION_PATH.test(`${dir}/${wpkg?.name ?? ""}`)) { score -= 3; reasons.push("documentation/storybook downranked"); }
  if (wpkg?.private !== true && (wpkg?.main || wpkg?.exports) && !command) { score -= 2; reasons.push("looks like a publishable library"); }
  if (SCAFFOLD_NAME.test(wpkg?.name ?? "") || SCAFFOLD_NAME.test(path.basename(dir))) { score -= 4; reasons.push("scaffold/sample name downranked"); }
  return { dir, name: wpkg?.name ?? dir, score, reason: reasons.join("; ") || "no signals" };
}

function rankWorkspaces(repo: string, pkg: any): WorkspaceCandidate[] {
  const dirs = new Set<string>();
  for (const pattern of workspacePatterns(repo, pkg)) for (const dir of expandWorkspacePattern(repo, pattern)) dirs.add(dir);
  const candidates: WorkspaceCandidate[] = [];
  if (pkg && (pickAppCommand(pkg, "npm").command || exists(repo, "go.mod") || exists(repo, "go.work"))) {
    candidates.push(scoreWorkspace(repo, ".", pkg, true));
  }
  for (const dir of dirs) {
    const wpkg = readJson(path.join(repo, dir, "package.json"));
    if (wpkg) candidates.push(scoreWorkspace(repo, dir, wpkg, false));
  }
  return candidates.sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir));
}

function looksLikeLibrary(pkg: any, appCommand: string | null, hasWorkspaces: boolean, recognizedApplication: boolean): string | null {
  if (appCommand || hasWorkspaces || recognizedApplication) return null;
  if (!pkg) return "no package.json and no recognizable application entrypoint";
  const isPublishable = pkg.private !== true && (pkg.main || pkg.exports || pkg.bin);
  if (isPublishable) return "publishable package (main/exports/bin) with no dev/start/serve script — this looks like a library, not a runnable application";
  return "no dev/start/serve/preview script found — nothing to boot";
}

function installCommand(pm: PackageManager, packageDir: string): string | null {
  if (pm === "unknown") return null;
  const command = pm === "yarn" ? "yarn install" : pm === "pnpm" ? "pnpm install" : pm === "bun" ? "bun install" : "npm install";
  return packageDir === "." ? command : `cd ${packageDir} && ${command}`;
}

export function inferRepo(repoPath: string, opts: { workspace?: string } = {}): Inference {
  let repo = path.resolve(repoPath);
  if (opts.workspace) repo = path.join(repo, opts.workspace);
  const pkg = readJson(path.join(repo, "package.json"));
  const rootRepo = path.resolve(repoPath);
  const rootPkg = opts.workspace ? readJson(path.join(rootRepo, "package.json")) : pkg;
  const nestedFrontend = detectNestedFrontend(repo);
  const repoComposeFile = detectRepoComposeFile(repo);
  const architecture = detectArchitecture(repo, pkg, nestedFrontend, repoComposeFile);
  const pm = detectPackageManager(repo, pkg, nestedFrontend?.dir ?? null);
  const rootApp = pickAppCommand(pkg, pm.pm);

  const backendCommand = architecture.flaskCommand ?? architecture.makeRunCommand;
  const nestedFrontendCommand = architecture.frontendMakeCommand;
  const frontendCommand = nestedFrontendCommand ?? rootApp.command;
  const appCommand = architecture.flaskCommand ?? rootApp.command;
  const appCommandSource = architecture.flaskCommand
    ? `Makefile Flask command: ${architecture.flaskCommand}`
    : rootApp.source;
  const recognizedApplication = architecture.hasPythonBackend || architecture.hasGoBackend || architecture.hasRubyBackend || architecture.hasMakeDrivenBackend;
  const workspaces = opts.workspace ? [] : rankWorkspaces(rootRepo, rootPkg);
  const notApp = looksLikeLibrary(pkg, appCommand, workspaces.some(candidate => candidate.dir !== "."), recognizedApplication);
  const { port, evidence: portEvidence } = detectPort(pkg, repo, [backendCommand, frontendCommand]);
  const env = detectEnv(repo);
  const services = detectServices(pkg, repo, repoComposeFile);
  const rootDeps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const dependencyInstallRequired = Boolean(
    rootApp.command &&
    (Object.keys(rootDeps).length > 0 || exists(repo, "yarn.lock") || exists(repo, "pnpm-lock.yaml") || exists(repo, "package-lock.json") || exists(repo, "nx.json")),
  );
  const incompleteAppCommand = Boolean(architecture.hasGoBackend && architecture.hasNodeFrontend && rootApp.command);
  const multiAppCommand = Boolean(rootApp.command && /\b(?:turbo|nx)\s+run\s+dev\b[^\n]*--parallel\b/i.test(rootApp.source));
  const commandScope = multiAppCommand
    ? "multi-workspace development pipeline; no single application health target selected"
    : incompleteAppCommand
    ? "frontend/dev pipeline only; Go backend markers also detected"
    : architecture.hasPythonBackend && nestedFrontend
      ? "Python/Flask backend command; React frontend and worker require separate orchestration"
      : appCommand
        ? "application command"
        : "no runnable command selected";
  const healthCandidates = notApp || !appCommand
    ? []
    : architecture.hasGoBackend && architecture.hasNodeFrontend
      ? [`http://localhost:${port}/api/health`, `http://localhost:${port}/`]
      : [`http://localhost:${port}/`];

  let confidence = 0;
  if (appCommand) confidence += 35;
  if (recognizedApplication) confidence += 25;
  if (architecture.stack.length) confidence += 15;
  if (pm.pm !== "unknown" && !pm.evidence.includes("assuming")) confidence += 10;
  if (!portEvidence.includes("assumption")) confidence += 10;
  if (services.length || env.required.length) confidence += 5;

  return {
    repoPath: repo,
    isApplication: !notApp,
    notAppReason: notApp ?? undefined,
    stack: architecture.stack,
    backendMarkers: architecture.backendMarkers,
    frontendMarkers: architecture.frontendMarkers,
    serviceMarkers: architecture.serviceMarkers,
    repoComposeFile,
    setupSteps: architecture.setupSteps,
    packageManager: pm.pm,
    packageManagerEvidence: pm.evidence,
    packageManagerVersion: pm.version ?? pkg?.engines?.[pm.pm] ?? rootPkg?.engines?.[pm.pm] ?? null,
    installCommand: installCommand(pm.pm, pm.packageDir),
    dependencyInstallRequired,
    appCommand,
    appCommandSource,
    backendCommand,
    frontendCommand,
    workerCommand: architecture.workerCommand,
    commandScope,
    incompleteAppCommand,
    multiAppCommand,
    port,
    portEvidence,
    healthCandidates,
    services,
    requiredEnv: env.required,
    envWithoutSafeDefault: env.noSafeDefault,
    engines: {
      node: pkg?.engines?.node ?? rootPkg?.engines?.node,
      npm: pkg?.engines?.npm ?? rootPkg?.engines?.npm,
      pnpm: pkg?.engines?.pnpm ?? rootPkg?.engines?.pnpm,
      yarn: pkg?.engines?.yarn ?? rootPkg?.engines?.yarn,
      bun: pkg?.engines?.bun ?? rootPkg?.engines?.bun,
    },
    workspaces,
    confidence: Math.min(confidence, 95),
  };
}
