# The Bootproof registry: federated by design

## The problem with every obvious design

A registry that updates "automatically from every run" implies the CLI phones home. For a trust-branded open-source tool that is fatal: silent telemetry betrays the honesty contract, opt-in uploads get single-digit participation, and a central database is paid infrastructure any fork can route around. Every direct path fails.

## The inversion

The attestation never needs to be *sent* — it is already *committed* somewhere public.

- **Write path = git.** `bootproof up` writes `.bootproof/attestation.json`. Developers commit it; the CI workflow (docs/CI_ACTION.md) refreshes it on every push. Committing to your own repository *is* the consent — there is nothing hidden to opt into.
- **Read path = the index.** The Bootproof index crawls public repositories for `bootproof/attestation/v1` and `bootproof/registry-entry/v1` documents, verifies every signature, discards anything invalid, and aggregates the result: which repos verifiably boot, on what environments, at which commits, and the live statistics of the failure taxonomy.

The artifacts are open by design (they are standard JSON in public repos; anyone may read them). The moat is not the data's existence — it is the **verified aggregation**: the index, its freshness, the signer trust graph, and the taxonomy statistics that come from operating it. The same shape as Go's module index, certificate-transparency logs, and code-search engines: open commons, defensible indexer.

## Consent and privacy rules (non-negotiable)

1. The CLI performs **no network writes, ever**. Not opt-out telemetry, not "anonymous pings". Nothing.
2. Sharing is a deliberate act with a visible artifact: `bootproof attest export` writes a **redacted, re-signed** registry entry locally and tells you exactly what is in it; *you* commit it.
3. Failure evidence may contain secrets, so it only travels in redacted form (src/redact.ts), and the entry lists which redactions were applied.
4. The index only reads what is already public, verifies before trusting, and links every claim back to its source repository.

## What this yields

Each repo's boot problem is solved once, by whoever solves it first, and the solution is cached in the repo itself — verified, signed, replayable by the next human or AI agent with `bootproof verify`. The world stops doing O(users × repos) setup work; the index makes the solved set discoverable; and the corpus of classified failures continuously improves the taxonomy that ships in the next release.
