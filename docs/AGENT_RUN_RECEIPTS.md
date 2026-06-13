# Agent Run Receipts

`bootproof plan-agent <path>` starts a local, redacted receipt chain under:

```text
.bootproof/agent-runs/<run-id>/
  initial-attestation.json
  agent-plan.json
  actions/<timestamp>-action.json
  verifications/<timestamp>-verification.json
  final-summary.json
```

Each immutable receipt contains its own SHA-256 hash and the previous receipt
hash. `final-summary.json` is a replaceable derived snapshot that points to the
last immutable receipt; it is not itself part of the chain.

Planning records candidate actions as not executed. It does not approve or run
them and cannot claim success. A later repository-scoped
`bootproof up . --external-health <url>` appends the observed verification to
the latest local run. The standalone `bootproof verify-url` command keeps its
existing file-free behavior.

Inspect and verify a run from the repository root:

```bash
bootproof explain-run <run-id>
```

The explanation distinguishes planning-only, approval stops, blocked actions,
external health verification, and BootProof-orchestrated verification. When
the initial modern attestation contains a valid
`bootproof/boot-skeleton/v1` object, the explanation also shows its safe
structural fields and fingerprint. Legacy attestations without `bootSkeleton`
remain valid.

Receipts are local only. BootProof redacts secret-like values and local username
paths before hashing and writing them. It performs no upload, telemetry, or
registry submission.

The machine schema is
[`schemas/agent-run-receipts-v1.schema.json`](schemas/agent-run-receipts-v1.schema.json).
