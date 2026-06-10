# Bootproof honesty contract

Bootproof's promise is not that every repository boots. The promise is that Bootproof never lies about what happened. These rules are enforced by tests in `tests/e2e.test.mjs`; a violation is a build failure, not a docs bug.

## Non-negotiable rules

1. **No green check without an observed event.** A `✓` is only printed for a step that executed and was observed (an exit code, an HTTP status). Plans and dry runs use `○ would:` language.
2. **A run is BOOTED only when an HTTP response was actually observed** at the health URL. The attestation records the exact status, URL, elapsed time and attempt count.
3. **Dry runs execute nothing, write nothing, and produce no proof.**
4. **`.env`, `.env.local`, `.env.development`, `.env.production` are never written or modified.** Bootproof writes only `*.bootproof.*` files. Attempting otherwise throws.
5. **Secrets are never invented.** Keys that look like secrets with no safe local default are listed as "you must provide this" — commented out, valueless.
6. **Failures are classified, evidenced, and preserved.** Every failed run or refusal writes a failed attestation with a taxonomy class and available evidence. Early refusals have no fabricated observed steps. Unclassifiable failures say `unknown_failure` — never a guess. Dry runs remain proof-free.
7. **Local (host) execution requires the explicit `--unsafe-local` acknowledgement.** No code path may downgrade docker to local silently.
8. **Monorepo ambiguity is surfaced, never guessed.** Multiple plausible apps means the user chooses.
9. **Attestations are signed; a tampered result fails verification.**
10. **Confidence scores describe evidence found, not predicted success**, and are labeled as such in output.

## What an attestation is

A signed record of observations: repo commit, environment fingerprint, the executed plan, each observed step with timestamps and exit codes, and the verified-or-classified-failure result. It claims only what was observed: "HTTP 200 at localhost:3000" — never "the app works."

Local attestations use trust level `local_developer_signed`. They are useful tamper-evident evidence from a developer machine, but they are not enterprise-grade CI proof. The reserved future level `ci_oidc_signed` will identify stronger CI/OIDC-backed supply-chain evidence; BootProof does not emit that level today.
