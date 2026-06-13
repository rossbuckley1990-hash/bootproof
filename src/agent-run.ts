import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { attestationPath, verifySignature } from "./proof.js";
import { explainBootSkeleton } from "./boot-skeleton.js";
import { redactJsonValue, redactText } from "./redact.js";
import type { AgentPlan, AgentPlanAction } from "./agent-plan.js";
import type { RepairMutationScope, RepairRiskLevel } from "./repair-safety.js";
import type { Attestation } from "./types.js";

export type AgentRunStatus =
  | "planned"
  | "stopped_for_approval"
  | "stopped_blocked"
  | "awaiting_verification"
  | "verified_external_health"
  | "verified_bootproof_orchestrated"
  | "verification_failed";

export type AgentApprovalStatus = "not_required" | "pending" | "approved" | "declined" | "blocked";
export type AgentExecutionStatus = "not_executed" | "executed" | "failed";

interface ChainedReceipt {
  runId: string;
  timestamp: string;
  previousReceiptHash: string | null;
  receiptHash: string;
  redactionsApplied: string[];
}

export interface AgentRunInitialReceipt extends ChainedReceipt {
  schema: "bootproof/agent-run-initial/v1";
  receiptType: "initial-attestation";
  sourceAttestationHash: string | null;
  sourceSignatureValid: boolean;
  attestation: Attestation | null;
  diagnosis: {
    failureClass: string | null;
    observedEvidence: string[];
    verificationMode: string;
    bootproofOrchestrated: boolean;
    healthVerified: boolean;
  };
}

export interface AgentRunPlanReceipt extends ChainedReceipt {
  schema: "bootproof/agent-run-plan/v1";
  receiptType: "agent-plan";
  plan: AgentPlan;
}

export interface AgentActionReceipt extends ChainedReceipt {
  schema: "bootproof/agent-action-receipt/v1";
  receiptType: "action";
  actionIndex: number;
  classification: string;
  actionType: string;
  command: string;
  riskLevel: RepairRiskLevel;
  mutationScope: RepairMutationScope;
  approvalStatus: AgentApprovalStatus;
  executionStatus: AgentExecutionStatus;
  verificationResult: string | null;
  failureClassBefore: string | null;
  failureClassAfter: string | null;
  blockedReason: string;
  secretSensitive: boolean;
}

export interface AgentVerificationReceipt extends ChainedReceipt {
  schema: "bootproof/agent-verification-receipt/v1";
  receiptType: "verification";
  verificationMode: string;
  bootproofOrchestrated: boolean;
  result: "verified" | "not_verified";
  classification: string | null;
  requestedUrl: string | null;
  observedStatus: number | null;
  observedFinalUrl: string | null;
  observedAt: string | null;
  healthObservation: string | null;
  connectionError: string | null;
  failureClassBefore: string | null;
  failureClassAfter: string | null;
  attestationHash: string;
}

export interface AgentRunSummary {
  schema: "bootproof/agent-run-summary/v1";
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: AgentRunStatus;
  lastReceiptHash: string;
  receiptCount: number;
  chainValid: boolean;
  initialFailureClass: string | null;
  currentFailureClass: string | null;
  bootproofOrchestrated: boolean;
  verifiedExternalHealth: boolean;
  onlyPlanned: boolean;
  stoppedForApproval: boolean;
  stoppedDueBlockedAction: boolean;
  verified: boolean;
  explanation: string;
  redactionsApplied: string[];
}

export interface AgentRunRecord {
  runId: string;
  directory: string;
  receipts: ChainedReceipt[];
  summary: AgentRunSummary;
  chainValid: boolean;
  errors: string[];
}

export interface CreateAgentRunOptions {
  createdAt?: string;
}

export interface AppendAgentActionInput {
  action: AgentPlanAction;
  approvalStatus: AgentApprovalStatus;
  executionStatus: AgentExecutionStatus;
  verificationResult?: string | null;
  failureClassBefore?: string | null;
  failureClassAfter?: string | null;
  timestamp?: string;
}

const RUN_ID = /^\d{8}T\d{9}Z-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function receiptBody(receipt: ChainedReceipt): object {
  const { receiptHash: _receiptHash, ...body } = receipt;
  return body;
}

export function hashAgentReceipt(receipt: ChainedReceipt): string {
  return sha256(JSON.stringify(receiptBody(receipt)));
}

function redacted<T>(value: T): { value: T; applied: string[] } {
  const result = redactJsonValue(value);
  return { value: result.value as T, applied: result.applied };
}

function finishReceipt<T extends Omit<ChainedReceipt, "receiptHash" | "redactionsApplied">>(
  value: T,
): T & ChainedReceipt {
  const safe = redacted(value);
  const receipt = {
    ...safe.value,
    redactionsApplied: safe.applied,
    receiptHash: "",
  } as T & ChainedReceipt;
  receipt.receiptHash = hashAgentReceipt(receipt);
  return receipt;
}

function compactTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid agent run timestamp: ${value}`);
  return date.toISOString().replace(/[-:.]/g, "");
}

function receiptFilename(timestamp: string, suffix: "action" | "verification", index = 0): string {
  const indexPart = index > 0 ? `-${String(index).padStart(3, "0")}` : "";
  return `${compactTimestamp(timestamp)}${indexPart}-${suffix}.json`;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function safeRunId(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`invalid agent run id: ${runId}`);
  return runId;
}

export function agentRunsDirectory(repo: string): string {
  return path.join(repo, ".bootproof", "agent-runs");
}

export function agentRunDirectory(repo: string, runId: string): string {
  return path.join(agentRunsDirectory(repo), safeRunId(runId));
}

export function generateAgentRunId(repo: string, plan: AgentPlan, createdAt: string): string {
  const safeRepo = redactText(path.resolve(repo)).text;
  const fingerprint = sha256(JSON.stringify({ repo: safeRepo, plan }));
  return `${compactTimestamp(createdAt)}-${fingerprint.slice(0, 12)}`;
}

function loadInitialAttestation(repo: string): {
  attestation: Attestation | null;
  sourceAttestationHash: string | null;
  sourceSignatureValid: boolean;
} {
  const file = attestationPath(repo);
  if (!fs.existsSync(file)) {
    return { attestation: null, sourceAttestationHash: null, sourceSignatureValid: false };
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const attestation = JSON.parse(raw) as Attestation;
    const sourceSignatureValid = verifySignature(attestation);
    return {
      attestation: sourceSignatureValid ? attestation : null,
      sourceAttestationHash: sha256(raw),
      sourceSignatureValid,
    };
  } catch {
    return { attestation: null, sourceAttestationHash: null, sourceSignatureValid: false };
  }
}

function approvalStatus(action: AgentPlanAction): AgentApprovalStatus {
  if (action.riskLevel === "blocked" || action.blockedReason) return "blocked";
  if (action.requiresApproval) return "pending";
  return "not_required";
}

function planningStatus(plan: AgentPlan): {
  status: AgentRunStatus;
  stoppedForApproval: boolean;
  stoppedDueBlockedAction: boolean;
  explanation: string;
} {
  const stoppedDueBlockedAction = plan.candidateNextActions.some(action =>
    action.riskLevel === "blocked" || Boolean(action.blockedReason)
  );
  const stoppedForApproval = plan.candidateNextActions.some(action =>
    action.requiresApproval && action.riskLevel !== "blocked"
  );
  if (stoppedDueBlockedAction) {
    return {
      status: "stopped_blocked",
      stoppedForApproval,
      stoppedDueBlockedAction,
      explanation: "Planning stopped because at least one candidate action is blocked. No action was executed.",
    };
  }
  if (stoppedForApproval) {
    return {
      status: "stopped_for_approval",
      stoppedForApproval,
      stoppedDueBlockedAction,
      explanation: "Planning completed and stopped for explicit approval. No action was executed and nothing was verified.",
    };
  }
  return {
    status: "planned",
    stoppedForApproval,
    stoppedDueBlockedAction,
    explanation: "Planning completed. No action was executed and planning alone is not verification.",
  };
}

function writeSummary(directory: string, summary: AgentRunSummary): void {
  writeJson(path.join(directory, "final-summary.json"), summary);
}

export function createAgentRun(
  repo: string,
  plan: AgentPlan,
  options: CreateAgentRunOptions = {},
): AgentRunSummary {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const runId = generateAgentRunId(repo, plan, createdAt);
  const directory = agentRunDirectory(repo, runId);
  if (fs.existsSync(directory)) throw new Error(`agent run already exists: ${runId}`);
  fs.mkdirSync(path.join(directory, "actions"), { recursive: true });
  fs.mkdirSync(path.join(directory, "verifications"), { recursive: true });

  const source = loadInitialAttestation(repo);
  const initialFailureClass =
    source.attestation?.result.failureClass ?? (plan.currentFailureClass || null);
  const initialTimestamp = new Date(createdAt).toISOString();
  const initial = finishReceipt({
    schema: "bootproof/agent-run-initial/v1" as const,
    receiptType: "initial-attestation" as const,
    runId,
    timestamp: initialTimestamp,
    previousReceiptHash: null,
    sourceAttestationHash: source.sourceAttestationHash,
    sourceSignatureValid: source.sourceSignatureValid,
    attestation: source.attestation,
    diagnosis: {
      failureClass: initialFailureClass,
      observedEvidence: plan.observedEvidence,
      verificationMode: source.attestation?.verificationMode ?? "planning-only",
      bootproofOrchestrated: source.attestation?.bootproofOrchestrated ?? false,
      healthVerified: source.attestation?.result.healthVerified ?? false,
    },
  });
  writeJson(path.join(directory, "initial-attestation.json"), initial);

  const planTimestamp = new Date(new Date(createdAt).getTime() + 1).toISOString();
  const planReceipt = finishReceipt({
    schema: "bootproof/agent-run-plan/v1" as const,
    receiptType: "agent-plan" as const,
    runId,
    timestamp: planTimestamp,
    previousReceiptHash: initial.receiptHash,
    plan,
  });
  writeJson(path.join(directory, "agent-plan.json"), planReceipt);

  let previousReceiptHash = planReceipt.receiptHash;
  let receiptCount = 2;
  const allRedactions = [...initial.redactionsApplied, ...planReceipt.redactionsApplied];
  for (const [index, candidate] of plan.candidateNextActions.entries()) {
    const timestamp = new Date(new Date(createdAt).getTime() + index + 2).toISOString();
    const actionReceipt = finishReceipt({
      schema: "bootproof/agent-action-receipt/v1" as const,
      receiptType: "action" as const,
      runId,
      timestamp,
      previousReceiptHash,
      actionIndex: index,
      classification: candidate.classification,
      actionType: candidate.actionType,
      command: candidate.command,
      riskLevel: candidate.riskLevel,
      mutationScope: candidate.mutationScope,
      approvalStatus: approvalStatus(candidate),
      executionStatus: "not_executed" as const,
      verificationResult: null,
      failureClassBefore: initialFailureClass,
      failureClassAfter: null,
      blockedReason: candidate.blockedReason,
      secretSensitive: candidate.secretSensitive,
    });
    writeJson(
      path.join(directory, "actions", receiptFilename(timestamp, "action", index + 1)),
      actionReceipt,
    );
    previousReceiptHash = actionReceipt.receiptHash;
    receiptCount += 1;
    allRedactions.push(...actionReceipt.redactionsApplied);
  }

  const planning = planningStatus(plan);
  const summary: AgentRunSummary = {
    schema: "bootproof/agent-run-summary/v1",
    runId,
    createdAt: initialTimestamp,
    updatedAt: new Date(new Date(createdAt).getTime() + receiptCount).toISOString(),
    status: planning.status,
    lastReceiptHash: previousReceiptHash,
    receiptCount,
    chainValid: true,
    initialFailureClass,
    currentFailureClass: initialFailureClass,
    bootproofOrchestrated: false,
    verifiedExternalHealth: false,
    onlyPlanned: true,
    stoppedForApproval: planning.stoppedForApproval,
    stoppedDueBlockedAction: planning.stoppedDueBlockedAction,
    verified: false,
    explanation: planning.explanation,
    redactionsApplied: unique(allRedactions),
  };
  writeSummary(directory, summary);
  return summary;
}

function receiptFiles(directory: string): string[] {
  const files = [
    path.join(directory, "initial-attestation.json"),
    path.join(directory, "agent-plan.json"),
  ];
  for (const child of ["actions", "verifications"]) {
    const childDirectory = path.join(directory, child);
    if (!fs.existsSync(childDirectory)) continue;
    for (const file of fs.readdirSync(childDirectory).filter(name => name.endsWith(".json"))) {
      files.push(path.join(childDirectory, file));
    }
  }
  return files;
}

function nextReceiptTimestamp(run: AgentRunRecord, requested: string): string {
  const requestedTime = new Date(requested).getTime();
  if (Number.isNaN(requestedTime)) throw new Error(`invalid agent receipt timestamp: ${requested}`);
  const lastTime = new Date(run.receipts.at(-1)?.timestamp ?? run.summary.updatedAt).getTime();
  return new Date(Math.max(requestedTime, lastTime + 1)).toISOString();
}

function isChainedReceipt(value: unknown): value is ChainedReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<ChainedReceipt>;
  return (
    typeof receipt.runId === "string" &&
    typeof receipt.timestamp === "string" &&
    (receipt.previousReceiptHash === null || typeof receipt.previousReceiptHash === "string") &&
    typeof receipt.receiptHash === "string" &&
    Array.isArray(receipt.redactionsApplied)
  );
}

export function readAgentRun(repo: string, runId: string): AgentRunRecord {
  const directory = agentRunDirectory(repo, runId);
  if (!fs.existsSync(directory)) throw new Error(`no agent run at ${directory}`);
  const summary = readJson<AgentRunSummary>(path.join(directory, "final-summary.json"));
  const receipts = receiptFiles(directory)
    .map(file => readJson<ChainedReceipt>(file))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const errors: string[] = [];
  let previousReceiptHash: string | null = null;
  for (const [index, receipt] of receipts.entries()) {
    if (!isChainedReceipt(receipt)) {
      errors.push(`receipt ${index + 1} is malformed`);
      continue;
    }
    if (receipt.runId !== runId) errors.push(`receipt ${index + 1} has the wrong run id`);
    if (receipt.previousReceiptHash !== previousReceiptHash) {
      errors.push(`receipt ${index + 1} does not link to the previous receipt hash`);
    }
    const expectedHash = hashAgentReceipt(receipt);
    if (!HASH.test(receipt.receiptHash) || receipt.receiptHash !== expectedHash) {
      errors.push(`receipt ${index + 1} hash is invalid`);
    }
    previousReceiptHash = receipt.receiptHash;
  }
  if (summary.runId !== runId) errors.push("final summary has the wrong run id");
  if (summary.lastReceiptHash !== previousReceiptHash) errors.push("final summary does not point to the last receipt");
  if (summary.receiptCount !== receipts.length) errors.push("final summary receipt count is incorrect");
  return {
    runId,
    directory,
    receipts,
    summary,
    chainValid: errors.length === 0,
    errors,
  };
}

export function latestAgentRunId(repo: string): string | null {
  const directory = agentRunsDirectory(repo);
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && RUN_ID.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .at(-1) ?? null;
}

export function appendAgentActionReceipt(
  repo: string,
  runId: string,
  input: AppendAgentActionInput,
): AgentActionReceipt {
  const run = readAgentRun(repo, runId);
  if (!run.chainValid) throw new Error(`agent run chain is invalid: ${run.errors.join("; ")}`);
  const timestamp = nextReceiptTimestamp(run, input.timestamp ?? new Date().toISOString());
  const actionIndex = run.receipts.filter(receipt =>
    (receipt as Partial<AgentActionReceipt>).receiptType === "action"
  ).length;
  const receipt = finishReceipt({
    schema: "bootproof/agent-action-receipt/v1" as const,
    receiptType: "action" as const,
    runId,
    timestamp,
    previousReceiptHash: run.summary.lastReceiptHash,
    actionIndex,
    classification: input.action.classification,
    actionType: input.action.actionType,
    command: input.action.command,
    riskLevel: input.action.riskLevel,
    mutationScope: input.action.mutationScope,
    approvalStatus: input.approvalStatus,
    executionStatus: input.executionStatus,
    verificationResult: input.verificationResult ?? null,
    failureClassBefore: input.failureClassBefore ?? run.summary.currentFailureClass,
    failureClassAfter: input.failureClassAfter ?? null,
    blockedReason: input.action.blockedReason,
    secretSensitive: input.action.secretSensitive,
  });
  const actionsDirectory = path.join(run.directory, "actions");
  writeJson(
    path.join(actionsDirectory, receiptFilename(timestamp, "action", actionIndex + 1)),
    receipt,
  );

  const executed = input.executionStatus !== "not_executed";
  const blocked = input.approvalStatus === "blocked" || input.action.riskLevel === "blocked";
  const stoppedForApproval = input.approvalStatus === "pending";
  const summary: AgentRunSummary = {
    ...run.summary,
    updatedAt: timestamp,
    status: blocked
      ? "stopped_blocked"
      : stoppedForApproval
        ? "stopped_for_approval"
        : executed
          ? "awaiting_verification"
          : run.summary.status,
    lastReceiptHash: receipt.receiptHash,
    receiptCount: run.summary.receiptCount + 1,
    chainValid: true,
    currentFailureClass: input.failureClassAfter ?? run.summary.currentFailureClass,
    onlyPlanned: run.summary.onlyPlanned && !executed,
    stoppedForApproval,
    stoppedDueBlockedAction: blocked,
    verified: false,
    explanation: blocked
      ? "The action was blocked by BootProof safety policy and was not executed."
      : stoppedForApproval
        ? "The action is waiting for explicit approval and was not executed."
        : executed
          ? "One approved action was recorded. Verification is required before success can be claimed."
          : "The action was recorded without execution. Verification remains pending.",
    redactionsApplied: unique([
      ...run.summary.redactionsApplied,
      ...receipt.redactionsApplied,
    ]),
  };
  writeSummary(run.directory, summary);
  return receipt;
}

export function appendAgentVerification(
  repo: string,
  runId: string,
  attestation: Attestation,
  timestamp = new Date().toISOString(),
): AgentVerificationReceipt {
  const run = readAgentRun(repo, runId);
  if (!run.chainValid) throw new Error(`agent run chain is invalid: ${run.errors.join("; ")}`);
  const receiptTimestamp = nextReceiptTimestamp(run, timestamp);
  const receipt = finishReceipt({
    schema: "bootproof/agent-verification-receipt/v1" as const,
    receiptType: "verification" as const,
    runId,
    timestamp: receiptTimestamp,
    previousReceiptHash: run.summary.lastReceiptHash,
    verificationMode: attestation.verificationMode,
    bootproofOrchestrated: attestation.bootproofOrchestrated,
    result: attestation.result.healthVerified ? "verified" as const : "not_verified" as const,
    classification: attestation.classification,
    requestedUrl: attestation.externalHealthUrl,
    observedStatus: attestation.observedStatus,
    observedFinalUrl: attestation.observedFinalUrl,
    observedAt: attestation.observedAt,
    healthObservation: attestation.result.healthObservation,
    connectionError: attestation.result.healthEvidence?.connectionError ?? null,
    failureClassBefore: run.summary.currentFailureClass,
    failureClassAfter: attestation.result.failureClass,
    attestationHash: sha256(JSON.stringify(attestation)),
  });
  const verificationDirectory = path.join(run.directory, "verifications");
  let file = path.join(verificationDirectory, receiptFilename(receiptTimestamp, "verification"));
  let suffix = 1;
  while (fs.existsSync(file)) {
    file = path.join(verificationDirectory, receiptFilename(receiptTimestamp, "verification", suffix));
    suffix += 1;
  }
  writeJson(file, receipt);

  const externalVerified =
    attestation.verificationMode === "external-health" &&
    attestation.result.healthVerified &&
    attestation.bootproofOrchestrated === false;
  const orchestratedVerified =
    attestation.verificationMode === "bootproof-orchestrated" &&
    attestation.result.booted &&
    attestation.result.healthVerified &&
    attestation.bootproofOrchestrated;
  const verified = externalVerified || orchestratedVerified;
  const summary: AgentRunSummary = {
    ...run.summary,
    updatedAt: receiptTimestamp,
    status: externalVerified
      ? "verified_external_health"
      : orchestratedVerified
        ? "verified_bootproof_orchestrated"
        : "verification_failed",
    lastReceiptHash: receipt.receiptHash,
    receiptCount: run.summary.receiptCount + 1,
    chainValid: true,
    currentFailureClass: attestation.result.failureClass,
    bootproofOrchestrated: orchestratedVerified,
    verifiedExternalHealth: externalVerified,
    onlyPlanned: false,
    stoppedForApproval: verified ? false : run.summary.stoppedForApproval,
    stoppedDueBlockedAction: verified ? false : run.summary.stoppedDueBlockedAction,
    verified,
    explanation: externalVerified
      ? "External health was observed. BootProof did not start or orchestrate the application."
      : orchestratedVerified
        ? "BootProof started the application and observed its declared health."
        : `Verification did not succeed: ${attestation.result.explanation}`,
    redactionsApplied: unique([
      ...run.summary.redactionsApplied,
      ...receipt.redactionsApplied,
    ]),
  };
  writeSummary(run.directory, summary);
  return receipt;
}

export function explainAgentRun(repo: string, runId: string): string[] {
  const run = readAgentRun(repo, runId);
  const summary = run.summary;
  const initial = run.receipts.find(receipt =>
    (receipt as Partial<AgentRunInitialReceipt>).receiptType === "initial-attestation"
  ) as AgentRunInitialReceipt | undefined;
  const skeletonLines = run.chainValid && initial?.attestation?.bootSkeleton
    ? explainBootSkeleton(initial.attestation.bootSkeleton)
    : [];
  const ownership = summary.bootproofOrchestrated
    ? "BootProof orchestrated the application and verified health."
    : summary.verifiedExternalHealth
      ? "BootProof verified external health and did not start the application."
      : summary.onlyPlanned
        ? "BootProof only planned; no action was executed."
        : "BootProof did not establish verified ownership.";
  return [
    "Agent run explained",
    `Run ID: ${runId}`,
    `Receipt chain: ${run.chainValid ? `valid (${run.receipts.length} receipts)` : "INVALID"}`,
    `Status: ${summary.status}`,
    `Initial failure class: ${summary.initialFailureClass ?? "none"}`,
    `Current failure class: ${summary.currentFailureClass ?? "none"}`,
    `Ownership: ${ownership}`,
    `Stopped for approval: ${summary.stoppedForApproval ? "yes" : "no"}`,
    `Stopped due blocked action: ${summary.stoppedDueBlockedAction ? "yes" : "no"}`,
    `Verified: ${summary.verified ? "yes" : "no"}`,
    ...skeletonLines,
    summary.explanation,
    ...run.errors.map(error => `Chain error: ${error}`),
  ];
}
