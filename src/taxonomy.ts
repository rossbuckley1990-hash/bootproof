import type { FailureClass } from "./types.js";

interface Rule { class: FailureClass; pattern: RegExp; explain: (m: RegExpMatchArray) => string }

const RULES: Rule[] = [
  { class: "runtime_engine_mismatch", pattern: /(Node version .{0,40}doesn'?t (?:satisfy|match)|The engine "node" is incompatible|EBADENGINE|required:\s*\{\s*node)/i,
    explain: () => "The host Node version does not satisfy the project's engines requirement. Switch Node versions (nvm/fnm/corepack) and retry." },
  { class: "missing_package_manager", pattern: /\b(yarn|pnpm|bun): (command )?not found/i,
    explain: m => `The project needs ${m[1]} and it is not installed. Enable Corepack (corepack enable) or install ${m[1]} directly.` },
  { class: "private_registry_or_auth", pattern: /(401 Unauthorized|E401|ENEEDAUTH|authentication token not provided|Permission.*registry)/i,
    explain: () => "Dependency install needs credentials for a private registry. Bootproof will not invent credentials; provide real ones and retry." },
  { class: "native_build_dependency", pattern: /(node-gyp|gyp ERR|pg_config.*not found|fatal error: .*\.h|prebuild-install)/i,
    explain: () => "A dependency needs a native toolchain or OS package that is missing on this machine." },
  { class: "port_in_use", pattern: /(EADDRINUSE|address already in use|[Pp]ort \d+ is (already )?in use)/,
    explain: () => "The app port is occupied by another process. Stop it or run with a different PORT." },
  { class: "postgres_auth_env_missing", pattern: /(SASL: SCRAM-SERVER-FIRST-MESSAGE|password authentication failed for user|client password must be a string)/i,
    explain: () => "Postgres was reached but authentication failed — the app's DATABASE_URL credentials don't match the running database. Align them with the values in docker-compose.bootproof.yml; bootproof will not edit your .env." },
  { class: "database_unreachable", pattern: /(ECONNREFUSED.*:(5432|3306|6379|27017)|P1001|Can'?t reach database server|Connection refused.*postgres)/i,
    explain: () => "The app requires a database that is not reachable. Start the generated docker-compose.bootproof.yml services first." },
  { class: "migrations_missing", pattern: /(relation .* does not exist|no such table|Migration.*pending|P3009)/i,
    explain: () => "The database schema is missing or behind. Run the project's migration command against the local database." },
  { class: "missing_env_var", pattern: /((Missing|Please set|required) (env(ironment)? var(iable)?s?|.*[A-Z][A-Z0-9_]{3,})|Invalid environment variables)/,
    explain: () => "The app refuses to start without specific environment variables. See .env.bootproof.example; secrets without safe defaults must come from you." },
  { class: "tls_or_proxy_interception", pattern: /(SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to get local issuer certificate)/,
    explain: () => "A TLS-intercepting proxy or self-signed certificate chain is blocking package/tool downloads. Configure your proxy CA (NODE_EXTRA_CA_CERTS) or run outside the intercepting network." },
  { class: "docker_unavailable", pattern: /(Cannot connect to the Docker daemon|docker: (command )?not found|docker daemon is not running|error during connect)/i,
    explain: () => "Docker is not available, and this plan needs it for services. Start Docker, or rerun with --provider local --unsafe-local if the app needs no containers." },
];

export function classifyFailure(evidence: string): { class: FailureClass; explanation: string } {
  for (const rule of RULES) {
    const m = evidence.match(rule.pattern);
    if (m) return { class: rule.class, explanation: rule.explain(m) };
  }
  return {
    class: "unknown_failure",
    explanation: "Bootproof could not classify this failure. The raw evidence is preserved in the attestation — please open an issue with it so this becomes a new detector.",
  };
}

export const TAXONOMY_DOC_CLASSES: FailureClass[] = [
  "not_an_application", "runtime_engine_mismatch", "missing_package_manager", "missing_env_var",
  "database_unreachable", "postgres_auth_env_missing", "migrations_missing", "port_in_use", "native_build_dependency",
  "private_registry_or_auth", "tls_or_proxy_interception", "docker_unavailable", "install_failed", "app_exited_early",
  "health_check_timeout", "workspace_ambiguous", "unknown_failure",
];
