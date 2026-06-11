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
10. Failed attestations preserve available raw local evidence; exported registry entries redact it.
11. A process starting is not enough. A health signal must be observed.
12. Confidence describes evidence found, not predicted success.
13. An image-only Compose service does not prove the checked-out source. Compose application proof requires a repository-local build context, a published HTTP port, and an observed HTTP response.

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

Remote mode accepts only credential-free public HTTPS GitHub repository URLs. BootProof clones them into a retained `.bootproof/remotes/` workspace. Cloning does not authorize execution: a remote application command runs only with `--provider local --unsafe-local`.

Remote `--dry-run` is refused before cloning. A clone writes files, while the dry-run contract promises that nothing is written.

Sharing proof is deliberate: inspect and commit `.bootproof/`, or export a redacted registry entry.
