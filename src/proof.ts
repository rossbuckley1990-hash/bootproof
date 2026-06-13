import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type {
  Attestation,
  ObservedStep,
  RunPlan,
  FailureClass,
  HealthEvidence,
  VerificationMode,
  ExternalVerificationClassification,
} from "./types.js";
import { buildExecutionEnv } from "./exec.js";

export const TOOL_ID = "bootproof@0.3.0";

export type SignerTrustTier = "invalid" | "self" | "known" | "unknown-foreign";

export interface SignatureTrustResult {
  integrityValid: boolean;
  tier: SignerTrustTier;
  fingerprint: string | null;
  label: string | null;
}

interface KnownSignerRecord {
  firstSeenAt: string;
  label?: string;
}

interface KnownSignerStore {
  schema: "bootproof/known-signers/v1";
  signers: Record<string, KnownSignerRecord>;
}

export function gitInfo(repo: string): Attestation["repo"] {
  const git = (...args: string[]) => {
    try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: buildExecutionEnv() }).trim(); } catch { return null; }
  };
  if (!fs.existsSync(path.join(repo, ".git"))) return { path: repo, remote: null, commit: null, dirty: null };
  const status = git("status", "--porcelain");
  return {
    path: repo,
    remote: git("config", "--get", "remote.origin.url"),
    commit: git("rev-parse", "HEAD"),
    dirty: status === null ? null : status.length > 0,
  };
}

function signerKeyPath(): string {
  return path.join(os.homedir(), ".bootproof", "signer.json");
}

export function knownSignersPath(): string {
  return path.join(os.homedir(), ".bootproof", "known_signers.json");
}

function loadOrCreateSigner(): { privateKey: crypto.KeyObject; publicKeyPem: string } {
  const p = signerKeyPath();
  if (fs.existsSync(p)) {
    const saved = JSON.parse(fs.readFileSync(p, "utf8"));
    return { privateKey: crypto.createPrivateKey(saved.privateKeyPem), publicKeyPem: saved.publicKeyPem };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify({ privateKeyPem, publicKeyPem }), { mode: 0o600 });
  return { privateKey: crypto.createPrivateKey(privateKeyPem), publicKeyPem };
}

function localSignerPublicKey(): string | null {
  const p = signerKeyPath();
  if (!fs.existsSync(p)) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(p, "utf8")) as { publicKeyPem?: unknown };
    return typeof saved.publicKeyPem === "string" ? saved.publicKeyPem : null;
  } catch {
    return null;
  }
}

function emptyKnownSignerStore(): KnownSignerStore {
  return { schema: "bootproof/known-signers/v1", signers: {} };
}

function readKnownSignerStore(): KnownSignerStore {
  const p = knownSignersPath();
  if (!fs.existsSync(p)) return emptyKnownSignerStore();
  try {
    const value = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<KnownSignerStore>;
    if (value.schema !== "bootproof/known-signers/v1" || !value.signers || typeof value.signers !== "object") {
      return emptyKnownSignerStore();
    }
    return { schema: value.schema, signers: value.signers };
  } catch {
    return emptyKnownSignerStore();
  }
}

export function signerFingerprint(publicKeyPem: string): string {
  const publicKey = crypto.createPublicKey(publicKeyPem);
  const spki = publicKey.export({ type: "spki", format: "der" });
  return `sha256:${crypto.createHash("sha256").update(spki).digest("hex")}`;
}

export function trustSigner(publicKeyPem: string, label?: string): {
  fingerprint: string;
  firstSeenAt: string;
  label: string | null;
} {
  const fingerprint = signerFingerprint(publicKeyPem);
  const store = readKnownSignerStore();
  const existing = store.signers[fingerprint];
  const record: KnownSignerRecord = existing ?? {
    firstSeenAt: new Date().toISOString(),
    ...(label ? { label } : {}),
  };
  if (label) record.label = label;
  store.signers[fingerprint] = record;
  const p = knownSignersPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  return {
    fingerprint,
    firstSeenAt: record.firstSeenAt,
    label: record.label ?? null,
  };
}

function signerTrust(publicKeyPem: string): Omit<SignatureTrustResult, "integrityValid"> {
  let fingerprint: string;
  try {
    fingerprint = signerFingerprint(publicKeyPem);
  } catch {
    return { tier: "invalid", fingerprint: null, label: null };
  }
  const localPublicKey = localSignerPublicKey();
  if (localPublicKey) {
    try {
      if (signerFingerprint(localPublicKey) === fingerprint) {
        return { tier: "self", fingerprint, label: null };
      }
    } catch {
      // A malformed local signer cannot establish trust in a foreign artifact.
    }
  }
  const known = readKnownSignerStore().signers[fingerprint];
  if (known) return { tier: "known", fingerprint, label: known.label ?? null };
  return { tier: "unknown-foreign", fingerprint, label: null };
}

export function evaluateDetachedSignature(
  body: Buffer,
  signature: string | null | undefined,
  publicKeyPem: string | null | undefined,
): SignatureTrustResult {
  if (!signature || !publicKeyPem || !verifyDetached(body, signature, publicKeyPem)) {
    return { integrityValid: false, tier: "invalid", fingerprint: null, label: null };
  }
  return { integrityValid: true, ...signerTrust(publicKeyPem) };
}

function canonicalBody(att: Attestation): Buffer {
  const { signature: _s, signer: _k, ...body } = att;
  return Buffer.from(JSON.stringify(body));
}

export function buildAttestation(input: {
  repo: string; plan: RunPlan; observed: ObservedStep[]; startedAt: string;
  booted: boolean; healthVerified: boolean; healthObservation: string | null;
  healthEvidence?: HealthEvidence | null;
  observedHealthCandidates?: string[];
  failureClass: FailureClass | null; failureEvidence: string | null; explanation: string;
  verificationMode?: VerificationMode;
  bootproofOrchestrated?: boolean;
  externalHealthUrl?: string | null;
  observedStatus?: number | null;
  observedFinalUrl?: string | null;
  observedAt?: string | null;
  responseSnippet?: string;
  classification?: ExternalVerificationClassification | null;
}): Attestation {
  const verificationMode = input.verificationMode ?? "bootproof-orchestrated";
  const bootproofOrchestrated = verificationMode === "external-health"
    ? false
    : input.bootproofOrchestrated ?? true;
  const att: Attestation = {
    schema: "bootproof/attestation/v1",
    tool: TOOL_ID,
    verificationMode,
    bootproofOrchestrated,
    externalHealthUrl: input.externalHealthUrl ?? null,
    observedStatus: input.observedStatus ?? null,
    observedFinalUrl: input.observedFinalUrl ?? null,
    observedAt: input.observedAt ?? null,
    responseSnippet: input.responseSnippet ?? "",
    classification: input.classification ?? null,
    repo: gitInfo(input.repo),
    environment: { os: `${os.platform()} ${os.release()}`, arch: os.arch(), node: process.version },
    trust: { level: "local_developer_signed", signer: "local_ed25519", oidc: null },
    plan: input.plan,
    observed: input.observed,
    result: {
      booted: input.booted,
      healthVerified: input.healthVerified,
      healthObservation: input.healthObservation,
      healthEvidence: input.healthEvidence ?? null,
      observedHealthCandidates: input.observedHealthCandidates ?? [],
      observedPort: input.plan.observedPort ?? null,
      healthCandidateSource: input.plan.healthCandidateSource ?? "inferred",
      failureClass: input.failureClass,
      failureEvidence: input.failureEvidence,
      explanation: input.explanation,
    },
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    signer: null,
    signature: null,
  };
  const { privateKey, publicKeyPem } = loadOrCreateSigner();
  att.signature = crypto.sign(null, canonicalBody(att), privateKey).toString("base64");
  att.signer = { publicKey: publicKeyPem, algorithm: "ed25519" };
  return att;
}

export function signDetached(body: Buffer): { signature: string; publicKeyPem: string } {
  const { privateKey, publicKeyPem } = loadOrCreateSigner();
  return { signature: crypto.sign(null, body, privateKey).toString("base64"), publicKeyPem };
}

export function verifyDetached(body: Buffer, signature: string, publicKeyPem: string): boolean {
  try { return crypto.verify(null, body, crypto.createPublicKey(publicKeyPem), Buffer.from(signature, "base64")); } catch { return false; }
}

export function verifySignature(att: Attestation): boolean {
  if (!att.signature || !att.signer) return false;
  return verifyDetached(canonicalBody(att), att.signature, att.signer.publicKey);
}

export function evaluateAttestationSignature(att: Attestation): SignatureTrustResult {
  return evaluateDetachedSignature(canonicalBody(att), att.signature, att.signer?.publicKey);
}

export function currentGitHead(repo: string): string | null {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
      env: buildExecutionEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function attestationPath(repo: string): string {
  return path.join(repo, ".bootproof", "attestation.json");
}

export function writeAttestation(repo: string, att: Attestation): string {
  const p = attestationPath(repo);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(att, null, 2) + "\n");
  return p;
}
