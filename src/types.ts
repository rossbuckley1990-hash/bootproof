
function classifyHealthFailure(evidence: string): "health_http_error" | "health_check_timeout" {
  if (/(only HTTP 5\d\d observed|HTTP 5\d\d|status\s*5\d\d|returned 5\d\d)/i.test(evidence)) {
    return "health_http_error";
  }
  return "health_check_timeout";
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export type FailureClass =
  | "not_an_application"
  | "orchestration_not_supported"
  | "go_service_orchestration_not_supported"
  | "auth_required"
  | "external_health_unreachable"
  | "runtime_engine_mismatch"
  | "missing_ruby_version"
  | "missing_package_manager"
  | "missing_runtime_tool"
  | "go_runtime_missing"
  | "go_build_failed"
  | "missing_project_cli"
  | "missing_php_runtime"
  | "missing_composer"
  | "unsupported_php_version_for_composer_lock"
  | "missing_php_vendor_autoload"
  | "laravel_sqlite_database_missing"
  | "laravel_migrations_required"
  | "missing_build_tool"
  | "native_extension_compile_failed"
  | "package_manager_version_mismatch"
  | "dependency_install_skipped"
  | "python_flask_setup_required"
  | "laravel_vite_ci_hmr_blocked"
  | "missing_env_var"
  | "missing_database_config"
  | "missing_required_config"
  | "database_unreachable"
  | "postgres_unavailable"
  | "postgres_role_missing"
  | "database_schema_missing"
  | "unsupported_database_version"
  | "unsupported_database_config"
  | "redis_unavailable"
  | "postgres_auth_env_missing"
  | "migrations_missing"
  | "port_in_use"
  | "native_build_dependency"
  | "private_registry_or_auth"
  | "tls_or_proxy_interception"
  | "service_port_allocated"
  | "docker_unavailable"
  | "install_failed"
  | "app_exited_early"
  | "health_check_timeout"
  | "health_http_error"
  | "health_candidate_port_mismatch"
  | "workspace_ambiguous"
  | "unknown_failure";

export type VerificationMode = "bootproof-orchestrated" | "external-health";

export type HealthCandidateSource = "inferred" | "known_service" | "process_output" | "observed";

export type ExternalVerificationClassification =
  | "external_service_verified"
  | "auth_required"
  | "external_health_unreachable";

export interface ServiceNeed {
  kind: "postgres" | "mysql" | "redis" | "mongodb";
  evidence: string;
}

export interface WorkspaceCandidate {
  dir: string;
  name: string;
  score: number;
  reason: string;
}

export interface PreparationCommand {
  id: string;
  kind: "install" | "build";
  command: string;
  description: string;
  source: string;
}

export interface ComposeApplicationService {
  name: string;
  source: "build" | "image";
  healthCandidates: string[];
}

export interface Inference {
  repoPath: string;
  isApplication: boolean;
  notAppReason?: string;
  stack: string[];
  backendMarkers: string[];
  frontendMarkers: string[];
  serviceMarkers: string[];
  repoComposeFile: string | null;
  composeApplicationServices: ComposeApplicationService[];
  composeHealthCandidates: string[];
  setupSteps: string[];
  packageManager: PackageManager;
  packageManagerEvidence: string;
  packageManagerVersion: string | null;
  installCommand: string | null;
  preparationCommands: PreparationCommand[];
  dependencyInstallRequired: boolean;
  appCommand: string | null;
  appCommandSource: string;
  selectedPackageScriptName: string | null;
  selectedPackageScriptCommand: string | null;
  projectCliCommand: string | null;
  projectCliReady: boolean | null;
  backendCommand: string | null;
  frontendCommand: string | null;
  asset_dev_server_command: string | null;
  workerCommand: string | null;
  commandScope: string;
  incompleteAppCommand: boolean;
  multiAppCommand: boolean;
  port: number;
  portEvidence: string;
  observedPort: number | null;
  healthCandidateSource: HealthCandidateSource;
  healthCandidates: string[];
  services: ServiceNeed[];
  requiredEnv: string[];
  envWithoutSafeDefault: string[];
  engines: { node?: string; npm?: string; pnpm?: string; yarn?: string; bun?: string };
  workspaces: WorkspaceCandidate[];
  confidence: number;
}

export interface PlanStep {
  id: string;
  kind: "install" | "build" | "service" | "start-app" | "health";
  command?: string;
  description: string;
  required: boolean;
}

export interface RunPlan {
  provider: "docker" | "local";
  steps: PlanStep[];
  healthUrl: string;
  healthCandidates: string[];
  observedPort: number | null;
  healthCandidateSource: HealthCandidateSource;
  generatedFiles: { path: string; purpose: string }[];
}

export interface ObservedStep {
  id: string;
  kind: PlanStep["kind"];
  command?: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  ok: boolean;
  observation: string;
  evidenceHead?: string;
  evidenceTail?: string;
  firstErrorLine?: string;
  firstExceptionLine?: string;
  detectedCause?: string;
}

export interface HealthEvidence {
  requestedUrl: string;
  statusCode: number | null;
  statusText: string | null;
  headers: Record<string, string>;
  redirectLocation: string | null;
  bodyExcerpt: string;
  timestamp: string;
  acceptedAsHealthy: boolean;
  connectionError: string | null;
}

export interface AttestationTrust {
  level: "local_developer_signed" | "ci_oidc_signed";
  signer: "local_ed25519" | "ci_oidc";
  oidc: Record<string, string> | null;
}

export interface Attestation {
  schema: "bootproof/attestation/v1";
  tool: string;
  verificationMode: VerificationMode;
  bootproofOrchestrated: boolean;
  externalHealthUrl: string | null;
  observedStatus: number | null;
  observedFinalUrl: string | null;
  observedAt: string | null;
  responseSnippet: string;
  classification: ExternalVerificationClassification | null;
  redactionsApplied: string[];
  repo: { path: string; remote: string | null; commit: string | null; dirty: boolean | null };
  environment: { os: string; arch: string; node: string };
  trust: AttestationTrust;
  plan: RunPlan;
  observed: ObservedStep[];
  result: {
    booted: boolean;
    healthVerified: boolean;
    healthObservation: string | null;
    healthEvidence: HealthEvidence | null;
    observedHealthCandidates: string[];
    observedPort: number | null;
    healthCandidateSource: HealthCandidateSource;
    failureClass: FailureClass | null;
    failureEvidence: string | null;
    explanation: string;
  };
  startedAt: string;
  finishedAt: string;
  signer: { publicKey: string; algorithm: "ed25519" } | null;
  signature: string | null;
}
