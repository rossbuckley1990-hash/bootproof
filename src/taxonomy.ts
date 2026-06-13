import type { FailureClass } from "./types.js";

export type FailureMetadata = Record<string, string | string[]>;

export interface FailureClassification {
  class: FailureClass;
  explanation: string;
  metadata?: FailureMetadata;
  safeNextStep?: string;
}

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
    /\b([A-Z][A-Z0-9_]{2,})(?:\s+environment variable)?\s+is\s+(?:not\s+set|required|missing|undefined)\b/g,
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

export function safeLocalEnvValue(name: string): string | null {
  return name === "RAILS_ENV" ? "development" : null;
}

function affectedGem(evidence: string): string | null {
  return evidence.match(/An error occurred while installing\s+([A-Za-z0-9_.-]+)/i)?.[1]?.toLowerCase()
    ?? evidence.match(/\/gems\/([A-Za-z0-9_.-]+?)-\d/i)?.[1]?.toLowerCase()
    ?? null;
}

function commaSeparated(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const names = value.split(",").map(name => name.trim()).filter(Boolean);
  return names.length ? names : undefined;
}

function hasHomebrewEvidence(evidence: string): boolean {
  return /\bHomebrew\b|\/opt\/homebrew\/|\/usr\/local\/Homebrew\/|\bbrew(?:\s+--version|\s+install|\s+list|\s+services)\b/i.test(evidence);
}

function missingCommand(evidence: string, command: "php" | "composer"): boolean {
  return new RegExp(
    `(?:command not found:\\s*${command}\\b|(?:^|\\s)${command}:\\s*(?:command )?not found\\b|'${command}' is not recognized as an internal or external command|spawn ${command} ENOENT)`,
    "im",
  ).test(evidence);
}

function missingGoRuntime(evidence: string): boolean {
  return /(?:command not found:\s*go\b|(?:^|\s)go:\s*(?:command )?not found\b|'go' is not recognized as an internal or external command|spawn go ENOENT)/im.test(evidence);
}

function goBuildFailure(evidence: string): FailureClassification | null {
  const compileFailure =
    /(?:^|\n)[^\n:]+\.go:\d+:\d+:\s*(?:undefined:|syntax error:|cannot use |not enough arguments|too many arguments|declared and not used|imported and not used)/im.test(evidence);
  const packageFailure =
    /\bpackage\s+\S+\s+is not in std\b/i.test(evidence)
    || /\bno required module provides package\b/i.test(evidence)
    || /\bbuild constraints exclude all Go files\b/i.test(evidence);
  const moduleFailure =
    /(?:^|\n)go:\s+[^\n]*(?:invalid version|reading \S+\/go\.mod|module lookup disabled|Get "https?:\/\/|dial tcp|no such host|connection refused|unexpected EOF)/im.test(evidence);
  const explicitBuildFailure = /\bgo(?: run| build)?:[^\n]*build failed\b/i.test(evidence);
  if (!compileFailure && !packageFailure && !moduleFailure && !explicitBuildFailure) return null;
  return {
    class: "go_build_failed",
    explanation: "The selected Go service command failed during module resolution or compilation.",
    safeNextStep: "Inspect the preserved Go compiler or module error, use the repository-declared Go version, resolve the reported dependency or source error, then rerun BootProof.",
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function suggestedSupportedPhpMajorMinor(constraints: string[]): string | null {
  for (const constraint of constraints) {
    const exclusiveUpperBound = constraint.match(/<\s*(\d+)\.(\d+)(?:\.\d+)?/);
    if (exclusiveUpperBound) {
      const major = Number(exclusiveUpperBound[1]);
      const minor = Number(exclusiveUpperBound[2]);
      if (minor > 0) return `${major}.${minor - 1}`;
    }
  }
  for (const constraint of constraints) {
    const inclusiveUpperBound = constraint.match(/<=\s*(\d+\.\d+)(?:\.\d+)?/);
    if (inclusiveUpperBound) return inclusiveUpperBound[1];
  }
  const compatibleVersions = constraints.flatMap(constraint =>
    [...constraint.matchAll(/(?:~|\^)\s*(\d+\.\d+)(?:\.\d+)?/g)].map(match => match[1])
  );
  if (compatibleVersions.length > 1) {
    return compatibleVersions.sort((left, right) => {
      const [leftMajor, leftMinor] = left.split(".").map(Number);
      const [rightMajor, rightMinor] = right.split(".").map(Number);
      return leftMajor - rightMajor || leftMinor - rightMinor;
    }).at(-1) ?? null;
  }
  return null;
}

function composerLockPhpFailure(evidence: string): FailureClassification | null {
  if (
    !/Your lock file does not contain a compatible set of packages/i.test(evidence)
    || !/\brequires php\b/i.test(evidence)
    || !/your php version\s*\([^)]+\)/i.test(evidence)
    || !/does not satisfy that requirement/i.test(evidence)
  ) {
    return null;
  }

  const currentPhpVersion = evidence.match(/your php version\s*\([^)]*?(\d+\.\d+(?:\.\d+)?)/i)?.[1];
  const requirements = [...evidence.matchAll(
    /^\s*-\s+([a-z0-9_.-]+\/[a-z0-9_.-]+)\s+.+?\brequires php\s+(.+?)\s+(?:->|but)\s+your php version\s*\([^)]+\)\s+does not satisfy that requirement/igm,
  )];
  const affectedPackages = unique(requirements.map(match => match[1]));
  const supportedPhpConstraints = unique(requirements.map(match => match[2].trim()));
  const suggestedSupportedMajorMinor = suggestedSupportedPhpMajorMinor(supportedPhpConstraints);
  const metadata: FailureMetadata = {};
  if (currentPhpVersion) metadata.currentPhpVersion = currentPhpVersion;
  if (affectedPackages.length) metadata.affectedPackages = affectedPackages;
  if (supportedPhpConstraints.length) metadata.supportedPhpConstraints = supportedPhpConstraints;
  if (suggestedSupportedMajorMinor) metadata.suggestedSupportedMajorMinor = suggestedSupportedMajorMinor;

  return {
    class: "unsupported_php_version_for_composer_lock",
    explanation: currentPhpVersion
      ? `PHP ${currentPhpVersion} does not satisfy package constraints recorded in composer.lock.`
      : "The available PHP version does not satisfy package constraints recorded in composer.lock.",
    ...(Object.keys(metadata).length ? { metadata } : {}),
    safeNextStep: suggestedSupportedMajorMinor
      ? `Use a PHP version compatible with composer.lock, such as PHP ${suggestedSupportedMajorMinor} based on the reported package constraints, then rerun composer install.`
      : "Use a PHP version compatible with composer.lock, then rerun composer install.",
  };
}

function laravelEvidence(evidence: string): boolean {
  return /\bLaravel\b|laravel[\\/]framework|Illuminate\\|php artisan|artisan migrate/i.test(evidence);
}

function laravelSqliteDatabaseMissing(evidence: string): FailureClassification | null {
  if (
    !/Database file at path\b/i.test(evidence)
    || !/does not exist/i.test(evidence)
    || !/Connection:\s*sqlite\b/i.test(evidence)
  ) {
    return null;
  }
  const databasePath = evidence.match(/Database file at path\s+\[([^\]]+)\]\s+does not exist/i)?.[1]?.trim()
    ?? evidence.match(/Database file at path\s+(.+?)\s+does not exist/i)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  return {
    class: "laravel_sqlite_database_missing",
    explanation: "Laravel reached its SQLite connection, but the configured database file does not exist.",
    metadata: {
      ...(databasePath ? { databasePath } : {}),
      connection: "sqlite",
      framework: "laravel",
    },
    safeNextStep: [
      "Create the local SQLite database file and then run Laravel migrations after review:",
      "mkdir -p database",
      "touch database/database.sqlite",
      "php artisan migrate",
    ].join("\n"),
  };
}

function laravelMigrationsRequired(evidence: string): FailureClassification | null {
  if (!laravelEvidence(evidence)) return null;
  const missingTable =
    evidence.match(/no such table:\s*([A-Za-z0-9_.-]+)/i)?.[1]
    ?? evidence.match(/Base table or view not found[\s\S]{0,200}?\bTable\s+['"`]([^'"`]+)['"`]\s+does(?:n't| not)\s+exist/i)?.[1]
    ?? evidence.match(/\bTable\s+['"`]([^'"`]+)['"`]\s+does(?:n't| not)\s+exist/i)?.[1]
    ?? evidence.match(/\b(sessions?|cache|cache_locks|users|jobs|failed_jobs|migrations?)\s+table\s+(?:is\s+)?(?:missing|does not exist|not found)/i)?.[1];
  const migrationTableMissing = /migration(?:s)? table\b[^\n]*(?:missing|does not exist|not found)/i.test(evidence);
  const namedLaravelTableMissing =
    /\b(?:sessions?|cache|cache_locks|users|jobs|failed_jobs|migrations)\b/i.test(evidence)
    && /(?:no such table|Base table or view not found|does(?:n't| not) exist|missing)/i.test(evidence);
  if (!missingTable && !migrationTableMissing && !namedLaravelTableMissing) return null;
  return {
    class: "laravel_migrations_required",
    explanation: missingTable
      ? `Laravel started, but required database table ${missingTable} is missing.`
      : "Laravel started, but its required database tables have not been migrated.",
    metadata: {
      framework: "laravel",
      ...(missingTable ? { table: missingTable } : {}),
    },
    safeNextStep: "Run the Laravel migrations after explicit approval: php artisan migrate",
  };
}

function classifyRealWorldFailure(evidence: string): FailureClassification | null {
  const sqliteMissing = laravelSqliteDatabaseMissing(evidence);
  if (sqliteMissing) return sqliteMissing;

  const laravelMigrations = laravelMigrationsRequired(evidence);
  if (laravelMigrations) return laravelMigrations;

  const composerPhpFailure = composerLockPhpFailure(evidence);
  if (composerPhpFailure) return composerPhpFailure;

  if (missingGoRuntime(evidence)) {
    return {
      class: "go_runtime_missing",
      explanation: "The repository requires the Go runtime, but the go executable is not available.",
      metadata: { runtime: "go" },
      safeNextStep: "Install a Go version supported by the repository, then rerun BootProof.",
    };
  }

  const goBuild = goBuildFailure(evidence);
  if (goBuild) return goBuild;

  if (missingCommand(evidence, "php")) {
    return {
      class: "missing_php_runtime",
      explanation: "The repository requires PHP, but the php executable is not available.",
      metadata: { runtime: "php" },
      safeNextStep: hasHomebrewEvidence(evidence)
        ? "Install a PHP version supported by the repository. Homebrew is present, so one reviewed option is: brew install php."
        : "Install a PHP version supported by the repository, then rerun BootProof.",
    };
  }

  if (missingCommand(evidence, "composer")) {
    return {
      class: "missing_composer",
      explanation: "The repository requires Composer, but the composer executable is not available.",
      metadata: { tool: "composer" },
      safeNextStep: hasHomebrewEvidence(evidence)
        ? "Install Composer. Homebrew is present, so one reviewed option is: brew install composer."
        : "Install Composer using its documented installation method, then rerun BootProof.",
    };
  }

  if (
    /vendor[\\/]autoload\.php/i.test(evidence)
    && /Failed to open stream:\s*No such file or directory|failed opening required|No such file or directory/i.test(evidence)
  ) {
    return {
      class: "missing_php_vendor_autoload",
      explanation: "vendor/autoload.php is missing, so the PHP dependencies required by the application are not installed.",
      metadata: { filePath: "vendor/autoload.php" },
      safeNextStep: "Resolve any PHP or Composer version issue first, then run composer install to generate vendor/autoload.php.",
    };
  }

  const laravelViteHmrBlocked =
    /You should not run the Vite HMR server in CI environments/i.test(evidence) &&
    (/LARAVEL_BYPASS_ENV_CHECK=1/i.test(evidence) || /laravel-vite-plugin/i.test(evidence));
  if (laravelViteHmrBlocked) {
    return {
      class: "laravel_vite_ci_hmr_blocked",
      explanation: "Laravel's Vite integration refused to start the HMR asset server in a CI environment.",
      metadata: { tool: "laravel-vite-plugin", mode: "ci-hmr" },
      safeNextStep: "For local verification: rerun with LARAVEL_BYPASS_ENV_CHECK=1 only if intentionally testing the Vite dev server. For CI verification: use production asset build instead of Vite HMR. For Laravel app verification: run the Laravel app server, not only the Vite asset server.",
    };
  }

  const healthCandidateMismatch = evidence.match(
    /Health candidate port mismatch\s+inferredHealthUrl:\s*(\S+)\s+advertisedHealthUrl:\s*(\S+)\s+advertisedPort:\s*(\d+)\s+selectedCommand:\s*([^\n]+)/i,
  );
  if (healthCandidateMismatch) {
    return {
      class: "health_candidate_port_mismatch",
      explanation: `The supervised process advertised ${healthCandidateMismatch[2]}, but BootProof inferred ${healthCandidateMismatch[1]} as the application health URL.`,
      metadata: {
        inferredHealthUrl: healthCandidateMismatch[1],
        advertisedHealthUrl: healthCandidateMismatch[2],
        advertisedPort: healthCandidateMismatch[3],
        selectedCommand: healthCandidateMismatch[4].trim(),
      },
      safeNextStep: "Confirm the primary application command and intended health port. For Laravel verification, run the Laravel app server rather than only the Vite asset server.",
    };
  }

  const rubyVersion = evidence.match(/rbenv:\s+version\s+['"]([^'"]+)['"]\s+is not installed/i);
  if (rubyVersion) {
    return {
      class: "missing_ruby_version",
      explanation: `The repository requires Ruby ${rubyVersion[1]}, but that rbenv version is not installed.`,
      metadata: { requiredVersion: rubyVersion[1] },
      safeNextStep: `rbenv install ${rubyVersion[1]}`,
    };
  }

  if (/ERROR:\s*CMake is required to build Rugged/i.test(evidence)) {
    return {
      class: "missing_build_tool",
      explanation: "CMake is required to build the Rugged gem, but it is not available.",
      metadata: { tool: "cmake", affectedGem: "rugged" },
      safeNextStep: "brew install cmake",
    };
  }

  if (/(?:Gem::Ext::BuildError|Failed to build gem native extension|An error occurred while installing\s+[A-Za-z0-9_.-]+)/i.test(evidence)) {
    const gem = affectedGem(evidence);
    return {
      class: "native_extension_compile_failed",
      explanation: gem
        ? `The native extension for ${gem} failed to compile.`
        : "A gem native extension failed to compile.",
      ...(gem ? { metadata: { affectedGem: gem } } : {}),
      safeNextStep: gem
        ? `Install the native build dependencies required by ${gem}, then rerun bundle install.`
        : "Inspect the preserved compiler output, install the required native build dependencies, then rerun bundle install.",
    };
  }

  if (/Could not load database configuration|No such file - \[['"]config\/database\.yml['"]\]/i.test(evidence)) {
    return {
      class: "missing_database_config",
      explanation: "The application could not load config/database.yml.",
      metadata: { filePath: "config/database.yml" },
      safeNextStep: "Create config/database.yml from the repository's documented example, review it, then rerun BootProof.",
    };
  }

  const requiredConfig = evidence.match(/No such file or directory @ rb_sysopen - ([^\s]+(?:\.ya?ml))/i);
  if (requiredConfig) {
    return {
      class: "missing_required_config",
      explanation: `The required configuration file ${requiredConfig[1]} is missing.`,
      metadata: { filePath: requiredConfig[1] },
      safeNextStep: `Create ${requiredConfig[1]} from the repository's documented example, review it, then rerun BootProof.`,
    };
  }

  const postgresRole = evidence.match(/FATAL:\s+role\s+["']([^"']+)["']\s+does not exist/i);
  if (postgresRole) {
    return {
      class: "postgres_role_missing",
      explanation: `PostgreSQL was reached, but role ${postgresRole[1]} does not exist.`,
      metadata: { role: postgresRole[1] },
      safeNextStep: `Create the PostgreSQL role ${postgresRole[1]} or configure the application to use an existing role, then rerun BootProof.`,
    };
  }

  const undefinedTable = evidence.match(/relation\s+["']([^"']+)["']\s+does not exist/i);
  if (/PG::UndefinedTable/i.test(evidence) || undefinedTable) {
    return {
      class: "database_schema_missing",
      explanation: undefinedTable
        ? `The database schema is missing table ${undefinedTable[1]}.`
        : "PostgreSQL reported an undefined table, so the database schema is missing or incomplete.",
      ...(undefinedTable ? { metadata: { table: undefinedTable[1] } } : {}),
      safeNextStep: "Run the repository's documented database migration or setup command, then rerun BootProof.",
    };
  }

  const databaseVersion = evidence.match(/PostgreSQL\s+([0-9]+(?:\.[0-9]+)*)\s+is installed,\s+but GitLab requires PostgreSQL\s+([><=~^ ]+[0-9]+(?:\.[0-9]+)*)/i);
  if (databaseVersion) {
    return {
      class: "unsupported_database_version",
      explanation: `PostgreSQL ${databaseVersion[1]} is installed, but the repository requires PostgreSQL ${databaseVersion[2].trim()}.`,
      metadata: { foundVersion: databaseVersion[1], requiredVersion: databaseVersion[2].trim() },
      safeNextStep: `Install or select PostgreSQL ${databaseVersion[2].trim()}, then rerun BootProof.`,
    };
  }

  const unsupportedConfig = evidence.match(/unsupported database names in ['"]config\/database\.yml['"]:\s*([^\n]+)/i);
  if (unsupportedConfig) {
    const supported = evidence.match(/supported database names(?: are|:)\s*([^\n]+)/i);
    const unsupportedNames = commaSeparated(unsupportedConfig[1]) ?? [];
    const supportedNames = commaSeparated(supported?.[1]);
    return {
      class: "unsupported_database_config",
      explanation: `config/database.yml contains unsupported database names: ${unsupportedNames.join(", ")}.`,
      metadata: {
        unsupportedNames,
        ...(supportedNames ? { supportedNames } : {}),
      },
      safeNextStep: supportedNames
        ? `Use only the supported database names (${supportedNames.join(", ")}) in config/database.yml, then rerun BootProof.`
        : "Review config/database.yml against the repository's supported database names, then rerun BootProof.",
    };
  }

  const postgresConnection = evidence.match(/connection to server at ["']([^"']+)["'],\s+port\s+(\d+)\s+failed:\s*Connection refused/i);
  const genericPgConnection = /PG::ConnectionBad/i.test(evidence)
    && !/password authentication failed|role\s+["'][^"']+["']\s+does not exist|PG::UndefinedTable/i.test(evidence);
  if (postgresConnection || genericPgConnection) {
    return {
      class: "postgres_unavailable",
      explanation: "The application could not connect to PostgreSQL.",
      ...(postgresConnection ? { metadata: { host: postgresConnection[1], port: postgresConnection[2] } } : {}),
      safeNextStep: "Start PostgreSQL, verify the configured host and port are reachable, then rerun BootProof.",
    };
  }

  const redisConnection = evidence.match(/(?:Connection refused - connect\(2\) for\s+([^:\s]+):(\d+)|redis:\/\/([^:\s/]+):(\d+))/i);
  const redisUrlFailure = /redis:\/\/localhost:6379/i.test(evidence)
    && /\b(?:error|refused|failed|cannot connect|unavailable)\b/i.test(evidence);
  if (
    /Redis::CannotConnectError/i.test(evidence)
    || /Connection refused - connect\(2\) for\s+(?:127\.0\.0\.1|localhost):6379/i.test(evidence)
    || redisUrlFailure
  ) {
    const host = redisConnection?.[1] ?? redisConnection?.[3];
    const port = redisConnection?.[2] ?? redisConnection?.[4];
    return {
      class: "redis_unavailable",
      explanation: "The application could not connect to Redis.",
      ...(host && port ? { metadata: { host, port } } : {}),
      safeNextStep: "Start Redis, verify the configured host and port are reachable, then rerun BootProof.",
    };
  }

  return null;
}

const RULES: Rule[] = [
  { class: "package_manager_version_mismatch", pattern: /(ERR_PNPM_UNSUPPORTED_ENGINE|Unsupported environment \(bad (?:pnpm|yarn|npm|bun) and\/or Node\.js version\)|(?:pnpm|yarn|npm|bun)[\s\S]{0,160}Expected version:\s*[^\n]+[\s\S]{0,120}Got:\s*[^\n]+|packageManager field[\s\S]{0,120}(?:version|mismatch)|engines\.(?:pnpm|yarn|npm|bun))/i,
    explain: () => "The repository declares a package manager version that does not match the version available in the current environment. Enable Corepack or install the required package manager version before rerunning BootProof." },
  { class: "runtime_engine_mismatch", pattern: /(Node version .{0,40}doesn'?t (?:satisfy|match)|The engine "node" is incompatible|EBADENGINE|required:\s*\{\s*node)/i,
    explain: () => "The host Node version does not satisfy the project's engines requirement. Switch Node versions (nvm/fnm/corepack) and retry." },
  { class: "missing_package_manager", pattern: /\b(yarn|pnpm|bun): (command )?not found/i,
    explain: m => `The project needs ${m[1]} and it is not installed. Enable Corepack (corepack enable) or install ${m[1]} directly.` },
  { class: "missing_runtime_tool", pattern: /(?:(?:^|\s)(ruby|bundle|make|python|php|composer): (?:command )?not found\b|'(ruby|bundle|make|python|php|composer)' is not recognized as an internal or external command|spawn (ruby|bundle|make|python|php|composer) ENOENT)/im,
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
  { class: "migrations_missing", pattern: /(relation .* does not exist|no such table|Migration.*pending|unapplied migrations?|PendingMigrationError|P3009)/i,
    explain: () => "The database schema is missing or behind. Run the project's migration command against the local database." },
  { class: "missing_env_var", pattern: /([A-Z][A-Z0-9_]{2,}(?:\s+environment variable)?\s+is\s+(?:not\s+set|required|missing|undefined)|Missing required secret:\s*[A-Z][A-Z0-9_]{2,}|^\s+[A-Z][A-Z0-9_]{2,}:\s*Required\b|please set\s+[A-Z][A-Z0-9_]{2,}|Invalid environment variables)/m,
    explain: () => "The app refuses to start without specific environment variables. BootProof will not invent secrets or write protected .env files." },
  { class: "tls_or_proxy_interception", pattern: /(SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to get local issuer certificate)/,
    explain: () => "A TLS-intercepting proxy or self-signed certificate chain is blocking package/tool downloads. Configure your proxy CA (NODE_EXTRA_CA_CERTS) or run outside the intercepting network." },
  { class: "service_port_allocated", pattern: /(port is already allocated|Bind for 0\.0\.0\.0:\d+ failed|failed programming external connectivity|Ports are not available)/i,
    explain: () => "Docker is available, but a required service port is already allocated by another local process or container. Stop the process using that port, or rerun with a different service port." },
  { class: "docker_unavailable", pattern: /(Cannot connect to the Docker daemon|docker: (command )?not found|docker daemon is not running|error during connect)/i,
    explain: () => "Docker is not available, and this plan needs it for services. Start Docker, or rerun with --provider local --unsafe-local if the app needs no containers." },
  { class: "health_http_error", pattern: /(only HTTP 5\d\d observed|HTTP 5\d\d|status\s*5\d\d|returned 5\d\d)/i,
    explain: () => "The app responded on the configured health URL, but returned HTTP 5xx. BootProof observed a running server, but not a verified healthy boot." },
];

export function classifyFailure(evidence: string): FailureClassification {
  if (isServicePortAllocatedEvidence(evidence) && /(docker|container|bind for|external connectivity|ports are not available|port is already allocated)/i.test(evidence)) {
    return {
      class: "service_port_allocated",
      explanation: "Docker is available, but a required service port is already allocated by another local process or container. Stop the process using that port, or rerun with a different service port.",
    };
  }
  const realWorld = classifyRealWorldFailure(evidence);
  if (realWorld) return realWorld;
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
  "not_an_application", "orchestration_not_supported", "go_service_orchestration_not_supported", "auth_required", "external_health_unreachable",
  "runtime_engine_mismatch", "missing_ruby_version", "missing_package_manager", "missing_runtime_tool",
  "go_runtime_missing", "go_build_failed",
  "missing_php_runtime", "missing_composer", "unsupported_php_version_for_composer_lock", "missing_php_vendor_autoload",
  "laravel_sqlite_database_missing", "laravel_migrations_required",
  "missing_build_tool", "native_extension_compile_failed", "package_manager_version_mismatch",
  "dependency_install_skipped", "python_flask_setup_required", "laravel_vite_ci_hmr_blocked", "missing_env_var", "missing_database_config", "missing_required_config",
  "database_unreachable", "postgres_unavailable", "postgres_role_missing", "database_schema_missing", "unsupported_database_version",
  "unsupported_database_config", "redis_unavailable", "postgres_auth_env_missing", "migrations_missing", "port_in_use", "native_build_dependency",
  "private_registry_or_auth", "tls_or_proxy_interception", "service_port_allocated", "docker_unavailable", "install_failed", "app_exited_early",
  "health_check_timeout", "health_http_error", "health_candidate_port_mismatch", "workspace_ambiguous", "unknown_failure",
];
