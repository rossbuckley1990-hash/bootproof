import fs from "node:fs";
import path from "node:path";
import type { Inference, PackageManager, ServiceNeed, WorkspaceCandidate } from "./types.js";

function readJson(p: string): any | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function exists(repo: string, rel: string): boolean {
  return fs.existsSync(path.join(repo, rel));
}
function readText(repo: string, rel: string): string {
  try { return fs.readFileSync(path.join(repo, rel), "utf8"); } catch { return ""; }
}

function detectPackageManager(repo: string, pkg: any): { pm: PackageManager; evidence: string } {
  const field: string | undefined = pkg?.packageManager;
  if (field) {
    const name = field.split("@")[0] as PackageManager;
    if (["npm", "pnpm", "yarn", "bun"].includes(name)) return { pm: name, evidence: `packageManager field: ${field}` };
  }
  if (exists(repo, "pnpm-lock.yaml")) return { pm: "pnpm", evidence: "pnpm-lock.yaml present" };
  if (exists(repo, "yarn.lock")) return { pm: "yarn", evidence: "yarn.lock present" };
  if (exists(repo, "bun.lockb") || exists(repo, "bun.lock")) return { pm: "bun", evidence: "bun lockfile present" };
  if (exists(repo, "package-lock.json")) return { pm: "npm", evidence: "package-lock.json present" };
  if (pkg) return { pm: "npm", evidence: "package.json present, no lockfile; assuming npm" };
  return { pm: "unknown", evidence: "no package.json found" };
}

function detectStack(pkg: any, repo: string): string[] {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const stack: string[] = [];
  if (deps.next) stack.push("nextjs");
  if (deps.vite) stack.push("vite");
  if (deps.react && !deps.next) stack.push("react");
  if (deps.express) stack.push("express");
  if (deps.fastify) stack.push("fastify");
  if (deps["@nestjs/core"]) stack.push("nestjs");
  if (deps.prisma || deps["@prisma/client"] || exists(repo, "prisma/schema.prisma")) stack.push("prisma");
  if (exists(repo, "docker-compose.yml") || exists(repo, "docker-compose.yaml") || exists(repo, "compose.yaml")) stack.push("docker-compose");
  return stack;
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

function detectPort(pkg: any, repo: string): { port: number; evidence: string } {
  const scripts = JSON.stringify(pkg?.scripts ?? {});
  const m = scripts.match(/(?:-p|--port)[=\s\\"]+(\d{2,5})/);
  if (m) return { port: Number(m[1]), evidence: `port flag in scripts: ${m[0].replace(/\\"/g, "").trim()}` };
  const envEx = readText(repo, ".env.example");
  const pm = envEx.match(/^PORT=(\d{2,5})/m);
  if (pm) return { port: Number(pm[1]), evidence: "PORT in .env.example" };
  return { port: 3000, evidence: "default assumption (3000); not evidence-based" };
}

function detectServices(pkg: any, repo: string): ServiceNeed[] {
  const out: ServiceNeed[] = [];
  const envEx = readText(repo, ".env.example") + readText(repo, ".env.sample");
  const schema = readText(repo, "prisma/schema.prisma");
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (/postgres(ql)?:\/\//i.test(envEx) || /provider\s*=\s*"postgresql"/.test(schema) || deps.pg)
    out.push({ kind: "postgres", evidence: deps.pg ? "pg dependency" : "postgres URL in env example or prisma schema" });
  if (/mysql:\/\//i.test(envEx) || /provider\s*=\s*"mysql"/.test(schema) || deps.mysql2)
    out.push({ kind: "mysql", evidence: "mysql URL or dependency" });
  if (/redis:\/\//i.test(envEx) || deps.ioredis || deps.redis)
    out.push({ kind: "redis", evidence: "redis URL or dependency" });
  if (/mongodb(\+srv)?:\/\//i.test(envEx) || deps.mongoose)
    out.push({ kind: "mongodb", evidence: "mongodb URL or dependency" });
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

const LIBRARY_DOWNRANK = /^(packages|libs|examples?|templates?|fixtures|docs|internal|tooling|scripts)\//;
const SCAFFOLD_DOWNRANK = /^create-|-(template|example|fixture|sandbox)$/;

function rankWorkspaces(repo: string, pkg: any): WorkspaceCandidate[] {
  const patterns: string[] = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages ?? [];
  const pnpmWs = readText(repo, "pnpm-workspace.yaml");
  for (const m of pnpmWs.matchAll(/-\s*['"]?([^'"#\n]+)['"]?/g)) patterns.push(m[1].trim());
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    const base = pattern.replace(/\/?\*+.*$/, "");
    const baseAbs = path.join(repo, base);
    if (pattern.includes("*")) {
      try { for (const d of fs.readdirSync(baseAbs)) if (fs.existsSync(path.join(baseAbs, d, "package.json"))) dirs.add(path.join(base, d)); } catch { /* pattern base missing */ }
    } else if (fs.existsSync(path.join(baseAbs, "package.json"))) dirs.add(base);
  }
  const candidates: WorkspaceCandidate[] = [];
  for (const dir of dirs) {
    const wpkg = readJson(path.join(repo, dir, "package.json"));
    if (!wpkg) continue;
    const { command } = pickAppCommand(wpkg, "npm");
    let score = 0;
    const reasons: string[] = [];
    if (command) { score += 3; reasons.push("has runnable script"); }
    const deps = { ...(wpkg.dependencies ?? {}), ...(wpkg.devDependencies ?? {}) };
    if (deps.next || deps.vite || deps.express || deps.fastify || deps["@nestjs/core"]) { score += 3; reasons.push("app framework dependency"); }
    if (/(^|\/)apps?\//.test(dir + "/") || dir.startsWith("apps")) { score += 2; reasons.push("under apps/"); }
    if (LIBRARY_DOWNRANK.test(dir + "/")) { score -= 2; reasons.push("library/example path downranked"); }
    if (wpkg.private !== true && wpkg.main && !command) { score -= 1; reasons.push("looks like a publishable library"); }
    if (SCAFFOLD_DOWNRANK.test(wpkg.name ?? "") || SCAFFOLD_DOWNRANK.test(path.basename(dir))) { score -= 2; reasons.push("scaffold/template name downranked"); }
    candidates.push({ dir, name: wpkg.name ?? dir, score, reason: reasons.join("; ") || "no signals" });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function looksLikeLibrary(pkg: any, appCommand: string | null, hasWorkspaces: boolean): string | null {
  if (appCommand || hasWorkspaces) return null;
  if (!pkg) return "no package.json and no recognizable application entrypoint";
  const isPublishable = pkg.private !== true && (pkg.main || pkg.exports || pkg.bin);
  if (isPublishable) return "publishable package (main/exports/bin) with no dev/start/serve script — this looks like a library, not a runnable application";
  return "no dev/start/serve/preview script found — nothing to boot";
}

export function inferRepo(repoPath: string, opts: { workspace?: string } = {}): Inference {
  let repo = path.resolve(repoPath);
  if (opts.workspace) repo = path.join(repo, opts.workspace);
  const pkg = readJson(path.join(repo, "package.json"));
  const rootRepo = path.resolve(repoPath);
  const rootPkg = opts.workspace ? readJson(path.join(rootRepo, "package.json")) : pkg;
  const workspaces = opts.workspace ? [] : rankWorkspaces(rootRepo, rootPkg);
  const { pm, evidence: pmEvidence } = detectPackageManager(opts.workspace ? rootRepo : repo, opts.workspace ? rootPkg : pkg);
  const app = pickAppCommand(pkg, pm);
  const notApp = looksLikeLibrary(pkg, app.command, workspaces.length > 0);
  const { port, evidence: portEvidence } = detectPort(pkg, repo);
  const env = detectEnv(repo);
  const services = detectServices(pkg, repo);
  const stack = detectStack(pkg, repo);
  const installCommand = pm === "unknown" ? null : pm === "yarn" ? "yarn install" : pm === "pnpm" ? "pnpm install" : pm === "bun" ? "bun install" : "npm install";

  let confidence = 0;
  if (app.command) confidence += 40;
  if (stack.length) confidence += 20;
  if (pm !== "unknown" && !pmEvidence.includes("assuming")) confidence += 15;
  if (!portEvidence.includes("assumption")) confidence += 15;
  if (services.length || env.required.length) confidence += 10;

  return {
    repoPath: repo,
    isApplication: !notApp,
    notAppReason: notApp ?? undefined,
    stack,
    packageManager: pm,
    packageManagerEvidence: pmEvidence,
    installCommand,
    appCommand: app.command,
    appCommandSource: app.source,
    port,
    portEvidence,
    services,
    requiredEnv: env.required,
    envWithoutSafeDefault: env.noSafeDefault,
    engines: { node: pkg?.engines?.node ?? rootPkg?.engines?.node },
    workspaces,
    confidence: Math.min(confidence, 95),
  };
}
