# Boot Skeleton Fingerprint

BootProof attestations include a deterministic description of the repository's
boot-relevant structure:

```text
bootproof/boot-skeleton/v1
```

The skeleton records structural signals such as runtime and package-manager
families, safely known major versions, framework markers, start-command shapes,
health route shapes, Compose service topology, declared ports, environment
variable names, lockfile families, and workspace topology.

It deliberately excludes repository identity, source contents, prose, commit
SHAs, timestamps, absolute paths, machine-specific values, protected `.env`
contents, environment values, credentials, and other secrets.

BootProof canonicalizes object keys, arrays, and path separators before hashing
the skeleton with SHA-256. The fingerprint has this form:

```text
sha256:<64 lowercase hexadecimal characters>
```

Structurally equivalent repositories can therefore share a fingerprint even
when their names, paths, commits, or safe template values differ. A structural
change to the boot setup produces a different fingerprint.

## Honesty Boundary

The fingerprint is content-addressed structural evidence. It is not a
prediction, a success claim, or proof that a repository boots. BootProof does
not use fingerprint similarity to issue a green check. Verified boot still
requires observed health evidence.

This implementation performs no corpus lookup, prediction, telemetry, registry
submission, receipt upload, or Cloud call.

New attestations include and sign the `bootSkeleton` object. Existing signed
attestations without that optional field remain valid.
