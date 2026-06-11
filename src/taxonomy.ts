import type { FailureClass } from "./types.js";

function classifyHealthFailure(evidence: string): "health_http_error" | "health_check_timeout" {
  if (/(only HTTP 5\d\d observed|HTTP 5\d\d|status\s*5\d\d|returned 5\d\d)/i.test(evidence)) {
    return "health_http_error";
  }
  return "health_check_timeout";
}


function isServicePortAllocatedEvidence(evidence: string): boolean {
  const lower = evidence.toLowerCase();
  return (
    lower.includes("port is already allocated") ||
    lower.includes("bind for 0.0.0.0:") ||
    lower.includes("failed programming external connectivity") ||
    lower.includes("ports are not available") ||
    lower.includes("address already in use")
  );
}


interface Rule { class: FailureClass; pattern: RegExp; explain: (m: RegExpMatchArray) => string }

export function extractMissingEnvNames(evidence: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /\b([A-Z][A-Z0-9_]{2,})\s+is\s+(?:not\s+set|required|missing|undefined)\b/g,
    /\bMissing required secret:\s*([A-Z][A-Z0-9_]{2,})\b/g,
    /^\s+([A-Z][A-Z0-9_]{2,}):\s*Required\b/gm,
    /\bplease set\s+([A-Z][A-Z0-9_]{2,})\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of evidence.matchAll(pattern)) {
      const name = match[1].toUpperCase();
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
      if (names.length === 10) return names;
    }
  }
  return names;
}

const RULES: Rule[] = [
  { class: "package_manager_version_mismatch", pattern: /(ERR_PNPM_UNSUPPORTED_ENGINE|Unsupported environment \(bad (?:pnpm|yarn|npm|bun) and\/or Node\.js version\)|(?:pnpm|yarn|npm|bun)[\s\S]{0,160}Expected version:\s*[^\n]+[\s\S]{0,120}Got:\s*[^\n]+|packageManager field[\s\S]{0,120}(?:version|mismatch)|engines\.(?:pnpm|yarn|npm|bun))/i,
    explain: () => "The repository declares a package manager version that does not match the version available in the current environment. Enable Corepack or install the required package manager version before rerunning BootProof." },
  { class: "runtime_engine_mismatch", pattern: /(Node version .{0,40}doesn'?t (?:satisfy|match)|The engine "node" is incompatible|EBADENGINE|required:\s*\{\s*node)/i,
    explain: () => "The host Node version does not satisfy the project's engines requirement. Switch Node versions (nvm/fnm/corepack) and retry." },
  { class: "missing_package_manager", pattern: /\b(yarn|pnpm|bun): (command )?not found/i,
    explain: m => `The project needs ${m[1]} and it is not installed. Enable Corepack (corepack enable) or install ${m[1]} directly.` },
  { class: "missing_runtime_tool", pattern: /(?:(?:^|\s)(go|ruby|bundle|make): (?:command )?not found\b|'(go|ruby|bundle|make)' is not recognized as an internal or external command|spawn (go|ruby|bundle|make) ENOENT)/im,
    explain: m => `The repository's explicit run path requires ${m[1] ?? m[2] ?? m[3]}, but that executable is not available in this environment.` },
  { class: "private_registry_or_auth", pattern: /(401 Unauthorized|E401|ENEEDAUTH|authentication token not provided|Permission.*registry)/i,
    explain: () => "Dependency install needs credentials for a private registry. Bootproof will not invent credentials; provide real ones and retry." },
  { class: "native_build_dependency", pattern: /(node-gyp|gyp ERR|pg_config.*not found|fatal error: .*\.h|prebuild-install)/i,
    explain: () => "A dependency needs a native toolchain or OS package that is missing on this machine." },
  { class: "port_in_use", pattern: /(EADDRINUSE|[Pp]ort \d+ is (already )?in use)/,
    explain: () => "The app port is occupied by another process. Stop it or run with a different PORT." },
  { class: "postgres_auth_env_missing", pattern: /(SASL: SCRAM-SERVER-FIRST-MESSAGE|password authentication failed for user|client password must be a string)/i,
    explain: () => "Postgres was reached but authentication failed — the app's DATABASE_URL credentials don't match the running database. Inspect the repository's own env and compose examples, or rerun after generating BootProof service scaffolding; bootproof will not edit your .env." },
  { class: "database_unreachable", pattern: /(ECONNREFUSED.*:(5432|3306|6379|27017)|P1001|Can'?t reach database server|Connection refused.*postgres)/i,
    explain: () => "The app requires a database that is not reachable. Start the repository's required database service and verify its configured address." },
  { class: "migrations_missing", pattern: /(relation .* does not exist|no such table|Migration.*pending|P3009)/i,
    explain: () => "The database schema is missing or behind. Run the project's migration command against the local database." },
  { class: "missing_env_var", pattern: /([A-Z][A-Z0-9_]{2,}\s+is\s+(?:not\s+set|required|missing|undefined)|Missing required secret:\s*[A-Z][A-Z0-9_]{2,}|^\s+[A-Z][A-Z0-9_]{2,}:\s*Required\b|please set\s+[A-Z][A-Z0-9_]{2,}|Invalid environment variables)/im,
    explain: () => "The app refuses to start without specific environment variables. See .env.bootproof.example; secrets without safe defaults must come from you." },
  { class: "tls_or_proxy_interception", pattern: /(SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to get local issuer certificate)/,
    explain: () => "A TLS-intercepting proxy or self-signed certificate chain is blocking package/tool downloads. Configure your proxy CA (NODE_EXTRA_CA_CERTS) or run outside the intercepting network." },
  { class: "service_port_allocated", pattern: /(port is already allocated|Bind for 0\.0\.0\.0:\d+ failed|failed programming external connectivity|Ports are not available)/i,
    explain: () => "Docker is available, but a required service port is already allocated by another local process or container. Stop the process using that port, or rerun with a different service port." },
  { class: "docker_unavailable", pattern: /(Cannot connect to the Docker daemon|docker: (command )?not found|docker daemon is not running|error during connect)/i,
    explain: () => "Docker is not available, and this plan needs it for services. Start Docker, or rerun with --provider local --unsafe-local if the app needs no containers." },
  { class: "health_http_error", pattern: /(only HTTP 5\d\d observed|HTTP 5\d\d|status\s*5\d\d|returned 5\d\d)/i,
    explain: () => "The app responded on the configured health URL, but returned HTTP 5xx. BootProof observed a running server, but not a verified healthy boot." },
];

export function classifyFailure(evidence: string): { class: FailureClass; explanation: string } {
  if (isServicePortAllocatedEvidence(evidence) && /(docker|container|bind for|external connectivity|ports are not available|port is already allocated)/i.test(evidence)) {
    return {
      class: "service_port_allocated",
      explanation: "Docker is available, but a required service port is already allocated by another local process or container. Stop the process using that port, or rerun with a different service port.",
    };
  }
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
  "not_an_application", "orchestration_not_supported", "runtime_engine_mismatch", "missing_package_manager", "missing_runtime_tool", "package_manager_version_mismatch",
  "dependency_install_skipped", "python_flask_setup_required", "missing_env_var",
  "database_unreachable", "postgres_auth_env_missing", "migrations_missing", "port_in_use", "native_build_dependency",
  "private_registry_or_auth", "tls_or_proxy_interception", "service_port_allocated", "docker_unavailable", "install_failed", "app_exited_early",
  "health_check_timeout", "health_http_error", "workspace_ambiguous", "unknown_failure",
];
