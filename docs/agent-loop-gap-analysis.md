# Agent-Loop Gap Analysis

Audit date: 2026-06-12

Target architecture:

> Diagnose -> Classify -> Plan -> Risk-Classify -> Approve -> Execute One Step
> -> Verify -> Receipt -> Repeat

This document tracks the current OSS agent-loop architecture. It does not
authorize autonomous execution.

## Status Summary

| Capability | Status | Current repository state |
|---|---|---|
| Engineering constitution | Exists | `AGENTS.md` contains the complete agent-loop principles, approval boundary, one-step rule, verification rule, receipt rule, honest-stop rule, and OSS/Cloud boundary. |
| External health verification | Exists | `verify-url` and `up --external-health` record external-health attestations with explicit non-orchestration ownership and honest auth/unreachable classifications. |
| Agent planning | Planning-only foundation exists | `bootproof plan-agent` writes a strict local agent plan with evidence, risk-classified candidate actions, approvals, verification steps, and stop conditions. It executes no candidate action. |
| Shared action risk model | Exists | Deterministic repair and `plan-agent` use one strict action-risk classifier with canonical mutation scopes, approval prompts, blocked reasons, verification steps, a hard blocklist, and at-least-medium risk for unknown commands. |
| Airbyte runbook recognition | Exists | Planning identifies Airbyte from repository identity and structural evidence, emits the abctl-managed orchestration classifications, uses the shared high-risk Kubernetes model, marks credential access secret-sensitive, and plans external health verification without execution. |
| Local agent receipt chain | Exists for planning and verification | `plan-agent` creates a redacted run directory with hash-linked diagnosis, plan, and action receipts. Repository-scoped external health can append verification receipts, the derived final summary states ownership and stop status, and `explain-run` verifies the chain. Approved action execution remains intentionally unimplemented. |

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

External verification now provides `bootproof verify-url <url>` and
`bootproof up . --external-health <url>`. Its attestations use
`verificationMode: external-health`, set `bootproofOrchestrated: false`, and
classify successful HTTP 2xx/3xx observations as `external_service_verified`.
HTTP 401/403 is `auth_required`; connection and non-success responses are
`external_health_unreachable`.

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

The deterministic repair safety module is the shared action-risk contract used
by deterministic repair and `plan-agent`. It provides:

- canonical action type, mutation scope, risk, and approval fields;
- generated approval prompts, blocked reasons, and verification steps;
- deterministic high-risk classification for host installs, Kubernetes
  mutations, database migrations, and credential generation;
- at-least-medium classification for unknown commands;
- one hard blocklist before any command can become executable.

Deterministic repair actions remain sourced from `deterministic_playbook`.
`plan-agent` consumes the same classifier but remains planning-only.

### Receipt History

BootProof writes `.bootproof/attestation.json`,
`.bootproof/repair-receipt.json`, and, after a rerun,
`.bootproof/repair-after-attestation.json`. Repair receipts are signed and bind
before/after attestations with hashes.

Repair files remain attempt-scoped. Agent planning now additionally creates a
run-scoped local chain under `.bootproof/agent-runs/<run-id>/`, where immutable
diagnosis, plan, action, and verification receipts link by SHA-256 hash.
`final-summary.json` records the current derived status, and
`bootproof explain-run <run-id>` verifies and explains the chain.

## Existing Agent Run Capability

- `.bootproof/agent-runs/<run-id>/`;
- redacted initial attestation and plan snapshots;
- per-action planning receipts;
- appendable verification receipts;
- previous-receipt SHA-256 links;
- a derived final summary;
- `bootproof explain-run <run-id>`.

Planning still executes nothing. No autonomous or approved action runner exists.

## Recommended Next Prompt Order

1. **Only after the receipt contracts are stable, add a human-driven
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
