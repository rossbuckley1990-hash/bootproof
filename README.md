# BootProof

[![CI](https://github.com/bootproof/bootproof/actions/workflows/ci.yml/badge.svg)](https://github.com/bootproof/bootproof/actions/workflows/ci.yml)

> **The honest Run Button for repos — with proof, not vibes.**

**Human diagnosis. Machine proof. One engine.**

```text
 bootproof up https://github.com/dubinc/dub

Remote source: https://github.com/dubinc/dub.git
Clone retained at: .bootproof/remotes/github.com/dubinc/dub-*/repo

Inference (evidence-based)
  application: yes
  package manager: pnpm.15.9
  selected command: pnpm dev

✗ NOT VERIFIED — remote_code_execution_blocked
Why BootProof refused: remote repositories are untrusted code and require explicit consent.

 bootproof up . --provider local --unsafe-local --install

✓ install: dependencies installed
✓ start-app: app process started and was supervised
✓ health: observed HTTP 200 at http://localhost:3333

✓ BOOTED — HTTP 200 at http://localhost:3333
Evidence: .bootproof/attestation.json
```

BootProof inspects a local repository, builds an evidence-based run plan, executes only what it can justify, observes HTTP health, and writes a signed attestation for success or failure.

It does not turn every repository green. That would defeat the point.

```text
No proof, no green check.
```

**Works on my machine is dead.**

**Predictable failure is a feature.**

BootProof turns AI repo onboarding from a hallucinated shell loop into a
verified execution loop. AI or a human may propose the next step; BootProof
classifies risk, requires approval where appropriate, records what happened,
and relies on observed verification rather than confidence or command
completion.

## One engine. Two interfaces.

Humans run:

```bash
bootproof up .
```

They get a diagnosis and a runbook.

Machines run:

```bash
bootproof up . --ci --json
```

They get a signed verdict and a deterministic exit code.

The same engine powers both.

## Agent-In-The-Loop Architecture

The intended safety loop is:

```text
Diagnose → Classify → Plan → Risk-Classify → Approve
→ Execute One Step → Verify → Receipt → Repeat
```

The complete autonomous loop is not implemented. Today BootProof exposes four
honest modes:

### 1. Direct Orchestration

```bash
bootproof up .
```

BootProof infers a supported local run path, executes it within the selected
safety boundary, observes health, and writes an attestation. Unsupported or
ambiguous orchestration is refused.

### 2. External Verification

```bash
bootproof verify-url http://localhost:8001/api/v1/health
```

BootProof observes a service started outside BootProof. Successful evidence is
classified as externally verified and never claims BootProof started the
application.

### 3. Agent Planning

```bash
bootproof plan-agent .
```

BootProof writes a deterministic, risk-classified plan and a redacted local
receipt chain. It does not execute candidate actions and planning never counts
as success.

### 4. Deterministic Repair

```bash
bootproof fix
```

BootProof maps exact known failures to deterministic repair actions. Mutating
commands and patches require explicit approval; verification decides whether
the failure progressed or the application booted.

See [docs/AGENT_IN_THE_LOOP.md](docs/AGENT_IN_THE_LOOP.md) and
[docs/AGENT_RUN_RECEIPTS.md](docs/AGENT_RUN_RECEIPTS.md).

## Airbyte Case Study

Airbyte correctly exceeded BootProof's direct orchestration boundary. BootProof
refused instead of pretending a normal Gradle, Make, or Compose command was
enough. The documented local path required `abctl`, `kind`, and `helm`; a human
followed that runbook and booted the application. BootProof could then verify
the external health endpoint without claiming ownership of the startup.
External verification proved that the documented endpoint responded
successfully; it did not prove BootProof orchestrated Airbyte.

That refusal plus external proof is a successful outcome: the verdict matches
what BootProof actually observed.

**Airbyte validates the design of the loop, not full autonomous execution yet.**

## Verified Repairs

For the small deterministic repair registry:

```bash
bootproof fix .
```

BootProof reads the latest signature-valid classified failure and maps exact known failures to
deterministic actions. Host and service commands show the exact command, scope, and risk, and
run only when the user types uppercase `Y`. JSON and CI modes never approve commands.

The deterministic registry also covers exact Ruby, native-extension, repository config,
PostgreSQL service/role/schema/version, and supported database-section failures. Multi-step
repairs expose one separately approved action per run; patches are previewed and tested only in
the repair sandbox. Signed receipts distinguish declined, failed, progressed, and verified outcomes.

Machine mode is:

```bash
bootproof fix . --json
```

It emits one `bootproof/repair-result/v1` object and exits `0` only when a verified receipt exists.

Public GitHub, GitLab, Bitbucket, and Codeberg repositories use the same retained managed workspace and execution gate as `up`:

```bash
bootproof fix https://github.com/user/repo --provider local --unsafe-local
```

`fix` never applies its patch. To explicitly apply a signature-valid file repair to a local working tree:

```bash
bootproof apply-repair .
```

Application checks the receipt signature, allowed file scope, signed content hashes, and exact current preimages before writing. Environment-only and plan-only receipts have no file change to apply.

See [docs/REPAIR_RECEIPT.md](docs/REPAIR_RECEIPT.md).

## What It Tells Humans

A failed run is still useful:

```text
NOT VERIFIED — package_manager_version_mismatch
What happened: The repository requires pnpm 10.24.0, but this environment has pnpm 9.15.4.
Why BootProof refused: The dependency install cannot be trusted with the wrong package manager version.
Safe next step: Run corepack enable && corepack prepare pnpm@10.24.0 --activate, then rerun BootProof.
Evidence: .bootproof/attestation.json
```

BootProof distinguishes diagnosis from proof. It can execute a narrow explicit Go main package, Rails `bin/rails` entrypoint, or Make run target, but detection alone never implies general support for every Go, Ruby, Make, Python, or monorepo architecture.

## What It Gives Machines

`--json` emits exactly one `bootproof/result/v1` object to stdout:

```json
{
  "schema": "bootproof/result/v1",
  "booted": false,
  "healthVerified": false,
  "failureClass": "dependency_install_skipped",
  "attestationPath": ".bootproof/attestation.json",
  "inference": {},
  "plan": {},
  "observed": []
}
```

`--ci` disables colour and interactive output. Exit codes are deterministic:

- `0`: `booted === true` and `healthVerified === true`
- `1`: every refusal, ambiguity, install failure, service failure, app failure, or health failure

## Quick Start

Run against a local repository:

```bash
cd /path/to/repository
npx bootproof up .
```

Host execution can be selected explicitly:

```bash
npx bootproof up . --provider local --unsafe-local
```

Run dependency installation only when intended:

```bash
npx bootproof up . --install
```

Verify an externally managed service without asking BootProof to start or
orchestrate it:

```bash
abctl local install --port 8001
bootproof verify-url http://localhost:8001/api/v1/health
```

To retain the same observation as `.bootproof/attestation.json` for the current
repository:

```bash
bootproof up . --external-health http://localhost:8001/api/v1/health
```

External health accepts observed HTTP 2xx and 3xx responses. HTTP 401/403 is
reported as `auth_required`; connection failures are
`external_health_unreachable`. These results always set
`bootproofOrchestrated: false` and never claim BootProof started the service.

Explain and verify the signed result:

```bash
npx bootproof explain .bootproof/attestation.json
npx bootproof verify .bootproof/attestation.json
```

Run against a public HTTPS Git repository on GitHub, GitLab, Bitbucket, or Codeberg:

```bash
npx bootproof up https://github.com/user/repo
```

BootProof clones credential-free HTTPS URLs from those named providers into `.bootproof/remotes/` and retains the clone so its evidence and any generated files continue to exist. It inspects the clone but refuses to execute remote code until host execution is explicitly acknowledged:

```bash
npx bootproof up https://github.com/user/repo --provider local --unsafe-local
```

Review the inferred commands before using that acknowledgement. Add `--install` only when you also intend to run dependency installation and its lifecycle scripts. Remote `--dry-run` is refused before cloning because dry runs promise to write nothing.

Contributors working from this source repository can use `npm ci`, `npm run build`, and `npm link`. Those steps are not required for npm users.

## Honesty Contract

BootProof is constrained on purpose:

- no verified boot without an observed health signal
- no Docker-to-host execution fallback; host commands require `--provider local --unsafe-local`
- no success rendering for skipped steps
- no invented secrets
- no writes to `.env`, `.env.local`, `.env.development`, or `.env.production`
- no silent project patching
- no guessed workspace when the repository is ambiguous
- no claim that generated scaffolding exists unless it was written
- signed failed attestations for refusals and execution failures
- raw local evidence preserved in the attestation
- no telemetry or hidden evidence upload

See [docs/HONESTY_CONTRACT.md](docs/HONESTY_CONTRACT.md).

## Open-Source Boundary

This repository contains the local trust layer:

- local diagnosis
- local planning
- local receipts
- local approvals
- optional BYOK AI suggestions belong in this boundary if implemented, subject
  to the same safety model and kept outside `bootproof up`
- no telemetry or automatic upload

The OSS engine works offline and does not require BootProof Cloud.

## Cloud Boundary

BootProof Cloud belongs in a separate private repository. Its boundary includes:

- hosted AI
- shared registry
- team approval workflows
- GitHub App
- SSO/RBAC
- policy
- fleet dashboards
- audit retention

These are product boundaries, not claims that those services are implemented
in this public repository. No Cloud/SaaS code is included here.

## Current Capabilities

BootProof currently provides:

- Node package-manager and start-command inference
- conservative Go main-package, Rails `bin/rails`, and explicit Make run-target execution
- Python/Flask and Go/Node hybrid detection
- monorepo candidate ranking
- Docker service dependency detection and scaffolding
- repository Compose execution when a web service builds the checked-out source and publishes an HTTP port
- localhost health-candidate discovery from repository evidence and app logs
- classified failures
- signed Ed25519 attestations
- strict JSON and fail-closed CI output
- redacted registry-entry export
- deterministic sandboxed repairs with signed before/after receipts for the registered v0.3 classes
- explicit repair application with signature, scope, and stale-preimage checks
- marker-and-evidence-backed migration repair for Prisma, Django, Rails, Knex, and Drizzle

Detection is broader than orchestration. For example:

- Superset-like Python/Flask/React/Celery repos are detected, then honestly refused with `python_flask_setup_required`.
- Grafana-like Go/Node hybrids are detected without pretending a frontend watcher is the whole application.
- Parallel monorepo root commands are refused until a specific workspace is selected.
- Image-only or infrastructure-only Compose services are not accepted as proof of the checked-out source.

The supported repository entrypoints are deliberately narrow:

- Go: exactly one `main.go` or `cmd/*/main.go`
- Ruby: `Gemfile` plus `bin/rails`
- Make: an explicit `run`, `serve`, `server`, `start`, or `dev` target
- Compose: a service with a repository-local build context and a published HTTP port

Each path still requires an observed HTTP response. A successful Compose `up -d`, process spawn, or command exit is not a green result by itself.

## Files Written

Depending on the observed plan, BootProof may write:

```text
.bootproof/attestation.json
.bootproof/registry-entry.json
.bootproof/registry/<timestamp>-<hash>.json
.bootproof/runtime/
docker-compose.bootproof.yml
.env.bootproof.example
```

Registry artifacts are written only by explicit `bootproof registry export` or
`bootproof attest export` commands. Federated public-candidate receipts require
`bootproof registry export . --federated`.

Docker and env guidance files are listed in proof only when BootProof actually generated them.

Protected application env files remain untouched.

## Attestation Trust

Current attestations contain:

```json
{
  "trust": {
    "level": "local_developer_signed",
    "signer": "local_ed25519",
    "oidc": null
  }
}
```

Local attestations are useful evidence. CI/OIDC attestations are stronger supply-chain proof. BootProof does not pretend local laptop proof is enterprise CI proof.

The future `ci_oidc_signed` level is reserved but is not emitted today.

## Failure Taxonomy

Examples include:

- `not_an_application`
- `workspace_ambiguous`
- `dependency_install_skipped`
- `package_manager_version_mismatch`
- `python_flask_setup_required`
- `service_port_allocated`
- `postgres_auth_env_missing`
- `health_http_error`
- `health_check_timeout`
- `unknown_failure`

Unknown failures remain unknown, with evidence preserved for the next detector.

See [docs/FAILURE_TAXONOMY.md](docs/FAILURE_TAXONOMY.md).

## Real Repository Evidence

BootProof records both useful successes and useful failures. The evidence ledger does not relabel failure as support.

See [docs/REAL_REPO_EVIDENCE.md](docs/REAL_REPO_EVIDENCE.md).

## CI And Registry

BootProof does not upload attestations. A project can deliberately export a redacted local
registry entry or a federated public-candidate receipt and review it before committing it.

The public crawler, private Cloud upload, and OIDC-backed trust model are future integrations,
not deployed services in this repository.

- [docs/CI_ACTION.md](docs/CI_ACTION.md)
- [docs/REGISTRY.md](docs/REGISTRY.md)

## Release Packaging

The npm package contains the compiled CLI, license, README, and docs. `dist/` is required at runtime, generated by `npm run build` during `prepack`, and intentionally not committed.

Run `npm run pack:check` to pack BootProof, install the tarball in an isolated temporary directory, and exercise the installed CLI. See [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

## Release Hygiene

`node_modules/`, `.DS_Store`, and generated `dist/` are ignored and not committed.

`dist/` is generated by `npm run build`. It is included in the npm package because `dist/cli.js` is the executable, and `npm pack`/publish runs the `prepack` build.

Repository metadata points to:

```text
https://github.com/rossbuckley1990-hash/bootproof
```

## What BootProof Is Not

BootProof is not a deployment platform, a general CI replacement, or a magic environment fixer.

It is the honest Run Button for repos. It runs what it can, refuses what it cannot prove, signs both success and failure, and gives humans and machines the same evidence.

## Status

BootProof is early alpha.

Near-term work includes:

- additional remote source providers beyond GitHub, GitLab, Bitbucket, and Codeberg
- broader deterministic remediation coverage
- stronger multi-service orchestration
- broader Python, Go, Ruby, and Make execution support
- CI/OIDC-backed signing
- proof-linked badges and a verified public index

Unsupported paths should fail clearly, not magically.

## License

Apache-2.0
