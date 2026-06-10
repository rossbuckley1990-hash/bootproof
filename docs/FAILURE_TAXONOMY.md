# Failure taxonomy

Bootproof treats failures as product data. Every failed run is classified into one of these classes; the raw evidence tail is preserved in the attestation. Unclassifiable failures are reported as `unknown_failure` — never silently absorbed.

| Class | Meaning | Example evidence |
|---|---|---|
| `not_an_application` | Repo is a library/package with nothing to boot. | publishable `main`/`exports`, no dev/start script |
| `runtime_engine_mismatch` | Host runtime fails the project's engines requirement. | `The engine "node" is incompatible` |
| `missing_package_manager` | Required PM/Corepack absent. | `yarn: command not found` |
| `missing_env_var` | App refuses to start without env vars. | `Please set NEXTAUTH_SECRET` |
| `database_unreachable` | Required DB not reachable. | `ECONNREFUSED 127.0.0.1:5432` |
| `postgres_auth_env_missing` | DB reached, credentials/env mismatched. | `SASL: SCRAM-SERVER-FIRST-MESSAGE` |
| `migrations_missing` | Schema missing/behind. | `relation does not exist` |
| `port_in_use` | App port occupied. | `EADDRINUSE` |
| `native_build_dependency` | Needs OS toolchain/package. | `node-gyp`, `pg_config not found` |
| `private_registry_or_auth` | Install needs private credentials. | `E401 Unauthorized` |
| `tls_or_proxy_interception` | TLS-intercepting proxy/self-signed chain blocks downloads. | `SELF_SIGNED_CERT_IN_CHAIN` |
| `docker_unavailable` | Plan needs Docker; daemon absent. | `Cannot connect to the Docker daemon` |
| `install_failed` | Dependency install failed (unclassified cause). | non-zero install exit |
| `app_exited_early` | App process died before responding. | exit before first HTTP response |
| `health_check_timeout` | Process alive, no HTTP response in time. | poll exhausted |
| `workspace_ambiguous` | Monorepo with multiple plausible apps. | candidates listed, user must choose |
| `unknown_failure` | Not yet classified — evidence preserved for a new detector. | anything else |
