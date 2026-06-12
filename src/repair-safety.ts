import path from "node:path";
import type { FailureClass } from "./types.js";

export type RepairActionType = "command" | "patch" | "instruction";
export type RepairMutationScope = "repo" | "host" | "service" | "database" | "none";
export type RepairRiskLevel = "low" | "medium" | "high" | "blocked";

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
  command: RepairCommand | null;
  patch: RepairPatch | null;
  instruction: string | null;
  explanation: string;
  evidenceRefs: string[];
  deterministic: true;
  source: "deterministic_playbook";
}

export interface RepairActionInput {
  actionType: RepairActionType;
  mutationScope: RepairMutationScope;
  riskLevel: RepairRiskLevel;
  requiresApproval?: boolean;
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

const ACTION_TYPES = new Set<RepairActionType>(["command", "patch", "instruction"]);
const MUTATION_SCOPES = new Set<RepairMutationScope>(["repo", "host", "service", "database", "none"]);
const RISK_LEVELS = new Set<RepairRiskLevel>(["low", "medium", "high", "blocked"]);
const ACTION_KEYS = new Set([
  "schema",
  "actionType",
  "mutationScope",
  "riskLevel",
  "requiresApproval",
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
      args.some(arg => /^(?:-F|--form|--data-binary|--upload-file|--post-file)$/i.test(arg))
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
  if (!nonEmptyString(action.explanation)) errors.push("explanation must be a non-empty string");
  if (!stringArray(action.evidenceRefs)) errors.push("evidenceRefs must be a string array");
  if (action.deterministic !== true) errors.push("deterministic must be true");
  if (action.source !== "deterministic_playbook") errors.push("source must be deterministic_playbook");
  if (action.riskLevel === "blocked") errors.push("blocked repair actions cannot be accepted");

  if (action.actionType === "command") {
    if (action.patch !== null || action.instruction !== null) errors.push("command actions may only contain command");
    errors.push(...validateRepairCommand(action.command).errors);
    if (action.mutationScope === "none") errors.push("command actions require a mutation scope");
    if (action.requiresApproval !== true) errors.push("command actions always require approval");
  } else if (action.actionType === "patch") {
    if (action.command !== null || action.instruction !== null) errors.push("patch actions may only contain patch");
    errors.push(...validateRepairPatch(action.patch).errors);
    if (action.mutationScope !== "repo") errors.push("patch actions must use repo mutation scope");
    if (action.requiresApproval !== true) errors.push("patch actions always require approval");
  } else if (action.actionType === "instruction") {
    if (action.command !== null || action.patch !== null) errors.push("instruction actions may only contain instruction");
    if (!nonEmptyString(action.instruction)) errors.push("instruction must be a non-empty string");
    if (action.mutationScope !== "none") errors.push("instruction actions must use none mutation scope");
  }

  return validation([...new Set(errors)]);
}

export function buildRepairAction(input: RepairActionInput): RepairAction {
  const action: RepairAction = {
    schema: "bootproof/repair-action/v1",
    actionType: input.actionType,
    mutationScope: input.mutationScope,
    riskLevel: input.riskLevel,
    requiresApproval: input.requiresApproval ?? true,
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
  if (!isoDate(receipt.createdAt)) errors.push("createdAt must be an ISO date");
  if (!/^[0-9a-f]{64}$/i.test(String(receipt.beforeEvidenceHash))) {
    errors.push("beforeEvidenceHash must be a SHA-256 hex digest");
  }
  errors.push(...validateRepairAction(receipt.proposedAction).errors);
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
