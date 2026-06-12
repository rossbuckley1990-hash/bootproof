import path from "node:path";
import type { FailureClass } from "./types.js";

export type RepairActionType = "command" | "patch" | "instruction";
export type RepairActionSource = "deterministic_playbook" | "ai_suggested";
export const ACTION_MUTATION_SCOPES = [
  "none",
  "repo_only",
  "project_cache",
  "container_runtime",
  "host_tool_install",
  "host_network",
  "kubernetes_cluster",
  "database",
  "service",
  "credentials",
  "unknown",
] as const;
export const ACTION_RISK_LEVELS = ["none", "low", "medium", "high", "blocked"] as const;
export type RepairMutationScope = typeof ACTION_MUTATION_SCOPES[number];
export type RepairRiskLevel = typeof ACTION_RISK_LEVELS[number];

export interface RepairCommand {
  executable: string;
  args: string[];
  display: string;
}

export interface RepairPatch {
  format: "unified-diff";
  content: string;
  files: string[];
}

export interface RepairAction {
  schema: "bootproof/repair-action/v1";
  actionType: RepairActionType;
  mutationScope: RepairMutationScope;
  riskLevel: RepairRiskLevel;
  requiresApproval: boolean;
  approvalPrompt: string;
  blockedReason: string;
  verificationStep: string;
  command: RepairCommand | null;
  patch: RepairPatch | null;
  instruction: string | null;
  explanation: string;
  evidenceRefs: string[];
  deterministic: boolean;
  source: RepairActionSource;
}

export interface RepairActionInput {
  actionType: RepairActionType;
  mutationScope: RepairMutationScope;
  riskLevel: RepairRiskLevel;
  requiresApproval?: boolean;
  blockedReason?: string;
  verificationStep?: string;
  command?: RepairCommand | null;
  patch?: RepairPatch | null;
  instruction?: string | null;
  explanation: string;
  evidenceRefs: string[];
}

export type RepairApplyStatus = "not_applied" | "applied" | "failed";

export interface RepairApplyResultRecord {
  status: RepairApplyStatus;
  exitCode: number | null;
  filesChanged: string[];
  evidence: string | null;
}

export interface RepairReceiptBase {
  schema: "bootproof/repair-receipt/v1";
  repairId: string;
  createdAt: string;
  bootproofVersion: string;
  source: RepairActionSource;
  beforeFailureClass: FailureClass;
  beforeEvidenceHash: string;
  proposedAction: RepairAction;
  actionType: RepairActionType;
  mutationScope: RepairMutationScope;
  riskLevel: RepairRiskLevel;
  userApprovalRequired: boolean;
  approvedAt?: string;
  appliedAt?: string;
  applyResult: RepairApplyResultRecord;
  afterFailureClass?: FailureClass;
  progressed: boolean;
  verified: boolean;
  explanation: string;
  redactionsApplied: string[];
}

export interface RepairReceiptBaseInput {
  repairId: string;
  createdAt: string;
  bootproofVersion: string;
  beforeFailureClass: FailureClass;
  beforeEvidenceHash: string;
  proposedAction: RepairAction;
  approvedAt?: string;
  appliedAt?: string;
  applyResult?: RepairApplyResultRecord;
  afterFailureClass?: FailureClass;
  progressed?: boolean;
  verified?: boolean;
  explanation: string;
  redactionsApplied?: string[];
}

export interface RepairSafetyValidation {
  valid: boolean;
  errors: string[];
}

export interface ActionRiskAssessment {
  actionType: RepairActionType;
  command: string;
  riskLevel: RepairRiskLevel;
  mutationScope: RepairMutationScope;
  requiresApproval: boolean;
  approvalPrompt: string;
  blockedReason: string;
  verificationStep: string;
}

export interface ActionRiskInput {
  actionType: RepairActionType;
  command?: RepairCommand | null;
  mutationScope?: RepairMutationScope;
  riskLevel?: RepairRiskLevel;
  requiresApproval?: boolean;
  blockedReason?: string;
  verificationStep?: string;
}

const ACTION_TYPES = new Set<RepairActionType>(["command", "patch", "instruction"]);
const MUTATION_SCOPES = new Set<RepairMutationScope>(ACTION_MUTATION_SCOPES);
const RISK_LEVELS = new Set<RepairRiskLevel>(ACTION_RISK_LEVELS);
const ACTION_KEYS = new Set([
  "schema",
  "actionType",
  "mutationScope",
  "riskLevel",
  "requiresApproval",
  "approvalPrompt",
  "blockedReason",
  "verificationStep",
  "command",
  "patch",
  "instruction",
  "explanation",
  "evidenceRefs",
  "deterministic",
  "source",
]);
const COMMAND_KEYS = new Set(["executable", "args", "display"]);
const PATCH_KEYS = new Set(["format", "content", "files"]);
const RECEIPT_KEYS = new Set([
  "schema",
  "repairId",
  "createdAt",
  "bootproofVersion",
  "source",
  "beforeFailureClass",
  "beforeEvidenceHash",
  "proposedAction",
  "actionType",
  "mutationScope",
  "riskLevel",
  "userApprovalRequired",
  "approvedAt",
  "appliedAt",
  "applyResult",
  "afterFailureClass",
  "progressed",
  "verified",
  "explanation",
  "redactionsApplied",
  "tool",
  "repo",
  "environment",
  "failure",
  "repair",
  "verification",
  "startedAt",
  "finishedAt",
  "signer",
  "signature",
]);
const APPLY_RESULT_KEYS = new Set(["status", "exitCode", "filesChanged", "evidence"]);
const SHELL_CONTROL = /(?:[;&|<>`]|[$]\(|[\r\n])/;
const SHELL_EXECUTABLE = /^(?:ba|z|k|c|fi)?sh$|^(?:cmd|powershell|pwsh)(?:\.exe)?$/i;
const NETWORK_EXECUTABLE = /^(?:curl|wget|nc|ncat|netcat|scp|sftp|ftp|rsync)$/i;
const MUTATING_EXECUTABLE = /^(?:cp|mv|install|touch|truncate|tee|sed|perl|ruby|python(?:3)?|node)$/i;
const SENSITIVE_PATH = /(?:^|\/)(?:\.ssh|\.aws|\.gnupg)(?:\/|$)|(?:^|\/)(?:id_rsa|id_ed25519|credentials)(?:$|\/)|private[_-]?key/i;
const ATTESTATION_PATH = /(?:^|\/)(?:\.bootproof\/)?attestation(?:\.[A-Za-z0-9_-]+)?\.json$/i;
const RISK_WEIGHT: Record<RepairRiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  blocked: 4,
};

function validation(errors: string[]): RepairSafetyValidation {
  return { valid: errors.length === 0, errors };
}

function unknownKeys(value: object, allowed: ReadonlySet<string>): string[] {
  return Object.keys(value)
    .filter(key => !allowed.has(key))
    .map(key => `unsupported field: ${key}`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isoDate(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function commandToken(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

export function renderRepairCommand(executable: string, args: string[]): string {
  return [executable, ...args].map(commandToken).join(" ");
}

export function createRepairCommand(executable: string, args: string[]): RepairCommand {
  return { executable, args: [...args], display: renderRepairCommand(executable, args) };
}

export function isProtectedEnvPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const base = path.posix.basename(normalized);
  return (
    base === ".env" ||
    base === ".env.local" ||
    base === ".env.development" ||
    base === ".env.production" ||
    /^\.env\..+\.local$/i.test(base)
  );
}

export function isBlockedRepairPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return true;
  }
  const relative = normalized.replace(/^\.\//, "");
  return (
    isProtectedEnvPath(relative) ||
    /(?:^|\/)\.git(?:\/|$)/.test(relative) ||
    /(?:^|\/)\.bootproof\/signer\.json$/.test(relative) ||
    SENSITIVE_PATH.test(relative)
  );
}

function commandText(command: RepairCommand): string {
  return [command.executable, ...command.args, command.display].join(" ");
}

function higherRisk(left: RepairRiskLevel, right: RepairRiskLevel): RepairRiskLevel {
  return RISK_WEIGHT[left] >= RISK_WEIGHT[right] ? left : right;
}

function defaultVerificationStep(actionType: RepairActionType): string {
  if (actionType === "patch") {
    return "Review the applied files, rerun BootProof, and require observed health evidence.";
  }
  if (actionType === "instruction") {
    return "Complete the instruction, then rerun BootProof and require observed health evidence.";
  }
  return "Rerun BootProof and require observed health evidence before marking progress.";
}

function approvalPromptFor(
  actionType: RepairActionType,
  scope: RepairMutationScope,
  requiresApproval: boolean,
  blockedReason: string,
): string {
  if (blockedReason) return `Blocked by BootProof safety policy: ${blockedReason}`;
  if (!requiresApproval) return "No approval is required because this action is non-mutating or read-only.";
  if (actionType === "patch") return "This action will modify repository files. Review the exact patch before approving it.";
  switch (scope) {
    case "host_tool_install":
      return "This action may install or change tools on your local machine. Review the exact command before approving it.";
    case "host_network":
      return "This action will access the network from your local machine. Review the destination and exact command before approving it.";
    case "container_runtime":
      return "This action may change local container runtime state. Review the exact command before approving it.";
    case "kubernetes_cluster":
      return "This action may create or modify a local Kubernetes cluster. Review the exact command before approving it.";
    case "database":
      return "This action may change local database state. Review the exact command before approving it.";
    case "service":
      return "This action may start or modify a local service. Review the exact command before approving it.";
    case "credentials":
      return "This action may create or change credentials. Do not proceed unless the credential destination and handling are understood.";
    case "project_cache":
      return "This action may change project-local tool configuration or caches. Review the exact command before approving it.";
    case "repo_only":
      return "This action may change repository files. Review the exact command before approving it.";
    case "none":
      return "This non-mutating action is configured to require explicit acknowledgement before it is recorded as approved.";
    default:
      return "This action has unknown mutation scope. Review the exact command and its effects before approving it.";
  }
}

function inferredCommandRisk(command: RepairCommand): {
  riskLevel: RepairRiskLevel;
  mutationScope: RepairMutationScope;
} {
  const executable = path.basename(command.executable).toLowerCase();
  const args = command.args.map(arg => arg.toLowerCase());
  const text = [executable, ...args].join(" ");

  if (
    (executable === "brew" && args[0] === "install") ||
    (executable === "rbenv" && args[0] === "install") ||
    (["apt", "apt-get", "dnf", "yum", "pacman", "zypper"].includes(executable) && args.includes("install")) ||
    (executable === "npm" && args.includes("--global")) ||
    (executable === "gem" && args[0] === "install")
  ) {
    return { riskLevel: "high", mutationScope: "host_tool_install" };
  }
  if (executable === "docker" && args[0] === "system" && args[1] === "prune") {
    return { riskLevel: "high", mutationScope: "container_runtime" };
  }
  if (
    (executable === "kind" && args[0] === "create" && args[1] === "cluster") ||
    (executable === "helm" && args[0] === "install") ||
    (executable === "kubectl" && args[0] === "apply") ||
    (executable === "abctl" && args[0] === "local" && args[1] === "install")
  ) {
    return { riskLevel: "high", mutationScope: "kubernetes_cluster" };
  }
  if (
    /\b(?:db:migrate|db:setup|migrate(?::latest)?|migrate\s+deploy|db\s+push)\b/i.test(text) ||
    (executable === "python" && args.some(arg => /manage\.py$/i.test(arg)) && args.includes("migrate"))
  ) {
    return { riskLevel: "high", mutationScope: "database" };
  }
  if (
    executable === "ssh-keygen" ||
    executable === "htpasswd" ||
    (executable === "abctl" && args[0] === "local" && args[1] === "credentials") ||
    (executable === "openssl" && ["rand", "genpkey", "genrsa", "req"].includes(args[0] ?? ""))
  ) {
    return { riskLevel: "high", mutationScope: "credentials" };
  }
  if (executable === "bootproof" && args[0] === "verify-url") {
    return { riskLevel: "low", mutationScope: "none" };
  }
  if (
    args.includes("--version") ||
    args[0] === "version" ||
    args[0] === "status" ||
    executable === "pg_isready" ||
    (executable === "kubectl" && args[0] === "cluster-info")
  ) {
    return { riskLevel: "low", mutationScope: "none" };
  }
  if (executable === "brew" && args[0] === "services") {
    return { riskLevel: "medium", mutationScope: "service" };
  }
  if (executable === "bundle" && args[0] === "config") {
    return { riskLevel: "medium", mutationScope: "project_cache" };
  }
  if (executable === "corepack" && args[0] === "prepare") {
    return { riskLevel: "medium", mutationScope: "project_cache" };
  }
  if (executable === "createuser") {
    return { riskLevel: "medium", mutationScope: "database" };
  }
  if (["docker", "podman"].includes(executable)) {
    return { riskLevel: "medium", mutationScope: "container_runtime" };
  }
  if (["kind", "helm", "kubectl", "abctl"].includes(executable)) {
    return { riskLevel: "medium", mutationScope: "kubernetes_cluster" };
  }
  if (NETWORK_EXECUTABLE.test(executable)) {
    return { riskLevel: "medium", mutationScope: "host_network" };
  }
  return { riskLevel: "medium", mutationScope: "unknown" };
}

export function assessActionRisk(input: ActionRiskInput): ActionRiskAssessment {
  let riskLevel = input.riskLevel ?? (input.actionType === "command" ? "medium" : "none");
  let mutationScope = input.mutationScope ?? (input.actionType === "patch" ? "repo_only" : "none");
  let blockedReason = input.blockedReason?.trim() ?? "";

  if (input.actionType === "command") {
    const commandValidation = validateRepairCommand(input.command);
    if (!commandValidation.valid) {
      riskLevel = "blocked";
      mutationScope = mutationScope === "none" ? "unknown" : mutationScope;
      blockedReason = commandValidation.errors.join("; ");
    } else {
      const inferred = inferredCommandRisk(input.command!);
      riskLevel = higherRisk(riskLevel, inferred.riskLevel);
      if (inferred.mutationScope !== "unknown") mutationScope = inferred.mutationScope;
      else if (mutationScope === "none") mutationScope = "unknown";
    }
  } else if (input.actionType === "patch") {
    mutationScope = "repo_only";
    riskLevel = higherRisk(riskLevel, "low");
  }

  if (riskLevel === "blocked" && !blockedReason) {
    blockedReason = "The action is unknown or blocked by BootProof's safety policy.";
  }
  if (riskLevel !== "blocked") blockedReason = "";
  const requiresApproval = riskLevel === "blocked"
    ? false
    : input.requiresApproval === true || input.actionType === "patch" || ["medium", "high"].includes(riskLevel);

  return {
    actionType: input.actionType,
    command: input.command?.display ?? "",
    riskLevel,
    mutationScope,
    requiresApproval,
    approvalPrompt: approvalPromptFor(
      input.actionType,
      mutationScope,
      requiresApproval,
      blockedReason,
    ),
    blockedReason,
    verificationStep: input.verificationStep?.trim() || defaultVerificationStep(input.actionType),
  };
}

export function validateActionRiskAssessment(value: unknown): RepairSafetyValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return validation(["action risk assessment must be an object"]);
  }
  const assessment = value as Partial<ActionRiskAssessment>;
  const errors: string[] = [];
  if (!ACTION_TYPES.has(assessment.actionType as RepairActionType)) errors.push("unknown action type");
  if (typeof assessment.command !== "string") errors.push("command must be a string");
  if (!RISK_LEVELS.has(assessment.riskLevel as RepairRiskLevel)) errors.push("invalid risk level");
  if (!MUTATION_SCOPES.has(assessment.mutationScope as RepairMutationScope)) errors.push("invalid mutation scope");
  if (typeof assessment.requiresApproval !== "boolean") errors.push("requiresApproval must be boolean");
  if (!nonEmptyString(assessment.approvalPrompt)) errors.push("approvalPrompt must be a non-empty string");
  if (typeof assessment.blockedReason !== "string") errors.push("blockedReason must be a string");
  if (!nonEmptyString(assessment.verificationStep)) errors.push("verificationStep must be a non-empty string");
  if (assessment.riskLevel === "blocked") {
    if (assessment.requiresApproval !== false) errors.push("blocked actions must not be executable");
    if (!nonEmptyString(assessment.blockedReason)) errors.push("blocked actions require blockedReason");
  } else {
    if (assessment.blockedReason !== "") errors.push("non-blocked actions must use an empty blockedReason");
    if (["medium", "high"].includes(String(assessment.riskLevel)) && assessment.requiresApproval !== true) {
      errors.push("medium and high risk actions require approval");
    }
  }
  return validation([...new Set(errors)]);
}

export function validateRepairCommand(command: unknown): RepairSafetyValidation {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return validation(["command must be an object"]);
  }
  const candidate = command as Partial<RepairCommand>;
  const errors = unknownKeys(command, COMMAND_KEYS);
  if (!nonEmptyString(candidate.executable)) errors.push("command.executable must be a non-empty string");
  if (!stringArray(candidate.args)) errors.push("command.args must be a string array");
  if (!nonEmptyString(candidate.display)) errors.push("command.display must be a non-empty string");
  if (errors.length) return validation(errors);

  const executable = candidate.executable!;
  const args = candidate.args!;
  const display = candidate.display!;
  const executableName = path.basename(executable).toLowerCase();
  const raw = commandText(candidate as RepairCommand);
  const normalized = raw.replace(/\s+/g, " ").trim();

  if (display !== renderRepairCommand(executable, args)) {
    errors.push("command.display must exactly represent command.executable and command.args");
  }
  if (SHELL_CONTROL.test(raw)) errors.push("hidden shell chaining, pipes, redirects, or substitution are not allowed");
  if (SHELL_EXECUTABLE.test(executableName)) errors.push("shell command interpreters are not allowed");
  if (executableName === "sudo" || /(^|\s)sudo(?:\s|$)/i.test(normalized)) errors.push("sudo is blocked");
  const rmFlags = args.filter(arg => arg.startsWith("-"));
  const recursiveRm = rmFlags.some(arg => arg === "--recursive" || /^-[^-]*r/i.test(arg));
  const forceRm = rmFlags.some(arg => arg === "--force" || /^-[^-]*f/i.test(arg));
  if (executableName === "rm" && recursiveRm && forceRm) {
    errors.push("rm -rf is blocked");
  }
  if (/(^|\s)(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|k|c|fi)?sh\b/i.test(raw)) {
    errors.push("pipe-to-shell downloads are blocked");
  }
  if (
    executableName === "chmod" &&
    args.some(arg => arg === "--recursive" || /^-[^-]*R/.test(arg)) &&
    args.includes("777")
  ) {
    errors.push("chmod -R 777 is blocked");
  }
  if (executableName === "chown" && args.some(arg => arg === "--recursive" || /^-[^-]*R/.test(arg))) {
    errors.push("chown -R is blocked");
  }
  if (/^mkfs(?:\.[A-Za-z0-9_-]+)?$/i.test(executableName)) errors.push("mkfs is blocked");
  if (executableName === "diskutil" && args.some(arg => /^erase/i.test(arg))) errors.push("diskutil erase is blocked");
  if (executableName === "dropdb" || /\bDROP\s+DATABASE\b/i.test(normalized)) {
    errors.push("destructive database drops are blocked");
  }
  if (executableName === "printenv" || executableName === "env") {
    errors.push("commands that print environment values are blocked");
  }

  const referencedPaths = args.filter(arg => /[./\\]/.test(arg));
  if (
    referencedPaths.some(isProtectedEnvPath) ||
    referencedPaths.some(arg => SENSITIVE_PATH.test(arg.replace(/\\/g, "/")))
  ) {
    errors.push("commands may not access protected environment or secret paths");
  }
  if (MUTATING_EXECUTABLE.test(executableName) && args.some(isBlockedRepairPath)) {
    errors.push("command targets a blocked path");
  }
  if (
    NETWORK_EXECUTABLE.test(executableName) &&
    (
      args.some(arg => isProtectedEnvPath(arg.replace(/^@/, "")) || SENSITIVE_PATH.test(arg)) ||
      args.some(arg => ATTESTATION_PATH.test(arg.replace(/^@/, ""))) ||
      args.some(arg => /^(?:-F|--form|--data-binary|--upload-file|--post-file|-T)$/i.test(arg))
    )
  ) {
    errors.push("secret upload or exfiltration patterns are blocked");
  }
  if (
    /\b(?:cat|printenv|env)\b[\s\S]*(?:curl|wget|nc|ncat|netcat|scp|sftp|ftp|rsync)\b/i.test(raw) ||
    /\b(?:curl|wget|nc|ncat|netcat|scp|sftp|ftp|rsync)\b[\s\S]*(?:cat|printenv|env)\b/i.test(raw)
  ) {
    errors.push("secret exposure to network commands is blocked");
  }

  return validation([...new Set(errors)]);
}

export function validateRepairPatch(patchValue: unknown): RepairSafetyValidation {
  if (!patchValue || typeof patchValue !== "object" || Array.isArray(patchValue)) {
    return validation(["patch must be an object"]);
  }
  const candidate = patchValue as Partial<RepairPatch>;
  const errors = unknownKeys(patchValue, PATCH_KEYS);
  if (candidate.format !== "unified-diff") errors.push("patch.format must be unified-diff");
  if (!nonEmptyString(candidate.content)) errors.push("patch.content must be a non-empty string");
  if (!stringArray(candidate.files) || candidate.files.length === 0) {
    errors.push("patch.files must be a non-empty string array");
  } else {
    for (const file of candidate.files) {
      if (isBlockedRepairPath(file)) errors.push(`patch targets blocked path: ${file}`);
    }
    if (new Set(candidate.files).size !== candidate.files.length) errors.push("patch.files must not contain duplicates");
  }
  if (typeof candidate.content === "string") {
    for (const match of candidate.content.matchAll(/^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\t\n]+)$/gm)) {
      const file = match[1].trim();
      if (file !== "/dev/null" && isBlockedRepairPath(file)) {
        errors.push(`patch content targets blocked path: ${file}`);
      }
    }
  }
  return validation([...new Set(errors)]);
}

export function validateRepairAction(value: unknown): RepairSafetyValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return validation(["repair action must be an object"]);
  }
  const action = value as Partial<RepairAction>;
  const errors = unknownKeys(value, ACTION_KEYS);
  if (action.schema !== "bootproof/repair-action/v1") errors.push("invalid repair action schema");
  if (!ACTION_TYPES.has(action.actionType as RepairActionType)) errors.push("unknown action type");
  if (!MUTATION_SCOPES.has(action.mutationScope as RepairMutationScope)) errors.push("invalid mutation scope");
  if (!RISK_LEVELS.has(action.riskLevel as RepairRiskLevel)) errors.push("invalid risk level");
  if (typeof action.requiresApproval !== "boolean") errors.push("requiresApproval must be boolean");
  if (!nonEmptyString(action.approvalPrompt)) errors.push("approvalPrompt must be a non-empty string");
  if (typeof action.blockedReason !== "string") errors.push("blockedReason must be a string");
  if (!nonEmptyString(action.verificationStep)) errors.push("verificationStep must be a non-empty string");
  if (!nonEmptyString(action.explanation)) errors.push("explanation must be a non-empty string");
  if (!stringArray(action.evidenceRefs)) errors.push("evidenceRefs must be a string array");
  if (typeof action.deterministic !== "boolean") errors.push("deterministic must be boolean");
  if (!["deterministic_playbook", "ai_suggested"].includes(String(action.source))) {
    errors.push("invalid repair action source");
  }
  if (action.source === "deterministic_playbook" && action.deterministic !== true) {
    errors.push("deterministic playbook actions must set deterministic=true");
  }
  if (action.source === "ai_suggested" && action.deterministic !== false) {
    errors.push("AI-suggested actions must set deterministic=false");
  }
  if (action.riskLevel === "blocked") errors.push("blocked repair actions cannot be accepted");
  if (action.riskLevel !== "blocked" && action.blockedReason !== "") {
    errors.push("non-blocked repair actions must use an empty blockedReason");
  }
  if (
    ["medium", "high"].includes(String(action.riskLevel)) &&
    action.requiresApproval !== true
  ) {
    errors.push("medium and high risk actions always require approval");
  }

  if (action.actionType === "command") {
    if (action.patch !== null || action.instruction !== null) errors.push("command actions may only contain command");
    errors.push(...validateRepairCommand(action.command).errors);
    if (action.mutationScope === "none" && action.riskLevel !== "none" && action.riskLevel !== "low") {
      errors.push("mutating command actions require a mutation scope");
    }
    if (action.command && validateRepairCommand(action.command).valid) {
      const minimum = assessActionRisk({
        actionType: "command",
        command: action.command,
        mutationScope: action.mutationScope,
        riskLevel: "none",
        verificationStep: action.verificationStep,
      });
      if (RISK_WEIGHT[action.riskLevel as RepairRiskLevel] < RISK_WEIGHT[minimum.riskLevel]) {
        errors.push(`command risk cannot be lower than ${minimum.riskLevel}`);
      }
      if (minimum.mutationScope !== "unknown" && action.mutationScope !== minimum.mutationScope) {
        errors.push(`command mutation scope must be ${minimum.mutationScope}`);
      }
    }
  } else if (action.actionType === "patch") {
    if (action.command !== null || action.instruction !== null) errors.push("patch actions may only contain patch");
    errors.push(...validateRepairPatch(action.patch).errors);
    if (action.mutationScope !== "repo_only") errors.push("patch actions must use repo_only mutation scope");
    if (action.requiresApproval !== true) errors.push("patch actions always require approval");
  } else if (action.actionType === "instruction") {
    if (action.command !== null || action.patch !== null) errors.push("instruction actions may only contain instruction");
    if (!nonEmptyString(action.instruction)) errors.push("instruction must be a non-empty string");
  }

  return validation([...new Set(errors)]);
}

export function buildRepairAction(input: RepairActionInput): RepairAction {
  const assessment = assessActionRisk({
    actionType: input.actionType,
    command: input.command,
    mutationScope: input.mutationScope,
    riskLevel: input.riskLevel,
    requiresApproval: input.requiresApproval ?? true,
    blockedReason: input.blockedReason,
    verificationStep: input.verificationStep,
  });
  const action: RepairAction = {
    schema: "bootproof/repair-action/v1",
    actionType: input.actionType,
    mutationScope: assessment.mutationScope,
    riskLevel: assessment.riskLevel,
    requiresApproval: assessment.requiresApproval,
    approvalPrompt: assessment.approvalPrompt,
    blockedReason: assessment.blockedReason,
    verificationStep: assessment.verificationStep,
    command: input.command ?? null,
    patch: input.patch ?? null,
    instruction: input.instruction ?? null,
    explanation: input.explanation,
    evidenceRefs: [...input.evidenceRefs],
    deterministic: true,
    source: "deterministic_playbook",
  };
  const result = validateRepairAction(action);
  if (!result.valid) throw new Error(`invalid deterministic repair action: ${result.errors.join("; ")}`);
  return action;
}

export const createRepairAction = buildRepairAction;

export function buildAiSuggestedRepairAction(input: RepairActionInput): RepairAction {
  const assessment = assessActionRisk({
    actionType: input.actionType,
    command: input.command,
    mutationScope: input.mutationScope,
    riskLevel: input.riskLevel,
    requiresApproval: true,
    blockedReason: input.blockedReason,
    verificationStep: input.verificationStep,
  });
  const action: RepairAction = {
    schema: "bootproof/repair-action/v1",
    actionType: input.actionType,
    mutationScope: assessment.mutationScope,
    riskLevel: assessment.riskLevel,
    requiresApproval: true,
    approvalPrompt: assessment.approvalPrompt,
    blockedReason: assessment.blockedReason,
    verificationStep: assessment.verificationStep,
    command: input.command ?? null,
    patch: input.patch ?? null,
    instruction: input.instruction ?? null,
    explanation: input.explanation,
    evidenceRefs: [...input.evidenceRefs],
    deterministic: false,
    source: "ai_suggested",
  };
  const result = validateRepairAction(action);
  if (!result.valid) throw new Error(`AI suggestion was blocked by BootProof safety policy: ${result.errors.join("; ")}`);
  return action;
}

function validateApplyResult(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["applyResult must be an object"];
  const result = value as Partial<RepairApplyResultRecord>;
  const errors = unknownKeys(value, APPLY_RESULT_KEYS);
  if (!["not_applied", "applied", "failed"].includes(String(result.status))) errors.push("invalid applyResult.status");
  if (result.exitCode !== null && !Number.isInteger(result.exitCode)) errors.push("applyResult.exitCode must be an integer or null");
  if (!stringArray(result.filesChanged)) errors.push("applyResult.filesChanged must be a string array");
  if (result.evidence !== null && typeof result.evidence !== "string") errors.push("applyResult.evidence must be a string or null");
  return errors;
}

export function validateRepairReceiptBase(value: unknown): RepairSafetyValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return validation(["repair receipt must be an object"]);
  }
  const receipt = value as Partial<RepairReceiptBase>;
  const errors = unknownKeys(value, RECEIPT_KEYS);
  if (receipt.schema !== "bootproof/repair-receipt/v1") errors.push("invalid repair receipt schema");
  for (const key of ["repairId", "bootproofVersion", "beforeFailureClass", "explanation"] as const) {
    if (!nonEmptyString(receipt[key])) errors.push(`${key} must be a non-empty string`);
  }
  if (!["deterministic_playbook", "ai_suggested"].includes(String(receipt.source))) {
    errors.push("invalid repair receipt source");
  }
  if (!isoDate(receipt.createdAt)) errors.push("createdAt must be an ISO date");
  if (!/^[0-9a-f]{64}$/i.test(String(receipt.beforeEvidenceHash))) {
    errors.push("beforeEvidenceHash must be a SHA-256 hex digest");
  }
  errors.push(...validateRepairAction(receipt.proposedAction).errors);
  if (receipt.source !== receipt.proposedAction?.source) errors.push("source must match proposedAction");
  if (receipt.actionType !== receipt.proposedAction?.actionType) errors.push("actionType must match proposedAction");
  if (receipt.mutationScope !== receipt.proposedAction?.mutationScope) errors.push("mutationScope must match proposedAction");
  if (receipt.riskLevel !== receipt.proposedAction?.riskLevel) errors.push("riskLevel must match proposedAction");
  if (receipt.userApprovalRequired !== receipt.proposedAction?.requiresApproval) {
    errors.push("userApprovalRequired must match proposedAction");
  }
  if (receipt.approvedAt !== undefined && !isoDate(receipt.approvedAt)) errors.push("approvedAt must be an ISO date");
  if (receipt.appliedAt !== undefined && !isoDate(receipt.appliedAt)) errors.push("appliedAt must be an ISO date");
  errors.push(...validateApplyResult(receipt.applyResult));
  if (receipt.appliedAt !== undefined && receipt.applyResult?.status !== "applied") {
    errors.push("appliedAt requires an applied applyResult");
  }
  if (receipt.applyResult?.status === "applied" && receipt.appliedAt === undefined) {
    errors.push("an applied applyResult requires appliedAt");
  }
  if (receipt.afterFailureClass !== undefined && !nonEmptyString(receipt.afterFailureClass)) {
    errors.push("afterFailureClass must be a non-empty string");
  }
  if (typeof receipt.progressed !== "boolean") errors.push("progressed must be boolean");
  if (typeof receipt.verified !== "boolean") errors.push("verified must be boolean");
  if (receipt.verified === true && receipt.progressed !== true) errors.push("verified receipts must also be progressed");
  if (!stringArray(receipt.redactionsApplied)) errors.push("redactionsApplied must be a string array");
  return validation([...new Set(errors)]);
}

export function buildRepairReceiptBase(input: RepairReceiptBaseInput): RepairReceiptBase {
  const receipt: RepairReceiptBase = {
    schema: "bootproof/repair-receipt/v1",
    repairId: input.repairId,
    createdAt: input.createdAt,
    bootproofVersion: input.bootproofVersion,
    source: input.proposedAction.source,
    beforeFailureClass: input.beforeFailureClass,
    beforeEvidenceHash: input.beforeEvidenceHash,
    proposedAction: input.proposedAction,
    actionType: input.proposedAction.actionType,
    mutationScope: input.proposedAction.mutationScope,
    riskLevel: input.proposedAction.riskLevel,
    userApprovalRequired: input.proposedAction.requiresApproval,
    ...(input.approvedAt ? { approvedAt: input.approvedAt } : {}),
    ...(input.appliedAt ? { appliedAt: input.appliedAt } : {}),
    applyResult: input.applyResult ?? {
      status: "not_applied",
      exitCode: null,
      filesChanged: [],
      evidence: null,
    },
    ...(input.afterFailureClass ? { afterFailureClass: input.afterFailureClass } : {}),
    progressed: input.progressed ?? false,
    verified: input.verified ?? false,
    explanation: input.explanation,
    redactionsApplied: [...(input.redactionsApplied ?? [])],
  };
  const result = validateRepairReceiptBase(receipt);
  if (!result.valid) throw new Error(`invalid repair receipt base: ${result.errors.join("; ")}`);
  return receipt;
}

export function serializeRepairReceiptBase(receipt: RepairReceiptBase): string {
  const result = validateRepairReceiptBase(receipt);
  if (!result.valid) throw new Error(`invalid repair receipt base: ${result.errors.join("; ")}`);
  return JSON.stringify(receipt, null, 2) + "\n";
}
