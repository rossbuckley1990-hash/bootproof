# Agent-Loop Gap Analysis

Audit date: 2026-06-12

Target architecture:

> Diagnose -> Classify -> Plan -> Risk-Classify -> Approve -> Execute One Step
> -> Verify -> Receipt -> Repeat

This audit describes the current OSS repository after Prompt 10. It does not
authorize autonomous execution and does not change runtime behavior.

## Status Summary

| Capability | Status | Current repository state |
|---|---|---|
| Engineering constitution | Exists | `AGENTS.md` contains the complete agent-loop principles, approval boundary, one-step rule, verification rule, receipt rule, honest-stop rule, and OSS/Cloud boundary. |
| External health verification | Missing, with reusable primitives | HTTP polling and health evidence exist, including accepted application redirects. There is no `verify-url`, `--external-health`, external attestation mode, or external-health taxonomy. |
| Agent planning | Missing, with a simpler run-plan precedent | `bootproof plan` previews the inferred boot plan without execution or writes. There is no `plan-agent`, agent-plan schema/file, or risk-classified candidate-action plan. |
| Shared action risk model | Partial | Deterministic repair has strict action, risk, approval, blocklist, and receipt models. The model is fixed to deterministic playbooks and lacks `blockedReason`, `verificationStep`, and unknown-command risk classification. |
| Airbyte runbook recognition | Missing | No Airbyte, `abctl`, kind, Helm, Kubernetes, or Gradle-specific recognition, taxonomy, plan, health endpoint, or credential-sensitive step exists. |
| Local agent receipt chain | Partial primitives only | Signed attestations and signed repair receipts contain before/after hashes and lifecycle state. There is no run directory, chained action/verification receipts, final summary, or `explain-run`. |

## Existing Capabilities

### Constitution

`AGENTS.md` already states that BootProof may plan and risk-classify actions,
may execute only approved local actions, must execute one step at a time,
must verify after every action, must save local receipts, and must stop on
unknown or unsafe steps.

It also preserves these boundaries:

- `bootproof up` is deterministic, zero-AI, and evidence-based.
- Planning and action completion are not proof.
- External health must not imply that BootProof started the application.
- AI assistance is optional and must use the same safety model.
- Cloud/SaaS, telemetry, and automatic upload remain outside this OSS repo.

### Deterministic Repair Loop

The current `bootproof fix` path implements a human-driven subset of the loop:

- reads a signature-valid failed attestation;
- classifies exact known evidence;
- selects one deterministic repair candidate;
- displays action type, mutation scope, risk, and exact command or patch;
- requires uppercase `Y` for command or patch testing;
- executes only the selected action;
- reruns BootProof in a sandbox;
- records declined, failed, progressed, or verified outcomes;
- writes a signed local repair receipt.

Later candidate actions may be displayed, but they are not silently chained or
executed in the same approval.

### Health and Evidence Primitives

The health engine already:

- records requested URL, HTTP status, headers, redirect location, body excerpt,
  timestamp, acceptance decision, and connection errors;
- accepts HTTP 2xx and expected application sign-in redirects;
- preserves failed observations;
- clears stale health evidence during later successful observations.

These primitives can support a future external-health attestation, but current
attestations describe `bootproof up` runs and set `booted` only through that
execution path.

### Safety and Receipt Primitives

`bootproof/repair-action/v1` currently provides:

- `actionType`;
- `mutationScope`;
- `riskLevel`;
- `requiresApproval`;
- structured commands, patches, and instructions;
- a hard safety validator for shell control, `sudo`, destructive commands,
  protected environment files, blocked paths, and exfiltration patterns.

`bootproof/repair-receipt/v1` currently records:

- proposed action and risk fields;
- approval and application timestamps;
- apply result;
- before and after failure classes;
- progress and verification;
- redactions;
- signature-valid before/after attestation hashes when available.

## Partial Capabilities

### Run Planning

`bootproof plan` is planning-only and performs no execution or writes. Its
`RunPlan` steps contain an identifier, kind, optional command, description,
and required flag.

It is not an agent plan because it does not contain:

- candidate alternatives;
- per-action risk classification;
- mutation scope;
- approval requirement;
- blocked reason;
- verification step;
- secret-sensitivity metadata;
- a persisted `.bootproof/agent-plan.json`.

### Shared Risk Model

The deterministic repair model is the correct foundation, but it is not yet a
general agent-action contract:

- `deterministic` is fixed to `true`;
- `source` is fixed to `deterministic_playbook`;
- `blockedReason` is absent;
- `verificationStep` is absent;
- callers supply the risk level;
- unknown commands are not independently classified as at least medium risk.

Unsafe commands are rejected by the hard blocklist. Unknown failures also stop
without a guessed repair.

### Receipt History

BootProof writes `.bootproof/attestation.json`,
`.bootproof/repair-receipt.json`, and, after a rerun,
`.bootproof/repair-after-attestation.json`. Repair receipts are signed and bind
before/after attestations with hashes.

These files are overwritten or replaced per repair attempt. They are not a
run-scoped append-only receipt chain, and there is no previous-receipt hash.
`bootproof explain` can explain one attestation or repair receipt, but cannot
explain a complete agent run.

## Missing Capabilities

### External Health

The following do not exist:

- `bootproof verify-url <url>`;
- `bootproof up . --external-health <url>`;
- an external-health attestation mode;
- `external_service_verified`;
- `external_health_unreachable`;
- `auth_required`.

The existing `bootproof verify` command validates stored signatures and may
make a non-attested bonus health observation for a previously booted
attestation. It is not external service verification.

### Agent Planning

The following do not exist:

- `bootproof plan-agent <path-or-url>`;
- `.bootproof/agent-plan.json`;
- an agent-plan schema;
- persisted candidate actions with risk, mutation, approval, verification, and
  blocked fields.

### Airbyte Recognition and Runbook

The repository has no special handling for:

- `airbytehq/airbyte`;
- `abctl`;
- kind;
- Helm;
- Kubernetes;
- Gradle traits;
- `airbyte_abctl_managed`;
- `external_orchestrator_required`;
- `abctl local install --port 8001`;
- `http://localhost:8001/api/v1/health`;
- a secret-sensitive credentials step.

The generic `orchestration_not_supported` class is conceptually related but
does not encode Airbyte or external-orchestrator semantics.

### Agent Run Receipts

The following do not exist:

- `.bootproof/agent-runs/<run-id>/`;
- `initial-attestation.json`;
- run-scoped `agent-plan.json`;
- per-action receipts;
- per-verification receipts;
- `final-summary.json`;
- a receipt hash chain;
- `bootproof explain-run <run-id>`.

## Recommended Next Prompt Order

1. **Generalize the action planning contract, without execution.**
   Add a strict agent-action schema that reuses the repair safety validator and
   adds `blockedReason`, `verificationStep`, secret sensitivity, action source,
   and deterministic risk classification. Unknown commands must be at least
   medium risk; blocked commands remain non-executable.
2. **Add external-health attestations.**
   Implement `verify-url` and `--external-health` with a distinct attestation
   mode and the three external-health failure/result classes. Reuse existing
   HTTP evidence, never set or imply `startedByBootProof`, and make no process
   ownership claim.
3. **Add planning-only `plan-agent`.**
   Persist `.bootproof/agent-plan.json` with strict schemas and risk-classified
   candidate actions. It must perform no action execution, approval prompting,
   telemetry, or upload.
4. **Add deterministic Airbyte recognition and a planning-only runbook.**
   Detect the repository and orchestration traits, classify the managed/external
   orchestrator path, propose `abctl local install --port 8001` as high risk,
   mark credentials secret-sensitive, and use the external health endpoint as
   the final verification step. Do not execute the plan.
5. **Add the local agent-run receipt chain.**
   Introduce the run directory, initial attestation, plan snapshot,
   hash-chained action and verification receipts, final summary, and
   `explain-run`. Keep all output local, redacted, signed where appropriate,
   and append-only within a run.
6. **Only after the preceding contracts are stable, add a human-driven
   single-step runner.**
   Execute exactly one approved local action, verify it, write the chained
   receipts, and stop for a new explicit approval. Do not add autonomous
   multi-step execution in this stage.

## Files Inspected

- `AGENTS.md`
- `src/cli.ts`
- `src/types.ts`
- `src/infer.ts`
- `src/plan.ts`
- `src/run.ts`
- `src/exec.ts`
- `src/proof.ts`
- `src/taxonomy.ts`
- `src/diagnosis.ts`
- `src/repair-safety.ts`
- `src/repair-playbooks.ts`
- `src/repair.ts`
- `src/registry.ts`
- `docs/DETERMINISTIC_REPAIR_SAFETY_MODEL.md`
- `docs/FAILURE_TAXONOMY.md`
- `docs/HONESTY_CONTRACT.md`
- `docs/REPAIR_RECEIPT.md`
- `docs/REGISTRY.md`
- `docs/schemas/repair-action-v1.schema.json`
- `docs/schemas/repair-receipt-v1.schema.json`
- `tests/unit.test.mjs`
- `tests/e2e.test.mjs`

