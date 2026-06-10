
function classifyHealthFailure(evidence: string): "health_http_error" | "health_check_timeout" {
  if (/(only HTTP 5\d\d observed|HTTP 5\d\d|status\s*5\d\d|returned 5\d\d)/i.test(evidence)) {
    return "health_http_error";
  }
  return "health_check_timeout";
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export type FailureClass =
  | "not_an_application"
  | "runtime_engine_mismatch"
  | "missing_package_manager"
  | "missing_env_var"
  | "database_unreachable"
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
  | "workspace_ambiguous"
  | "unknown_failure";

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

export interface Inference {
  repoPath: string;
  isApplication: boolean;
  notAppReason?: string;
  stack: string[];
  packageManager: PackageManager;
  packageManagerEvidence: string;
  installCommand: string | null;
  appCommand: string | null;
  appCommandSource: string;
  port: number;
  portEvidence: string;
  services: ServiceNeed[];
  requiredEnv: string[];
  envWithoutSafeDefault: string[];
  engines: { node?: string };
  workspaces: WorkspaceCandidate[];
  confidence: number;
}

export interface PlanStep {
  id: string;
  kind: "install" | "service" | "start-app" | "health";
  command?: string;
  description: string;
  required: boolean;
}

export interface RunPlan {
  provider: "docker" | "local";
  steps: PlanStep[];
  healthUrl: string;
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
  evidenceTail?: string;
}

export interface Attestation {
  schema: "bootproof/attestation/v1";
  tool: string;
  repo: { path: string; remote: string | null; commit: string | null; dirty: boolean | null };
  environment: { os: string; arch: string; node: string };
  plan: RunPlan;
  observed: ObservedStep[];
  result: {
    booted: boolean;
    healthVerified: boolean;
    healthObservation: string | null;
    failureClass: FailureClass | null;
    failureEvidence: string | null;
    explanation: string;
  };
  startedAt: string;
  finishedAt: string;
  signer: { publicKey: string; algorithm: "ed25519" } | null;
  signature: string | null;
}
