# Failure Taxonomy

BootProof classifies failure so humans get a runbook and machines get a stable verdict.

Every class still means:

```text
booted: false
healthVerified: false
```

Unknown evidence remains `unknown_failure`. BootProof does not pick a more marketable class when the evidence is inconclusive.

| Class | Meaning | Safe next step |
|---|---|---|
| `not_an_application` | No trustworthy runnable entrypoint was found. | Select a runnable workspace or add an explicit start command. |
| `runtime_engine_mismatch` | Node.js does not satisfy the declared engine. | Switch to a compatible runtime and rerun. |
| `missing_package_manager` | The declared package manager executable is absent. | Enable Corepack or install the required manager. |
| `package_manager_version_mismatch` | The available package-manager version differs from the exact/simple declared version. | Activate the declared version, then rerun. |
| `dependency_install_skipped` | A dependency-backed application was not started because install was not requested. | Review the install command and opt in with `--install`. |
| `python_flask_setup_required` | Python/Flask setup requires migrations, initialization, workers, frontend, or service orchestration not yet supported safely. | Complete the documented setup manually; do not treat detection as full support. |
| `missing_env_var` | Required environment configuration is missing. | Supply real values through the repository's documented path. BootProof will not edit `.env`. |
| `database_unreachable` | A required database or cache could not be reached. | Start the real required service and verify its address. |
| `postgres_auth_env_missing` | Postgres was reached but authentication or env configuration did not match. | Correct the real database configuration; BootProof will not invent credentials. |
| `migrations_missing` | The database schema is absent or behind. | Run the repository's documented migration flow. |
| `port_in_use` | The application port is occupied. | Stop the process or use a supported explicit port. |
| `native_build_dependency` | An OS toolchain or native dependency is missing. | Install the required build dependency and rerun. |
| `private_registry_or_auth` | Package installation requires credentials. | Provide real registry credentials outside BootProof. |
| `tls_or_proxy_interception` | TLS verification is blocked by a proxy or certificate chain. | Configure the trusted CA or use an appropriate network. |
| `service_port_allocated` | Docker is available, but a service port bind failed. | Stop the conflicting process/container or change the service port. |
| `docker_unavailable` | Docker is required by the plan but unavailable. | Start Docker or explicitly choose a safe local path. |
| `install_failed` | Dependency installation failed for an otherwise unclassified reason. | Inspect preserved install evidence and fix the underlying cause. |
| `app_exited_early` | The application exited before health was observed. | Inspect process evidence and fix startup. |
| `health_check_timeout` | No HTTP response was observed before timeout. | Check logs, port inference, and health candidates. |
| `health_http_error` | A health candidate returned HTTP 5xx. | Fix the server error; a responding process is not yet healthy. |
| `workspace_ambiguous` | Multiple applications or health targets are plausible. | Choose one with `--workspace <dir>`. |
| `unknown_failure` | Available evidence does not match a trustworthy detector. | Inspect the signed raw evidence and report a reproducible detector case. |

## Important Distinctions

- Docker bind conflicts are `service_port_allocated`, not `docker_unavailable`.
- HTTP 5xx is `health_http_error`, not `health_check_timeout`.
- Postgres authentication/env mismatch is `postgres_auth_env_missing`.
- A skipped install is not success.
- A detected stack is not a verified boot.

## Evidence

Local failed attestations preserve available raw evidence:

```text
.bootproof/attestation.json
```

Registry export redacts sensitive values before producing a shareable entry.
