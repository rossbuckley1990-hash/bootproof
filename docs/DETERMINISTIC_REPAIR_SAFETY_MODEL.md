# Deterministic Repair Safety Model

Status: foundation plus interactive MVP in progress. The shared action model, safety validation,
additive receipt schema, uppercase-`Y` approval, structured executor, and initial real-world
playbooks are implemented. Signed repair plans and action-hash approvals remain future work.

## Product Contract

BootProof proposes. The human approves. BootProof reruns. Proof decides.

`bootproof up` remains deterministic, zero-AI, and evidence-based. `bootproof fix` without
`--ai` is also deterministic and performs no mutation. It selects only registered local
playbooks whose predicates match signed failure evidence and repository facts.

The repair layer must not:

- execute a command or apply a patch during planning
- mutate protected `.env` files
- invent secrets
- use `sudo`
- execute a shell command string
- upload evidence, telemetry, receipts, or registry data
- turn an unknown failure into a guessed repair
- admit an AI suggestion into the deterministic playbook registry

## Current Gap

The current implementation already provides useful foundations:

- signed before and after attestations
- sandboxed deterministic remediation attempts
- signed `bootproof/repair-receipt/v1` artifacts
- exact file preimage checks
- a separate `bootproof apply-repair` command for repository file changes

The first MVP directly prompts for exact CMake and Redis commands and records instructions for
`RAILS_ENV`. Existing legacy sandbox remediations remain until the full planning model changes
the boundary:

1. `bootproof fix` plans only.
2. `bootproof apply-repair` is the only command or patch mutation entrypoint.
3. Approval binds to the exact action hash.
4. Host, service, and database actions require additional scope-specific acknowledgement.
5. The normal `bootproof up` engine reruns after an approved action.

## Repair Lifecycle

### 1. Find the attestation

By default, `bootproof fix <repo>` reads `.bootproof/attestation.json`. A future
`--attestation <path>` flag may select a different local file.

Planning continues only when:

- the schema is `bootproof/attestation/v1`
- the signature is valid
- `booted` and `healthVerified` are both false
- `failureClass` is present
- the attestation names the same repository remote and commit
- the Git working tree is clean and still at that commit

If freshness cannot be proved, `fix` refuses and tells the user to rerun `bootproof up`. It does
not reproduce the failure automatically because planning must execute nothing.

Non-Git repositories require a future signed repository snapshot manifest before they can use
an attestation as a repair-planning input. Until then, they receive an honest refusal.

### 2. Select candidates

Candidate selection is a pure lookup:

1. Look up the exact failure class in the deterministic playbook registry.
2. Validate required classifier metadata.
3. Inspect allowlisted repository files without executing them.
4. Evaluate platform and tool preconditions.
5. Construct zero or more immutable repair actions.
6. Run every action through the safety validator.
7. Sort candidates by stable playbook ID. Never silently choose between multiple candidates.

No candidate is built from free-form model output. An AI suggestion, if introduced separately
in the future, has `source: ai_suggestion` and can never be inserted into or executed through
the deterministic registry automatically.

### 3. Write a signed plan

`fix` writes `.bootproof/repair-plan.json` only after a candidate was deterministically
constructed. The plan uses `bootproof/repair-plan/v1`, contains the before-attestation hash,
repository identity, candidate actions, safety decisions, and a local Ed25519 signature.

```json
{
  "schema": "bootproof/repair-plan/v1",
  "createdAt": "...",
  "tool": "bootproof@0.3.0",
  "repo": {
    "remote": "...",
    "commit": "...",
    "dirty": false
  },
  "beforeAttestationHash": "...",
  "failureClass": "missing_ruby_version",
  "candidates": [],
  "optInRequired": true,
  "signer": {
    "publicKey": "...",
    "algorithm": "ed25519"
  },
  "signature": "..."
}
```

If no playbook matches, `fix` writes no executable action. It reports
`no_known_deterministic_repair` and preserves the original failed attestation.

### 4. Approve and apply one action

`bootproof apply-repair`:

1. verifies the plan signature and schema
2. verifies the selected action hash
3. verifies the original attestation signature and hash
4. verifies the repository commit and all action preconditions
5. reruns the safety validator immediately before mutation
6. requires the exact approval flags for the action's scope and risk
7. applies exactly one patch or executes exactly one structured command
8. reruns `bootproof up` with the attested provider and explicit execution consent
9. writes the after attestation and a signed repair receipt

An instruction action is never executable. The user follows it manually and reruns
`bootproof up`.

## Repair Action Schema

Implemented foundation schema: `bootproof/repair-action/v1`.

```json
{
  "schema": "bootproof/repair-action/v1",
  "actionType": "command",
  "mutationScope": "host_tool_install",
  "riskLevel": "high",
  "requiresApproval": true,
  "approvalPrompt": "This action may install or change tools on your local machine. Review the exact command before approving it.",
  "blockedReason": "",
  "verificationStep": "Rerun BootProof and require observed health evidence before marking progress.",
  "command": {
    "executable": "rbenv",
    "args": ["install", "3.3.11"],
    "display": "rbenv install 3.3.11"
  },
  "patch": null,
  "instruction": null,
  "explanation": "Install the exact Ruby version selected by the repository.",
  "evidenceRefs": [".bootproof/attestation.json"],
  "deterministic": true,
  "source": "deterministic_playbook"
}
```

Required enums:

```text
actionType: command | patch | instruction
mutationScope: none | repo_only | project_cache | container_runtime |
  host_tool_install | host_network | kubernetes_cluster | database |
  service | credentials | unknown
riskLevel: none | low | medium | high | blocked
```

Rules:

- `medium` and `high` actions always have `requiresApproval: true`.
- `none` and `low` actions may be displayed without approval.
- repository patches still require approval and use `mutationScope: repo_only`.
- instructions are not executable.
- `riskLevel: blocked` cannot have an executable command or applicable patch.
- unknown commands are at least `medium` risk and use `mutationScope: unknown`
  unless a stricter deterministic classification applies.
- the shared classifier assigns high risk to host installs, Kubernetes creation
  or application, database migrations, and credential generation.
- Exactly one of `command`, `patch`, or `instruction` is present.
- The future signed plan adds playbook identity, preconditions, progression rules, and an
  action hash around this validated action payload.

Patch actions contain:

```json
{
  "patch": {
    "format": "unified-diff",
    "content": "...",
    "files": ["config/database.yml"]
  }
}
```

The future signed repair plan binds patch hashes, preconditions, and transactional application
metadata around this exact payload. A failed post-repair boot does not silently roll back an
approved patch.

## Command Safety Model

Command actions are structured argv, never shell strings. Execution uses `execFile` or
`spawn` with `shell: false`.

No hidden chaining means:

- one executable
- one argument array
- no `sh -c`, `bash -c`, `zsh -c`, `cmd /c`, or PowerShell command strings
- no `;`, `&&`, `||`, pipes, redirects, command substitution, backticks, or newlines
- no arbitrary interpreter snippets such as `node -e`, `python -c`, or `ruby -e`

The blocklist is a mandatory backstop, not the allow mechanism. A command must first be
constructed by a named playbook with executable-specific argument validation. It is then
rejected if its normalized executable, arguments, display form, target paths, or environment
match any blocked rule.

Hard-blocked patterns include:

- `rm -rf`
- `sudo rm`
- any use of `sudo`
- `curl | sh`
- `wget | sh`
- `chmod -R 777`
- `chown -R`
- `mkfs`
- `diskutil erase`
- destructive database drops, including `dropdb`, `DROP DATABASE`, `DROP SCHEMA`,
  `rails db:drop`, migration reset commands, and equivalents
- commands that write a protected `.env`
- shell redirection into a protected `.env`
- secret exfiltration patterns
- upload of local secret files

Protected env paths include `.env`, `.env.local`, `.env.development`, `.env.production`, and
`.env.*.local`. Example templates may be patched only when the playbook explicitly permits
them and the content passes secret scanning.

Additional command rules:

- resolved executables inside the repository are not trusted as host tools
- host commands must resolve to a playbook-approved executable
- repository commands are untrusted code and retain the existing `--unsafe-local` gate
- command environment values are never embedded in plans or receipts
- inherited environment names may be recorded, but their values are not
- stdout/stderr evidence is redacted before entering receipts
- network-capable upload tools are not valid deterministic repair executables
- blocklist validation runs during planning and again immediately before execution

## Risk And Approval

Suggested approval interface:

```bash
bootproof apply-repair . \
  --action install-required-ruby \
  --approve <action-hash> \
  --allow-host-mutation
```

Required acknowledgements:

| Scope/risk | Required flags |
|---|---|
| `repo`, low/medium patch | `--approve <action-hash>` |
| `host` | `--approve <action-hash> --allow-host-mutation` |
| `service` | `--approve <action-hash> --allow-service-mutation` |
| `database` | `--approve <action-hash> --allow-database-mutation` |
| `high` | scope flag plus `--allow-high-risk` |
| `blocked` | never executable |

The approval hash binds consent to the exact command or patch shown by `fix`. Changing any
argument, patch byte, precondition, scope, or risk changes the hash and invalidates approval.

CI mode never prompts. Missing approval flags fail closed. Human mode should also prefer the
explicit flags over a generic `y/N` prompt so approval is reproducible and auditable.

## Command UX

Planning:

```text
$ bootproof fix .

NOT APPLIED - deterministic repair candidate
failure: missing_ruby_version
action: install-required-ruby
type: command
scope: host
risk: medium
exact command: rbenv install 3.3.11
approval required: yes
action hash: 8f...

Nothing was executed or mutated.
Plan: .bootproof/repair-plan.json
Apply explicitly:
  bootproof apply-repair . --action install-required-ruby \
    --approve 8f... --allow-host-mutation
```

Patch preview:

```text
$ bootproof fix .

NOT APPLIED - deterministic repair candidate
failure: missing_database_config
action: copy-database-config-example
type: patch
scope: repo
risk: medium

--- /dev/null
+++ b/config/database.yml
...

Nothing was executed or mutated.
```

Application:

```text
$ bootproof apply-repair . --action copy-database-config-example --approve 4a...

approved: exact patch hash 4a...
applied: config/database.yml
rerun: bootproof up . --provider local --unsafe-local
progress: missing_database_config -> postgres_unavailable
verified: no
receipt: .bootproof/repair-receipt.json
```

Only an observed healthy rerun prints:

```text
verified: yes - HTTP 302 Found -> /users/sign_in
```

Proposed exit behavior:

- `bootproof fix` exits `0` when it successfully produces a valid plan, and `1` when planning
  refuses or finds no deterministic candidate. Exit `0` means "plan created," never "booted."
- `bootproof apply-repair` exits `0` only for verified boot.
- `bootproof apply-repair` exits `2` when the action applied and reached an allowed later
  blocker but did not verify.
- `bootproof apply-repair` exits `1` for refusal, blocked action, failed application, or no
  measured progress.

Machine output must expose the lifecycle booleans so callers never need to infer boot proof
from prose or an action's process exit code.

## Progress Detection

Application and verification are separate facts.

`applied` means the approved patch completed or the approved command exited successfully.
It does not mean the repository boots.

`verified` means the after attestation has:

```text
booted: true
healthVerified: true
```

`progressed` is true when either:

1. `verified` is true; or
2. the signed after attestation has a different failure class at a strictly later deterministic
   setup stage allowed by the selected playbook.

Proposed stages:

| Stage | Failure examples |
|---|---|
| 10 runtime/toolchain | `missing_ruby_version`, `runtime_engine_mismatch`, `missing_runtime_tool` |
| 20 dependency build | `missing_build_tool`, `native_extension_compile_failed`, `install_failed` |
| 30 configuration | `missing_database_config`, `missing_required_config`, `unsupported_database_config`, `missing_env_var` |
| 40 services | `postgres_unavailable`, `redis_unavailable`, `service_port_allocated`, `docker_unavailable`, `unsupported_database_version` |
| 50 database identity/auth | `postgres_role_missing`, `postgres_auth_env_missing` |
| 60 database schema | `database_schema_missing`, `migrations_missing` |
| 70 application startup | `app_exited_early`, `port_in_use` |
| 80 health | `health_check_timeout`, `health_http_error` |
| 100 verified | observed healthy boot |

A stage number alone is insufficient. Each playbook also declares its allowed later failure
classes. `unknown_failure`, an unchanged class, a lower stage, or a class not allowed by that
playbook is not progress.

## Repair Receipt Schema

The requested schema remains `bootproof/repair-receipt/v1`. Because this repository already
emits a v1 receipt, implementation must either make the lifecycle fields additive and retain
legacy verification or, before a stable release, explicitly migrate old v1 receipts. It must
not silently make existing signatures unverifiable.

Proposed receipt:

```json
{
  "schema": "bootproof/repair-receipt/v1",
  "tool": "bootproof@0.3.0",
  "planHash": "...",
  "action": {
    "id": "install-required-ruby",
    "actionHash": "...",
    "actionType": "command",
    "mutationScope": "host_tool_install",
    "riskLevel": "high",
    "exactCommand": "rbenv install 3.3.11",
    "exactPatchHash": null
  },
  "before": {
    "failureClass": "missing_ruby_version",
    "stage": 10,
    "attestationHash": "..."
  },
  "lifecycle": {
    "suggested": {
      "value": true,
      "at": "..."
    },
    "approved": {
      "value": true,
      "at": "...",
      "approvalMethod": "action_hash_and_scope_flag"
    },
    "applied": {
      "value": true,
      "at": "...",
      "exitCode": 0,
      "changedFiles": []
    },
    "progressed": {
      "value": true,
      "reason": "later_failure_class"
    },
    "verified": {
      "value": false,
      "healthObservation": null
    }
  },
  "after": {
    "failureClass": "missing_build_tool",
    "stage": 20,
    "attestationHash": "..."
  },
  "evidence": {
    "stdoutHeadRedacted": "...",
    "stdoutTailRedacted": "...",
    "stderrHeadRedacted": "...",
    "stderrTailRedacted": "...",
    "redactionsApplied": []
  },
  "safety": {
    "ruleset": "bootproof/repair-command-safety/v1",
    "blocklistPassed": true
  },
  "signer": {
    "publicKey": "...",
    "algorithm": "ed25519"
  },
  "signature": "..."
}
```

Lifecycle meanings:

- `suggested`: a deterministic signed plan contained this exact action
- `approved`: the user supplied the exact action hash and required scope/risk flags
- `applied`: the patch transaction completed or command exited successfully
- `progressed`: the after proof verified or reached an allowed later blocker
- `verified`: observed health succeeded

A command that exits nonzero may still produce a signed receipt with `approved: true`,
`applied: false`, `progressed: false`, and `verified: false`. Failed approved attempts are
valuable evidence.

Receipt verification checks:

- strict schema validation
- receipt signature
- plan hash and action hash
- before and after attestation signatures and hashes
- approval requirements for the recorded scope/risk
- file preimages and postimages for patches
- command argv hash for commands
- safety ruleset and blocklist result
- internal lifecycle consistency

Examples of invalid state:

- `verified: true` without observed health
- `progressed: true` without a verified boot or allowed later failure
- `applied: true` for a blocked action
- `approved: false` with an applied command or patch

## Initial Deterministic Playbooks

These candidates are implemented with exact evidence and repository-state gates. Multi-step
repairs expose one action per run; later actions are shown but never silently chained.

| Failure class | Proposed action | Scope | Risk | Conditions |
|---|---|---|---|---|
| `missing_ruby_version` | `rbenv install <requiredVersion>` | host | medium | Exact safe version metadata. |
| `missing_build_tool` | `brew install cmake` | host | medium | macOS, exact `cmake` classifier metadata, Homebrew available. Otherwise instruction. |
| `native_extension_compile_failed` for `idn-ruby` | Install `libidn` and `pkg-config`, then configure Bundler with the detected static Homebrew prefix in a later approved run. | host | medium | Exact affected gem and Homebrew prefix; no shell substitution. |
| `missing_database_config` | Copy the PostgreSQL example, otherwise the generic example, to `config/database.yml` as a patch. | repo | medium | Destination absent; source is repository-local; secret scan passes. |
| `missing_required_config` | Copy the exact sibling example to the reported path as a patch. | repo | medium | Reported safe relative path; unique example; secret scan passes. |
| `unsupported_database_config` | Remove only classifier-identified `geo` or `embedding` top-level database sections. | repo | medium | YAML parses; exact diff shown; secret scan passes. |
| `postgres_unavailable` | Start an exact local PostgreSQL service, such as `brew services start postgresql@17`. | service | medium | Localhost endpoint, exact required major when versioned, and one platform-specific registered service command. Otherwise instruction. |
| `redis_unavailable` | `brew services start redis` | service | medium | macOS, localhost endpoint, Homebrew available. Otherwise instruction. |
| `postgres_role_missing` | `createuser -s <role>` for the exact validated role. | database | medium | Role is shell-safe and comes from classifier metadata. |
| `database_schema_missing` | Run one exact framework migration command. | database | high | One unambiguous framework and migration directory/config. |
| `migrations_missing` | Run one exact framework migration command. | database | high | Existing Prisma/Django/Rails/Knex/Drizzle predicates remain unambiguous. |
| `unsupported_database_version` | Separate install and service-start actions for the exact required PostgreSQL major. | host/service | high | Homebrew and major version are exact; each action separately approved; PATH is never changed. |
| `service_port_allocated` | Patch a BootProof-owned Compose override/copy using the first available port in a deterministic bounded range. | repo | low | Exact service/port mapping and signed source precondition. |
| `package_manager_version_mismatch` | Activate the exact declared package manager version. | host | medium | Exact simple version declaration; Corepack available. |
| `missing_env_var` | Instruction showing exact variable names and safe known values only. | none | low | Never writes `.env`; never invents secret values. |

Database commands that can destroy or reset data are blocked even when the framework is known.
For example, `prisma migrate reset`, `rails db:drop`, and `dropdb` are never deterministic
repair actions.

## No-Known-Repair Classes

The initial implementation should remain instruction-only or refuse for:

- `unknown_failure`
- `runtime_engine_mismatch`
- `missing_package_manager`
- `missing_runtime_tool`
- `private_registry_or_auth`
- `postgres_auth_env_missing`
- `tls_or_proxy_interception`
- `native_extension_compile_failed` without an exact classified missing tool
- generic `native_build_dependency`
- generic `database_unreachable`
- `dependency_install_skipped`
- `install_failed`
- `health_http_error`
- `health_check_timeout`
- `app_exited_early` without a more precise classifier
- `port_in_use`
- `docker_unavailable`
- `workspace_ambiguous`
- `not_an_application`
- `orchestration_not_supported`
- `python_flask_setup_required`

Credentials, tokens, proxy trust, and secret values are always human-supplied outside the
deterministic registry.

## Proposed Files And Modules

Keep `src/repair.ts` as a compatibility facade while moving distinct responsibilities into:

```text
src/repair/model.ts        action, plan, receipt, and result types
src/repair/plan.ts         attestation loading, freshness, candidate construction
src/repair/playbooks.ts    deterministic registry and predicates
src/repair/safety.ts       command allow rules, blocklist, protected paths
src/repair/apply.ts        approval validation and one-action application
src/repair/progress.ts     after-attestation stage/progression decision
src/repair/receipt.ts      canonical hashing, signing, strict verification
src/repair/rerun.ts        explicit handoff to the normal up engine
docs/schemas/repair-action-v1.schema.json
docs/schemas/repair-plan-v1.schema.json
docs/schemas/repair-receipt-v1.schema.json
```

`src/cli.ts` should only parse flags, render the exact action, and call these modules.

## Test Plan

### Pure unit tests

- action schemas reject unknown fields and invalid enum combinations
- command and patch actions always require approval
- instruction actions cannot be executed
- action hashes are stable and change for any command, patch, scope, risk, or precondition change
- candidate selection is stable and refuses ambiguous playbooks
- stale, unsigned, successful, or mismatched attestations cannot produce plans
- unknown failures produce no executable candidate
- AI-source actions are rejected by the deterministic registry and apply path
- progress requires verified health or an allowed later failure class
- unchanged, lower-stage, unknown, or unapproved failure transitions are not progress

### Blocklist tests

Test exact and obfuscated forms of every required block:

- whitespace and quoting variants of `rm -rf` and `sudo`
- `curl|sh`, `curl | sh`, `wget | bash`
- recursive world-writable chmod and recursive chown
- `mkfs` and `diskutil erase`
- database drop/reset commands
- shell operators in any argv item
- protected env paths passed to mutating tools
- `tee`, redirects, or interpreter snippets targeting `.env`
- uploads of `.env`, `.ssh`, `.aws`, private keys, and token files

Every blocked action must execute zero child processes and write zero files.

### Patch tests

- exact config example copy preview and application
- unique-example requirement
- secret-bearing example refused
- protected `.env` destination refused
- symlink/path traversal refused
- stale source example or destination preimage refused
- transactional rollback on partial write failure
- displayed patch bytes equal applied patch bytes

### Command tests

- exact argv shown equals exact argv executed
- execution uses `shell: false`
- no command runs without action hash approval
- host/service/database acknowledgements are independently required
- high-risk acknowledgement is required
- blocklist is checked again immediately before execution
- inherited env values reach the child but never enter plan/receipt JSON
- timeout, nonzero exit, and connection errors produce failed receipts

### End-to-end tests

- `fix` reads a fresh signed failure and performs no command/file mutation
- `fix` writes a signed plan and prints exact command or patch
- `apply-repair` refuses stale or tampered plans
- approved patch reruns `up` and records verified boot
- approved command reruns `up` and records a later blocker as progress
- approved action with no progress records `applied: true`, `progressed: false`
- failed approved action records `approved: true`, `applied: false`
- receipt verification detects tampered lifecycle fields
- no receipt can claim verified without an after attestation containing observed health
- remote retained clones keep the existing `--unsafe-local` execution gate
- no telemetry, upload, or network call originates from BootProof evidence handling

## Implementation Order

1. Add strict action, plan, and additive receipt schemas plus validators.
2. Add pure playbook selection and safety validation; change `fix` to planning only.
3. Add patch-only approval/application with exact hashes and rerun.
4. Add structured command execution with blocklist and scope/risk approvals.
5. Add progress classification and lifecycle receipts for failed and successful attempts.
6. Migrate existing port, package-manager, and migration remediations into the new registry.
7. Add the narrowly evidenced Mastodon/GitLab playbooks listed above.

Patch-only application should land before host-mutating commands. This keeps the first
implementation step inside the already established signed file-preimage boundary.

## Risks

- Changing current `fix` behavior from auto-attempt to plan-only is a CLI compatibility change
  and must be explicit in release notes.
- The existing v1 receipt is already emitted; additive compatibility or a deliberate version
  migration is required.
- Package managers and version managers perform their own network activity. Approval copy must
  say so even though BootProof itself uploads nothing.
- Database migrations can be irreversible. Exact framework detection does not make them low
  risk.
- Starting a service can affect unrelated local projects.
- A blocklist alone is insufficient; playbook-specific executable and argument allow rules are
  mandatory.
- Repository-provided executables and migration code are untrusted code and still require
  explicit local-execution consent.
- Progress stages can overstate improvement if they are global only; playbook-specific allowed
  transitions are required.
- Exact patches may contain sensitive configuration. Candidate construction must secret-scan
  and refuse rather than redact an executable patch into something different.
- Host changes may not be reversible. Receipts must never imply rollback capability that does
  not exist.

## Intentionally Not Implemented

The current foundation does not implement:

- additional repair playbooks beyond the three-command/instruction MVP
- receipt migration
- signed repair plans or action-hash approval
- general command or patch application through the new model
- AI repair
- hosted services, Cloud upload, crawler, telemetry, or automatic sharing
