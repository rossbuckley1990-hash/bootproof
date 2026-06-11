# Registry Export Formats

BootProof supports local, redacted registry artifacts. It does not operate a public index from
this repository, upload evidence automatically, or call a registry service.

Create a local entry explicitly:

```bash
bootproof registry export .
```

This writes `.bootproof/registry-entry.json` using
`bootproof/registry-entry/v1`. `bootproof attest export .` remains a compatibility alias.

## Public/Federated Registry

Public repositories may explicitly create a public-candidate wrapper:

```bash
bootproof registry export . --federated
```

This writes a redacted, signed `bootproof/federated-receipt/v1` artifact under
`.bootproof/registry/`. A repository owner may review and deliberately commit that receipt to
the repository's own Git history.

A future BootProof indexer could crawl public receipts, verify signatures, and build an open
commons of verified boot, failure, and repair knowledge. The crawler and public index do not
exist in this repository and are not implemented by this command.

## Private Cloud Registry

Organisations may later explicitly upload redacted attestations and repair receipts to
BootProof Cloud. Private repository data would remain governed, tenant-isolated, and paid.

This repository only supports producing a `cloud_upload_candidate` local export. BootProof
Cloud, upload transport, billing, governance, and hosted registry storage are intentionally
not implemented here.

## Consent And Privacy

1. Every registry entry has `optInRequired: true`; federated wrappers contain that entry.
2. Export builders perform no network calls and do not upload telemetry or evidence.
3. Files are written only after an explicit export command.
4. Raw environment values, tokens, private keys, protected `.env` contents, and local username
   paths are excluded or redacted.
5. Repository owner and name identifiers are hashed; a public repository URL is included only
   when it is a credential-free URL on a supported public Git host.
6. Full local attestations may contain raw evidence and should not be treated as public exports.

The strict schemas are:

- [`schemas/registry-entry-v1.schema.json`](schemas/registry-entry-v1.schema.json)
- [`schemas/federated-receipt-v1.schema.json`](schemas/federated-receipt-v1.schema.json)
