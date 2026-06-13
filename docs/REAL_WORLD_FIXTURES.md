# Real-World Fixture Guide

BootProof uses small, synthetic fixtures to preserve lessons from real repository
testing without copying entire third-party repositories. A fixture captures only
the structural markers and minimal evidence needed to exercise an inference,
classification, safety decision, or verification path.

Predictions and examples are not proof. A fixture may show what BootProof should
infer or classify, but verified boot still requires observed health evidence from
the application or an explicitly external health endpoint.

## Why Fixtures Stay Small

Whole external repositories are unsuitable test fixtures because they:

- add large, unstable dependency trees;
- can contain copyrighted implementation details or vendor configuration;
- may expose secrets, usernames, local paths, or private operational data;
- change independently of BootProof and make tests nondeterministic; and
- can tempt tests to execute untrusted setup or orchestration commands.

BootProof fixtures instead use placeholder package names, empty marker files,
minimal manifests, and short synthetic evidence strings. They should reproduce
the shape of a failure, not the source repository.

## Coverage Map

The documentation seeds under
[`examples/registry-seeds/`](examples/registry-seeds/) summarize the current
real-world coverage:

| Seed | Representative repository class |
|---|---|
| `laravel-vite-sqlite` | Laravel backend with Vite assets and local SQLite setup |
| `rails-bundler` | Rails application with Ruby/Bundler runtime and native extension blockers |
| `php-composer` | Composer lockfile and vendor bootstrap failures |
| `go-ollama-service` | Go service with an evidenced command, port, and health contract |
| `airbyte-abctl-external-orchestrator` | Heavy external orchestration through abctl, kind, Helm, and Kubernetes |
| `sentry-devenv-direnv` | Large Python/Node hybrid with devenv and direnv setup |
| `monorepo-ambiguous-health` | Multiple plausible workspaces or health targets |
| `advertised-port-mismatch` | Process output advertises a different port from the inferred health candidate |

These JSON files use `bootproof/registry-seed-example/v1`. They are
documentation examples, not signed attestations, importable deterministic
playbooks, public corpus submissions, or production registry entries.

## Seed Fields

Each seed records:

- structural markers that may be represented by a minimal fixture;
- expected classifications or inference labels;
- a conservative safe next step;
- whether repair is approval-required or refused;
- whether the application is externally orchestrated;
- whether the described path can eventually support verified boot or only a
  failed/diagnostic receipt; and
- the observed evidence still required before any verified claim.

`repairDisposition: automatic` is reserved for non-mutating behavior. It must
never be used to authorize silent command execution, host mutation, database
mutation, or repository patches. Commands and patches remain approval-gated.

## Adding A Fixture Safely

1. Identify the smallest structural markers required for the behavior.
2. Write synthetic manifests and evidence instead of copying vendor files.
3. Remove real repository names when they are not necessary to the detector.
4. Use placeholders for hosts, package names, paths, and versions.
5. Never include `.env` contents, tokens, credentials, private keys, user data,
   private hostnames, or username-bearing local paths.
6. Add a focused test for the intended inference or classifier and at least one
   nearby case that must not be overclassified.
7. Keep commands inert in fixtures. Tests must not install tools, start external
   orchestrators, run migrations, or execute repository setup scripts.
8. Document whether the safe next step is approval-required or refused.
9. Require a real health observation before a test or example can represent a
   verified boot.

Public documentation may name a real repository family when that context is
useful, but it must not reproduce vendor config blobs, source files, private
incident data, or proprietary runbooks. Evidence strings should be the minimum
short patterns needed to explain classifier behavior.

## Evidence And Honesty

Classifiers must remain evidence-based and conservative. A marker can justify an
inference, and an exact failure string can justify a failure class, but neither
proves that the application booted.

BootProof may record a failed or diagnostic receipt when setup is incomplete,
orchestrator ownership is external, a workspace is ambiguous, or a health
candidate is wrong. It may report verified boot only after observed health
evidence satisfies the health contract.

For external orchestration, BootProof must state that it verified an
already-running service and must not claim that it started the application.

## Registry Boundary

Seed examples are local documentation only. Reading or testing them performs no
network calls, telemetry, upload, registry submission, Cloud API request, or
automatic file mutation. To produce a real redacted registry entry, use the
explicit local export workflow described in [REGISTRY.md](REGISTRY.md).

