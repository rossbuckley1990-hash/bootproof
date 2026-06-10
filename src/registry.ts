// The Bootproof registry is federated by design (docs/REGISTRY.md):
//   WRITE PATH: developers commit .bootproof/attestation.json to their own repos (git is the registry).
//   READ PATH: an index crawls public repos for these artifacts and verifies every signature.
// The CLI therefore never uploads anything. `attest export` produces a redacted, re-signed
// registry entry, and shows the user exactly what is in it. Sharing it is a deliberate git/PR act.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Attestation } from "./types.js";
import { redactText } from "./redact.js";
import { signDetached, verifyDetached } from "./proof.js";

export interface RegistryEntry {
  schema: "bootproof/registry-entry/v1";
  tool: string;
  repo: { remote: string | null; commit: string | null; dirty: boolean | null };
  environment: Attestation["environment"];
  plan: { provider: string; healthUrl: string; steps: { kind: string; command?: string }[] };
  result: {
    booted: boolean;
    healthVerified: boolean;
    healthObservation: string | null;
    failureClass: string | null;
    redactedEvidence: string | null;
  };
  redactionsApplied: string[];
  attestationSha256: string; // hash of the full local attestation this entry summarizes
  attestedAt: string;
  signer: { publicKey: string; algorithm: "ed25519" } | null;
  signature: string | null;
}

export function buildRegistryEntry(att: Attestation): RegistryEntry {
  const redactions = new Set<string>();
  let redactedEvidence: string | null = null;
  if (att.result.failureEvidence) {
    const r = redactText(att.result.failureEvidence);
    redactedEvidence = r.text;
    r.applied.forEach(a => redactions.add(a));
  }
  const fullHash = crypto.createHash("sha256").update(JSON.stringify(att)).digest("hex");
  const entry: RegistryEntry = {
    schema: "bootproof/registry-entry/v1",
    tool: att.tool,
    repo: { remote: att.repo.remote, commit: att.repo.commit, dirty: att.repo.dirty },
    environment: att.environment,
    plan: {
      provider: att.plan.provider,
      healthUrl: att.plan.healthUrl,
      steps: att.plan.steps.map(s => {
        const r = s.command ? redactText(s.command) : null;
        if (r) r.applied.forEach(a => redactions.add(a));
        return { kind: s.kind, command: r?.text };
      }),
    },
    result: {
      booted: att.result.booted,
      healthVerified: att.result.healthVerified,
      healthObservation: att.result.healthObservation,
      failureClass: att.result.failureClass,
      redactedEvidence,
    },
    redactionsApplied: [...redactions],
    attestationSha256: fullHash,
    attestedAt: att.finishedAt,
    signer: null,
    signature: null,
  };
  const signed = signDetached(canonical(entry));
  entry.signature = signed.signature;
  entry.signer = { publicKey: signed.publicKeyPem, algorithm: "ed25519" };
  return entry;
}

function canonical(entry: RegistryEntry): Buffer {
  const { signature: _s, signer: _k, ...body } = entry;
  return Buffer.from(JSON.stringify(body));
}

export function verifyRegistryEntry(entry: RegistryEntry): boolean {
  if (!entry.signature || !entry.signer) return false;
  return verifyDetached(canonical(entry), entry.signature, entry.signer.publicKey);
}

export function registryEntryPath(repo: string): string {
  return path.join(repo, ".bootproof", "registry-entry.json");
}

export function writeRegistryEntry(repo: string, entry: RegistryEntry): string {
  const p = registryEntryPath(repo);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(entry, null, 2) + "\n");
  return p;
}
