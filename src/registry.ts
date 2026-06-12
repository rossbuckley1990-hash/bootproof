// Registry exports are local artifacts only. They never upload, call a registry service, or
// claim that a public index exists. See docs/REGISTRY.md.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Inference, Attestation, FailureClass } from "./types.js";
import type { RepairReceipt, RepairKind } from "./repair.js";
import { buildExecutionEnv } from "./exec.js";
import { redactText } from "./redact.js";
import { signDetached, verifyDetached } from "./proof.js";

export type RegistryMode =
  | "local_export"
  | "federated_public_candidate"
  | "cloud_upload_candidate";

export interface RegistrySignature {
  algorithm: "ed25519";
  publicKey: string;
  value: string;
}

export interface RegistryEntry {
  schema: "bootproof/registry-entry/v1";
  createdAt: string;
  bootproofVersion: string;
  source: "local_cli";
  registryMode: RegistryMode;
  repoFingerprint: string;
  repoHost: string | null;
  repoOwnerHash: string;
  repoNameHash: string;
  publicRepoHint?: string;
  commitHash: string | null;
  branch: string | null;
  os: string;
  arch: string;
  platform: string;
  packageManager: string;
  detectedStack: string[];
  detectedServices: string[];
  selectedCommandHash: string | null;
  selectedCommandRedacted: string | null;
  failureClass: FailureClass | null;
  failureEvidenceFingerprint: string | null;
  evidenceHeadRedacted: string | null;
  evidenceTailRedacted: string | null;
  healthStatus: "healthy" | "unhealthy" | "connection_error" | "not_observed";
  healthUrlPattern: string | null;
  healthRedirectLocationPattern: string | null;
  repairActionType?: RepairKind;
  repairCommandHash?: string;
  repairCommandRedacted?: string;
  beforeFailureClass?: FailureClass;
  afterFailureClass?: FailureClass;
  progressed?: boolean;
  verified: boolean;
  attestationHash: string;
  repairReceiptHash?: string;
  redactionsApplied: string[];
  signature?: RegistrySignature;
  optInRequired: true;
}

export interface FederatedReceipt {
  schema: "bootproof/federated-receipt/v1";
  createdAt: string;
  registryEntry: RegistryEntry;
  attestationHash: string;
  repairReceiptHash?: string;
  signature?: RegistrySignature;
  publicRepoDeclaration: true;
  crawlerHint: {
    repoUrl?: string;
    commitHash: string | null;
    branch: string | null;
  };
  redactionsApplied: string[];
  noSecretsIncluded: true;
}

export interface RegistryBuildOptions {
  registryMode?: RegistryMode;
  inference?: Pick<Inference, "packageManager" | "stack" | "services" | "composeApplicationServices">;
  repairReceipt?: RepairReceipt | null;
  createdAt?: string;
  branch?: string | null;
  sign?: boolean;
}

export interface FederatedReceiptBuildOptions {
  createdAt?: string;
  sign?: boolean;
}

interface SafeRepoIdentity {
  host: string | null;
  owner: string;
  name: string;
  publicUrl: string | null;
  fingerprintSource: string;
}

const PUBLIC_REPO_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"]);
const REGISTRY_ENTRY_KEYS = new Set([
  "schema", "createdAt", "bootproofVersion", "source", "registryMode", "repoFingerprint",
  "repoHost", "repoOwnerHash", "repoNameHash", "publicRepoHint", "commitHash", "branch",
  "os", "arch", "platform", "packageManager", "detectedStack", "detectedServices",
  "selectedCommandHash", "selectedCommandRedacted", "failureClass", "failureEvidenceFingerprint",
  "evidenceHeadRedacted", "evidenceTailRedacted", "healthStatus", "healthUrlPattern",
  "healthRedirectLocationPattern", "repairActionType", "repairCommandHash",
  "repairCommandRedacted", "beforeFailureClass", "afterFailureClass", "progressed", "verified",
  "attestationHash", "repairReceiptHash", "redactionsApplied", "signature", "optInRequired",
]);
const FEDERATED_RECEIPT_KEYS = new Set([
  "schema", "createdAt", "registryEntry", "attestationHash", "repairReceiptHash", "signature",
  "publicRepoDeclaration", "crawlerHint", "redactionsApplied", "noSecretsIncluded",
]);

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashObject(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function canonicalWithoutSignature(value: { signature?: RegistrySignature }): Buffer {
  const { signature: _signature, ...body } = value;
  return Buffer.from(JSON.stringify(body));
}

function signed(value: { signature?: RegistrySignature }): RegistrySignature {
  const result = signDetached(canonicalWithoutSignature(value));
  return { algorithm: "ed25519", publicKey: result.publicKeyPem, value: result.signature };
}

function safeRepoIdentity(att: Attestation): SafeRepoIdentity {
  const fallbackName = path.basename(path.resolve(att.repo.path)) || "repository";
  const fallbackOwner = path.basename(path.dirname(path.resolve(att.repo.path))) || "local";
  const remote = att.repo.remote?.trim() ?? "";
  let candidate = remote;
  const scp = remote.match(/^git@([^:]+):(.+)$/i);
  if (scp) candidate = `https://${scp[1]}/${scp[2]}`;

  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    const name = parts.at(-1)?.replace(/\.git$/i, "") ?? "";
    const owner = parts.slice(0, -1).join("/");
    const safeSegments = [...parts.slice(0, -1), name].every(part => /^[A-Za-z0-9_.-]+$/.test(part));
    const safeIdentity =
      Boolean(host && owner && name && safeSegments) &&
      !url.search &&
      !url.hash;
    const safePublic =
      url.protocol === "https:" &&
      PUBLIC_REPO_HOSTS.has(host) &&
      !url.username &&
      !url.password &&
      !url.port &&
      safeIdentity;
    if (safeIdentity) {
      return {
        host,
        owner,
        name,
        publicUrl: safePublic ? `https://${host}/${owner}/${name}` : null,
        fingerprintSource: `${host}/${owner}/${name}`,
      };
    }
  } catch {
    // Non-public or local remotes are represented only by hashes below.
  }

  return {
    host: null,
    owner: fallbackOwner,
    name: fallbackName,
    publicUrl: null,
    fingerprintSource: remote || path.resolve(att.repo.path),
  };
}

function redactRegistryText(input: string | null | undefined): { text: string | null; applied: string[] } {
  if (!input) return { text: null, applied: [] };
  const base = redactText(input);
  let text = base.text;
  const applied = new Set(base.applied);

  const privateKey = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g;
  if (privateKey.test(text)) {
    text = text.replace(privateKey, "[redacted-private-key]");
    applied.add("private keys");
  }

  const envAssignment = /(^|[\s;])([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s;]+)/gm;
  if (envAssignment.test(text)) {
    text = text.replace(envAssignment, "$1$2=[redacted]");
    applied.add("environment values");
  }

  const localPath = /\/(?:Users|home)\/[^/\s]+/g;
  if (localPath.test(text) || text.includes("~/")) {
    text = text.replace(localPath, "[home]").replace(/~(?=\/)/g, "[home]");
    applied.add("local user paths");
  }

  return { text, applied: [...applied] };
}

function redactUrlPattern(value: string | null | undefined): { text: string | null; applied: string[] } {
  if (!value) return { text: null, applied: [] };
  try {
    const absolute = new URL(value, "http://bootproof.invalid");
    const relative = !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
    const dynamicPath = absolute.pathname
      .split("/")
      .map(segment => /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) ? ":id" : segment)
      .join("/");
    const port = absolute.port ? ":<port>" : "";
    const text = relative
      ? dynamicPath || "/"
      : `${absolute.protocol}//${absolute.hostname}${port}${dynamicPath || "/"}`;
    const applied = ["URL query and credentials"];
    if (absolute.port) applied.push("URL port");
    if (dynamicPath !== absolute.pathname) applied.push("dynamic URL path segments");
    return { text, applied };
  } catch {
    return redactRegistryText(value);
  }
}

function failedProcessEvidence(att: Attestation): { head: string | null; tail: string | null } {
  const failed = att.observed.find(step => !step.ok && (step.evidenceHead || step.evidenceTail));
  return {
    head: failed?.evidenceHead ?? null,
    tail: failed?.evidenceTail ?? att.result.failureEvidence,
  };
}

function healthStatus(att: Attestation): RegistryEntry["healthStatus"] {
  const evidence = att.result.healthEvidence;
  if (att.result.healthVerified && evidence?.acceptedAsHealthy) return "healthy";
  if (evidence?.connectionError) return "connection_error";
  if (evidence || att.result.healthObservation) return "unhealthy";
  return "not_observed";
}

function repairCommand(receipt: RepairReceipt | null | undefined): string | null {
  return receipt?.repair?.planDelta
    ?? receipt?.repair?.envDelta
    ?? receipt?.proposedAction.command?.display
    ?? receipt?.proposedAction.instruction
    ?? null;
}

function registryRepairKind(receipt: RepairReceipt): RepairKind {
  if (receipt.repair) return receipt.repair.kind;
  return receipt.actionType === "command" ? "environment" : "plan-step";
}

export function currentGitBranch(repo: string): string | null {
  try {
    const branch = execFileSync(
      "git",
      ["-C", repo, "symbolic-ref", "--quiet", "--short", "HEAD"],
      { encoding: "utf8", env: buildExecutionEnv(), stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return branch || null;
  } catch {
    return null;
  }
}

export function buildRegistryEntry(att: Attestation, options: RegistryBuildOptions = {}): RegistryEntry {
  const redactions = new Set<string>(["repository identity hashed"]);
  const identity = safeRepoIdentity(att);
  const selectedCommand = att.plan.steps.find(step => step.kind === "start-app")?.command ?? null;
  const processEvidence = failedProcessEvidence(att);
  const head = redactRegistryText(processEvidence.head);
  const tail = redactRegistryText(processEvidence.tail);
  const command = redactRegistryText(selectedCommand);
  const healthUrl = redactUrlPattern(att.result.healthEvidence?.requestedUrl ?? att.plan.healthUrl);
  const healthRedirect = redactUrlPattern(att.result.healthEvidence?.redirectLocation);
  const receipt = options.repairReceipt ?? null;
  const repair = repairCommand(receipt);
  const repairRedacted = redactRegistryText(repair);
  for (const result of [head, tail, command, healthUrl, healthRedirect, repairRedacted]) {
    result.applied.forEach(item => redactions.add(item));
  }

  const detectedServices = [
    ...(options.inference?.services.map(service => service.kind) ?? []),
    ...(options.inference?.composeApplicationServices.map(service => service.name) ?? []),
  ];
  const platform = att.environment.os.trim().split(/\s+/)[0] || "unknown";
  const entry: RegistryEntry = {
    schema: "bootproof/registry-entry/v1",
    createdAt: options.createdAt ?? new Date().toISOString(),
    bootproofVersion: att.tool.replace(/^bootproof@/, ""),
    source: "local_cli",
    registryMode: options.registryMode ?? "local_export",
    repoFingerprint: sha256(`bootproof/repo/v1\0${identity.fingerprintSource}`),
    repoHost: identity.host,
    repoOwnerHash: sha256(`bootproof/repo-owner/v1\0${identity.owner}`),
    repoNameHash: sha256(`bootproof/repo-name/v1\0${identity.name}`),
    ...(identity.publicUrl ? { publicRepoHint: identity.publicUrl } : {}),
    commitHash: att.repo.commit,
    branch: options.branch ?? null,
    os: att.environment.os,
    arch: att.environment.arch,
    platform,
    packageManager: options.inference?.packageManager ?? "unknown",
    detectedStack: [...new Set(options.inference?.stack ?? [])].sort(),
    detectedServices: [...new Set(detectedServices)].sort(),
    selectedCommandHash: selectedCommand ? sha256(selectedCommand) : null,
    selectedCommandRedacted: command.text,
    failureClass: att.result.failureClass,
    failureEvidenceFingerprint: att.result.failureEvidence ? sha256(att.result.failureEvidence) : null,
    evidenceHeadRedacted: head.text,
    evidenceTailRedacted: tail.text,
    healthStatus: healthStatus(att),
    healthUrlPattern: healthUrl.text,
    healthRedirectLocationPattern: healthRedirect.text,
    ...(receipt ? { repairActionType: registryRepairKind(receipt) } : {}),
    ...(repair ? { repairCommandHash: sha256(repair) } : {}),
    ...(repairRedacted.text ? { repairCommandRedacted: repairRedacted.text } : {}),
    ...(receipt ? { beforeFailureClass: receipt.beforeFailureClass } : {}),
    ...(receipt?.afterFailureClass ? { afterFailureClass: receipt.afterFailureClass } : {}),
    ...(receipt ? { progressed: receipt.progressed } : {}),
    verified: att.result.booted === true && att.result.healthVerified === true,
    attestationHash: hashObject(att),
    ...(receipt ? { repairReceiptHash: hashObject(receipt) } : {}),
    redactionsApplied: [...redactions].sort(),
    optInRequired: true,
  };
  if (options.sign) entry.signature = signed(entry);
  assertValidRegistryEntry(entry);
  return entry;
}

export function buildFederatedReceipt(
  registryEntry: RegistryEntry,
  options: FederatedReceiptBuildOptions = {},
): FederatedReceipt {
  const receipt: FederatedReceipt = {
    schema: "bootproof/federated-receipt/v1",
    createdAt: options.createdAt ?? registryEntry.createdAt,
    registryEntry,
    attestationHash: registryEntry.attestationHash,
    ...(registryEntry.repairReceiptHash ? { repairReceiptHash: registryEntry.repairReceiptHash } : {}),
    publicRepoDeclaration: true,
    crawlerHint: {
      ...(registryEntry.publicRepoHint ? { repoUrl: registryEntry.publicRepoHint } : {}),
      commitHash: registryEntry.commitHash,
      branch: registryEntry.branch,
    },
    redactionsApplied: [...registryEntry.redactionsApplied],
    noSecretsIncluded: true,
  };
  if (options.sign) receipt.signature = signed(receipt);
  assertValidFederatedReceipt(receipt);
  return receipt;
}

export function verifyRegistryEntry(entry: RegistryEntry): boolean {
  return Boolean(
    entry.signature &&
    verifyDetached(canonicalWithoutSignature(entry), entry.signature.value, entry.signature.publicKey),
  );
}

export function verifyFederatedReceipt(receipt: FederatedReceipt): boolean {
  return Boolean(
    receipt.signature &&
    verifyDetached(canonicalWithoutSignature(receipt), receipt.signature.value, receipt.signature.publicKey),
  );
}

function unknownKeys(value: object, allowed: ReadonlySet<string>): string[] {
  return Object.keys(value).filter(key => !allowed.has(key));
}

export function validateRegistryEntry(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["entry must be an object"];
  const entry = value as Partial<RegistryEntry>;
  const errors = unknownKeys(value, REGISTRY_ENTRY_KEYS).map(key => `unsupported field: ${key}`);
  if (entry.schema !== "bootproof/registry-entry/v1") errors.push("invalid schema");
  if (entry.source !== "local_cli") errors.push("invalid source");
  if (!["local_export", "federated_public_candidate", "cloud_upload_candidate"].includes(String(entry.registryMode))) {
    errors.push("invalid registryMode");
  }
  for (const key of [
    "createdAt", "bootproofVersion", "repoFingerprint", "repoOwnerHash", "repoNameHash",
    "os", "arch", "platform", "packageManager", "attestationHash",
  ] as const) {
    if (typeof entry[key] !== "string" || !entry[key]) errors.push(`${key} must be a non-empty string`);
  }
  for (const key of ["detectedStack", "detectedServices", "redactionsApplied"] as const) {
    if (!Array.isArray(entry[key]) || entry[key]?.some(item => typeof item !== "string")) {
      errors.push(`${key} must be a string array`);
    }
  }
  if (!["healthy", "unhealthy", "connection_error", "not_observed"].includes(String(entry.healthStatus))) {
    errors.push("invalid healthStatus");
  }
  if (typeof entry.verified !== "boolean") errors.push("verified must be boolean");
  if (entry.optInRequired !== true) errors.push("optInRequired must be true");
  if (entry.signature && (
    entry.signature.algorithm !== "ed25519" ||
    typeof entry.signature.publicKey !== "string" ||
    typeof entry.signature.value !== "string"
  )) {
    errors.push("invalid signature");
  }
  return errors;
}

export function validateFederatedReceipt(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["receipt must be an object"];
  const receipt = value as Partial<FederatedReceipt>;
  const errors = unknownKeys(value, FEDERATED_RECEIPT_KEYS).map(key => `unsupported field: ${key}`);
  if (receipt.schema !== "bootproof/federated-receipt/v1") errors.push("invalid schema");
  if (typeof receipt.createdAt !== "string" || !receipt.createdAt) errors.push("createdAt must be a non-empty string");
  errors.push(...validateRegistryEntry(receipt.registryEntry).map(error => `registryEntry: ${error}`));
  if (receipt.registryEntry?.registryMode !== "federated_public_candidate") {
    errors.push("registryEntry.registryMode must be federated_public_candidate");
  }
  if (receipt.attestationHash !== receipt.registryEntry?.attestationHash) errors.push("attestationHash must match registryEntry");
  if (receipt.repairReceiptHash !== receipt.registryEntry?.repairReceiptHash) errors.push("repairReceiptHash must match registryEntry");
  if (receipt.publicRepoDeclaration !== true) errors.push("publicRepoDeclaration must be true");
  if (!receipt.crawlerHint || typeof receipt.crawlerHint !== "object") errors.push("crawlerHint must be an object");
  if (!Array.isArray(receipt.redactionsApplied) || receipt.redactionsApplied.some(item => typeof item !== "string")) {
    errors.push("redactionsApplied must be a string array");
  }
  if (receipt.noSecretsIncluded !== true) errors.push("noSecretsIncluded must be true");
  if (receipt.signature && (
    receipt.signature.algorithm !== "ed25519" ||
    typeof receipt.signature.publicKey !== "string" ||
    typeof receipt.signature.value !== "string"
  )) {
    errors.push("invalid signature");
  }
  return errors;
}

function assertValidRegistryEntry(entry: RegistryEntry): void {
  const errors = validateRegistryEntry(entry);
  if (errors.length) throw new Error(`invalid registry entry: ${errors.join("; ")}`);
}

function assertValidFederatedReceipt(receipt: FederatedReceipt): void {
  const errors = validateFederatedReceipt(receipt);
  if (errors.length) throw new Error(`invalid federated receipt: ${errors.join("; ")}`);
}

export function registryEntryPath(repo: string): string {
  return path.join(repo, ".bootproof", "registry-entry.json");
}

export function federatedReceiptPath(repo: string, receipt: FederatedReceipt): string {
  const timestamp = receipt.createdAt.replace(/[:.]/g, "-");
  return path.join(repo, ".bootproof", "registry", `${timestamp}-${receipt.attestationHash.slice(0, 12)}.json`);
}

export function writeRegistryEntry(repo: string, entry: RegistryEntry): string {
  assertValidRegistryEntry(entry);
  const output = registryEntryPath(repo);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(entry, null, 2) + "\n");
  return output;
}

export function writeFederatedReceipt(repo: string, receipt: FederatedReceipt): string {
  assertValidFederatedReceipt(receipt);
  const output = federatedReceiptPath(repo, receipt);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  return output;
}
