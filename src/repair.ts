import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { buildExecutionEnv, runToCompletion } from "./exec.js";
import { REPAIRED_GENERATED_COMPOSE_MARKER, repoComposeRepairFile } from "./plan.js";
import { redactText } from "./redact.js";
import {
  attestationPath,
  buildAttestation,
  evaluateDetachedSignature,
  gitInfo,
  signDetached,
  TOOL_ID,
  verifyDetached,
  verifySignature,
  writeAttestation,
  type SignatureTrustResult,
} from "./proof.js";
import { up, type UpOptions, type UpOutcome } from "./run.js";
import { inferRepo } from "./infer.js";
import { buildExternalHealthAttestation } from "./external-health.js";
import {
  buildRepairAction,
  buildRepairReceiptBase,
  createRepairCommand,
  validateRepairAction,
  type RepairAction,
  type RepairCommand,
  type RepairMutationScope,
  type RepairReceiptBase,
  type RepairRiskLevel,
} from "./repair-safety.js";
import {
  deterministicRepairCandidateFor,
  repairProgressed,
  type DeterministicRepairCandidate,
} from "./repair-playbooks.js";
import type { Attestation, FailureClass, PackageManager, PreparationCommand } from "./types.js";

export * from "./repair-safety.js";
export * from "./repair-playbooks.js";

export type RepairKind = "repo-diff" | "plan-step" | "environment";

export interface RepairReceipt extends RepairReceiptBase {
  tool?: string;
  repo?: { remote: string | null; commit: string | null; dirty: boolean | null };
  environment?: { os: string; arch: string; node: string };
  failure?: { class: FailureClass; beforeAttestationSha256: string };
  repair?: {
    id: string;
    kind: RepairKind;
    description: string;
    diff: string | null;
    filesChanged: string[];
    fileChanges: RepairReceiptFileChange[];
    preconditions: RepairReceiptPrecondition[];
    planDelta: string | null;
    envDelta: string | null;
  };
  verification?: {
    before: { booted: false; failureClass: FailureClass; attestationSha256: string };
    after: {
      booted: boolean;
      bootproofOrchestrated: boolean;
      healthObservation: string;
      attestationSha256: string;
    };
  };
  startedAt?: string;
  finishedAt?: string;
  signer: { publicKey: string; algorithm: "ed25519" } | null;
  signature: string | null;
}

export interface RepairResult {
  schema: "bootproof/repair-result/v1";
  repaired: boolean;
  failureClass: FailureClass | null;
  repairId: string | null;
  receiptPath: string | null;
  patchPath: string | null;
  afterAttestationPath: string | null;
  explanation: string;
}

export interface RepairApplyResult {
  schema: "bootproof/repair-apply-result/v1";
  applied: boolean;
  receiptPath: string;
  filesChanged: string[];
  explanation: string;
}

export interface RepairOptions {
  provider?: "docker" | "local";
  unsafeLocal: boolean;
  timeoutMs: number;
  port?: number;
  remoteSource?: string;
  commandApproved?: boolean;
  actionApproved?: boolean;
}

export interface LatestRepairCandidate {
  attestation: Attestation;
  candidate: DeterministicRepairCandidate;
}

export interface RepairFileChange {
  path: string;
  before: string | null;
  after: string;
}

export interface RepairReceiptFileChange {
  path: string;
  beforeSha256: string | null;
  afterSha256: string;
  beforeContent: string | null;
  afterContent: string;
}

export interface RepairReceiptPrecondition {
  path: string;
  sha256: string;
}

interface AppliedRepair {
  id: string;
  kind: RepairKind;
  description: string;
  diff: string | null;
  patch: string | null;
  filesChanged: string[];
  fileChanges: RepairFileChange[];
  preconditions: { path: string; content: string }[];
  planDelta: string | null;
  envDelta: string | null;
  environment?: Record<string, string>;
  additionalPreparationCommands?: PreparationCommand[];
  mutationScope: RepairMutationScope;
  riskLevel: RepairRiskLevel;
  command?: RepairCommand;
}

interface RepairContext {
  sandbox: string;
  before: UpOutcome;
  failureClass: FailureClass;
}

interface LifecycleRepairCandidate {
  id: string;
  failureClass: FailureClass;
  action: RepairAction;
}

interface RegisteredRemediation {
  id: string;
  kind: RepairKind;
  apply: (context: RepairContext) => Promise<AppliedRepair | null>;
}

const LOCKFILE = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Gemfile\.lock|go\.sum)$/;
const ENV_EXAMPLE = /^\.env(?:\.[^/]+)?\.example$/;
const BOOTPROOF_FILE = /(^|\/)[^/]*\.bootproof\.[^/]+$/;

function normalizedRelative(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  if (path.isAbsolute(file) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`honesty contract violation: repair path escapes repository: ${file}`);
  }
  return normalized.replace(/^\.\//, "");
}

export function assertRepairTargetPath(repoPath: string, file: string): void {
  const repo = path.resolve(repoPath);
  const relative = normalizedRelative(file);
  let current = repo;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`honesty contract violation: repair target traverses symbolic link: ${relative}`);
    }
  }
}

function packageJsonOutsideAllowedKeys(value: string | null): unknown {
  if (value === null) return null;
  const parsed = JSON.parse(value);
  delete parsed.engines;
  delete parsed.packageManager;
  return parsed;
}

export function assertRepairScope(changes: RepairFileChange[]): void {
  for (const change of changes) {
    const file = normalizedRelative(change.path);
    const base = path.posix.basename(file);
    const allowed =
      file === "package.json" ||
      file === "config/database.yml" ||
      file === "config/gitlab.yml" ||
      LOCKFILE.test(base) ||
      BOOTPROOF_FILE.test(file) ||
      ENV_EXAMPLE.test(base) ||
      base === "docker-compose.bootproof.override.yml" ||
      file === "compose.bootproof.override.yml";
    if (!allowed) {
      throw new Error(`honesty contract violation: repair attempted to edit application file ${file}`);
    }
    if (file === "package.json") {
      if (change.before === null) {
        throw new Error("honesty contract violation: repair may not create package.json");
      }
      const before = JSON.stringify(packageJsonOutsideAllowedKeys(change.before));
      const after = JSON.stringify(packageJsonOutsideAllowedKeys(change.after));
      if (before !== after) {
        throw new Error("honesty contract violation: package.json repair exceeded engines/packageManager scope");
      }
    }
  }
}

function canonicalReceipt(receipt: RepairReceipt): Buffer {
  const { signature: _signature, signer: _signer, ...body } = receipt;
  return Buffer.from(JSON.stringify(body));
}

export function verifyRepairReceipt(receipt: RepairReceipt): boolean {
  if (!receipt.signature || !receipt.signer) return false;
  return verifyDetached(canonicalReceipt(receipt), receipt.signature, receipt.signer.publicKey);
}

export function evaluateRepairReceiptSignature(receipt: RepairReceipt): SignatureTrustResult {
  return evaluateDetachedSignature(
    canonicalReceipt(receipt),
    receipt.signature,
    receipt.signer?.publicKey,
  );
}

export function sha256Attestation(attestation: Attestation): string {
  return crypto.createHash("sha256").update(JSON.stringify(attestation)).digest("hex");
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function unifiedDiff(change: RepairFileChange): string {
  const file = normalizedRelative(change.path);
  const beforeLines = change.before === null ? [] : change.before.replace(/\n$/, "").split("\n");
  const afterLines = change.after.replace(/\n$/, "").split("\n");
  const oldPath = change.before === null ? "/dev/null" : `a/${file}`;
  return [
    `--- ${oldPath}`,
    `+++ b/${file}`,
    `@@ -${beforeLines.length ? `1,${beforeLines.length}` : "0,0"} +1,${afterLines.length} @@`,
    ...beforeLines.map(line => `-${line}`),
    ...afterLines.map(line => `+${line}`),
    "",
  ].join("\n");
}

function writeChanges(repo: string, changes: RepairFileChange[]): string {
  assertRepairScope(changes);
  for (const change of changes) {
    assertRepairTargetPath(repo, change.path);
    const target = path.join(repo, normalizedRelative(change.path));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, change.after);
  }
  return changes.map(unifiedDiff).join("");
}

function composePort(value: unknown): { host: number; container: number } | null {
  if (typeof value === "object" && value !== null) {
    const item = value as Record<string, unknown>;
    const host = Number(item.published);
    const container = Number(item.target);
    return Number.isInteger(host) && Number.isInteger(container) ? { host, container } : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\$\{[^}:]+:-?(\d+)\}/g, "$1").split("/")[0];
  const parts = normalized.split(":");
  if (parts.length < 2) return null;
  const host = Number(parts.at(-2));
  const container = Number(parts.at(-1));
  return Number.isInteger(host) && Number.isInteger(container) ? { host, container } : null;
}

function conflictingPort(evidence: string): number | null {
  const patterns = [
    /(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):(\d{2,5})/i,
    /\bport\s+(\d{2,5})\s+is already allocated\b/i,
    /\bBind for [^:\n]+:(\d{2,5}) failed\b/i,
  ];
  for (const pattern of patterns) {
    const match = evidence.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a free repair port"));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function composeMapping(repo: string, composeFile: string, hostPort: number): {
  service: string;
  containerPort: number;
} | null {
  try {
    const document = parse(fs.readFileSync(path.join(repo, composeFile), "utf8")) as {
      services?: Record<string, { ports?: unknown[] }>;
    };
    for (const [service, definition] of Object.entries(document.services ?? {})) {
      for (const value of Array.isArray(definition.ports) ? definition.ports : []) {
        const mapping = composePort(value);
        if (mapping?.host === hostPort) return { service, containerPort: mapping.container };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function remapComposePortValue(
  value: unknown,
  occupiedPort: number,
  replacementPort: number,
  containerPort: number,
): unknown {
  if (typeof value === "object" && value !== null) {
    const item = value as Record<string, unknown>;
    if (Number(item.published) !== occupiedPort || Number(item.target) !== containerPort) return value;
    return {
      ...item,
      published: typeof item.published === "string" ? String(replacementPort) : replacementPort,
    };
  }
  if (typeof value !== "string") return value;
  const protocol = value.includes("/") ? `/${value.split("/").at(-1)}` : "";
  const withoutProtocol = value.split("/")[0];
  const parts = withoutProtocol.split(":");
  if (parts.length < 2 || Number(parts.at(-2)) !== occupiedPort || Number(parts.at(-1)) !== containerPort) return value;
  parts[parts.length - 2] = String(replacementPort);
  return `${parts.join(":")}${protocol}`;
}

export function composePortRepair(
  source: string,
  service: string,
  occupiedPort: number,
  replacementPort: number,
  containerPort: number,
): string {
  const document = parse(source) as { services?: Record<string, { ports?: unknown[] }> };
  const definition = document.services?.[service];
  if (!definition || !Array.isArray(definition.ports)) {
    throw new Error(`could not find service ${service} ports in repository Compose file`);
  }
  let changed = false;
  definition.ports = definition.ports.map(value => {
    const remapped = remapComposePortValue(value, occupiedPort, replacementPort, containerPort);
    if (remapped !== value) changed = true;
    return remapped;
  });
  if (!changed) {
    throw new Error(`could not remap ${service} port ${occupiedPort}:${containerPort}`);
  }
  return [
    "# Generated by BootProof repair from the repository Compose file.",
    "# This complete repaired copy avoids version-specific Compose merge tags and leaves the source file untouched.",
    stringify(document).trimEnd(),
    "",
  ].join("\n");
}

async function remapConflictingServicePort(context: RepairContext): Promise<AppliedRepair | null> {
  const evidence = context.before.attestation?.result.failureEvidence ?? "";
  const occupied = conflictingPort(evidence);
  if (!occupied) return null;
  const repoCompose = context.before.inference.repoComposeFile;
  const composeFile = repoCompose ?? "docker-compose.bootproof.yml";
  const mapping = composeMapping(context.sandbox, composeFile, occupied);
  if (!mapping) return null;
  const replacement = await getFreePort();

  if (repoCompose) {
    const source = fs.readFileSync(path.join(context.sandbox, repoCompose), "utf8");
    const repairedCompose = composePortRepair(source, mapping.service, occupied, replacement, mapping.containerPort);
    const repairFile = repoComposeRepairFile(repoCompose);
    const change: RepairFileChange = { path: repairFile, before: null, after: repairedCompose };
    const patch = writeChanges(context.sandbox, [change]);
    const command = `docker compose -f ${repairFile} up -d`;
    return {
      id: "remap-conflicting-service-port",
      kind: "plan-step",
      description: `Remap ${mapping.service} host port ${occupied} to free port ${replacement} without editing ${repoCompose}.`,
      diff: null,
      patch,
      filesChanged: [repairFile],
      fileChanges: [change],
      preconditions: [{ path: repoCompose, content: source }],
      planDelta: `Create ${repairFile} as a complete repaired copy of ${repoCompose}. Use service step: ${command}`,
      envDelta: null,
      mutationScope: "repo_only",
      riskLevel: "low",
    };
  }

  const generatedPath = path.join(context.sandbox, composeFile);
  const before = fs.readFileSync(generatedPath, "utf8");
  const quotedMapping = new RegExp(`(["'])${occupied}:${mapping.containerPort}\\1`);
  if (!quotedMapping.test(before)) return null;
  const after = before
    .replace(
      "# Generated by bootproof — review before use. Standard compose; no bootproof runtime required.",
      `# Generated by bootproof — review before use. Standard compose; no bootproof runtime required.\n${REPAIRED_GENERATED_COMPOSE_MARKER}`,
    )
    .replace(quotedMapping, `"${replacement}:${mapping.containerPort}"`);
  const change: RepairFileChange = { path: composeFile, before, after };
  const diff = writeChanges(context.sandbox, [change]);
  return {
    id: "remap-conflicting-service-port",
    kind: "repo-diff",
    description: `Remap the BootProof-generated ${mapping.service} host port ${occupied} to free port ${replacement}.`,
    diff,
    patch: diff,
    filesChanged: [composeFile],
    fileChanges: [change],
    preconditions: [],
    planDelta: null,
    envDelta: null,
    mutationScope: "repo_only",
    riskLevel: "low",
  };
}

export function packageManagerActivationCommand(
  packageManager: PackageManager,
  version: string | null,
): string | null {
  if (packageManager === "unknown" || !version || !/^\d+(?:\.\d+){0,2}$/.test(version)) return null;
  return `corepack prepare ${packageManager}@${version} --activate`;
}

async function activatePackageManager(context: RepairContext): Promise<AppliedRepair | null> {
  const { packageManager, packageManagerVersion } = context.before.inference;
  const command = packageManagerActivationCommand(packageManager, packageManagerVersion);
  if (!command || !packageManagerVersion) return null;
  const corepackHome = path.join(context.sandbox, ".bootproof", "corepack");
  const environment = { COREPACK_HOME: corepackHome };
  const result = await runToCompletion(command, context.sandbox, 120_000, buildExecutionEnv(environment));
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`environment remediation failed: ${command}\n${result.stderr || result.stdout}`);
  }
  return {
    id: "activate-declared-package-manager",
    kind: "environment",
    description: `Activate the repository-declared ${packageManager} ${packageManagerVersion} in the repair sandbox.`,
    diff: null,
    patch: null,
    filesChanged: [],
    fileChanges: [],
    preconditions: [],
    planDelta: null,
    envDelta: command,
    environment,
    mutationScope: "project_cache",
    riskLevel: "medium",
    command: createRepairCommand("corepack", ["prepare", `${packageManager}@${packageManagerVersion}`, "--activate"]),
  };
}

export function prismaRepairCommand(repo: string): string {
  return fs.existsSync(path.join(repo, "prisma", "migrations"))
    ? "npx prisma migrate deploy"
    : "npx prisma db push --skip-generate";
}

export interface MigrationRepair {
  id: string;
  framework: "prisma" | "django" | "rails" | "knex" | "drizzle";
  command: string;
  source: string;
}

function readPackageJson(repo: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

function hasAnyFile(repo: string, files: string[]): string | null {
  return files.find(file => fs.existsSync(path.join(repo, file))) ?? null;
}

function structuredPlaybookCommand(command: string): RepairCommand {
  const [executable, ...args] = command.split(" ");
  return createRepairCommand(executable, args);
}

export function migrationRepairFor(repo: string, evidence: string): MigrationRepair | null {
  const pkg = readPackageJson(repo);
  const dependencies = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const pyproject = fs.existsSync(path.join(repo, "pyproject.toml"))
    ? fs.readFileSync(path.join(repo, "pyproject.toml"), "utf8")
    : "";
  const requirements = fs.existsSync(path.join(repo, "requirements.txt"))
    ? fs.readFileSync(path.join(repo, "requirements.txt"), "utf8")
    : "";
  const gemfile = fs.existsSync(path.join(repo, "Gemfile"))
    ? fs.readFileSync(path.join(repo, "Gemfile"), "utf8")
    : "";
  const genericSchemaEvidence = /(relation .* does not exist|no such table|Migration.*pending|unapplied migrations?)/i.test(evidence);
  const candidates: MigrationRepair[] = [];

  if (
    fs.existsSync(path.join(repo, "prisma", "schema.prisma")) &&
    (/\bprisma\b|\bP\d{4}\b/i.test(evidence) || genericSchemaEvidence)
  ) {
    const hasMigrations = fs.existsSync(path.join(repo, "prisma", "migrations"));
    candidates.push({
      id: hasMigrations ? "deploy-prisma-migrations" : "push-prisma-schema",
      framework: "prisma",
      command: prismaRepairCommand(repo),
      source: hasMigrations ? "prisma/schema.prisma and prisma/migrations" : "prisma/schema.prisma without migrations directory",
    });
  }
  if (
    fs.existsSync(path.join(repo, "manage.py")) &&
    /\bdjango\b/i.test(pyproject + requirements) &&
    (/\bdjango\b|unapplied migrations?/i.test(evidence) || genericSchemaEvidence)
  ) {
    candidates.push({
      id: "apply-django-migrations",
      framework: "django",
      command: "python manage.py migrate --noinput",
      source: "manage.py and declared Django dependency",
    });
  }
  if (
    fs.existsSync(path.join(repo, "bin", "rails")) &&
    /\b(?:rails|activerecord)\b/i.test(gemfile) &&
    (/\bActiveRecord\b|pending migration/i.test(evidence) || genericSchemaEvidence)
  ) {
    candidates.push({
      id: "apply-rails-migrations",
      framework: "rails",
      command: "bundle exec rails db:migrate",
      source: "bin/rails and Rails/ActiveRecord Gemfile entry",
    });
  }
  const knexFile = hasAnyFile(repo, ["knexfile.js", "knexfile.cjs", "knexfile.mjs", "knexfile.ts"]);
  if (
    knexFile &&
    dependencies.knex &&
    (/\bknex\b/i.test(evidence) || genericSchemaEvidence)
  ) {
    candidates.push({
      id: "apply-knex-migrations",
      framework: "knex",
      command: "npx knex migrate:latest",
      source: `${knexFile} and knex dependency`,
    });
  }
  const drizzleConfig = hasAnyFile(repo, ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs", "drizzle.config.cjs"]);
  if (
    drizzleConfig &&
    (dependencies["drizzle-kit"] || dependencies["drizzle-orm"]) &&
    (/\bdrizzle\b/i.test(evidence) || genericSchemaEvidence)
  ) {
    candidates.push({
      id: "apply-drizzle-migrations",
      framework: "drizzle",
      command: "npx drizzle-kit migrate",
      source: `${drizzleConfig} and Drizzle dependency`,
    });
  }

  return candidates.length === 1 ? candidates[0] : null;
}

async function deployFrameworkMigrations(context: RepairContext): Promise<AppliedRepair | null> {
  const evidence = context.before.attestation?.result.failureEvidence ?? "";
  const migration = migrationRepairFor(context.sandbox, evidence);
  if (!migration) return null;
  const preparation: PreparationCommand = {
    id: `repair-${migration.framework}-schema`,
    kind: "build",
    command: migration.command,
    description: `apply the repository's ${migration.framework} migrations before application start`,
    source: migration.source,
  };
  return {
    id: migration.id,
    kind: "plan-step",
    description: `Run the repository's ${migration.framework} migration command before application start.`,
    diff: null,
    patch: null,
    filesChanged: [],
    fileChanges: [],
    preconditions: [],
    planDelta: `Insert after dependency installation and before application start: ${migration.command}`,
    envDelta: null,
    additionalPreparationCommands: [preparation],
    mutationScope: "database",
    riskLevel: "high",
    command: structuredPlaybookCommand(migration.command),
  };
}

const REGISTRY: Partial<Record<FailureClass, RegisteredRemediation[]>> = {
  service_port_allocated: [{
    id: "remap-conflicting-service-port",
    kind: "plan-step",
    apply: remapConflictingServicePort,
  }],
  package_manager_version_mismatch: [{
    id: "activate-declared-package-manager",
    kind: "environment",
    apply: activatePackageManager,
  }],
  migrations_missing: [{
    id: "apply-framework-migrations",
    kind: "plan-step",
    apply: deployFrameworkMigrations,
  }],
};

export function registeredRemediationsFor(failureClass: FailureClass): { id: string; kind: RepairKind }[] {
  return (REGISTRY[failureClass] ?? []).map(remediation => ({
    id: remediation.id,
    kind: remediation.kind,
  }));
}

function copyToSandbox(repo: string): { root: string; sandbox: string; composeProjectName: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootproof-repair-"));
  const sandbox = path.join(root, "repo");
  fs.cpSync(repo, sandbox, {
    recursive: true,
    filter(source) {
      const relative = path.relative(repo, source);
      if (!relative) return true;
      const top = relative.split(path.sep)[0];
      return top !== ".git" && top !== ".bootproof";
    },
  });
  return {
    root,
    sandbox,
    composeProjectName: `bootproof_repair_${path.basename(root).replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()}`,
  };
}

function persistFailureAttestation(
  repo: string,
  source: Attestation,
  extraEvidence: string | null = null,
): Attestation {
  const failureEvidence = [source.result.failureEvidence, extraEvidence].filter(Boolean).join("\n\n");
  const attestation = buildAttestation({
    repo,
    plan: source.plan,
    observed: source.observed,
    startedAt: source.startedAt,
    booted: false,
    healthVerified: false,
    healthObservation: null,
    observedHealthCandidates: source.result.observedHealthCandidates,
    failureClass: source.result.failureClass,
    failureEvidence,
    explanation: source.result.explanation,
  });
  writeAttestation(repo, attestation);
  return attestation;
}

function proposedActionFor(applied: AppliedRepair) {
  if (applied.fileChanges.length) {
    const patch = applied.patch ?? applied.diff;
    if (!patch) throw new Error("repair file changes require an exact patch");
    return buildRepairAction({
      actionType: "patch",
      mutationScope: "repo_only",
      riskLevel: applied.riskLevel,
      patch: {
        format: "unified-diff",
        content: patch,
        files: applied.fileChanges.map(change => normalizedRelative(change.path)),
      },
      explanation: applied.description,
      evidenceRefs: [".bootproof/attestation.json"],
    });
  }
  if (applied.command) {
    return buildRepairAction({
      actionType: "command",
      mutationScope: applied.mutationScope,
      riskLevel: applied.riskLevel,
      command: applied.command,
      explanation: applied.description,
      evidenceRefs: [".bootproof/attestation.json"],
    });
  }
  return buildRepairAction({
    actionType: "instruction",
    mutationScope: "none",
    riskLevel: applied.riskLevel,
    instruction: applied.description,
    explanation: applied.description,
    evidenceRefs: [".bootproof/attestation.json"],
  });
}

function buildRepairReceipt(
  repo: string,
  before: Attestation,
  after: Attestation,
  applied: AppliedRepair,
  startedAt: string,
): RepairReceipt {
  if (
    before.result.booted ||
    before.result.healthVerified ||
    !before.result.failureClass ||
    !verifySignature(before)
  ) {
    throw new Error("repair receipt requires a signature-valid classified failed before attestation");
  }
  if (!after.result.booted || !after.result.healthVerified || !after.result.healthObservation) {
    throw new Error("repair receipt requires an observed healthy after attestation");
  }
  if (!verifySignature(after)) {
    throw new Error("repair receipt requires a signature-valid after attestation");
  }
  const beforeHash = sha256Attestation(before);
  const afterHash = sha256Attestation(after);
  const info = gitInfo(repo);
  const finishedAt = new Date().toISOString();
  const proposedAction = proposedActionFor(applied);
  const base = buildRepairReceiptBase({
    repairId: applied.id,
    createdAt: finishedAt,
    bootproofVersion: TOOL_ID.replace(/^bootproof@/, ""),
    beforeFailureClass: before.result.failureClass,
    beforeEvidenceHash: sha256Text(before.result.failureEvidence ?? ""),
    proposedAction,
    appliedAt: finishedAt,
    applyResult: {
      status: "applied",
      exitCode: 0,
      filesChanged: applied.filesChanged.map(normalizedRelative),
      evidence: null,
    },
    progressed: true,
    verified: true,
    explanation: applied.description,
    redactionsApplied: [],
  });
  const receipt: RepairReceipt = {
    ...base,
    tool: TOOL_ID,
    repo: { remote: info.remote, commit: info.commit, dirty: info.dirty },
    environment: { os: `${os.platform()} ${os.release()}`, arch: os.arch(), node: process.version },
    failure: { class: before.result.failureClass, beforeAttestationSha256: beforeHash },
    repair: {
      id: applied.id,
      kind: applied.kind,
      description: applied.description,
      diff: applied.kind === "repo-diff" ? applied.diff : null,
      filesChanged: applied.filesChanged,
      fileChanges: applied.fileChanges.map(change => ({
        path: normalizedRelative(change.path),
        beforeSha256: change.before === null ? null : sha256Text(change.before),
        afterSha256: sha256Text(change.after),
        beforeContent: change.before,
        afterContent: change.after,
      })),
      preconditions: applied.preconditions.map(precondition => ({
        path: normalizedRelative(precondition.path),
        sha256: sha256Text(precondition.content),
      })),
      planDelta: applied.kind === "plan-step" ? applied.planDelta : null,
      envDelta: applied.kind === "environment" ? applied.envDelta : null,
    },
    verification: {
      before: {
        booted: false,
        failureClass: before.result.failureClass,
        attestationSha256: beforeHash,
      },
      after: {
        booted: true,
        bootproofOrchestrated: true,
        healthObservation: after.result.healthObservation,
        attestationSha256: afterHash,
      },
    },
    startedAt,
    finishedAt,
    signer: null,
    signature: null,
  };
  const signed = signDetached(canonicalReceipt(receipt));
  receipt.signature = signed.signature;
  receipt.signer = { publicKey: signed.publicKeyPem, algorithm: "ed25519" };
  return receipt;
}

function receiptPath(repo: string): string {
  return path.join(repo, ".bootproof", "repair-receipt.json");
}

function afterAttestationPath(repo: string): string {
  return path.join(repo, ".bootproof", "repair-after-attestation.json");
}

function cleanPreviousRepairOutputs(repo: string): void {
  const output = path.join(repo, ".bootproof");
  if (!fs.existsSync(output)) return;
  for (const entry of fs.readdirSync(output)) {
    if (entry === "repair-receipt.json" || entry === "repair-after-attestation.json" || /^repair-.+\.patch$/.test(entry)) {
      fs.rmSync(path.join(output, entry), { force: true });
    }
  }
}

function freshFailedAttestation(repo: string, requestedProvider?: "docker" | "local"): Attestation | null {
  const attestation = signedFailedAttestation(repo, requestedProvider);
  if (!attestation) return null;
  const current = gitInfo(repo);
  const exactCleanCommit =
    current.commit !== null &&
    current.dirty === false &&
    attestation.repo.commit === current.commit &&
    attestation.repo.remote === current.remote &&
    attestation.repo.dirty === false;
  return exactCleanCommit ? attestation : null;
}

function signedFailedAttestation(repo: string, requestedProvider?: "docker" | "local"): Attestation | null {
  const file = attestationPath(repo);
  if (!fs.existsSync(file)) return null;
  try {
    const attestation = JSON.parse(fs.readFileSync(file, "utf8")) as Attestation;
    const sameProvider = requestedProvider === undefined || attestation.plan.provider === requestedProvider;
    const classifiedFailure =
      attestation.result.booted === false &&
      attestation.result.healthVerified === false &&
      attestation.result.failureClass !== null;
    return sameProvider && classifiedFailure && verifySignature(attestation)
      ? attestation
      : null;
  } catch {
    return null;
  }
}

export function latestDeterministicRepairCandidate(
  repoPath: string,
  requestedProvider?: "docker" | "local",
): LatestRepairCandidate | null {
  const repo = path.resolve(repoPath);
  const attestation = signedFailedAttestation(repo, requestedProvider);
  if (!attestation) return null;
  const candidate = deterministicRepairCandidateFor(attestation, { repoPath: repo });
  return candidate ? { attestation, candidate } : null;
}

export function latestFailedAttestation(
  repoPath: string,
  requestedProvider?: "docker" | "local",
): Attestation | null {
  return signedFailedAttestation(path.resolve(repoPath), requestedProvider);
}

interface StructuredRepairCommandResult {
  exitCode: number | null;
  evidence: string;
  redactionsApplied: string[];
}

async function runStructuredRepairCommand(
  command: RepairCommand,
  cwd: string,
  timeoutMs = 600_000,
): Promise<StructuredRepairCommandResult> {
  return await new Promise(resolve => {
    const child = spawn(command.executable, command.args, {
      cwd,
      shell: false,
      env: buildExecutionEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (exitCode: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const redacted = redactText(`${output}${extra}`.slice(-4000));
      resolve({
        exitCode,
        evidence: redacted.text,
        redactionsApplied: redacted.applied,
      });
    };
    const capture = (chunk: unknown) => {
      output = `${output}${String(chunk)}`.slice(-4000);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("close", code => finish(code));
    child.on("error", error => finish(null, `\n${error.message}`));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(null, "\nrepair command timed out");
    }, timeoutMs);
  });
}

function buildLifecycleRepairReceipt(input: {
  repo: string;
  before: Attestation;
  candidate: LifecycleRepairCandidate;
  createdAt: string;
  approvedAt?: string;
  appliedAt?: string;
  applyResult: RepairReceiptBase["applyResult"];
  after?: Attestation | null;
  explanation: string;
  redactionsApplied?: string[];
}): RepairReceipt {
  const after = input.after ?? null;
  const verified = Boolean(
    after?.result.healthVerified &&
    (after.result.booted || after.verificationMode === "external-health"),
  );
  const progressed = repairProgressed(input.candidate.failureClass, after);
  const info = gitInfo(input.repo);
  const redactedRemote = redactText(info.remote ?? "");
  const redactionsApplied = [...new Set([
    ...(input.redactionsApplied ?? []),
    ...redactedRemote.applied,
  ])];
  const base = buildRepairReceiptBase({
    repairId: input.candidate.id,
    createdAt: input.createdAt,
    bootproofVersion: TOOL_ID.replace(/^bootproof@/, ""),
    beforeFailureClass: input.candidate.failureClass,
    beforeEvidenceHash: sha256Text(input.before.result.failureEvidence ?? ""),
    proposedAction: input.candidate.action,
    ...(input.approvedAt ? { approvedAt: input.approvedAt } : {}),
    ...(input.appliedAt ? { appliedAt: input.appliedAt } : {}),
    applyResult: input.applyResult,
    ...(after?.result.failureClass ? { afterFailureClass: after.result.failureClass } : {}),
    progressed,
    verified,
    explanation: input.explanation,
    redactionsApplied,
  });
  const receipt: RepairReceipt = {
    ...base,
    tool: TOOL_ID,
    repo: {
      remote: info.remote === null ? null : redactedRemote.text,
      commit: info.commit,
      dirty: info.dirty,
    },
    environment: { os: `${os.platform()} ${os.release()}`, arch: os.arch(), node: process.version },
    failure: {
      class: input.candidate.failureClass,
      beforeAttestationSha256: sha256Attestation(input.before),
    },
    startedAt: input.createdAt,
    finishedAt: new Date().toISOString(),
    ...(verified && after?.result.healthObservation
      ? {
          verification: {
            before: {
              booted: false,
              failureClass: input.candidate.failureClass,
              attestationSha256: sha256Attestation(input.before),
            },
            after: {
              booted: after.result.booted,
              bootproofOrchestrated: after.bootproofOrchestrated,
              healthObservation: after.result.healthObservation,
              attestationSha256: sha256Attestation(after),
            },
          },
        }
      : {}),
    signer: null,
    signature: null,
  };
  const signed = signDetached(canonicalReceipt(receipt));
  receipt.signature = signed.signature;
  receipt.signer = { publicKey: signed.publicKeyPem, algorithm: "ed25519" };
  return receipt;
}

function writeLifecycleRepairReceipt(repo: string, receipt: RepairReceipt): string {
  const file = receiptPath(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
  return file;
}

async function executeDeterministicRepairCandidate(
  repo: string,
  before: Attestation,
  candidate: DeterministicRepairCandidate,
  options: RepairOptions,
): Promise<RepairResult> {
  const startedAt = new Date().toISOString();
  cleanPreviousRepairOutputs(repo);
  const result = (
    receipt: RepairReceipt,
    explanation: string,
    afterFile: string | null = null,
    patchFile: string | null = null,
  ): RepairResult => {
    const receiptFile = writeLifecycleRepairReceipt(repo, receipt);
    return {
      schema: "bootproof/repair-result/v1",
      repaired: receipt.verified,
      failureClass: candidate.failureClass,
      repairId: candidate.id,
      receiptPath: relativeOutput(repo, receiptFile),
      patchPath: relativeOutput(repo, patchFile),
      afterAttestationPath: relativeOutput(repo, afterFile),
      explanation,
    };
  };

  const safetyErrors = [candidate.action, ...(candidate.followUpActions ?? [])]
    .flatMap(action => validateRepairAction(action).errors);
  if (safetyErrors.length) {
    const explanation = `Deterministic repair candidate was blocked by the safety validator: ${[...new Set(safetyErrors)].join("; ")}`;
    return result(buildLifecycleRepairReceipt({
      repo,
      before,
      candidate,
      createdAt: startedAt,
      applyResult: { status: "failed", exitCode: null, filesChanged: [], evidence: explanation },
      explanation,
    }), explanation);
  }

  const provider = options.provider ?? before.plan.provider;
  if (candidate.action.actionType === "instruction") {
    const explanation = `Deterministic instruction recorded: ${candidate.action.instruction}`;
    return result(buildLifecycleRepairReceipt({
      repo,
      before,
      candidate,
      createdAt: startedAt,
      applyResult: { status: "not_applied", exitCode: null, filesChanged: [], evidence: null },
      explanation,
    }), explanation);
  }

  if (candidate.action.actionType === "patch") {
    const patch = candidate.action.patch;
    if (!patch || !candidate.fileChanges?.length) {
      throw new Error("validated patch repair is missing its exact file changes");
    }
    const patchFile = path.join(repo, ".bootproof", `repair-${candidate.id}.patch`);
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(patchFile, patch.content);
    if (provider === "local" && !options.unsafeLocal) {
      const explanation = "The repair patch was not tested because the required BootProof rerun would execute repository code locally; rerun with --unsafe-local after review.";
      return result(buildLifecycleRepairReceipt({
        repo,
        before,
        candidate,
        createdAt: startedAt,
        applyResult: { status: "not_applied", exitCode: null, filesChanged: [], evidence: null },
        explanation,
      }), explanation, null, patchFile);
    }
    if (options.actionApproved !== true) {
      const explanation = "Repair patch was not approved. The working tree was not modified.";
      return result(buildLifecycleRepairReceipt({
        repo,
        before,
        candidate,
        createdAt: startedAt,
        applyResult: { status: "not_applied", exitCode: null, filesChanged: [], evidence: null },
        explanation,
      }), explanation, null, patchFile);
    }

    const approvedAt = new Date().toISOString();
    const { root, sandbox, composeProjectName } = copyToSandbox(repo);
    let patchApplied = false;
    let afterOutcome: UpOutcome | null = null;
    let rerunError = "";
    try {
      for (const change of candidate.fileChanges) {
        const target = path.join(sandbox, normalizedRelative(change.path));
        const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
        if (current !== change.before) {
          throw new Error(`repair patch preimage changed for ${change.path}`);
        }
      }
      writeChanges(sandbox, candidate.fileChanges);
      patchApplied = true;
      afterOutcome = await up(sandbox, {
        provider,
        unsafeLocal: options.unsafeLocal,
        dryRun: false,
        timeoutMs: options.timeoutMs,
        install: true,
        port: options.port,
        remoteSource: options.remoteSource,
        environment: { COMPOSE_PROJECT_NAME: composeProjectName },
      });
    } catch (error) {
      rerunError = error instanceof Error ? error.message : String(error);
    } finally {
      await cleanupServices(afterOutcome, buildExecutionEnv({ COMPOSE_PROJECT_NAME: composeProjectName }));
      fs.rmSync(root, { recursive: true, force: true });
    }

    const after = afterOutcome?.attestation ?? null;
    let afterFile: string | null = null;
    if (after) {
      afterFile = afterAttestationPath(repo);
      fs.mkdirSync(path.dirname(afterFile), { recursive: true });
      fs.writeFileSync(afterFile, JSON.stringify(after, null, 2) + "\n");
    }
    const verified = Boolean(after?.result.booted && after.result.healthVerified);
    const progressed = repairProgressed(candidate.failureClass, after);
    const redactedError = redactText(rerunError);
    const explanation = !patchApplied
      ? `Repair patch could not be applied in the sandbox: ${redactedError.text || "unknown failure"}.`
      : verified
        ? `Repair patch was tested in the sandbox and BootProof observed verified health: ${after!.result.healthObservation}.`
        : progressed
          ? `Repair patch was tested in the sandbox; BootProof progressed from ${candidate.failureClass} to ${after!.result.failureClass}.`
          : "Repair patch was tested in the sandbox, but the BootProof rerun did not verify boot or reach a different failure class.";
    return result(buildLifecycleRepairReceipt({
      repo,
      before,
      candidate,
      createdAt: startedAt,
      approvedAt,
      ...(patchApplied ? { appliedAt: new Date().toISOString() } : {}),
      applyResult: {
        status: patchApplied ? "applied" : "failed",
        exitCode: patchApplied ? 0 : null,
        filesChanged: patchApplied ? candidate.fileChanges.map(change => change.path) : [],
        evidence: redactedError.text || null,
      },
      after,
      explanation,
      redactionsApplied: redactedError.applied,
    }), explanation, afterFile, patchFile);
  }

  const command = candidate.action.command;
  if (!command) throw new Error("validated command repair is missing its exact command");
  if (provider === "local" && !options.unsafeLocal) {
    const explanation = "The repair command was not run because the required BootProof rerun would execute repository code locally; rerun with --unsafe-local after review.";
    return result(buildLifecycleRepairReceipt({
      repo,
      before,
      candidate,
      createdAt: startedAt,
      applyResult: { status: "not_applied", exitCode: null, filesChanged: [], evidence: null },
      explanation,
    }), explanation);
  }
  if (options.actionApproved !== true && options.commandApproved !== true) {
    const explanation = "Repair command was not approved. No command was executed.";
    return result(buildLifecycleRepairReceipt({
      repo,
      before,
      candidate,
      createdAt: startedAt,
      applyResult: { status: "not_applied", exitCode: null, filesChanged: [], evidence: null },
      explanation,
    }), explanation);
  }

  const approvedAt = new Date().toISOString();
  const commandResult = await runStructuredRepairCommand(command, repo);
  const { root, sandbox, composeProjectName } = copyToSandbox(repo);
  let afterOutcome: UpOutcome | null = null;
  let rerunError = "";
  try {
    afterOutcome = await up(sandbox, {
      provider,
      unsafeLocal: options.unsafeLocal,
      dryRun: false,
      timeoutMs: options.timeoutMs,
      install: true,
      port: options.port,
      remoteSource: options.remoteSource,
      environment: { COMPOSE_PROJECT_NAME: composeProjectName },
    });
  } catch (error) {
    rerunError = error instanceof Error ? error.message : String(error);
  } finally {
    await cleanupServices(afterOutcome, buildExecutionEnv({ COMPOSE_PROJECT_NAME: composeProjectName }));
    fs.rmSync(root, { recursive: true, force: true });
  }

  const after = afterOutcome?.attestation ?? null;
  let afterFile: string | null = null;
  if (after) {
    afterFile = afterAttestationPath(repo);
    fs.mkdirSync(path.dirname(afterFile), { recursive: true });
    fs.writeFileSync(afterFile, JSON.stringify(after, null, 2) + "\n");
  }
  const commandApplied = commandResult.exitCode === 0;
  const verified = Boolean(after?.result.booted && after.result.healthVerified);
  const progressed = repairProgressed(candidate.failureClass, after);
  const redactedEvidence = redactText([commandResult.evidence, rerunError].filter(Boolean).join("\n"));
  const explanation = verified
    ? commandApplied
      ? `Repair command applied and BootProof observed verified health: ${after!.result.healthObservation}.`
      : `Repair command failed with exit ${commandResult.exitCode ?? "unknown"}, but the BootProof rerun observed verified health: ${after!.result.healthObservation}.`
    : progressed
      ? commandApplied
        ? `Repair command applied; BootProof progressed from ${candidate.failureClass} to ${after!.result.failureClass}.`
        : `Repair command failed with exit ${commandResult.exitCode ?? "unknown"}, but BootProof progressed from ${candidate.failureClass} to ${after!.result.failureClass}.`
      : commandApplied
        ? "Repair command completed, but the BootProof rerun did not verify boot or reach a different failure class."
        : `Repair command failed with exit ${commandResult.exitCode ?? "unknown"}; the BootProof rerun did not verify boot or reach a different failure class.`;
  const receipt = buildLifecycleRepairReceipt({
    repo,
    before,
    candidate,
    createdAt: startedAt,
    approvedAt,
    ...(commandApplied ? { appliedAt: new Date().toISOString() } : {}),
    applyResult: {
      status: commandApplied ? "applied" : "failed",
      exitCode: commandResult.exitCode,
      filesChanged: [],
      evidence: redactedEvidence.text || null,
    },
    after,
    explanation,
    redactionsApplied: [...new Set([
      ...commandResult.redactionsApplied,
      ...redactedEvidence.applied,
    ])],
  });
  return result(receipt, explanation, afterFile);
}

function verifiedAfterRepair(attestation: Attestation | null): boolean {
  return Boolean(
    attestation?.result.healthVerified &&
    (attestation.result.booted || attestation.verificationMode === "external-health"),
  );
}

function writeRepairAfterAttestation(repo: string, attestation: Attestation | null): string | null {
  if (!attestation) return null;
  const file = afterAttestationPath(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(attestation, null, 2) + "\n");
  return file;
}

async function rerunAfterAiRepair(
  sandbox: string,
  before: Attestation,
  provider: "docker" | "local",
  options: RepairOptions,
  composeProjectName: string,
): Promise<{ after: Attestation | null; outcome: UpOutcome | null; error: string }> {
  try {
    if (before.verificationMode === "external-health" && before.externalHealthUrl) {
      const after = await buildExternalHealthAttestation(
        sandbox,
        before.externalHealthUrl,
        options.timeoutMs,
      );
      return { after, outcome: null, error: "" };
    }
    const outcome = await up(sandbox, {
      provider,
      unsafeLocal: options.unsafeLocal,
      dryRun: false,
      timeoutMs: options.timeoutMs,
      install: true,
      port: options.port,
      remoteSource: options.remoteSource,
      environment: { COMPOSE_PROJECT_NAME: composeProjectName },
    });
    return { after: outcome.attestation, outcome, error: "" };
  } catch (error) {
    return {
      after: null,
      outcome: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function executeAiSuggestedRepair(
  repoPath: string,
  before: Attestation,
  action: RepairAction,
  options: RepairOptions,
): Promise<RepairResult> {
  const repo = path.resolve(repoPath);
  const startedAt = new Date().toISOString();
  const failureClass = before.result.failureClass;
  if (!failureClass || before.result.healthVerified || before.result.booted || !verifySignature(before)) {
    throw new Error("AI repair requires a signature-valid classified failed attestation.");
  }
  if (action.source !== "ai_suggested" || action.deterministic) {
    throw new Error("AI repair execution requires an ai_suggested action.");
  }
  const validation = validateRepairAction(action);
  if (!validation.valid) {
    throw new Error(`AI suggestion was blocked by BootProof safety policy: ${validation.errors.join("; ")}`);
  }

  cleanPreviousRepairOutputs(repo);
  const candidate: LifecycleRepairCandidate = {
    id: `ai-suggested-${failureClass}-${sha256Text(JSON.stringify(action)).slice(0, 12)}`,
    failureClass,
    action,
  };
  const result = (
    receipt: RepairReceipt,
    explanation: string,
    afterFile: string | null = null,
    patchFile: string | null = null,
  ): RepairResult => {
    const receiptFile = writeLifecycleRepairReceipt(repo, receipt);
    return {
      schema: "bootproof/repair-result/v1",
      repaired: receipt.verified,
      failureClass,
      repairId: candidate.id,
      receiptPath: relativeOutput(repo, receiptFile),
      patchPath: relativeOutput(repo, patchFile),
      afterAttestationPath: relativeOutput(repo, afterFile),
      explanation,
    };
  };
  const receiptFor = (input: Omit<Parameters<typeof buildLifecycleRepairReceipt>[0], "repo" | "before" | "candidate" | "createdAt">) =>
    buildLifecycleRepairReceipt({
      repo,
      before,
      candidate,
      createdAt: startedAt,
      ...input,
    });
  const provider = options.provider ?? before.plan.provider;
  const localRerunRequiresAcknowledgement =
    before.verificationMode !== "external-health" &&
    provider === "local" &&
    !options.unsafeLocal;

  if (action.actionType === "instruction") {
    const approved = options.actionApproved === true;
    const explanation = approved
      ? `AI-suggested instruction was approved for manual use but was not executed: ${action.instruction}`
      : "AI-suggested instruction was not approved. No command or patch was executed.";
    return result(receiptFor({
      ...(approved ? { approvedAt: new Date().toISOString() } : {}),
      applyResult: { status: "not_applied", exitCode: null, filesChanged: [], evidence: null },
      explanation,
      redactionsApplied: [],
    }), explanation);
  }

  if (action.actionType === "patch") {
    const patch = action.patch;
    if (!patch) throw new Error("validated AI patch suggestion is missing its exact patch");
    const patchFile = path.join(repo, ".bootproof", `repair-${candidate.id}.patch`);
    if (localRerunRequiresAcknowledgement) {
      const explanation = "The AI-suggested patch was not tested because the required BootProof rerun would execute repository code locally; rerun with --unsafe-local after review.";
      return result(receiptFor({
        applyResult: { status: "not_applied", exitCode: null, filesChanged: [], evidence: null },
        explanation,
        redactionsApplied: [],
      }), explanation);
    }
    if (options.actionApproved !== true) {
      const explanation = "AI-suggested patch was not approved. The working tree was not modified.";
      return result(receiptFor({
        applyResult: { status: "not_applied", exitCode: null, filesChanged: [], evidence: null },
        explanation,
        redactionsApplied: [],
      }), explanation);
    }

    const approvedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(patchFile, patch.content);
    const { root, sandbox, composeProjectName } = copyToSandbox(repo);
    const sandboxPatch = path.join(root, "ai-suggested.patch");
    fs.writeFileSync(sandboxPatch, patch.content);
    let patchResult: StructuredRepairCommandResult = {
      exitCode: null,
      evidence: "",
      redactionsApplied: [],
    };
    let after: Attestation | null = null;
    let outcome: UpOutcome | null = null;
    let rerunError = "";
    try {
      for (const file of patch.files) assertRepairTargetPath(sandbox, file);
      const check = await runStructuredRepairCommand(
        createRepairCommand("git", ["apply", "--check", sandboxPatch]),
        sandbox,
      );
      patchResult = check.exitCode === 0
        ? await runStructuredRepairCommand(createRepairCommand("git", ["apply", sandboxPatch]), sandbox)
        : check;
      if (patchResult.exitCode === 0) {
        const rerun = await rerunAfterAiRepair(sandbox, before, provider, options, composeProjectName);
        after = rerun.after;
        outcome = rerun.outcome;
        rerunError = rerun.error;
      }
    } catch (error) {
      rerunError = error instanceof Error ? error.message : String(error);
    } finally {
      await cleanupServices(outcome, buildExecutionEnv({ COMPOSE_PROJECT_NAME: composeProjectName }));
      fs.rmSync(root, { recursive: true, force: true });
    }
    const afterFile = writeRepairAfterAttestation(repo, after);
    const patchApplied = patchResult.exitCode === 0;
    const progressed = repairProgressed(failureClass, after);
    const redacted = redactText([patchResult.evidence, rerunError].filter(Boolean).join("\n"));
    const explanation = verifiedAfterRepair(after)
      ? `AI-suggested patch was tested in a sandbox and BootProof independently verified health: ${after!.result.healthObservation}.`
      : progressed
        ? `AI-suggested patch was tested in a sandbox; BootProof progressed from ${failureClass} to ${after!.result.failureClass}.`
        : patchApplied
          ? "AI-suggested patch was tested in a sandbox, but BootProof did not verify boot or reach a different failure class."
          : `AI-suggested patch was blocked or failed in the sandbox: ${redacted.text || "git apply failed"}.`;
    return result(receiptFor({
      approvedAt,
      ...(patchApplied ? { appliedAt: new Date().toISOString() } : {}),
      applyResult: {
        status: patchApplied ? "applied" : "failed",
        exitCode: patchResult.exitCode,
        filesChanged: patchApplied ? patch.files : [],
        evidence: redacted.text || null,
      },
      after,
      explanation,
      redactionsApplied: [...new Set([...patchResult.redactionsApplied, ...redacted.applied])],
    }), explanation, afterFile, patchFile);
  }

  const command = action.command;
  if (!command) throw new Error("validated AI command suggestion is missing its exact command");
  if (localRerunRequiresAcknowledgement) {
    const explanation = "The AI-suggested command was not run because the required BootProof rerun would execute repository code locally; rerun with --unsafe-local after review.";
    return result(receiptFor({
      applyResult: { status: "not_applied", exitCode: null, filesChanged: [], evidence: null },
      explanation,
      redactionsApplied: [],
    }), explanation);
  }
  if (options.actionApproved !== true) {
    const explanation = "AI-suggested command was not approved. No command was executed.";
    return result(receiptFor({
      applyResult: { status: "not_applied", exitCode: null, filesChanged: [], evidence: null },
      explanation,
      redactionsApplied: [],
    }), explanation);
  }

  const approvedAt = new Date().toISOString();
  const commandResult = await runStructuredRepairCommand(command, repo);
  const { root, sandbox, composeProjectName } = copyToSandbox(repo);
  let after: Attestation | null = null;
  let outcome: UpOutcome | null = null;
  let rerunError = "";
  try {
    const rerun = await rerunAfterAiRepair(sandbox, before, provider, options, composeProjectName);
    after = rerun.after;
    outcome = rerun.outcome;
    rerunError = rerun.error;
  } finally {
    await cleanupServices(outcome, buildExecutionEnv({ COMPOSE_PROJECT_NAME: composeProjectName }));
    fs.rmSync(root, { recursive: true, force: true });
  }
  const afterFile = writeRepairAfterAttestation(repo, after);
  const commandApplied = commandResult.exitCode === 0;
  const progressed = repairProgressed(failureClass, after);
  const redacted = redactText([commandResult.evidence, rerunError].filter(Boolean).join("\n"));
  const explanation = verifiedAfterRepair(after)
    ? commandApplied
      ? `AI-suggested command completed and BootProof independently verified health: ${after!.result.healthObservation}.`
      : `AI-suggested command failed with exit ${commandResult.exitCode ?? "unknown"}, but BootProof independently verified health: ${after!.result.healthObservation}.`
    : progressed
      ? `AI-suggested command ${commandApplied ? "completed" : "failed"}; BootProof progressed from ${failureClass} to ${after!.result.failureClass}.`
      : commandApplied
        ? "AI-suggested command completed, but BootProof did not verify boot or reach a different failure class."
        : `AI-suggested command failed with exit ${commandResult.exitCode ?? "unknown"}; BootProof did not verify boot or reach a different failure class.`;
  return result(receiptFor({
    approvedAt,
    ...(commandApplied ? { appliedAt: new Date().toISOString() } : {}),
    applyResult: {
      status: commandApplied ? "applied" : "failed",
      exitCode: commandResult.exitCode,
      filesChanged: [],
      evidence: redacted.text || null,
    },
    after,
    explanation,
    redactionsApplied: [...new Set([...commandResult.redactionsApplied, ...redacted.applied])],
  }), explanation, afterFile);
}

async function cleanupServices(outcome: UpOutcome | null, env: NodeJS.ProcessEnv): Promise<void> {
  if (!outcome) return;
  const service = outcome?.plan.steps.find(step => step.kind === "service" && step.command?.includes("docker compose"));
  if (!service?.command) return;
  const down = service.command.replace(/\s+up\s+-d(?:\s.*)?$/, " down --remove-orphans");
  if (down === service.command) return;
  await runToCompletion(down, outcome.inference.repoPath, 60_000, env);
}

function relativeOutput(repo: string, target: string | null): string | null {
  return target ? path.relative(repo, target).replace(/\\/g, "/") : null;
}

export function applyVerifiedRepair(
  repoPath: string,
  receiptFile = path.join(repoPath, ".bootproof", "repair-receipt.json"),
): RepairApplyResult {
  const repo = path.resolve(repoPath);
  const resolvedReceipt = path.resolve(receiptFile);
  const displayReceipt = path.relative(repo, resolvedReceipt).replace(/\\/g, "/");
  const fail = (explanation: string): RepairApplyResult => ({
    schema: "bootproof/repair-apply-result/v1",
    applied: false,
    receiptPath: displayReceipt,
    filesChanged: [],
    explanation,
  });

  if (!fs.existsSync(resolvedReceipt)) return fail(`no repair receipt at ${displayReceipt}`);
  let receipt: RepairReceipt;
  try {
    receipt = JSON.parse(fs.readFileSync(resolvedReceipt, "utf8")) as RepairReceipt;
  } catch (error) {
    return fail(`could not parse repair receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (receipt.schema !== "bootproof/repair-receipt/v1" || !verifyRepairReceipt(receipt)) {
    return fail("repair receipt signature is invalid; no files were written");
  }
  if (!receipt.verified) {
    return fail("repair receipt is not verified; no repository files were written");
  }
  if (!receipt.repair) {
    return fail("repair receipt contains no verified repository file changes to apply");
  }
  const changes = receipt.repair.fileChanges;
  if (!Array.isArray(changes) || changes.length === 0) {
    return fail("verified repair has no repository file changes to apply");
  }
  const manifestPaths = changes.map(change => normalizedRelative(change.path));
  if (
    new Set(manifestPaths).size !== manifestPaths.length ||
    [...manifestPaths].sort().join("\n") !== [...receipt.repair.filesChanged].map(normalizedRelative).sort().join("\n")
  ) {
    return fail("repair receipt file manifest is inconsistent; no files were written");
  }

  const scopeChanges: RepairFileChange[] = [];
  for (const change of changes) {
    if ((change.beforeContent === null) !== (change.beforeSha256 === null)) {
      return fail(`signed preimage metadata is inconsistent for ${change.path}; no files were written`);
    }
    if (sha256Text(change.afterContent) !== change.afterSha256) {
      return fail(`signed after-content hash does not match for ${change.path}; no files were written`);
    }
    if (
      change.beforeContent !== null &&
      sha256Text(change.beforeContent) !== change.beforeSha256
    ) {
      return fail(`signed before-content hash does not match for ${change.path}; no files were written`);
    }
    scopeChanges.push({ path: change.path, before: change.beforeContent, after: change.afterContent });
  }
  try {
    assertRepairScope(scopeChanges);
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}; no files were written`);
  }

  const preconditions = receipt.repair.preconditions;
  if (!Array.isArray(preconditions)) {
    return fail("repair receipt prerequisites are malformed; no files were written");
  }
  for (const precondition of preconditions) {
    const relative = normalizedRelative(precondition.path);
    try {
      assertRepairTargetPath(repo, relative);
    } catch (error) {
      return fail(`${error instanceof Error ? error.message : String(error)}; no files were written`);
    }
    const target = path.join(repo, relative);
    if (!fs.existsSync(target) || sha256Text(fs.readFileSync(target, "utf8")) !== precondition.sha256) {
      return fail(`prerequisite mismatch for ${relative}; the repair inputs changed after verification, so no files were written`);
    }
  }

  for (const change of changes) {
    const target = path.join(repo, normalizedRelative(change.path));
    try {
      assertRepairTargetPath(repo, change.path);
    } catch (error) {
      return fail(`${error instanceof Error ? error.message : String(error)}; no files were written`);
    }
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    const currentHash = current === null ? null : sha256Text(current);
    if (currentHash !== change.beforeSha256) {
      return fail(`preimage mismatch for ${change.path}; the working tree changed after verification, so no files were written`);
    }
  }

  const written: RepairReceiptFileChange[] = [];
  try {
    for (const change of changes) {
      const target = path.join(repo, normalizedRelative(change.path));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, change.afterContent);
      written.push(change);
    }
    for (const change of changes) {
      const target = path.join(repo, normalizedRelative(change.path));
      if (sha256Text(fs.readFileSync(target, "utf8")) !== change.afterSha256) {
        throw new Error(`post-write hash mismatch for ${change.path}`);
      }
    }
  } catch (error) {
    for (const change of written.reverse()) {
      const target = path.join(repo, normalizedRelative(change.path));
      if (change.beforeContent === null) fs.rmSync(target, { force: true });
      else fs.writeFileSync(target, change.beforeContent);
    }
    return fail(`${error instanceof Error ? error.message : String(error)}; writes were rolled back`);
  }

  return {
    schema: "bootproof/repair-apply-result/v1",
    applied: true,
    receiptPath: displayReceipt,
    filesChanged: manifestPaths,
    explanation: `applied the signature-valid verified repair to ${manifestPaths.join(", ")}`,
  };
}

export async function repairRepo(repoPath: string, options: RepairOptions): Promise<RepairResult> {
  const repo = path.resolve(repoPath);
  const startedAt = new Date().toISOString();
  const existingBefore = signedFailedAttestation(repo, options.provider);
  const freshBefore = freshFailedAttestation(repo, options.provider);
  const provider = options.provider ?? existingBefore?.plan.provider ?? "docker";
  if (existingBefore) {
    const candidate = deterministicRepairCandidateFor(existingBefore, { repoPath: repo });
    if (candidate) {
      return await executeDeterministicRepairCandidate(repo, existingBefore, candidate, options);
    }
    if (!(REGISTRY[existingBefore.result.failureClass!] ?? []).length) {
      const failureClass = existingBefore.result.failureClass!;
      return {
        schema: "bootproof/repair-result/v1",
        repaired: false,
        failureClass,
        repairId: null,
        receiptPath: null,
        patchPath: null,
        afterAttestationPath: null,
        explanation: `No verified deterministic remediation is known for ${failureClass} yet.`,
      };
    }
  }
  if (provider === "local" && !options.unsafeLocal) {
    return {
      schema: "bootproof/repair-result/v1",
      repaired: false,
      failureClass: existingBefore?.result.failureClass ?? null,
      repairId: null,
      receiptPath: null,
      patchPath: null,
      afterAttestationPath: null,
      explanation: "local repair verification executes repository code in a sandbox on this host; rerun with --unsafe-local to acknowledge it",
    };
  }
  cleanPreviousRepairOutputs(repo);
  const { root, sandbox, composeProjectName } = copyToSandbox(repo);
  let lastOutcome: UpOutcome | null = null;
  const baseOptions: UpOptions = {
    provider,
    unsafeLocal: options.unsafeLocal,
    dryRun: false,
    timeoutMs: options.timeoutMs,
    install: true,
    port: options.port,
    remoteSource: options.remoteSource,
    environment: { COMPOSE_PROJECT_NAME: composeProjectName },
  };

  try {
    const beforeOutcome: UpOutcome = freshBefore
      ? {
          inference: inferRepo(sandbox),
          plan: freshBefore.plan,
          attestation: freshBefore,
          refusal: null,
          writtenFiles: [],
        }
      : await up(sandbox, baseOptions);
    lastOutcome = freshBefore ? null : beforeOutcome;
    const sandboxBefore = beforeOutcome.attestation;
    if (!sandboxBefore) throw new Error("repair baseline did not produce an attestation");
    if (sandboxBefore.result.booted || sandboxBefore.result.healthVerified) {
      return {
        schema: "bootproof/repair-result/v1",
        repaired: false,
        failureClass: null,
        repairId: null,
        receiptPath: null,
        patchPath: null,
        afterAttestationPath: null,
        explanation: "repository already boots with observed HTTP health; no repair receipt was produced",
      };
    }
    const failureClass = sandboxBefore.result.failureClass;
    if (!failureClass) throw new Error("repair baseline failed without a failure class");
    const before = freshBefore ?? persistFailureAttestation(repo, sandboxBefore);
    const remediations = REGISTRY[failureClass] ?? [];
    if (!remediations.length) {
      return {
        schema: "bootproof/repair-result/v1",
        repaired: false,
        failureClass,
        repairId: null,
        receiptPath: null,
        patchPath: null,
        afterAttestationPath: null,
        explanation: `No verified deterministic remediation is known for ${failureClass} yet.`,
      };
    }

    let attemptedId: string | null = null;
    let attemptEvidence = "";
    for (const remediation of remediations) {
      attemptedId = remediation.id;
      let applied: AppliedRepair | null;
      try {
        applied = await remediation.apply({ sandbox, before: beforeOutcome, failureClass });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/^honesty contract violation:/.test(message)) throw error;
        attemptEvidence = `Repair attempt ${remediation.id} failed before verification:\n${message}`;
        break;
      }
      if (!applied) continue;

      const afterOptions: UpOptions = {
        ...baseOptions,
        environment: {
          COMPOSE_PROJECT_NAME: composeProjectName,
          ...applied.environment,
        },
        additionalPreparationCommands: applied.additionalPreparationCommands,
      };
      const afterOutcome = await up(sandbox, afterOptions);
      lastOutcome = afterOutcome;
      const after = afterOutcome.attestation;
      if (after?.result.booted === true && after.result.healthVerified === true && after.result.healthObservation) {
        assertRepairScope(applied.fileChanges);
        const receipt = buildRepairReceipt(repo, before, after, applied, startedAt);
        const output = path.join(repo, ".bootproof");
        fs.mkdirSync(output, { recursive: true });
        const receiptFile = receiptPath(repo);
        const afterFile = afterAttestationPath(repo);
        fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
        fs.writeFileSync(afterFile, JSON.stringify(after, null, 2) + "\n");
        let patchFile: string | null = null;
        if (applied.patch) {
          patchFile = path.join(output, `repair-${applied.id}.patch`);
          fs.writeFileSync(patchFile, applied.patch);
        }
        return {
          schema: "bootproof/repair-result/v1",
          repaired: true,
          failureClass,
          repairId: applied.id,
          receiptPath: relativeOutput(repo, receiptFile),
          patchPath: relativeOutput(repo, patchFile),
          afterAttestationPath: relativeOutput(repo, afterFile),
          explanation: `verified remediation ${applied.id}: before failed with ${failureClass}; after observed ${after.result.healthObservation}`,
        };
      }
      attemptEvidence = [
        `Repair attempt ${remediation.id}: known remediation for ${failureClass} did not resolve it; evidence preserved.`,
        after?.result.failureEvidence ?? after?.result.explanation ?? "after verification produced no attestation evidence",
      ].join("\n");
      break;
    }

    if (!attemptedId || !attemptEvidence) {
      attemptEvidence = `Registered remediation for ${failureClass} was not applicable to the preserved evidence.`;
    }
    persistFailureAttestation(repo, sandboxBefore, attemptEvidence);
    return {
      schema: "bootproof/repair-result/v1",
      repaired: false,
      failureClass,
      repairId: attemptedId,
      receiptPath: null,
      patchPath: null,
      afterAttestationPath: null,
      explanation: `known remediation for ${failureClass} did not resolve it; evidence preserved`,
    };
  } finally {
    await cleanupServices(lastOutcome, buildExecutionEnv({ COMPOSE_PROJECT_NAME: composeProjectName }));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
