import { redactJsonValue, redactText } from "./redact.js";
import {
  ACTION_RISK_LEVELS,
  buildAiSuggestedRepairAction,
  type RepairAction,
  type RepairActionType,
  type RepairCommand,
  type RepairPatch,
  type RepairRiskLevel,
} from "./repair-safety.js";
import type { Attestation, FailureClass } from "./types.js";

export const AI_KEY_REQUIRED_MESSAGE =
  "AI-assisted repair is optional and requires your own OPENAI_API_KEY or ANTHROPIC_API_KEY. BootProof up, explain, plan-agent, verify-url, and deterministic fix work without AI.";

export type AiProvider = "openai" | "anthropic";

export interface AiProviderConfig {
  provider: AiProvider;
  apiKey: string;
  model: string;
  endpoint: string;
}

export interface AiRepairContext {
  schema: "bootproof/ai-repair-context/v1";
  failureClass: FailureClass;
  verificationMode: Attestation["verificationMode"];
  bootproofOrchestrated: boolean;
  failureEvidence: string;
  explanation: string;
  observedEvidence: Array<{
    id: string;
    ok: boolean;
    observation: string;
    evidenceHead?: string;
    evidenceTail?: string;
    firstErrorLine?: string;
    firstExceptionLine?: string;
    detectedCause?: string;
  }>;
  healthEvidence: Attestation["result"]["healthEvidence"];
  redactionsApplied: string[];
}

export interface AiRepairSuggestion {
  schema: "bootproof/ai-repair-suggestion/v1";
  confidence: number;
  failure_class: FailureClass;
  suggested_action_type: RepairActionType;
  suggested_command: RepairCommand | null;
  suggested_patch: RepairPatch | null;
  explanation_for_user: string;
  risk_level: RepairRiskLevel;
  requires_human_approval: true;
  why_this_is_safe: string;
  what_to_check_after: string;
}

export interface RequestedAiRepair {
  provider: AiProvider;
  model: string;
  context: AiRepairContext;
  suggestion: AiRepairSuggestion;
  action: RepairAction;
}

const SUGGESTION_KEYS = new Set([
  "schema",
  "confidence",
  "failure_class",
  "suggested_action_type",
  "suggested_command",
  "suggested_patch",
  "explanation_for_user",
  "risk_level",
  "requires_human_approval",
  "why_this_is_safe",
  "what_to_check_after",
]);
const COMMAND_KEYS = new Set(["executable", "args", "display"]);
const PATCH_KEYS = new Set(["format", "content", "files"]);
const ACTION_TYPES = new Set<RepairActionType>(["command", "patch", "instruction"]);
const FAILURE_EVIDENCE_LIMIT = 8000;
const STEP_EVIDENCE_LIMIT = 2000;
const RESPONSE_LIMIT = 256_000;

export function buildOpenAiRepairResponseFormat() {
  return {
    type: "json_schema",
    name: "bootproof_ai_repair_suggestion",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [...SUGGESTION_KEYS],
      properties: {
        schema: { type: "string", const: "bootproof/ai-repair-suggestion/v1" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        failure_class: { type: "string", minLength: 1 },
        suggested_action_type: { type: "string", enum: ["command", "patch", "instruction"] },
        suggested_command: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["executable", "args", "display"],
              properties: {
                executable: { type: "string", minLength: 1 },
                args: { type: "array", items: { type: "string" } },
                display: { type: "string", minLength: 1 },
              },
            },
            { type: "null" },
          ],
        },
        suggested_patch: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["format", "content", "files"],
              properties: {
                format: { type: "string", const: "unified-diff" },
                content: { type: "string", minLength: 1 },
                files: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                },
              },
            },
            { type: "null" },
          ],
        },
        explanation_for_user: { type: "string", minLength: 1 },
        risk_level: { type: "string", enum: [...ACTION_RISK_LEVELS] },
        requires_human_approval: { type: "boolean", const: true },
        why_this_is_safe: { type: "string", minLength: 1 },
        what_to_check_after: { type: "string", minLength: 1 },
      },
    },
  } as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(value).filter(key => !allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated]`;
}

function patchHeaderFiles(content: string): string[] {
  const files = new Set<string>();
  for (const match of content.matchAll(/^(?:---|\+\+\+)\s+([^\t\n]+)$/gm)) {
    const raw = match[1].trim();
    if (raw === "/dev/null") continue;
    files.add(raw.replace(/^[ab]\//, ""));
  }
  return [...files].sort();
}

export function resolveAiProvider(env: NodeJS.ProcessEnv = process.env): AiProviderConfig {
  const openaiKey = env.OPENAI_API_KEY?.trim();
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const requested = env.BOOTPROOF_AI_PROVIDER?.trim().toLowerCase();
  if (!openaiKey && !anthropicKey) throw new Error(AI_KEY_REQUIRED_MESSAGE);
  if (requested && requested !== "openai" && requested !== "anthropic") {
    throw new Error(`Unsupported BOOTPROOF_AI_PROVIDER: ${requested}. Expected openai or anthropic.`);
  }
  if (requested === "openai" && !openaiKey) {
    throw new Error("BOOTPROOF_AI_PROVIDER=openai requires OPENAI_API_KEY.");
  }
  if (requested === "anthropic" && !anthropicKey) {
    throw new Error("BOOTPROOF_AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY.");
  }
  if ((requested === "openai" || (!requested && openaiKey)) && openaiKey) {
    return {
      provider: "openai",
      apiKey: openaiKey,
      model: env.BOOTPROOF_OPENAI_MODEL?.trim() || "gpt-4.1",
      endpoint: "https://api.openai.com/v1/responses",
    };
  }
  return {
    provider: "anthropic",
    apiKey: anthropicKey!,
    model: env.BOOTPROOF_ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6",
    endpoint: "https://api.anthropic.com/v1/messages",
  };
}

export function buildAiRepairContext(attestation: Attestation): AiRepairContext {
  if (
    attestation.result.booted ||
    attestation.result.healthVerified ||
    !attestation.result.failureClass
  ) {
    throw new Error("AI repair requires a classified failed attestation.");
  }
  const raw = {
    schema: "bootproof/ai-repair-context/v1",
    failureClass: attestation.result.failureClass,
    verificationMode: attestation.verificationMode,
    bootproofOrchestrated: attestation.bootproofOrchestrated,
    failureEvidence: truncate(attestation.result.failureEvidence ?? "", FAILURE_EVIDENCE_LIMIT),
    explanation: truncate(attestation.result.explanation, STEP_EVIDENCE_LIMIT),
    observedEvidence: attestation.observed.map(observation => ({
      id: observation.id,
      ok: observation.ok,
      observation: truncate(observation.observation, STEP_EVIDENCE_LIMIT),
      ...(observation.evidenceHead
        ? { evidenceHead: truncate(observation.evidenceHead, STEP_EVIDENCE_LIMIT) }
        : {}),
      ...(observation.evidenceTail
        ? { evidenceTail: truncate(observation.evidenceTail, STEP_EVIDENCE_LIMIT) }
        : {}),
      ...(observation.firstErrorLine ? { firstErrorLine: observation.firstErrorLine } : {}),
      ...(observation.firstExceptionLine ? { firstExceptionLine: observation.firstExceptionLine } : {}),
      ...(observation.detectedCause ? { detectedCause: observation.detectedCause } : {}),
    })),
    healthEvidence: attestation.result.healthEvidence,
  };
  const redacted = redactJsonValue(raw);
  return {
    ...(redacted.value as Omit<AiRepairContext, "redactionsApplied">),
    redactionsApplied: redacted.applied,
  };
}

export function validateAiRepairSuggestion(
  value: unknown,
  expectedFailureClass?: FailureClass,
): AiRepairSuggestion {
  if (!isRecord(value)) throw new Error("AI repair suggestion must be a JSON object.");
  const errors: string[] = exactKeys(value, SUGGESTION_KEYS).map(key => `unsupported field: ${key}`);
  for (const key of SUGGESTION_KEYS) {
    if (!(key in value)) errors.push(`missing field: ${key}`);
  }
  if (value.schema !== "bootproof/ai-repair-suggestion/v1") errors.push("invalid AI repair suggestion schema");
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) {
    errors.push("confidence must be a number from 0 to 1");
  }
  if (!nonEmptyString(value.failure_class)) errors.push("failure_class must be a non-empty string");
  if (expectedFailureClass && value.failure_class !== expectedFailureClass) {
    errors.push(`failure_class must match ${expectedFailureClass}`);
  }
  if (!ACTION_TYPES.has(value.suggested_action_type as RepairActionType)) errors.push("invalid suggested_action_type");
  if (!ACTION_RISK_LEVELS.includes(value.risk_level as RepairRiskLevel)) errors.push("invalid risk_level");
  if (value.requires_human_approval !== true) errors.push("requires_human_approval must be true");
  for (const key of ["explanation_for_user", "why_this_is_safe", "what_to_check_after"] as const) {
    if (!nonEmptyString(value[key])) errors.push(`${key} must be a non-empty string`);
  }

  const command = value.suggested_command;
  if (command !== null) {
    if (!isRecord(command)) {
      errors.push("suggested_command must be an object or null");
    } else {
      errors.push(...exactKeys(command, COMMAND_KEYS).map(key => `unsupported command field: ${key}`));
      if (!nonEmptyString(command.executable)) errors.push("suggested_command.executable must be a non-empty string");
      if (!stringArray(command.args)) errors.push("suggested_command.args must be a string array");
      if (!nonEmptyString(command.display)) errors.push("suggested_command.display must be a non-empty string");
    }
  }

  const patch = value.suggested_patch;
  if (patch !== null) {
    if (!isRecord(patch)) {
      errors.push("suggested_patch must be an object or null");
    } else {
      errors.push(...exactKeys(patch, PATCH_KEYS).map(key => `unsupported patch field: ${key}`));
      if (patch.format !== "unified-diff") errors.push("suggested_patch.format must be unified-diff");
      if (!nonEmptyString(patch.content)) errors.push("suggested_patch.content must be a non-empty string");
      if (!stringArray(patch.files) || patch.files.length === 0) {
        errors.push("suggested_patch.files must be a non-empty string array");
      } else if (typeof patch.content === "string") {
        if (new Set(patch.files).size !== patch.files.length) {
          errors.push("suggested_patch.files must not contain duplicates");
        }
        const headers = patchHeaderFiles(patch.content);
        const declared = [...new Set(patch.files)].sort();
        if (headers.join("\n") !== declared.join("\n")) {
          errors.push("suggested_patch.files must exactly match unified diff headers");
        }
      }
    }
  }

  if (value.suggested_action_type === "command" && (command === null || patch !== null)) {
    errors.push("command suggestions require only suggested_command");
  }
  if (value.suggested_action_type === "patch" && (patch === null || command !== null)) {
    errors.push("patch suggestions require only suggested_patch");
  }
  if (value.suggested_action_type === "instruction" && (command !== null || patch !== null)) {
    errors.push("instruction suggestions cannot contain a command or patch");
  }
  if (errors.length) throw new Error(`Invalid AI repair JSON: ${[...new Set(errors)].join("; ")}`);
  return value as unknown as AiRepairSuggestion;
}

function promptFor(context: AiRepairContext): string {
  return [
    "Return exactly one JSON object matching bootproof/ai-repair-suggestion/v1.",
    "Suggest one smallest safe local action only. Do not claim success.",
    "Never use sudo, shell chaining, redirects, pipe-to-shell, protected .env writes, secret reads, uploads, destructive commands, or invented secrets.",
    "Commands must be structured as executable plus args, and display must exactly render them.",
    "Set requires_human_approval to true. BootProof will independently risk-classify, approve, execute, and verify.",
    "Structured redacted failure evidence:",
    JSON.stringify(context),
  ].join("\n");
}

function openAiText(payload: unknown): string {
  if (!isRecord(payload)) throw new Error("OpenAI returned an invalid response envelope.");
  if (nonEmptyString(payload.output_text)) return payload.output_text;
  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (isRecord(content) && content.type === "output_text" && nonEmptyString(content.text)) {
          return content.text;
        }
      }
    }
  }
  throw new Error("OpenAI response did not contain JSON output text.");
}

function anthropicText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    throw new Error("Anthropic returned an invalid response envelope.");
  }
  const text = payload.content
    .filter(item => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map(item => (item as { text: string }).text)
    .join("");
  if (!text.trim()) throw new Error("Anthropic response did not contain JSON output text.");
  return text;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > RESPONSE_LIMIT) throw new Error("AI provider response exceeded BootProof's size limit.");
  if (!response.ok) {
    const safe = redactText(text).text.slice(0, 1000);
    throw new Error(`AI provider request failed with HTTP ${response.status}${safe ? `: ${safe}` : ""}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("AI provider returned a non-JSON response envelope.");
  }
}

export async function requestAiRepairSuggestion(
  attestation: Attestation,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<RequestedAiRepair> {
  const config = resolveAiProvider(options.env);
  const context = buildAiRepairContext(attestation);
  const prompt = promptFor(context);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = config.provider === "openai"
      ? await fetchImpl(config.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            store: false,
            instructions: "You are a repair suggestion generator. Output only the requested strict JSON object.",
            input: prompt,
            text: {
              format: buildOpenAiRepairResponseFormat(),
            },
          }),
          signal: controller.signal,
        })
      : await fetchImpl(config.endpoint, {
          method: "POST",
          headers: {
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "x-api-key": config.apiKey,
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 2048,
            system: "Output only one strict JSON object matching the requested schema.",
            messages: [{ role: "user", content: prompt }],
          }),
          signal: controller.signal,
        });
    const envelope = await responseJson(response);
    const output = config.provider === "openai" ? openAiText(envelope) : anthropicText(envelope);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error("Invalid AI repair JSON: provider output was not exactly one JSON object.");
    }
    const suggestion = validateAiRepairSuggestion(parsed, context.failureClass);
    const action = buildAiSuggestedRepairAction({
      actionType: suggestion.suggested_action_type,
      mutationScope: suggestion.suggested_action_type === "patch" ? "repo_only" : "none",
      riskLevel: suggestion.risk_level,
      requiresApproval: true,
      command: suggestion.suggested_command,
      patch: suggestion.suggested_patch,
      instruction: suggestion.suggested_action_type === "instruction"
        ? suggestion.explanation_for_user
        : null,
      explanation: suggestion.explanation_for_user,
      evidenceRefs: [".bootproof/attestation.json"],
      verificationStep: suggestion.what_to_check_after,
    });
    return {
      provider: config.provider,
      model: config.model,
      context,
      suggestion,
      action,
    };
  } finally {
    clearTimeout(timer);
  }
}
