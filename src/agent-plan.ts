import fs from "node:fs";
import path from "node:path";
import { inferRepo } from "./infer.js";
import { attestationPath, verifySignature } from "./proof.js";
import { redactText } from "./redact.js";
import {
  createRepairCommand,
  validateRepairCommand,
  type RepairMutationScope,
  type RepairRiskLevel,
} from "./repair-safety.js";
import type { Attestation } from "./types.js";

export type AgentSafetyClassification =
  | "host_tool_install_required"
  | "kubernetes_cluster_creation_required"
  | "heavy_orchestration_required"
  | "credential_required"
  | "external_health_verification_required";

export interface AgentPlanAction {
  classification: AgentSafetyClassification;
  actionType: "command" | "instruction";
  command: string;
  reason: string;
  evidence: string[];
  riskLevel: RepairRiskLevel;
  mutationScope: RepairMutationScope;
  requiresApproval: true;
  verificationStep: string;
  stopCondition: string;
}

export interface AgentPlan {
  schema: "bootproof/agent-plan/v1";
  mode: "agent-plan";
  currentFailureClass: string;
  observedEvidence: string[];
  suspectedStack: string[];
  missingTools: string[];
  candidateNextActions: AgentPlanAction[];
  verificationSteps: string[];
  stopConditions: string[];
  canBootProofOrchestrateDirectly: boolean;
  canBootProofVerifyExternally: boolean;
}

export interface AgentPlanOptions {
  availableTools?: ReadonlySet<string>;
  pathValue?: string;
}

export interface AgentPlanValidation {
  valid: boolean;
  errors: string[];
}

const PLAN_KEYS = new Set([
  "schema",
  "mode",
  "currentFailureClass",
  "observedEvidence",
  "suspectedStack",
  "missingTools",
  "candidateNextActions",
  "verificationSteps",
  "stopConditions",
  "canBootProofOrchestrateDirectly",
  "canBootProofVerifyExternally",
]);
const ACTION_KEYS = new Set([
  "classification",
  "actionType",
  "command",
  "reason",
  "evidence",
  "riskLevel",
  "mutationScope",
  "requiresApproval",
  "verificationStep",
  "stopCondition",
]);
const CLASSIFICATIONS = new Set<AgentSafetyClassification>([
  "host_tool_install_required",
  "kubernetes_cluster_creation_required",
  "heavy_orchestration_required",
  "credential_required",
  "external_health_verification_required",
]);
const ACTION_TYPES = new Set(["command", "instruction"]);
const RISK_LEVELS = new Set<RepairRiskLevel>(["low", "medium", "high", "blocked"]);
const MUTATION_SCOPES = new Set<RepairMutationScope>(["repo", "host", "service", "database", "none"]);
const INSPECTION_LIMIT = 256;
const FILE_SIZE_LIMIT = 128 * 1024;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".bootproof",
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  ".gradle",
]);

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function safeEvidence(value: string): string {
  return redactText(value).text;
}

function isInspectionFile(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  const inDocs = normalized.startsWith("docs/") || normalized.includes("/docs/");
  return (
    /^README(?:\..+)?$/i.test(base) ||
    /^Makefile$/i.test(base) ||
    /^Dockerfile(?:\..+)?$/i.test(base) ||
    /^(?:docker-)?compose(?:\..+)?\.ya?ml$/i.test(base) ||
    /^(?:build|settings)\.gradle(?:\.kts)?$/i.test(base) ||
    base === "gradle.properties" ||
    base === "gradlew" ||
    base === "gradlew.bat" ||
    base === "package.json" ||
    base === "pom.xml" ||
    base === "Chart.yaml" ||
    base === "values.yaml" ||
    (inDocs && /\.(?:md|txt|rst|adoc)$/i.test(base)) ||
    (/(?:^|\/)(?:k8s|kubernetes|helm)(?:\/|$)/i.test(normalized) && /\.ya?ml$/i.test(base))
  );
}

function collectInspectionFiles(repo: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 5 || files.length >= INSPECTION_LIMIT) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= INSPECTION_LIMIT) break;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(repo, absolute).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(absolute, depth + 1);
      } else if (entry.isFile() && isInspectionFile(relative)) {
        files.push(relative);
      }
    }
  };
  visit(repo, 0);
  return uniqueSorted(files);
}

function readInspectionText(repo: string, relativePath: string): string {
  const absolute = path.join(repo, relativePath);
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > FILE_SIZE_LIMIT) return "";
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return "";
  }
}

function executableAvailable(name: string, pathValue = process.env.PATH ?? ""): boolean {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        const stat = fs.statSync(path.join(directory, `${name}${extension}`));
        if (stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0)) return true;
      } catch {
        // Continue through PATH without executing the candidate tool.
      }
    }
  }
  return false;
}

function isToolAvailable(name: string, options: AgentPlanOptions): boolean {
  return options.availableTools
    ? options.availableTools.has(name)
    : executableAvailable(name, options.pathValue);
}

function loadPriorAttestation(repo: string): {
  attestation: Attestation | null;
  evidence: string[];
} {
  const proofPath = attestationPath(repo);
  if (!fs.existsSync(proofPath)) {
    return { attestation: null, evidence: ["No existing .bootproof/attestation.json was found."] };
  }
  try {
    const attestation = JSON.parse(fs.readFileSync(proofPath, "utf8")) as Attestation;
    if (!verifySignature(attestation)) {
      return {
        attestation: null,
        evidence: ["Existing .bootproof/attestation.json has an invalid signature and was not trusted."],
      };
    }
    return {
      attestation,
      evidence: [
        `Read signature-valid prior attestation with failure class ${attestation.result.failureClass ?? "none"}.`,
      ],
    };
  } catch {
    return {
      attestation: null,
      evidence: ["Existing .bootproof/attestation.json could not be parsed and was not trusted."],
    };
  }
}

function documentedHealthUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/[^\s"'`<>)]*)?/gi)) {
    const value = match[0].replace(/[),.;\]}]+$/, "");
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) continue;
      urls.push(url.toString());
    } catch {
      // Ignore malformed documentation examples.
    }
  }
  return uniqueSorted(urls).sort((a, b) => {
    const healthDifference = Number(!/health/i.test(a)) - Number(!/health/i.test(b));
    return healthDifference || a.localeCompare(b);
  });
}

function documentedAbctlCommands(text: string): string[] {
  const commands: string[] = [];
  for (const match of text.matchAll(/\babctl\s+local\s+install(?:\s+--port\s+(\d{2,5}))?/gi)) {
    const args = ["local", "install", ...(match[1] ? ["--port", match[1]] : [])];
    const command = createRepairCommand("abctl", args);
    if (validateRepairCommand(command).valid) commands.push(command.display);
  }
  return uniqueSorted(commands);
}

function documentedKindCommands(text: string): string[] {
  const commands: string[] = [];
  for (const match of text.matchAll(/\bkind\s+create\s+cluster(?:\s+--name\s+([A-Za-z0-9_.-]+))?/gi)) {
    const args = ["create", "cluster", ...(match[1] ? ["--name", match[1]] : [])];
    const command = createRepairCommand("kind", args);
    if (validateRepairCommand(command).valid) commands.push(command.display);
  }
  return uniqueSorted(commands);
}

function action(input: Omit<AgentPlanAction, "requiresApproval">): AgentPlanAction {
  return {
    ...input,
    evidence: uniqueSorted(input.evidence.map(safeEvidence)),
    requiresApproval: true,
  };
}

function validateAgentCommand(display: string): string[] {
  const tokens = display.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return ["command must not be empty"];
  const [executable, ...args] = tokens;
  if (!["abctl", "kind", "bootproof"].includes(executable)) {
    return ["command is not in the deterministic agent-plan registry"];
  }
  const command = createRepairCommand(executable, args);
  if (command.display !== display) {
    return ["command must be a canonical single command without shell quoting or chaining"];
  }
  return validateRepairCommand(command).errors;
}

function genericFailureClass(input: {
  priorFailureClass: string;
  missingTools: string[];
  hasKindCommand: boolean;
  heavyOrchestration: boolean;
  credentialRequired: boolean;
  externalHealthAvailable: boolean;
}): string {
  if (input.priorFailureClass) return input.priorFailureClass;
  if (input.missingTools.length) return "host_tool_install_required";
  if (input.hasKindCommand) return "kubernetes_cluster_creation_required";
  if (input.heavyOrchestration) return "heavy_orchestration_required";
  if (input.credentialRequired) return "credential_required";
  if (input.externalHealthAvailable) return "external_health_verification_required";
  return "";
}

export function validateAgentPlan(value: unknown): AgentPlanValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["agent plan must be an object"] };
  }
  const plan = value as Partial<AgentPlan>;
  for (const key of Object.keys(value)) if (!PLAN_KEYS.has(key)) errors.push(`unsupported field: ${key}`);
  if (plan.schema !== "bootproof/agent-plan/v1") errors.push("invalid agent plan schema");
  if (plan.mode !== "agent-plan") errors.push("invalid agent plan mode");
  if (typeof plan.currentFailureClass !== "string") errors.push("currentFailureClass must be a string");
  for (const field of ["observedEvidence", "suspectedStack", "missingTools", "verificationSteps", "stopConditions"] as const) {
    if (!isStringArray(plan[field])) {
      errors.push(`${field} must be a string array`);
    } else if (hasDuplicates(plan[field])) {
      errors.push(`${field} must not contain duplicates`);
    }
  }
  if (typeof plan.canBootProofOrchestrateDirectly !== "boolean") {
    errors.push("canBootProofOrchestrateDirectly must be boolean");
  }
  if (typeof plan.canBootProofVerifyExternally !== "boolean") {
    errors.push("canBootProofVerifyExternally must be boolean");
  }
  if (!Array.isArray(plan.candidateNextActions)) {
    errors.push("candidateNextActions must be an array");
  } else {
    for (const [index, candidate] of plan.candidateNextActions.entries()) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        errors.push(`candidateNextActions[${index}] must be an object`);
        continue;
      }
      for (const key of Object.keys(candidate)) {
        if (!ACTION_KEYS.has(key)) errors.push(`candidateNextActions[${index}] has unsupported field: ${key}`);
      }
      const item = candidate as Partial<AgentPlanAction>;
      if (!CLASSIFICATIONS.has(item.classification as AgentSafetyClassification)) errors.push(`candidateNextActions[${index}] has invalid classification`);
      if (!ACTION_TYPES.has(String(item.actionType))) errors.push(`candidateNextActions[${index}] has invalid actionType`);
      if (typeof item.command !== "string") errors.push(`candidateNextActions[${index}].command must be a string`);
      for (const field of ["reason", "verificationStep", "stopCondition"] as const) {
        if (typeof item[field] !== "string" || !item[field]!.trim()) {
          errors.push(`candidateNextActions[${index}].${field} must be a non-empty string`);
        }
      }
      if (!isStringArray(item.evidence)) {
        errors.push(`candidateNextActions[${index}].evidence must be a string array`);
      } else if (hasDuplicates(item.evidence)) {
        errors.push(`candidateNextActions[${index}].evidence must not contain duplicates`);
      }
      if (!RISK_LEVELS.has(item.riskLevel as RepairRiskLevel)) errors.push(`candidateNextActions[${index}] has invalid riskLevel`);
      if (!MUTATION_SCOPES.has(item.mutationScope as RepairMutationScope)) errors.push(`candidateNextActions[${index}] has invalid mutationScope`);
      if (item.requiresApproval !== true) errors.push(`candidateNextActions[${index}].requiresApproval must be true`);
      if (item.actionType === "command" && !item.command?.trim()) {
        errors.push(`candidateNextActions[${index}] command actions require a command`);
      } else if (item.actionType === "command" && item.command) {
        errors.push(...validateAgentCommand(item.command).map(error => `candidateNextActions[${index}]: ${error}`));
      }
      if (item.actionType === "instruction" && item.command !== "") {
        errors.push(`candidateNextActions[${index}] instruction actions must use an empty command`);
      }
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function buildAgentPlan(repoPath: string, options: AgentPlanOptions = {}): AgentPlan {
  const repo = path.resolve(repoPath);
  const inference = inferRepo(repo);
  const inspectionFiles = collectInspectionFiles(repo);
  const fileTexts = inspectionFiles.map(relativePath => ({
    relativePath,
    text: readInspectionText(repo, relativePath),
  }));
  const combinedText = fileTexts.map(file => file.text).join("\n");
  const prior = loadPriorAttestation(repo);

  const gradleFiles = inspectionFiles.filter(file => /(?:^|\/)(?:build|settings)\.gradle(?:\.kts)?$|(?:^|\/)gradle\.properties$|(?:^|\/)gradlew(?:\.bat)?$/i.test(file));
  const dockerFiles = inspectionFiles.filter(file => /(?:^|\/)(?:Dockerfile|(?:docker-)?compose)/i.test(file));
  const kubernetesFiles = inspectionFiles.filter(file => /(?:^|\/)(?:k8s|kubernetes|helm)(?:\/|$)|(?:^|\/)Chart\.yaml$/i.test(file));
  const hasGradle = gradleFiles.length > 0;
  const hasJava = hasGradle || inspectionFiles.includes("pom.xml") || /\bJava\b|\bJDK\b/i.test(combinedText);
  const hasAbctl = /\babctl\b/i.test(combinedText);
  const hasKind = /\bkind\s+(?:create|delete|get|load)\b|\bkind cluster\b/i.test(combinedText);
  const hasHelm = kubernetesFiles.some(file => /helm|Chart\.yaml/i.test(file)) || /\bhelm\s+(?:install|upgrade|dependency|repo)\b/i.test(combinedText);
  const hasKubernetes = kubernetesFiles.length > 0 || /\bkubernetes\b|\bkubectl\b/i.test(combinedText);
  const credentialRequired = /\b(?:credentials? required|login required|authentication required|username and password|initial credentials?)\b/i.test(combinedText);
  const abctlCommands = documentedAbctlCommands(combinedText);
  const kindCommands = documentedKindCommands(combinedText);
  const priorHealthUrls = prior.attestation?.verificationMode === "external-health" && prior.attestation.externalHealthUrl
    ? documentedHealthUrls(prior.attestation.externalHealthUrl)
    : [];
  const healthUrls = uniqueSorted([...documentedHealthUrls(combinedText), ...priorHealthUrls])
    .sort((a, b) => Number(!/health/i.test(a)) - Number(!/health/i.test(b)) || a.localeCompare(b));

  const relevantTools = [
    ...(hasJava ? ["java"] : []),
    ...(hasGradle && !inspectionFiles.some(file => /(?:^|\/)gradlew(?:\.bat)?$/i.test(file)) ? ["gradle"] : []),
    ...(hasAbctl ? ["abctl"] : []),
    ...(hasKind ? ["kind"] : []),
    ...(hasHelm ? ["helm"] : []),
    ...(hasKubernetes && /\bkubectl\b/i.test(combinedText) ? ["kubectl"] : []),
  ];
  const missingTools = uniqueSorted(relevantTools.filter(tool => !isToolAvailable(tool, options)));
  const suspectedStack = uniqueSorted([
    ...inference.stack,
    ...(hasJava ? ["java"] : []),
    ...(hasGradle ? ["gradle"] : []),
    ...(dockerFiles.length ? ["docker"] : []),
    ...(hasKubernetes ? ["kubernetes"] : []),
    ...(hasKind ? ["kind"] : []),
    ...(hasHelm ? ["helm"] : []),
    ...(hasAbctl ? ["abctl"] : []),
  ]);
  const heavyOrchestration = hasAbctl || hasKubernetes || hasHelm || hasKind;
  const priorFailureClass = prior.attestation?.result.failureClass ?? "";
  const canBootProofOrchestrateDirectly = Boolean(
    inference.isApplication &&
    !heavyOrchestration &&
    !inference.incompleteAppCommand &&
    !inference.multiAppCommand &&
    (inference.appCommand || inference.composeHealthCandidates.length === 1) &&
    priorFailureClass !== "orchestration_not_supported",
  );
  const canBootProofVerifyExternally = !canBootProofOrchestrateDirectly && healthUrls.length > 0;

  const observedEvidence = [
    ...prior.evidence,
    ...inspectionFiles.map(file => `Inspected ${file}.`),
    ...(inference.stack.length ? [`Repository inference detected: ${inference.stack.join(", ")}.`] : []),
    ...(gradleFiles.length ? [`Gradle traits: ${gradleFiles.join(", ")}.`] : []),
    ...(dockerFiles.length ? [`Docker traits: ${dockerFiles.join(", ")}.`] : []),
    ...(kubernetesFiles.length ? [`Kubernetes/Helm traits: ${kubernetesFiles.join(", ")}.`] : []),
    ...abctlCommands.map(command => `Documented runbook command: ${command}.`),
    ...kindCommands.map(command => `Documented cluster command: ${command}.`),
    ...healthUrls.map(url => `Documented external health endpoint: ${url}.`),
    ...(credentialRequired ? ["Documentation indicates a credential-sensitive authentication step."] : []),
  ].map(safeEvidence);

  const candidateNextActions: AgentPlanAction[] = [];
  for (const tool of missingTools) {
    candidateNextActions.push(action({
      classification: "host_tool_install_required",
      actionType: "instruction",
      command: "",
      reason: `${tool} is required by repository or runbook evidence but is not available on PATH. Install a repository-supported version manually; BootProof does not choose an installer or version without evidence.`,
      evidence: [`Missing tool: ${tool}.`],
      riskLevel: "medium",
      mutationScope: "host",
      verificationStep: `${tool} --version`,
      stopCondition: `Stop if the repository does not document a trusted ${tool} version or installation source.`,
    }));
  }

  for (const command of kindCommands) {
    candidateNextActions.push(action({
      classification: "kubernetes_cluster_creation_required",
      actionType: "command",
      command,
      reason: "The documented runbook requires creation of a local Kubernetes cluster.",
      evidence: [`Documented cluster command: ${command}.`],
      riskLevel: "high",
      mutationScope: "service",
      verificationStep: "kubectl cluster-info",
      stopCondition: "Stop unless the user explicitly approves local cluster creation; stop on any unexpected cluster or context change.",
    }));
  }
  if (hasKubernetes && !hasAbctl && kindCommands.length === 0) {
    candidateNextActions.push(action({
      classification: "kubernetes_cluster_creation_required",
      actionType: "instruction",
      command: "",
      reason: "Kubernetes traits were found, but no exact safe cluster-creation command was documented.",
      evidence: kubernetesFiles.map(file => `Kubernetes marker: ${file}.`),
      riskLevel: "high",
      mutationScope: "service",
      verificationStep: "Verify the selected Kubernetes context and required workloads before any health claim.",
      stopCondition: "Stop until a human selects and approves the repository's documented cluster workflow.",
    }));
  }

  for (const command of abctlCommands) {
    candidateNextActions.push(action({
      classification: "heavy_orchestration_required",
      actionType: "command",
      command,
      reason: "The repository documents an external orchestrator runbook that BootProof must not execute automatically.",
      evidence: [`Documented runbook command: ${command}.`],
      riskLevel: "high",
      mutationScope: "service",
      verificationStep: "abctl local status",
      stopCondition: "Stop unless the user explicitly approves the one documented orchestration step; stop if deployment status is not healthy.",
    }));
  }
  if (heavyOrchestration && abctlCommands.length === 0 && kindCommands.length === 0) {
    candidateNextActions.push(action({
      classification: "heavy_orchestration_required",
      actionType: "instruction",
      command: "",
      reason: "The repository requires multi-service or external orchestration, but no exact safe command was established.",
      evidence: suspectedStack.filter(stack => ["kubernetes", "kind", "helm", "abctl"].includes(stack)),
      riskLevel: "high",
      mutationScope: "service",
      verificationStep: "Confirm all documented services and workloads are running before checking application health.",
      stopCondition: "Stop until the repository's documented runbook is reviewed and one exact action is explicitly approved.",
    }));
  }

  if (credentialRequired) {
    candidateNextActions.push(action({
      classification: "credential_required",
      actionType: "instruction",
      command: "",
      reason: "A later authentication step requires real credentials. BootProof will not infer, invent, persist, or expose them.",
      evidence: ["Documentation indicates a credential-sensitive authentication step."],
      riskLevel: "high",
      mutationScope: "none",
      verificationStep: "Verify authenticated access manually without storing credentials in the agent plan.",
      stopCondition: "Stop if credentials are unavailable, ambiguous, or would need to be invented or exposed.",
    }));
  }

  if (canBootProofVerifyExternally) {
    const url = healthUrls[0];
    const command = createRepairCommand("bootproof", ["verify-url", url]);
    if (validateRepairCommand(command).valid) {
      candidateNextActions.push(action({
        classification: "external_health_verification_required",
        actionType: "command",
        command: command.display,
        reason: "BootProof cannot safely orchestrate this stack directly, but a documented external HTTP health endpoint can be observed.",
        evidence: [`Documented external health endpoint: ${url}.`],
        riskLevel: "low",
        mutationScope: "none",
        verificationStep: "Require an external_service_verified attestation; HTTP 401/403 remains auth_required.",
        stopCondition: "Stop if the endpoint is unreachable, requires undisclosed credentials, or does not return HTTP 2xx/3xx.",
      }));
    }
  }

  if (!canBootProofOrchestrateDirectly && candidateNextActions.length === 0) {
    candidateNextActions.push(action({
      classification: "heavy_orchestration_required",
      actionType: "instruction",
      command: "",
      reason: "BootProof found no trustworthy direct orchestration path or exact deterministic next command.",
      evidence: [inference.notAppReason ?? inference.commandScope],
      riskLevel: "blocked",
      mutationScope: "none",
      verificationStep: "Obtain a documented runbook and explicit health contract before proceeding.",
      stopCondition: "Stop because the next step is unknown or unsupported.",
    }));
  }

  const verificationSteps = uniqueSorted([
    ...candidateNextActions.map(candidate => candidate.verificationStep),
    ...(canBootProofOrchestrateDirectly
      ? ["Run bootproof up manually; only its observed signed health evidence can verify the application."]
      : []),
  ]);
  const stopConditions = uniqueSorted([
    "Stop after this plan is written; plan-agent never executes candidate actions.",
    "Stop on any unknown, unsupported, ambiguous, or unsafe action.",
    ...candidateNextActions.map(candidate => candidate.stopCondition),
  ]);
  const plan: AgentPlan = {
    schema: "bootproof/agent-plan/v1",
    mode: "agent-plan",
    currentFailureClass: genericFailureClass({
      priorFailureClass,
      missingTools,
      hasKindCommand: kindCommands.length > 0,
      heavyOrchestration,
      credentialRequired,
      externalHealthAvailable: canBootProofVerifyExternally,
    }),
    observedEvidence: uniqueSorted(observedEvidence),
    suspectedStack,
    missingTools,
    candidateNextActions,
    verificationSteps,
    stopConditions,
    canBootProofOrchestrateDirectly,
    canBootProofVerifyExternally,
  };
  const validation = validateAgentPlan(plan);
  if (!validation.valid) throw new Error(`invalid agent plan: ${validation.errors.join("; ")}`);
  return plan;
}

export function agentPlanPath(repo: string): string {
  return path.join(repo, ".bootproof", "agent-plan.json");
}

export function writeAgentPlan(repo: string, plan: AgentPlan): string {
  const validation = validateAgentPlan(plan);
  if (!validation.valid) throw new Error(`invalid agent plan: ${validation.errors.join("; ")}`);
  const output = agentPlanPath(repo);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(plan, null, 2) + "\n");
  return output;
}
