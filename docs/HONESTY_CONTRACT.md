# BootProof Honesty Contract

BootProof's promise is not that every repository boots. Its promise is that the verdict matches the evidence.

## Non-Negotiable Rules

1. A run is `BOOTED` only after an HTTP health response is observed.
2. Skipped steps are never rendered as success.
3. Dry runs execute nothing, write nothing, and create no proof.
4. `.env`, `.env.local`, `.env.development`, and `.env.production` are never written or modified.
5. Secrets are never invented.
6. BootProof never silently patches project files to force startup.
7. Ambiguous workspaces are surfaced instead of guessed.
8. Generated files are referenced as generated evidence only when they were actually written.
9. Refusals and execution failures write signed failed attestations where a signer is available.
10. Failed attestations preserve available diagnostic evidence, redacted at capture before it is persisted. Registry export applies its own additional public-artifact redaction.
11. A process starting is not enough. A health signal must be observed.
12. Confidence describes evidence found, not predicted success.
13. An image-only Compose service does not prove the checked-out source. Compose application proof requires a repository-local build context, a published HTTP port, and an observed HTTP response.
14. A deterministic repair suggestion requires a signature-valid classified failed attestation.
15. Commands run only after the exact command, mutation scope, and risk are shown and the user types uppercase `Y`. JSON and CI modes never approve commands.
16. Repair generation never patches the user's working tree; applying a diff requires the separate explicit `apply-repair` command.
17. Repair diffs are restricted to boot-plumbing scope; application logic is never edited.
18. Declined, failed, progressed, and verified repair attempts remain distinct signed receipt states.
19. Explicit repair application requires a valid signed receipt and exact file preimages; stale or tampered receipts write nothing.

These behaviors are enforced by tests.

## Human And Machine Modes

Human mode:

```bash
bootproof up .
```

It explains:

- what happened
- why BootProof withheld proof
- a safe next step
- where the signed evidence lives

Machine mode:

```bash
bootproof up . --ci --json
```

It emits one JSON object and exits `0` only for an observed, health-verified boot. Human prose and ANSI colour are excluded from JSON output.

Both modes use the same inference, execution, classification, and signing engine.

## What An Attestation Proves

An attestation is a signed execution receipt containing repository state, environment metadata, the plan, observed steps, health candidates, and the result.

It can prove a narrow claim such as:

```text
HTTP 200 was observed at http://localhost:3000/
```

It does not prove:

- every feature works
- every dependency is production-ready
- every service in a platform is healthy
- another machine will produce the same outcome

A repository Compose receipt is equally narrow. `docker compose up -d` exit 0 proves only that Compose accepted the request. BootProof issues `BOOTED` only after HTTP responds. If health fails, it records Compose service state and logs where available.

## Verified Repairs

`bootproof fix` reads the latest signature-valid classified failure. The first interactive
command playbooks cover missing CMake and unavailable Redis; `RAILS_ENV` receives a safe
instruction only. Commands are structured argv, pass the safety validator, and require the
literal response `Y`. After an approved command, BootProof copies the repository to a temporary
sandbox and reruns the normal proof engine.

The original working tree is never used as the repair target. BootProof writes only its evidence under `.bootproof/`:

- the signed failed before attestation
- a human-reviewable patch when files changed
- the signed after attestation when a command was rerun
- the signed repair receipt recording suggestion, approval, application, progress, and verification

Declined, failed, and unverified attempts still produce receipts because failed attestations and
repair attempts are valuable. `verified` remains false unless the rerun observes healthy HTTP.
`progressed` is true only for verified health or a changed failure class.

`bootproof fix` never auto-applies a patch. `bootproof apply-repair` is a separate, explicit mutation command. It verifies the receipt signature, scope whitelist, signed content hashes, and current preimages before writing. A mismatch writes nothing.

See [REPAIR_RECEIPT.md](REPAIR_RECEIPT.md).

## Trust Levels

Current local runs use:

```text
local_developer_signed
```

Local attestations are useful evidence. CI/OIDC attestations are stronger supply-chain proof. BootProof does not pretend local laptop proof is enterprise CI proof.

`ci_oidc_signed` is reserved for future workload-identity-backed signing. BootProof does not emit it today.

## Network And Sharing

BootProof itself does not upload telemetry or evidence.

Commands chosen from a repository, such as package installation or application startup, may perform their own network activity. That behavior belongs to the command being executed and should be reviewed before using `--install` or unsafe local execution.

Selecting `--provider docker` never authorizes host execution. If the inferred plan would require host-side install, build, migration, or application commands and no source-built repository Compose application can contain them, BootProof refuses with `orchestration_not_supported`.

Remote mode accepts only credential-free public HTTPS repository URLs from GitHub, GitLab, Bitbucket, and Codeberg. BootProof clones them into a retained `.bootproof/remotes/` workspace. Cloning does not authorize execution: a remote application command runs only with `--provider local --unsafe-local`.

The same rule applies to remote repair. Receipts and patches remain inside the retained clone. Applying a file repair requires naming that local clone with the separate `apply-repair` command.

Remote `--dry-run` is refused before cloning. A clone writes files, while the dry-run contract promises that nothing is written.

Sharing proof is deliberate: inspect and commit `.bootproof/`, or export a redacted registry entry.
