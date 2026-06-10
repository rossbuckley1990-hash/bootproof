# Bootproof

**The honest local run button. Proof that it boots.**

Bootproof inspects an unfamiliar repository, infers how it probably runs, starts what it safely can, verifies `localhost` actually responded — and writes a **signed attestation** of what really happened. When it cannot boot a repo, it says so, classifies why, and preserves the evidence.

Status: `v0.1.0-alpha`. Useful, local-first, zero runtime dependencies, and deliberately making no broad success-rate claims. The only claims Bootproof makes are per-run, observed, and signed.

```bash
git clone https://github.com/rossbuckley1990-hash/bootproof
cd bootproof && npm ci && npm run build && npm link   # npm package publishing is planned; name is reserved

bootproof analyze ~/code/some-repo        # evidence-based inference, nothing executed
bootproof plan ~/code/some-repo           # the exact plan and files it WOULD create
bootproof up ~/code/some-repo             # execute, verify localhost, sign proof
bootproof verify ~/code/some-repo         # check a committed attestation
bootproof explain .bootproof/attestation.json
bootproof attest export ~/code/some-repo  # redacted, re-signed shareable proof — never uploads
```

## The honesty contract

Every rule below is enforced by a test; breaking one fails the build. See [`docs/HONESTY_CONTRACT.md`](docs/HONESTY_CONTRACT.md).

- No green check without an observed event (exit code or HTTP status).
- `BOOTED` only when an HTTP response was actually observed at the health URL.
- Dry runs execute nothing, write nothing, prove nothing — and say so.
- `.env`, `.env.local`, `.env.development`, `.env.production` are **never** written.
- Secrets are never invented; you're told exactly which ones only you can provide.
- Host execution requires the explicit `--unsafe-local` acknowledgement. Docker is the default.
- Monorepo ambiguity is surfaced as a ranked choice, never guessed.
- Every failure is classified ([`docs/FAILURE_TAXONOMY.md`](docs/FAILURE_TAXONOMY.md)) with raw evidence preserved. Unknown failures say `unknown_failure`.

## What an attestation is

`bootproof up` writes `.bootproof/attestation.json`: a signed (ed25519) record of the repo commit, environment fingerprint, executed plan, every observed step with timestamps and exit codes, and either the observed health response or the classified failure. It claims only what was observed — `"HTTP 200 at http://localhost:3000/"` — never "the app works."

Commit it, and the next contributor (human or AI agent) can run `bootproof verify` to replay the proven plan instead of re-solving your repo from scratch. The long-term idea: **runnability becomes a cached, verifiable property of a repository — solved once, replayed by everyone — instead of a puzzle every contributor re-solves alone.**

## The registry (federated by design)

Bootproof performs **no network writes, ever** — no telemetry, no pings. The registry's write path is git itself: commit your attestation (or install the [CI workflow](docs/CI_ACTION.md) that refreshes it on every push) and your repo carries living, signed proof. The read path is an index that crawls public repos for these artifacts and verifies every signature. Open artifacts, verified aggregation — see [`docs/REGISTRY.md`](docs/REGISTRY.md). Failure evidence only travels redacted (`bootproof attest export` shows you exactly what would be shared, then leaves the sharing to you).

## What Bootproof generates

Only files with `bootproof` in the name, all standard formats that work without Bootproof installed:

- `docker-compose.bootproof.yml` — detected service dependencies (Postgres/MySQL/Redis/Mongo)
- `.env.bootproof.example` — suggested local values; secrets left for you; never auto-applied
- `.bootproof/attestation.json` — the signed proof

## Honest limitations (alpha)

- Node.js-ecosystem inference only; Python/Go/Ruby/Rust detection is not built yet.
- The app itself runs via your local toolchain (`--provider local --unsafe-local`) or alongside Docker-managed services; fully containerised app execution is in progress.
- One health URL per app; multi-service products verify their primary app only.
- Signature trust is TOFU (trust-on-first-use); a registry of verifiable signers is the roadmap, not the present.
- The failure taxonomy has 15 classes seeded from real-world evidence strings; it will be wrong sometimes, and `unknown_failure` + preserved evidence is the honest fallback.

Apache-2.0. Failures are product data — if Bootproof misclassifies or overclaims anything, that is a bug of the highest severity; please open an issue with the attestation attached.
