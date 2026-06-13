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
| `orchestration_not_supported` | An application stack was detected, but no explicit supported entrypoint or source-built Compose web service was found. | Use the repository's documented runbook; treat the signed result as diagnosis, not boot proof. |
| `auth_required` | An externally managed health endpoint returned HTTP 401 or 403. | Use a separate unauthenticated health endpoint or verify authentication manually without exposing credentials. |
| `external_health_unreachable` | An externally managed health endpoint could not be reached or did not return HTTP 2xx/3xx. | Confirm the service and endpoint are reachable, then rerun external verification. |
| `runtime_engine_mismatch` | Node.js does not satisfy the declared engine. | Switch to a compatible runtime and rerun. |
| `missing_ruby_version` | The exact Ruby version selected by rbenv is not installed. | Run `rbenv install <version>`. |
| `missing_package_manager` | The declared package manager executable is absent. | Enable Corepack or install the required manager. |
| `missing_runtime_tool` | An explicit Go, Ruby, Bundler, Make, PHP, or Composer run path was selected, but the executable is absent. | Install the repository-supported runtime or tool and rerun. |
| `missing_php_runtime` | The repository requires PHP, but the `php` executable is unavailable. | Install a repository-supported PHP version; mention Homebrew only when its presence is evidenced. |
| `missing_composer` | The repository requires Composer, but the `composer` executable is unavailable. | Install Composer through an evidenced or documented method. |
| `unsupported_php_version_for_composer_lock` | The current PHP version does not satisfy package constraints recorded in `composer.lock`. | Select a compatible PHP version, then rerun `composer install`; do not edit the lockfile as the first step. |
| `missing_php_vendor_autoload` | `vendor/autoload.php` is absent after PHP dependencies failed or were not installed. | Resolve PHP/Composer compatibility, then run `composer install`. |
| `missing_build_tool` | A named native build tool required by a dependency is absent. | Install the reported tool, such as `brew install cmake`. |
| `native_extension_compile_failed` | A gem native extension failed to compile. | Install the affected gem's native dependencies and rerun installation. |
| `package_manager_version_mismatch` | The available package-manager version differs from the exact/simple declared version. | Activate the declared version, then rerun. |
| `dependency_install_skipped` | A dependency-backed application was not started because install was not requested. | Review the install command and opt in with `--install`. |
| `python_flask_setup_required` | Python/Flask setup requires migrations, initialization, workers, frontend, or service orchestration not yet supported safely. | Complete the documented setup manually; do not treat detection as full support. |
| `laravel_vite_ci_hmr_blocked` | Laravel's Vite plugin refused to start the HMR asset server in CI. | Use a production asset build in CI, or run the Laravel application server for app verification. |
| `missing_env_var` | Required environment configuration is missing. | Supply real values through the repository's documented path. BootProof will not edit `.env`. |
| `missing_database_config` | `config/database.yml` could not be loaded or is absent. | Create it from the repository's documented example and review it. |
| `missing_required_config` | Another explicitly named required configuration file is absent. | Restore the reported file from the repository's documented example. |
| `database_unreachable` | A required database or cache could not be reached. | Start the real required service and verify its address. |
| `postgres_unavailable` | PostgreSQL refused or could not accept the connection. | Start PostgreSQL and verify the configured host and port. |
| `postgres_role_missing` | PostgreSQL is reachable, but the configured role does not exist. | Create the role or configure an existing one. |
| `database_schema_missing` | PostgreSQL reports an undefined table or missing relation. | Run the repository's documented migrations or database setup. |
| `unsupported_database_version` | The installed PostgreSQL version is outside the repository's supported range. | Install or select a supported version. |
| `unsupported_database_config` | `config/database.yml` contains unsupported database names. | Use only the repository-supported names. |
| `redis_unavailable` | Redis refused or could not accept the connection. | Start Redis and verify the configured host and port. |
| `postgres_auth_env_missing` | Postgres was reached but authentication or env configuration did not match. | Correct the real database configuration; BootProof will not invent credentials. |
| `migrations_missing` | The database schema is absent or behind. | Run the repository's documented migration flow. Repair is attempted only for one unambiguous recognized framework. |
| `port_in_use` | The selected application command could not bind its requested port. | Identify the process with `lsof -i :<port>`, then stop it or use a different supported port. |
| `native_build_dependency` | An OS toolchain or native dependency is missing. | Install the required build dependency and rerun. |
| `private_registry_or_auth` | Package installation requires credentials. | Provide real registry credentials outside BootProof. |
| `tls_or_proxy_interception` | TLS verification is blocked by a proxy or certificate chain. | Configure the trusted CA or use an appropriate network. |
| `service_port_allocated` | Docker is available, but a service port bind failed. | Stop the conflicting process/container or change the service port. |
| `docker_unavailable` | Docker is required by the plan but unavailable. | Start Docker or explicitly choose a safe local path. |
| `install_failed` | Dependency installation failed for an otherwise unclassified reason. | Inspect preserved install evidence and fix the underlying cause. |
| `app_exited_early` | The application exited before health was observed. | Inspect process evidence and fix startup. |
| `health_check_timeout` | No HTTP response was observed before timeout. | Check logs, port inference, and health candidates. |
| `health_http_error` | A health candidate returned HTTP 5xx. | Fix the server error; a responding process is not yet healthy. |
| `health_candidate_port_mismatch` | Process output advertised a different port from the inferred application health URL. | Confirm the primary app command and intended health port; do not mistake an asset server for the Laravel app. |
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
