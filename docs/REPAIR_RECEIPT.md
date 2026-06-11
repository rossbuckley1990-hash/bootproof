# Repair Receipts

`bootproof fix` treats the normal BootProof verdict as an oracle. A signature-valid failed attestation is reused only when it identifies the exact current clean Git commit. Otherwise BootProof reproduces the failed run in a temporary copy. It applies one deterministic registered remediation there and reruns full verification.

No receipt is emitted unless both statements are signed evidence:

- before: the sandbox run failed with a classified failure
- after: the remediated sandbox run observed successful HTTP health

`bootproof fix` does not edit the original repository. A human may review the patch written under `.bootproof/` and explicitly invoke `bootproof apply-repair`.

## Schema

```text
bootproof/repair-receipt/v1
```

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

Exit `0` means a signed repair receipt was produced after observed HTTP health. Every unknown, inapplicable, failed, or unverified remediation exits `1`.

`bootproof fix . --dry-run` executes nothing, writes nothing, and produces no proof.

Local sandbox execution still requires:

```bash
bootproof fix . --provider local --unsafe-local
```

Remote repair accepts credential-free public HTTPS GitHub repositories and keeps all evidence in the retained clone:

```bash
bootproof fix https://github.com/user/repo --provider local --unsafe-local
```

Cloning is not execution consent. The existing local execution acknowledgement remains mandatory.

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
| `service_port_allocated` | Remap a BootProof-generated Compose host port, or create a complete BootProof-owned repaired Compose copy beside the repository file without editing it. |
| `package_manager_version_mismatch` | Run the exact declared `corepack prepare <manager>@<version> --activate` command in the sandbox. |
| `migrations_missing` | For Prisma evidence only, insert `npx prisma migrate deploy`, or `npx prisma db push --skip-generate` when no migrations directory exists. |

There are no LLM calls in the repair registry.

## Files

Successful repair output is kept in the original repository's BootProof output directory:

```text
.bootproof/attestation.json
.bootproof/repair-receipt.json
.bootproof/repair-after-attestation.json
.bootproof/repair-<id>.patch
```

The patch is present only when the repair produced a repository or repaired-Compose file change. Plan-only and environment-only repairs may have no patch.

The after attestation is retained so its signature and receipt hash can be inspected independently. Sandbox paths in that attestation describe where verification actually occurred.

## Allowed Scope

Repair file changes are hard-limited to:

- `package.json`, and only its `engines` or `packageManager` keys
- lockfiles
- `*.bootproof.*` files
- `.env*.example` files
- Compose override files created by BootProof

Application source is outside repair scope. A remediation that attempts to edit it throws an honesty-contract violation.

Repository Compose repair files are complete copies invoked directly. They do not rely on the version-specific `!override` merge tag, and they are written beside the source Compose file so relative build contexts keep the same base directory.
