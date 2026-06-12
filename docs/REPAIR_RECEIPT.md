# Repair Receipts

`bootproof fix` treats the normal BootProof verdict as the oracle. The deterministic MVP reads
the latest signature-valid classified failure and maps only exact known evidence to a repair
action. It never uses AI.

Receipts preserve the complete lifecycle:

- suggested
- approved or declined
- applied or failed
- progressed or unchanged
- verified or unverified

Declined and failed attempts are valuable evidence, so they also produce signed receipts.
Only observed healthy HTTP sets `verified: true`. Progress without verification requires a
different after failure class.

## Schema

```text
bootproof/repair-receipt/v1
```

The strict machine schemas are:

- [`schemas/repair-action-v1.schema.json`](schemas/repair-action-v1.schema.json)
- [`schemas/repair-receipt-v1.schema.json`](schemas/repair-receipt-v1.schema.json)

The v1 receipt now includes additive safety-foundation fields: the deterministic proposed
action, mutation scope, risk level, approval requirement, apply result, progress and
verification booleans, and redaction record. Existing signed verification fields remain for
backward-compatible inspection and application.

```json
{
  "schema": "bootproof/repair-receipt/v1",
  "tool": "bootproof@0.3.0",
  "repo": {
    "remote": null,
    "commit": null,
    "dirty": null
  },
  "environment": {
    "os": "darwin 25.4.0",
    "arch": "arm64",
    "node": "v22.0.0"
  },
  "failure": {
    "class": "service_port_allocated",
    "beforeAttestationSha256": "..."
  },
  "repair": {
    "id": "remap-conflicting-service-port",
    "kind": "plan-step",
    "description": "...",
    "diff": null,
    "filesChanged": [
      "docker-compose.bootproof.override.yml"
    ],
    "fileChanges": [
      {
        "path": "docker-compose.bootproof.override.yml",
        "beforeSha256": null,
        "afterSha256": "...",
        "beforeContent": null,
        "afterContent": "..."
      }
    ],
    "preconditions": [
      {
        "path": "docker-compose.yml",
        "sha256": "..."
      }
    ],
    "planDelta": "...",
    "envDelta": null
  },
  "verification": {
    "before": {
      "booted": false,
      "failureClass": "service_port_allocated",
      "attestationSha256": "..."
    },
    "after": {
      "booted": true,
      "healthObservation": "HTTP 200 at http://localhost:4000/",
      "attestationSha256": "..."
    }
  },
  "startedAt": "...",
  "finishedAt": "...",
  "signer": {
    "publicKey": "...",
    "algorithm": "ed25519"
  },
  "signature": "..."
}
```

The receipt uses the same Ed25519 canonical-body pattern as attestations: `signer` and `signature` are excluded from the signed body. Tampering with the repair, before result, or after result invalidates verification.

`beforeAttestationSha256` and both verification hashes are SHA-256 hashes of the corresponding attestation JSON objects.

`fileChanges` is a signed application manifest. It contains only allowlisted boot-plumbing files and binds the expected preimage and verified after-content to SHA-256 hashes. `preconditions` binds read-only source inputs, such as the repository Compose file from which a repaired copy was derived.

## Result Interface

```bash
bootproof fix . --json
```

emits exactly one:

```text
bootproof/repair-result/v1
```

Exit `0` means the rerun observed healthy HTTP. A declined, failed, progressed-but-unverified,
unknown, or inapplicable remediation exits `1`, even when a signed receipt was written.

`bootproof fix . --dry-run` executes nothing, writes nothing, and produces no proof.

Local sandbox execution still requires:

```bash
bootproof fix . --provider local --unsafe-local
```

Remote repair accepts credential-free public HTTPS repositories from GitHub, GitLab, Bitbucket, and Codeberg and keeps all evidence in the retained clone:

```bash
bootproof fix https://github.com/user/repo --provider local --unsafe-local
```

Cloning is not execution consent. The existing local execution acknowledgement remains mandatory.

Human command repairs show:

```text
This repair may modify your local machine or services.
Command: <exact command>
Risk: medium
Run this command? Type Y to approve:
```

Only uppercase `Y` approves. JSON and CI modes never prompt and never execute a repair command.

## Explicit Application

Repair generation and repair application are separate operations:

```bash
bootproof apply-repair .
```

Application exits `0` only after all signed file changes are written and re-hashed. It writes nothing when:

- the receipt signature is invalid
- a path is outside the repair allowlist
- signed content hashes are inconsistent
- a signed read-only repair prerequisite changed
- the current file preimage differs from the verified preimage
- the receipt is environment-only or plan-only

`bootproof apply-repair . --dry-run` writes nothing. No repair is ever auto-applied by `bootproof fix`.

## v0.3 Registry

| Failure class | Deterministic remediation |
|---|---|
| `missing_build_tool` with exact CMake evidence | Propose `brew install cmake` as a host mutation requiring approval. |
| `redis_unavailable` | Propose `brew services start redis` when Homebrew is detectable; otherwise emit a generic instruction. |
| `missing_env_var` for only `RAILS_ENV` | Emit `RAILS_ENV=development bootproof up . --provider local --unsafe-local --install` as a non-executed instruction. |
| `service_port_allocated` | Remap a BootProof-generated Compose host port, or create a complete BootProof-owned repaired Compose copy beside the repository file without editing it. |
| `package_manager_version_mismatch` | Run the exact declared `corepack prepare <manager>@<version> --activate` command in the sandbox. |
| `migrations_missing` | Select one exact migration framework from repository markers plus preserved evidence: Prisma, Django, Rails, Knex, or Drizzle. Ambiguous matches refuse instead of guessing. |

There are no LLM calls in the repair registry.

Local host execution still requires `--unsafe-local`, and `fix` never auto-applies a repair. These are honesty boundaries. The separate application command exists so mutation is deliberate and independently verified.

## Files

Repair output is kept in the original repository's BootProof output directory:

```text
.bootproof/attestation.json
.bootproof/repair-receipt.json
.bootproof/repair-after-attestation.json
.bootproof/repair-<id>.patch
```

The patch is present only when the repair produced a repository or repaired-Compose file change. Plan-only and environment-only repairs may have no patch.

The after attestation exists only when an approved command triggered a rerun. It is retained so
progress and verification can be inspected independently.

## Allowed Scope

Repair file changes are hard-limited to:

- `package.json`, and only its `engines` or `packageManager` keys
- lockfiles
- `*.bootproof.*` files
- `.env*.example` files
- Compose override files created by BootProof

Application source is outside repair scope. A remediation that attempts to edit it throws an honesty-contract violation.

Repository Compose repair files are complete copies invoked directly. They do not rely on the version-specific `!override` merge tag, and they are written beside the source Compose file so relative build contexts keep the same base directory.
