# BootProof Engineering Constitution

This file governs all engineering work in this repository. Every future change
must preserve these principles and boundaries.

## Mission

BootProof is the honest Run Button for GitHub repositories.

- BootProof makes repositories prove they boot.
- No proof, no green check.
- AI can suggest. BootProof proves.
- Failed attestations are valuable evidence, not disposable errors.

## Non-Negotiable Invariants

### `bootproof up` is sacred

`bootproof up` must remain deterministic, zero-AI, and evidence-based. Its
result must follow from observed execution and health evidence, never from an
AI judgment, optimistic inference, or fabricated state.

### Verification must be honest

- Never claim verified boot unless health was actually observed.
- A process starting, a port opening, or a command exiting successfully is not
  sufficient unless it satisfies the declared health contract.
- Preserve failed attestations and report failures clearly.
- Never turn missing, ambiguous, or inconclusive evidence into success.
- Never silently ignore CLI flags. Honor them or fail with a clear error.

### Secrets and environments must be protected

- Never invent secrets, credentials, tokens, or secret-like placeholder values
  and present them as real.
- Never silently mutate protected `.env` files.
- Any permitted environment-file change must be explicit, visible, and
  consented to by the user.
- Redact secrets from attestations, evidence, logs, registry exports, prompts,
  repair receipts, and other persisted or transmitted output.

### Execution requires consent

- Never execute remote or untrusted code without explicit user consent.
- Make the code source and execution implications clear before requesting
  consent.
- Do not broaden granted consent beyond the specific operation authorized.

### Local data stays local by default

- Never upload telemetry, attestations, repair receipts, registry data, or
  derived evidence by default.
- Registry and cloud uploads must be explicit and opt-in.
- Offline operation must remain complete and useful without BootProof Cloud.

## Open-Source Boundary

This public repository contains the local proof engine.

It may contain:

- Deterministic local boot discovery, execution, health checks, and proof.
- Deterministic local repair.
- Optional bring-your-own-key AI repair suggestions.
- Standard local evidence formats, including attestations, repair receipts,
  diff results, and registry export entries.

It must not contain BootProof Cloud or cloud-product capabilities, including:

- SaaS billing.
- Team dashboards.
- Hosted managed AI.
- Shared repair memory.
- Enterprise policy.
- Fleet analytics.
- Cloud governance.

Do not add cloud implementations here behind feature flags, dormant modules, or
"future" abstractions.

## Commercial Boundary

BootProof Cloud lives in a separate private repository. Cloud owns:

- Hosted evidence.
- Managed AI.
- Team policy and approval workflows.
- GitHub and GitLab integration history.
- Registry intelligence.
- Dashboards.
- SSO and billing.
- The global data moat.

Public interfaces may support explicit interoperability with Cloud, but this
repository must not implement Cloud-owned behavior or require Cloud to operate.

## Data Moat Principle

- OSS generates standard evidence: attestations, repair receipts, diff results,
  and registry export entries.
- Cloud may ingest explicitly opted-in, redacted evidence.
- Cloud builds the canonical registry, the Global Atlas of Broken Environments.
- OSS must always work offline without Cloud.
- Local formats must remain useful without upload or a hosted account.

## AI Boundary

- AI may suggest repairs; deterministic execution and observed health determine
  whether a repair worked.
- AI output is untrusted input and must never be treated as proof.
- BYOK AI support must be optional and must use native `fetch`.
- Do not add OpenAI, Anthropic, or other provider SDKs to the OSS dependency
  graph.
- Redact secrets before constructing or sending prompts.
- AI must never participate in the `bootproof up` proof path.

## Implementation Rules

- Prefer small, surgical changes.
- Add tests for every behavior change.
- Keep dependencies minimal and justify each new dependency.
- Use strict JSON schemas for machine interfaces.
- Reject invalid machine input clearly; do not silently coerce away contract
  violations.
- Preserve deterministic behavior in proof, repair, evidence, and export paths.
- Keep evidence and receipts accurate, inspectable, and redacted.
- Treat security, consent, privacy, and truthful verification as product
  correctness requirements.

## Completion Gate

Before completing any engineering task:

1. Confirm the change respects this constitution and the OSS/Cloud boundary.
2. Confirm every behavior change has appropriate tests.
3. Run `npm run build` when available.
4. Run `npm test` when available.
5. Do not report completion while required builds or tests are failing.

When requirements conflict with this constitution, stop and surface the
conflict rather than weakening these guarantees.
