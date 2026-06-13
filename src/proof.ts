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
import { redactJsonValue } from "./redact.js";

export const TOOL_ID = "bootproof@0.3.0";

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
  const redactionsApplied = new Set<string>();
  const redact = <T>(value: T): T => {
    const redacted = redactJsonValue(value);
    for (const rule of redacted.applied) redactionsApplied.add(rule);
    return redacted.value as T;
  };
  const repo = gitInfo(input.repo);
  const persistedRepo = {
    ...repo,
    remote: redact(repo.remote),
  };
  const persistedPlan = redact(input.plan);
  const persistedObserved = redact(input.observed);
  const persistedHealthObservation = redact(input.healthObservation);
  const persistedHealthEvidence = redact(input.healthEvidence ?? null);
  const persistedObservedHealthCandidates = redact(input.observedHealthCandidates ?? []);
  const persistedFailureEvidence = redact(input.failureEvidence);
  const persistedExplanation = redact(input.explanation);
  const persistedExternalHealthUrl = redact(input.externalHealthUrl ?? null);
  const persistedObservedFinalUrl = redact(input.observedFinalUrl ?? null);
  const persistedResponseSnippet = redact(input.responseSnippet ?? "");
  const att: Attestation = {
    schema: "bootproof/attestation/v1",
    tool: TOOL_ID,
    verificationMode,
    bootproofOrchestrated,
    externalHealthUrl: persistedExternalHealthUrl,
    observedStatus: input.observedStatus ?? null,
    observedFinalUrl: persistedObservedFinalUrl,
    observedAt: input.observedAt ?? null,
    responseSnippet: persistedResponseSnippet,
    classification: input.classification ?? null,
    redactionsApplied: [...redactionsApplied].sort(),
    repo: persistedRepo,
    environment: { os: `${os.platform()} ${os.release()}`, arch: os.arch(), node: process.version },
    trust: { level: "local_developer_signed", signer: "local_ed25519", oidc: null },
    plan: persistedPlan,
    observed: persistedObserved,
    result: {
      booted: input.booted,
      healthVerified: input.healthVerified,
      healthObservation: persistedHealthObservation,
      healthEvidence: persistedHealthEvidence,
      observedHealthCandidates: persistedObservedHealthCandidates,
      observedPort: persistedPlan.observedPort ?? null,
      healthCandidateSource: persistedPlan.healthCandidateSource ?? "inferred",
      failureClass: input.failureClass,
      failureEvidence: persistedFailureEvidence,
      explanation: persistedExplanation,
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
  try {
    return crypto.verify(null, canonicalBody(att), crypto.createPublicKey(att.signer.publicKey), Buffer.from(att.signature, "base64"));
  } catch { return false; }
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
