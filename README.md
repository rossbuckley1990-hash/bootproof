# BootProof

> **The honest Run Button for repos — with proof, not vibes.**

BootProof looks at any repository, works out how it's supposed to run, starts what it safely
can, and tells you the truth: a signed **BOOTS** receipt when localhost actually responded,
or an honest, classified explanation of exactly why it didn't.

```text
No proof, no green check.
```

<p align="center">
  <img src="https://raw.githubusercontent.com/rossbuckley1990-hash/bootproof/main/assets/bootproof_viral_demo.gif" alt="BootProof demo" width="900">
</p>

---

## Try it in 60 seconds

**You need:** Node 20.11+ and git. (Docker is optional — only used for service containers
like Postgres.) Nothing to install: `npx` fetches BootProof on the fly.

### Step 1 — X-ray any repository (nothing is executed)

```bash
npx bootproof up https://github.com/usememos/memos
```

BootProof clones it for inspection and gives you the diagnosis in seconds: the stack, the
package manager and exact version it expects, the services it needs, the secrets only you
can provide, and which folder the real app lives in. **No code from the repository runs.**
This step is safe to point at anything.

### Step 2 — actually run it (your explicit choice)

Step 1 ends by stopping on purpose:

```text
✗ NOT VERIFIED
Why BootProof refused: A remote clone is untrusted code, and BootProof requires
explicit acknowledgement before running it on the host.
```

That stop is the product working, not breaking — BootProof never runs a stranger's code
without your yes. To give it:

```bash
npx bootproof up https://github.com/usememos/memos --provider local --unsafe-local
```

Plain English: `--provider local --unsafe-local` means *"I understand this runs the
repository's own code on my machine, like running its README commands myself."* Only say it
to repositories you'd be willing to run by hand.

### Or start with a repo you already trust — your own

```bash
cd ~/code/my-project
npx bootproof up . --provider local --unsafe-local
```

Two outcomes, both honest:

```text
✓ BOOTED — HTTP 200 at http://localhost:3000/ (observed, signed)
Evidence: .bootproof/attestation.json
```

or

```text
✗ NOT VERIFIED — package_manager_version_mismatch
The repository requires pnpm 10.24, but this environment has 9.15.4.
Enable Corepack (corepack enable) and rerun.
```

Either way you get a signed receipt in `.bootproof/` recording exactly what was observed.

---

## What the output is telling you

- **Inference** — everything BootProof worked out from evidence, with the evidence named.
  When it's guessing, it says so (`port: 3000 (default assumption; not evidence-based)`).
- **secrets you must provide** — keys like `API_SECRET` that have no safe local value.
  BootProof will never invent them, and **never writes your `.env` files. Ever.**
- **BOOTED** — printed only when an HTTP response was actually observed at localhost.
- **NOT VERIFIED — `<failure_class>`** — an honest, classified failure with the raw
  evidence preserved in the receipt and a concrete next step. The classes are documented in
  [docs/FAILURE_TAXONOMY.md](docs/FAILURE_TAXONOMY.md).

## The honesty contract

Every promise below is enforced by a test — breaking one fails our build:

- No green check without an observed event. Dry runs say "would" and prove nothing.
- `BOOTED` only when localhost actually responded.
- Your `.env`, `.env.local`, and friends are never written or modified.
- Secrets are never invented.
- Running repository code on your machine always requires your explicit consent.
- Every failure is classified with evidence preserved; unknowns say `unknown_failure`.
- Receipts are signed (ed25519); a tampered result fails verification.

Full text: [docs/HONESTY_CONTRACT.md](docs/HONESTY_CONTRACT.md)

## Commands

| Command | What it does | Runs repo code? |
|---|---|---|
| `bootproof up <path or url>` | Diagnose, and (with consent) boot + verify + sign a receipt | Only with `--unsafe-local` |
| `bootproof analyze <path>` | The diagnosis only | No |
| `bootproof plan <path>` | What it *would* do — every line says "would" | No |
| `bootproof verify <path>` | Check a receipt's signature and claims | No |
| `bootproof explain <receipt>` | Plain-language walkthrough of a receipt | No |
| `bootproof attest export <path>` | Redacted, shareable copy of your receipt (never uploads) | No |

Useful flags: `--install` (run dependency installation), `--port <n>`, `--timeout <ms>`,
`--workspace <dir>` (pick a monorepo app), `--dry-run`, `--json`, `--ci`.

## For machines and AI agents

```bash
bootproof up . --ci --json
```

One `bootproof/result/v1` JSON object on stdout, deterministic exit codes, fail-closed
behaviour, no prompts. An agent gets ground truth about whether code runs — from a tool
that is structurally unable to claim a boot it didn't observe.

## When something blocks you

| You see | It means | Do this |
|---|---|---|
| `requires explicit acknowledgement before running` | The consent gate — by design | Rerun the same command with `--provider local --unsafe-local` |
| `package_manager_version_mismatch` | Repo wants a different pnpm/yarn/npm | `corepack enable`, then rerun |
| `docker_unavailable` | Repo needs service containers; Docker isn't running | Start Docker Desktop, or skip services for now |
| `not_an_application` | It's a library — nothing to boot | Point at an app, or a `--workspace` that is one |
| `workspace_ambiguous` | Monorepo with several apps | Rerun with `--workspace <dir>` from the listed candidates |
| `missing_env_var` | The app needs secrets only you have | Copy `.env.bootproof.example`, fill the named keys yourself |
| `port_in_use` | Something else owns the port | Rerun with `--port <free port>` |

Anything else: the receipt at `.bootproof/attestation.json` preserves the raw evidence —
`bootproof explain` it, or open an issue with the receipt attached. A confusing failure is
a bug we want.

## Honest limitations (v0.1)

Node.js applications boot end-to-end today; Python is partially supported; Go and Ruby get
a full diagnosis but not orchestration yet — BootProof tells you so explicitly rather than
pretending. Docker is used for service containers, not yet for running the app itself. One
health URL per app. These are roadmap items, not hidden surprises.

## Receipts, and where this is going

Commit `.bootproof/` and your repository carries living, replayable proof that it boots —
the next contributor (human or AI) runs `bootproof verify` instead of re-solving your setup
from scratch. BootProof itself never uploads anything, ever: no telemetry, no pings.
Sharing proof is always your deliberate act. Design: [docs/REGISTRY.md](docs/REGISTRY.md).

Apache-2.0. Built in Huddersfield. If BootProof ever overclaims anything, that is our
highest-severity bug — please open an issue with the receipt attached.
