# Git-Native Registry Design

BootProof does not operate a public registry service today.

The current primitive is portable signed evidence:

```text
.bootproof/attestation.json
```

Projects may deliberately commit that file or export a redacted entry:

```bash
bootproof attest export .
```

This writes:

```text
.bootproof/registry-entry.json
```

Nothing is uploaded automatically.

## Intended Design

The proposed registry model is federated:

- write path: repositories deliberately publish signed proof through Git
- read path: a future index discovers public attestations, verifies signatures, and links claims to source commits
- failure corpus: classified failures improve detectors without converting failures into success claims

The index, badge service, freshness tracking, and signer trust graph are roadmap items. They are not deployed capabilities.

## Consent And Privacy

1. BootProof sends no telemetry or hidden evidence upload.
2. Sharing requires a visible local artifact and an explicit user action.
3. Full local attestations may contain raw failure evidence.
4. Registry export applies redaction and records which redactions were used.
5. A future index should trust only valid signatures and public evidence.

Repository commands executed by BootProof may access the network independently. The no-upload promise applies to BootProof's own telemetry and evidence handling, not arbitrary install or application commands.

## Trust

Current attestations are `local_developer_signed`.

CI/OIDC-backed proof will be stronger because a verifier can bind the signature to a repository workflow identity. BootProof does not claim that trust level yet.
