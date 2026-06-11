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

## Verified Repairs

For the small deterministic repair registry:

```bash
bootproof fix .
```

BootProof reuses a signature-valid failure only at the exact clean Git commit; otherwise it reproduces the failure in a temporary copy. It applies one known remediation there and reruns full verification. It emits a signed `bootproof/repair-receipt/v1` only when the before run failed and the after run observed successful HTTP health.

The original working tree is not edited. File changes are written as a reviewable patch under `.bootproof/`; the human decides whether to apply it.

Machine mode is:

```bash
bootproof fix . --json
```

It emits one `bootproof/repair-result/v1` object and exits `0` only when a verified receipt exists.

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

Explain and verify the signed result:

```bash
npx bootproof explain .bootproof/attestation.json
npx bootproof verify .bootproof/attestation.json
```

Run against a public GitHub repository:

```bash
npx bootproof up https://github.com/user/repo
```

BootProof clones credential-free HTTPS GitHub URLs into `.bootproof/remotes/` and retains the clone so its evidence and any generated files continue to exist. It inspects the clone but refuses to execute remote code until host execution is explicitly acknowledged:

```bash
npx bootproof up https://github.com/user/repo --provider local --unsafe-local
```

Review the inferred commands before using that acknowledgement. Add `--install` only when you also intend to run dependency installation and its lifecycle scripts. Remote `--dry-run` is refused before cloning because dry runs promise to write nothing.

Contributors working from this source repository can use `npm ci`, `npm run build`, and `npm link`. Those steps are not required for npm users.

## Honesty Contract

BootProof is constrained on purpose:

- no verified boot without an observed health signal
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
.bootproof/runtime/
docker-compose.bootproof.yml
.env.bootproof.example
```

`registry-entry.json` is written only by `bootproof attest export`.

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

BootProof does not upload attestations. A project can deliberately commit `.bootproof/` or export a redacted registry entry.

The Git-native registry and OIDC-backed trust model are designs in progress, not deployed services.

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

- additional remote source providers beyond public HTTPS GitHub repositories
- stronger multi-service orchestration
- broader Python, Go, Ruby, and Make execution support
- CI/OIDC-backed signing
- proof-linked badges and a verified public index

Unsupported paths should fail clearly, not magically.

## License

Apache-2.0
