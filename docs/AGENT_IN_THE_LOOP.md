# Agent-In-The-Loop Architecture

Works on my machine is dead.

No proof, no green check.

Predictable failure is a feature.

BootProof turns AI repo onboarding from a hallucinated shell loop into a
verified execution loop.

The distinction is evidence. A human or AI may suggest that a package should be
installed, a service started, or a command rerun. A suggestion is not proof.
Command completion is not proof. Planning is not proof. BootProof establishes a
successful result only through the verification contract, such as an observed
healthy HTTP response.

## The Loop

```text
Diagnose → Classify → Plan → Risk-Classify → Approve
→ Execute One Step → Verify → Receipt → Repeat
```

This is the target architecture and safety contract:

- diagnosis preserves observed evidence;
- classification names known failures and leaves unknown failures honest;
- planning proposes deterministic next actions;
- risk classification records mutation scope and approval requirements;
- approval applies to one exact local action, not a hidden chain;
- execution performs at most the approved step;
- verification observes the result before any success claim;
- receipts preserve the local audit trail;
- repetition requires a new plan or approval decision.

The complete autonomous loop is not implemented. `plan-agent` is planning-only.
It writes candidate actions and receipts but executes no candidate command.
Deterministic repair implements a narrower, human-approved loop for registered
failures. Unknown or blocked actions stop.

## Current Modes

### Direct Orchestration

```bash
bootproof up .
```

For a supported repository, BootProof constructs a deterministic local plan,
executes the selected path, observes health, and writes a signed attestation.
If the repository requires unsupported, ambiguous, or unsafe orchestration,
BootProof refuses and preserves the failure evidence.

`bootproof up` is zero-AI. It never treats an AI judgment as execution evidence.

### External Verification

```bash
bootproof verify-url http://localhost:8001/api/v1/health
```

This mode verifies a service managed outside BootProof. It records the HTTP
status, safe headers, response snippet, timestamp, and connection evidence.
A successful result is `external_service_verified`, with
`bootproofOrchestrated: false`.

External verification proves only that the endpoint responded according to the
health contract. It does not prove that BootProof started the application.

For repository-scoped evidence, use:

```bash
bootproof up . --external-health http://localhost:8001/api/v1/health
```

### Agent Planning

```bash
bootproof plan-agent .
```

Planning inspects repository evidence and existing attestations, then writes:

- `.bootproof/agent-plan.json`;
- a redacted receipt chain under `.bootproof/agent-runs/<run-id>/`;
- candidate actions with risk, mutation scope, approval, verification, and stop
  fields.

It does not execute candidate actions. It does not claim the repository booted.
Use `bootproof explain-run <run-id>` to inspect the local chain.

### Deterministic Repair

```bash
bootproof fix
```

Deterministic repair reads a signature-valid classified failure and selects only
registered playbook actions. It shows the exact command or patch, mutation
scope, and risk. Commands and patches that require approval run only after the
literal response `Y`.

The repair path records declined, failed, progressed, and verified outcomes.
Only observed health can set the verified result.

## Airbyte Case Study

Airbyte demonstrated why BootProof needs more than a universal run command.

1. BootProof inspected the repository and refused direct orchestration.
2. Repository evidence showed that local Airbyte deployment required `abctl`,
   `kind`, Helm, Kubernetes, Docker, and local authentication.
3. A human followed the documented Airbyte runbook and started the application
   outside BootProof.
4. The resulting service exposed
   `http://localhost:8001/api/v1/health`.
5. BootProof external verification observed a successful response from that
   endpoint without claiming it ran `abctl` or started Airbyte.

This is a successful honesty outcome. BootProof withheld a false green check,
the manual runbook handled orchestration, and the health endpoint supplied
proof of the externally managed service.

**Airbyte validates the design of the loop, not full autonomous execution yet.**

BootProof currently recognizes the Airbyte runbook in planning mode. It may
describe `abctl local install --port 8001` as a high-risk,
approval-required Kubernetes action, but it does not execute Airbyte, abctl,
kind, Helm, Kubernetes, or credential commands through `plan-agent`.

Airbyte-style repositories are externally orchestrated. BootProof may produce a
local plan and may verify an already-running documented health endpoint, but it
must not silently create or mutate a cluster. Cluster-level actions, including
`abctl local install`, `kind create cluster`, and `helm install`, are high-risk
and require explicit approval. CI planning remains non-interactive and executes
none of those candidate actions.

## Open-Source Boundary

The public repository owns the local brakes and trust layer:

- local diagnosis;
- local planning;
- local receipts;
- local approvals;
- optional BYOK AI suggestions, when implemented, using the same redaction,
  risk, approval, verification, and receipt model;
- no telemetry, hidden upload, or automatic receipt submission.

BYOK AI is optional and must remain outside `bootproof up`. AI output is
untrusted input: it may suggest, but BootProof must prove.

The local proof engine must work offline without a Cloud account.

## Cloud Boundary

BootProof Cloud is a separate private product boundary for:

- hosted AI;
- shared registry;
- team approval workflows;
- GitHub App;
- SSO/RBAC;
- policy;
- fleet dashboards;
- audit retention.

This public repository does not implement those capabilities. Registry or
evidence upload must remain explicit and opt-in; no Cloud service is required
for local diagnosis, planning, receipts, repair, or proof.
