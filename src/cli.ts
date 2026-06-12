#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline/promises";
import { inferRepo } from "./infer.js";
import { buildPlan, composeFileFor, envExampleFor } from "./plan.js";
import { up, type UpOptions, type UpOutcome } from "./run.js";
import { verifySignature, attestationPath, writeAttestation, TOOL_ID } from "./proof.js";
import { pollHealth } from "./exec.js";
import { buildExternalHealthAttestation } from "./external-health.js";
import {
  buildFederatedReceipt,
  buildRegistryEntry,
  currentGitBranch,
  verifyRegistryEntry,
  writeFederatedReceipt,
  writeRegistryEntry,
  registryEntryPath,
  type RegistryMode,
} from "./registry.js";
import { normalizeDockerBindPath, detectHostPlatform } from "./platform.js";
import { diagnoseFailure, type FailureDiagnosis } from "./diagnosis.js";
import { cloneRemoteTarget, isRemoteTarget, managedRemoteSource, type RemoteClone } from "./remote.js";
import {
  applyVerifiedRepair,
  latestDeterministicRepairCandidate,
  repairRepo,
  verifyRepairReceipt,
  type RepairApplyResult,
  type RepairReceipt,
  type RepairResult,
} from "./repair.js";
import type { Attestation } from "./types.js";

let GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RESET = "\x1b[0m";
const ok = (s: string) => console.log(`${GREEN}\u2713 ${s}${RESET}`);
const would = (s: string) => console.log(`${DIM}\u25cb would: ${s}${RESET}`);
const warn = (s: string) => console.log(`${YELLOW}! ${s}${RESET}`);
const bad = (s: string) => console.log(`${RED}\u2717 ${s}${RESET}`);
const disableColor = () => { GREEN = ""; YELLOW = ""; RED = ""; DIM = ""; BOLD = ""; RESET = ""; };
const portableRelative = (from: string, to: string) => path.relative(from, to).replace(/\\/g, "/");

const COMMANDS = ["up", "verify-url", "fix", "apply-repair", "analyze", "plan", "verify", "explain", "attest", "registry", "help", "version", "--help", "-h", "--version"];
const SUPPORTED_FLAGS: Record<string, ReadonlySet<string>> = {
  analyze: new Set(["workspace", "json", "ci"]),
  plan: new Set(["workspace", "provider", "ci"]),
  "apply-repair": new Set(["receipt", "dry-run", "json", "ci"]),
  fix: new Set(["provider", "unsafe-local", "port", "timeout", "dry-run", "json", "ci"]),
  up: new Set(["provider", "unsafe-local", "install", "workspace", "port", "timeout", "dry-run", "json", "ci", "command", "external-health"]),
  "verify-url": new Set(["timeout", "json", "ci"]),
  verify: new Set(["ci"]),
  attest: new Set(["ci"]),
  registry: new Set(["mode", "federated", "ci"]),
  explain: new Set(["ci"]),
};
void normalizeDockerBindPath; void detectHostPlatform; // exported surface, used by docker provider work in progress

if (process.env.NO_COLOR !== undefined) disableColor();

function parseFlags(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function help() {
  console.log(`${BOLD}bootproof${RESET} — Human diagnosis. Machine proof. One engine.

Usage:
  bootproof analyze <path|git-url> [--workspace dir] [--json]
                                                            inspect a repo, show evidence-based inference
  bootproof plan <path|git-url> [--workspace dir]           show the run plan and files that WOULD be generated
  bootproof up <path|git-url> [options]                     execute the plan, verify localhost, write signed proof
  bootproof verify-url <url> [--timeout ms]                 verify an externally managed HTTP service
  bootproof fix <path|git-url> [options]                    test a deterministic repair in a sandbox
  bootproof apply-repair <path> [--receipt proof.json]      explicitly apply a signature-valid verified file change
  bootproof verify <path|proof.json>                        validate an attestation or repair-receipt signature
  bootproof explain <proof.json>                            explain an attestation or repair receipt
  bootproof registry export <path>                          explicitly write a redacted local registry export
  bootproof registry export <path> --federated              explicitly write a public-candidate receipt
  bootproof attest export <path>                            compatibility alias for local registry export
  bootproof attest check <path>                             verify a registry entry signature
  bootproof version

Options for up:
  --provider docker|local   execution provider (default docker)
  --unsafe-local            required acknowledgement for --provider local
  --install                 run the dependency install step (off by default)
  --workspace <dir>         pick a monorepo workspace
  --command <command>       override the inferred application start command
  --external-health <url>   verify an externally managed service; do not start the app
  --port <n>                override inferred port
  --timeout <ms>            health verification timeout (default 60000)
  --dry-run                 show what would happen; executes nothing, writes nothing
  --json                    one bootproof/result/v1 JSON object on stdout
  --ci                      no prompts, colours, or interactive UI; fail closed

Options for fix:
  --provider docker|local   execution provider (default docker)
  --unsafe-local            required acknowledgement for local sandbox execution
  --port <n>                override inferred application port
  --timeout <ms>            before/after health timeout (default 60000)
  --dry-run                 execute nothing, write nothing, produce no repair proof
  --json                    one bootproof/repair-result/v1 object on stdout

Command repairs show the exact command and require the literal response Y before execution.
JSON and CI modes never prompt and never approve a command.

Honesty contract: no green check without an observed event; dry runs say "would";
.env/.env.local are never written; secrets are never invented.
Remote execution requires --provider local --unsafe-local. docs/HONESTY_CONTRACT.md`);
}

function printInference(inf: ReturnType<typeof inferRepo>) {
  console.log(`${BOLD}Inference (evidence-based)${RESET}`);
  console.log(`  application: ${inf.isApplication ? "yes" : `no — ${inf.notAppReason}`}`);
  if (inf.stack.length) console.log(`  stack: ${inf.stack.join(", ")}`);
  if (inf.backendMarkers.length) console.log(`  backend markers: ${inf.backendMarkers.join(", ")}`);
  if (inf.frontendMarkers.length) console.log(`  frontend markers: ${inf.frontendMarkers.join(", ")}`);
  if (inf.serviceMarkers.length) console.log(`  service markers: ${inf.serviceMarkers.join(", ")}`);
  if (inf.repoComposeFile) console.log(`  repo compose: ${inf.repoComposeFile} (bootproof defers to it)`);
  if (inf.composeApplicationServices.length) {
    console.log(`  compose HTTP services: ${inf.composeApplicationServices.map(service => `${service.name} (${service.source === "build" ? "builds checked-out source" : "image only"})`).join("; ")}`);
  }
  console.log(`  package manager: ${inf.packageManager} ${DIM}(${inf.packageManagerEvidence})${RESET}`);
  if (inf.setupSteps.length) console.log(`  setup steps: ${inf.setupSteps.join("; ")}`);
  if (inf.backendCommand) console.log(`  backend command: ${inf.backendCommand}`);
  if (inf.frontendCommand) console.log(`  frontend command: ${inf.frontendCommand}`);
  if (inf.workerCommand) console.log(`  worker command: ${inf.workerCommand}`);
  if (inf.appCommand) console.log(`  selected command: ${inf.appCommand} ${DIM}(${inf.appCommandSource})${RESET}`);
  if (inf.preparationCommands.length) console.log(`  preparation: ${inf.preparationCommands.map(command => command.command).join("; ")}`);
  console.log(`  command scope: ${inf.commandScope}`);
  console.log(`  port: ${inf.port} ${DIM}(${inf.portEvidence})${RESET}`);
  if (inf.healthCandidates.length) console.log(`  health candidates: ${inf.healthCandidates.join(", ")}`);
  if (inf.services.length) console.log(`  services: ${inf.services.map(s => `${s.kind} (${s.evidence})`).join("; ")}`);
  if (inf.envWithoutSafeDefault.length) console.log(`  secrets you must provide: ${inf.envWithoutSafeDefault.join(", ")}`);
  if (inf.workspaces.length > 1) {
    console.log(`  monorepo candidates (ranked):`);
    for (const w of inf.workspaces.slice(0, 8)) console.log(`    ${w.score >= 3 ? "*" : " "} ${w.dir} ${DIM}(${w.name}; ${w.reason})${RESET}`);
  }
  console.log(`  confidence: ${inf.confidence}% ${DIM}(heuristic score of evidence found, not a success prediction)${RESET}`);
}

function machineResult(outcome: UpOutcome, evidencePath: string) {
  const result = outcome.attestation?.result;
  return {
    schema: "bootproof/result/v1",
    booted: result?.booted ?? false,
    healthVerified: result?.healthVerified ?? false,
    failureClass: result?.failureClass ?? outcome.refusal?.failureClass ?? null,
    attestationPath: outcome.attestation ? evidencePath : null,
    inference: outcome.inference,
    plan: outcome.plan,
    observed: outcome.attestation?.observed ?? [],
    explanation: result?.explanation ?? outcome.refusal?.explanation ?? null,
    trust: outcome.attestation?.trust ?? null,
    writtenFiles: outcome.writtenFiles,
  };
}

function machineFailure(explanation: string) {
  return {
    schema: "bootproof/result/v1",
    booted: false,
    healthVerified: false,
    failureClass: "unknown_failure",
    attestationPath: null,
    inference: {},
    plan: {},
    observed: [],
    explanation,
    trust: null,
    writtenFiles: [],
  };
}

function externalMachineResult(attestation: Attestation, evidencePath: string | null) {
  return {
    schema: "bootproof/result/v1",
    booted: false,
    healthVerified: attestation.result.healthVerified,
    failureClass: attestation.result.failureClass,
    classification: attestation.classification,
    verificationMode: attestation.verificationMode,
    bootproofOrchestrated: attestation.bootproofOrchestrated,
    externalHealthUrl: attestation.externalHealthUrl,
    observedStatus: attestation.observedStatus,
    observedFinalUrl: attestation.observedFinalUrl,
    observedAt: attestation.observedAt,
    responseSnippet: attestation.responseSnippet,
    attestationPath: evidencePath,
    plan: attestation.plan,
    observed: attestation.observed,
    explanation: attestation.result.explanation,
    trust: attestation.trust,
    writtenFiles: evidencePath ? [evidencePath] : [],
  };
}

function printExternalHealthResult(attestation: Attestation, evidencePath: string | null): void {
  const result = attestation.result;
  if (result.healthVerified) {
    ok(`${BOLD}EXTERNAL SERVICE VERIFIED${RESET}${GREEN} — ${result.healthObservation} (observed, signed)`);
  } else {
    bad(`${BOLD}NOT VERIFIED${RESET}${RED} — ${attestation.classification}`);
    if (attestation.observedStatus !== null) {
      console.log(`Observed: HTTP ${attestation.observedStatus} at ${attestation.observedFinalUrl}`);
    }
    const connectionError = result.healthEvidence?.connectionError;
    if (connectionError) console.log(`Connection error: ${connectionError}`);
  }
  console.log("Ownership: externally managed (bootproofOrchestrated=false).");
  if (evidencePath) console.log(`Evidence: ${evidencePath}`);
}

function printFailure(failureClass: NonNullable<Attestation["result"]["failureClass"]>, diagnosis: FailureDiagnosis, evidencePath: string) {
  bad(`${BOLD}NOT VERIFIED${RESET}${RED} — ${failureClass}`);
  console.log(`What happened: ${diagnosis.whatHappened}`);
  console.log(`Why BootProof refused: ${diagnosis.whyRefused}`);
  console.log(`Safe next step: ${diagnosis.safeNextStep}`);
  console.log(`Evidence: ${evidencePath}`);
}

function isRepairReceipt(value: unknown): value is RepairReceipt {
  return Boolean(value && typeof value === "object" && (value as { schema?: string }).schema === "bootproof/repair-receipt/v1");
}

function optionalRepairReceipt(repo: string): RepairReceipt | null {
  const receipt = path.join(repo, ".bootproof", "repair-receipt.json");
  if (!fs.existsSync(receipt)) return null;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(receipt, "utf8"));
    return isRepairReceipt(value) && verifyRepairReceipt(value) ? value : null;
  } catch {
    return null;
  }
}

function registryEntryFor(repo: string, registryMode: RegistryMode) {
  const ap = attestationPath(repo);
  if (!fs.existsSync(ap)) return null;
  const att: Attestation = JSON.parse(fs.readFileSync(ap, "utf8"));
  return buildRegistryEntry(att, {
    registryMode,
    inference: inferRepo(repo),
    repairReceipt: optionalRepairReceipt(repo),
    branch: currentGitBranch(repo),
    sign: true,
  });
}

function printRepairResult(result: RepairResult): void {
  if (result.repaired) {
    ok(`${BOLD}VERIFIED REPAIR${RESET}${GREEN} — ${result.repairId}`);
    console.log(result.explanation);
    if (result.patchPath) console.log(`Patch: ${result.patchPath}`);
    console.log(`Receipt: ${result.receiptPath}`);
    console.log(`After attestation: ${result.afterAttestationPath}`);
    return;
  }
  bad(`${BOLD}NO VERIFIED REPAIR${RESET}${RED}${result.failureClass ? ` — ${result.failureClass}` : ""}`);
  console.log(result.explanation);
  if (result.receiptPath) console.log(`Receipt: ${result.receiptPath}`);
}

async function commandRepairApproval(command: string, riskLevel: string): Promise<boolean> {
  console.log("This repair may modify your local machine or services.");
  console.log(`Command: ${command}`);
  console.log(`Risk: ${riskLevel}`);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question("Run this command? Type Y to approve: ") === "Y";
  } finally {
    prompt.close();
  }
}

async function patchRepairApproval(): Promise<boolean> {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question("Test this patch in the repair sandbox? Type Y to approve: ") === "Y";
  } finally {
    prompt.close();
  }
}

function printRepairCandidate(candidate: ReturnType<typeof latestDeterministicRepairCandidate>): void {
  if (!candidate) return;
  const action = candidate.candidate.action;
  console.log(`${BOLD}Deterministic repair candidate${RESET}`);
  console.log(`Failure: ${candidate.candidate.failureClass}`);
  if (action.command) console.log(`Command: ${action.command.display}`);
  if (action.instruction) console.log(`Instruction: ${action.instruction}`);
  if (action.patch) console.log(`Patch preview:\n${action.patch.content}`);
  console.log(`Mutation scope: ${action.mutationScope}`);
  console.log(`Risk: ${action.riskLevel}`);
  for (const followUp of candidate.candidate.followUpActions ?? []) {
    if (followUp.command) console.log(`Later separately approved command: ${followUp.command.display}`);
    if (followUp.instruction) console.log(`Follow-up instruction: ${followUp.instruction}`);
  }
}

function printRepairApplyResult(result: RepairApplyResult): void {
  if (result.applied) {
    ok(`${BOLD}APPLIED VERIFIED REPAIR${RESET}`);
    console.log(result.explanation);
    console.log(`Receipt: ${result.receiptPath}`);
    return;
  }
  bad(`${BOLD}REPAIR NOT APPLIED${RESET}`);
  console.log(result.explanation);
}

function rebaseRemoteRepairPaths(result: RepairResult, repo: string): RepairResult {
  const rebase = (value: string | null) => value
    ? portableRelative(process.cwd(), path.join(repo, value))
    : null;
  return {
    ...result,
    receiptPath: rebase(result.receiptPath),
    patchPath: rebase(result.patchPath),
    afterAttestationPath: rebase(result.afterAttestationPath),
  };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return help();
  if (cmd === "version" || cmd === "--version") return console.log(TOOL_ID);
  if (!COMMANDS.includes(cmd)) {
    bad(`unknown command: ${cmd}`);
    console.log(`Run ${BOLD}bootproof help${RESET}. Bootproof never guesses what you meant.`);
    process.exitCode = 1;
    return;
  }
  const { flags, positional } = parseFlags(rest);
  if (flags.ci || flags.json) disableColor();
  const unsupportedFlag = Object.keys(flags).find(flag => !SUPPORTED_FLAGS[cmd]?.has(flag));
  if (unsupportedFlag) {
    const explanation = `unsupported flag for ${cmd}: --${unsupportedFlag}`;
    if (cmd === "up" && flags.json) console.log(JSON.stringify(machineFailure(explanation)));
    else bad(explanation);
    process.exitCode = 1;
    return;
  }
  const targetInput = String(positional[0] ?? ".");

  if (cmd === "verify-url") {
    if (!positional[0] || positional.length > 1) {
      const explanation = "verify-url requires exactly one HTTP or HTTPS URL";
      if (flags.json) console.log(JSON.stringify(machineFailure(explanation)));
      else bad(explanation);
      process.exitCode = 1;
      return;
    }
    const timeoutMs = Number(flags.timeout ?? 5000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      const explanation = `invalid --timeout value: ${String(flags.timeout)} (expected a positive number)`;
      if (flags.json) console.log(JSON.stringify(machineFailure(explanation)));
      else bad(explanation);
      process.exitCode = 1;
      return;
    }
    const attestation = await buildExternalHealthAttestation(process.cwd(), targetInput, timeoutMs);
    if (flags.json) console.log(JSON.stringify(attestation));
    else printExternalHealthResult(attestation, null);
    process.exitCode = attestation.result.healthVerified ? 0 : 1;
    return;
  }

  if (cmd === "up" && flags["external-health"] !== undefined) {
    const externalHealthUrl = flags["external-health"];
    const incompatibleFlag = ["provider", "unsafe-local", "install", "workspace", "port", "dry-run", "command"]
      .find(flag => flags[flag] !== undefined);
    const timeoutMs = Number(flags.timeout ?? 5000);
    const optionError =
      typeof externalHealthUrl !== "string" || externalHealthUrl.trim().length === 0
        ? "--external-health requires an HTTP or HTTPS URL"
        : incompatibleFlag
          ? `--external-health cannot be combined with --${incompatibleFlag}`
          : !Number.isFinite(timeoutMs) || timeoutMs <= 0
            ? `invalid --timeout value: ${String(flags.timeout)} (expected a positive number)`
            : isRemoteTarget(targetInput)
              ? "--external-health requires a local evidence directory, not a remote repository URL"
              : null;
    if (optionError) {
      if (flags.json) console.log(JSON.stringify(machineFailure(optionError)));
      else bad(optionError);
      process.exitCode = 1;
      return;
    }
    const target = path.resolve(targetInput);
    const evidencePath = ".bootproof/attestation.json";
    const attestation = await buildExternalHealthAttestation(target, externalHealthUrl as string, timeoutMs);
    writeAttestation(target, attestation);
    if (flags.json) console.log(JSON.stringify(externalMachineResult(attestation, evidencePath)));
    else printExternalHealthResult(attestation, evidencePath);
    process.exitCode = attestation.result.healthVerified ? 0 : 1;
    return;
  }

  let target = path.resolve(targetInput);
  let remote: RemoteClone | null = null;
  let remoteSource: string | null = null;
  if (["analyze", "plan", "up", "fix"].includes(cmd) && isRemoteTarget(targetInput)) {
    if (flags["dry-run"]) {
      const explanation = "Remote dry runs are refused because cloning would write files, while BootProof dry runs promise to write nothing.";
      if (flags.json) console.log(JSON.stringify(machineFailure(explanation)));
      else bad(explanation);
      process.exitCode = 1;
      return;
    }
    try {
      remote = cloneRemoteTarget(targetInput, process.cwd());
      target = remote.repoPath;
      remoteSource = remote.canonicalUrl;
      if (!flags.json) {
        console.log(`${DIM}Remote source: ${remote.canonicalUrl}${RESET}`);
        console.log(`${DIM}Clone retained at: ${portableRelative(process.cwd(), remote.repoPath)}${RESET}`);
      }
    } catch (error) {
      const explanation = error instanceof Error ? error.message : String(error);
      if (flags.json) console.log(JSON.stringify(machineFailure(explanation)));
      else bad(explanation);
      process.exitCode = 1;
      return;
    }
  }
  if (!remote && ["analyze", "plan", "up", "fix"].includes(cmd)) {
    remoteSource = managedRemoteSource(target);
    if (remoteSource && !flags.json) {
      console.log(`${DIM}Managed remote source: ${remoteSource}${RESET}`);
    }
  }
  const evidencePath = remote
    ? portableRelative(process.cwd(), attestationPath(target))
    : ".bootproof/attestation.json";

  if (cmd === "analyze") {
    const inf = inferRepo(target, { workspace: flags.workspace as string | undefined });
    if (flags.json) return console.log(JSON.stringify(inf, null, 2));
    return printInference(inf);
  }

  if (cmd === "plan") {
    const inf = inferRepo(target, { workspace: flags.workspace as string | undefined });
    printInference(inf);
    const plan = buildPlan(inf, (flags.provider as "docker" | "local") ?? "docker");
    console.log(`\n${BOLD}Plan (nothing has been executed or written)${RESET}`);
    for (const s of plan.steps) would(s.command ? `${s.description} — ${DIM}${s.command}${RESET}` : s.description);
    for (const f of plan.generatedFiles) would(`generate ${f.path} (${f.purpose})`);
    if (composeFileFor(inf)) console.log(`\n${DIM}--- docker-compose.bootproof.yml (preview) ---\n${composeFileFor(inf)}${RESET}`);
    if (envExampleFor(inf)) console.log(`${DIM}--- .env.bootproof.example (preview) ---\n${envExampleFor(inf)}${RESET}`);
    return;
  }

  if (cmd === "apply-repair") {
    if (isRemoteTarget(targetInput)) {
      const result: RepairApplyResult = {
        schema: "bootproof/repair-apply-result/v1",
        applied: false,
        receiptPath: String(flags.receipt ?? ".bootproof/repair-receipt.json"),
        filesChanged: [],
        explanation: "apply-repair requires a local working tree; use the retained managed clone path for a remote repair",
      };
      if (flags.json) console.log(JSON.stringify(result));
      else printRepairApplyResult(result);
      process.exitCode = 1;
      return;
    }
    if (flags["dry-run"]) {
      const result: RepairApplyResult = {
        schema: "bootproof/repair-apply-result/v1",
        applied: false,
        receiptPath: String(flags.receipt ?? ".bootproof/repair-receipt.json"),
        filesChanged: [],
        explanation: "Dry run — no repair files were applied.",
      };
      if (flags.json) console.log(JSON.stringify(result));
      else printRepairApplyResult(result);
      process.exitCode = 1;
      return;
    }
    const receipt = flags.receipt
      ? path.resolve(String(flags.receipt))
      : path.join(target, ".bootproof", "repair-receipt.json");
    const result = applyVerifiedRepair(target, receipt);
    if (flags.json) console.log(JSON.stringify(result));
    else printRepairApplyResult(result);
    process.exitCode = result.applied ? 0 : 1;
    return;
  }

  if (cmd === "fix") {
    if (flags["dry-run"]) {
      const result: RepairResult = {
        schema: "bootproof/repair-result/v1",
        repaired: false,
        failureClass: null,
        repairId: null,
        receiptPath: null,
        patchPath: null,
        afterAttestationPath: null,
        explanation: "Dry run — nothing was executed, nothing was written, and no repair proof exists.",
      };
      if (flags.json) console.log(JSON.stringify(result));
      else printRepairResult(result);
      process.exitCode = 1;
      return;
    }
    const provider = flags.provider;
    const timeoutMs = Number(flags.timeout ?? 60_000);
    const port = flags.port === undefined ? undefined : Number(flags.port);
    const optionError =
      provider !== undefined && provider !== "docker" && provider !== "local"
        ? `invalid --provider value: ${String(provider)} (expected docker or local)`
        : !Number.isFinite(timeoutMs) || timeoutMs <= 0
          ? `invalid --timeout value: ${String(flags.timeout)} (expected a positive number)`
          : port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)
            ? `invalid --port value: ${String(flags.port)} (expected an integer from 1 to 65535)`
          : null;
    if (optionError) {
      const result: RepairResult = {
        schema: "bootproof/repair-result/v1",
        repaired: false,
        failureClass: null,
        repairId: null,
        receiptPath: null,
        patchPath: null,
        afterAttestationPath: null,
        explanation: optionError,
      };
      if (flags.json) console.log(JSON.stringify(result));
      else printRepairResult(result);
      process.exitCode = 1;
      return;
    }
    const latestCandidate = latestDeterministicRepairCandidate(
      target,
      provider as "docker" | "local" | undefined,
    );
    let actionApproved = false;
    if (latestCandidate && !flags.json) {
      printRepairCandidate(latestCandidate);
    }
    if (
      latestCandidate &&
      latestCandidate.candidate.action.actionType !== "instruction" &&
      !flags.json &&
      !flags.ci
    ) {
      const effectiveProvider = provider ?? latestCandidate.attestation.plan.provider;
      if (effectiveProvider !== "local" || flags["unsafe-local"]) {
        actionApproved = latestCandidate.candidate.action.actionType === "command"
          ? await commandRepairApproval(
              latestCandidate.candidate.action.command!.display,
              latestCandidate.candidate.action.riskLevel,
            )
          : await patchRepairApproval();
      }
    }
    const repairResult = await repairRepo(target, {
      provider: provider as "docker" | "local" | undefined,
      unsafeLocal: Boolean(flags["unsafe-local"]),
      timeoutMs,
      port,
      remoteSource: remoteSource ?? undefined,
      actionApproved,
    });
    const result = remote ? rebaseRemoteRepairPaths(repairResult, target) : repairResult;
    if (flags.json) console.log(JSON.stringify(result));
    else printRepairResult(result);
    process.exitCode = result.repaired ? 0 : 1;
    return;
  }

  if (cmd === "up") {
    const provider = flags.provider ?? "docker";
    const timeoutMs = Number(flags.timeout ?? 60_000);
    const port = flags.port === undefined ? undefined : Number(flags.port);
    const command = flags.command;
    const optionError =
      provider !== "docker" && provider !== "local"
        ? `invalid --provider value: ${String(provider)} (expected docker or local)`
        : !Number.isFinite(timeoutMs) || timeoutMs <= 0
          ? `invalid --timeout value: ${String(flags.timeout)} (expected a positive number)`
          : port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)
            ? `invalid --port value: ${String(flags.port)} (expected an integer from 1 to 65535)`
            : command !== undefined && (typeof command !== "string" || command.trim().length === 0)
              ? "--command requires a non-empty command string"
            : null;
    if (optionError) {
      if (flags.json) console.log(JSON.stringify(machineFailure(optionError)));
      else bad(optionError);
      process.exitCode = 1;
      return;
    }
    const opts: UpOptions = {
      provider: provider as UpOptions["provider"],
      unsafeLocal: Boolean(flags["unsafe-local"]),
      dryRun: Boolean(flags["dry-run"]),
      remoteSource: remoteSource ?? undefined,
      workspace: flags.workspace as string | undefined,
      timeoutMs,
      install: Boolean(flags.install),
      port,
      command: typeof command === "string" ? command : undefined,
    };
    const outcome = await up(target, opts);
    const verified = outcome.attestation?.result.booted === true && outcome.attestation.result.healthVerified === true;
    if (flags.json) {
      console.log(JSON.stringify(machineResult(outcome, evidencePath)));
      if (flags.ci || !opts.dryRun) process.exitCode = verified ? 0 : 1;
      return;
    }
    printInference(outcome.inference);
    console.log("");
    if (outcome.refusal) {
      for (const o of outcome.attestation?.observed ?? []) (o.observation.startsWith("skipped") ? warn : o.ok ? ok : bad)(`${o.id}: ${o.observation}`);
      const diagnosis = diagnoseFailure(
        outcome.refusal.failureClass,
        outcome.attestation?.result.failureEvidence ?? null,
        outcome.refusal.explanation,
        outcome.inference,
      );
      printFailure(outcome.refusal.failureClass, diagnosis, evidencePath);
      process.exitCode = 1;
      return;
    }
    if (opts.dryRun) {
      console.log(`${BOLD}Dry run — nothing was executed, nothing was written, no proof exists.${RESET}`);
      for (const s of outcome.plan.steps) would(s.command ? `${s.description} — ${DIM}${s.command}${RESET}` : s.description);
      for (const f of outcome.plan.generatedFiles) would(`generate ${f.path}`);
      if (flags.ci) process.exitCode = 1;
      return;
    }
    for (const o of outcome.attestation!.observed) (o.observation.startsWith("skipped") ? warn : o.ok ? ok : bad)(`${o.id}: ${o.observation}`);
    const r = outcome.attestation!.result;
    console.log("");
    if (r.healthVerified) {
      ok(`${BOLD}BOOTED${RESET}${GREEN} — ${r.healthObservation} (observed, signed)`);
      console.log(`Evidence: ${evidencePath}`);
    } else {
      const diagnosis = diagnoseFailure(r.failureClass, r.failureEvidence, r.explanation, outcome.inference);
      printFailure(r.failureClass!, diagnosis, evidencePath);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "verify") {
    const p = path.extname(target) === ".json" ? target : attestationPath(target);
    if (!fs.existsSync(p)) { bad(`no proof at ${p} — run bootproof up or bootproof fix first`); process.exitCode = 1; return; }
    const proof: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
    if (isRepairReceipt(proof)) {
      const valid = verifyRepairReceipt(proof);
      (valid ? ok : bad)(`repair receipt signature ${valid ? "valid" : "INVALID"} (ed25519, trust-on-first-use)`);
      const summary = proof.verification && proof.repair
        ? `failure=${proof.verification.before.failureClass} repair=${proof.repair.id} after=${proof.verification.after.healthObservation}`
        : `failure=${proof.beforeFailureClass} repair=${proof.repairId} applied=${proof.applyResult.status} progressed=${proof.progressed} verified=${proof.verified}`;
      console.log(`${DIM}${summary}${RESET}`);
      if (!valid) process.exitCode = 1;
      return;
    }
    const att = proof as Attestation;
    const sig = verifySignature(att);
    (sig ? ok : bad)(`signature ${sig ? "valid" : "INVALID"} (ed25519, trust-on-first-use)`);
    console.log(`Trust level: ${att.trust?.level ?? "legacy_unspecified"}`);
    if (att.verificationMode === "external-health") {
      console.log(`${DIM}attested: classification=${att.classification} bootproofOrchestrated=false at ${att.observedAt ?? att.finishedAt}${RESET}`);
      console.log("This attestation observes an externally managed service; it does not claim BootProof started the application.");
      if (!sig) process.exitCode = 1;
      return;
    }
    console.log(`${DIM}attested: booted=${att.result.booted} at commit ${att.repo.commit ?? "unknown"} on ${att.environment.os} node ${att.environment.node}${RESET}`);
    const retainedRemote = managedRemoteSource(att.repo.path);
    if (retainedRemote) {
      console.log(`Retained remote source: ${retainedRemote}`);
      console.log("Replay requires explicit host execution acknowledgement: bootproof up <clone-path> --provider local --unsafe-local.");
    } else {
      console.log(`Replaying attested plan with bootproof up --provider ${att.plan.provider} would re-verify it on this machine.`);
    }
    if (att.result.booted) {
      const live = await pollHealth(att.plan.healthUrl, 3000);
      if (live.responded) ok(`bonus observation: ${att.plan.healthUrl} is responding right now (HTTP ${live.status})`);
      else console.log(`${DIM}(app not currently running — attestation describes a past verified run)${RESET}`);
    }
    if (!sig) process.exitCode = 1;
    return;
  }

  if (cmd === "registry") {
    const sub = positional[0];
    const repo = path.resolve(String(positional[1] ?? "."));
    if (sub !== "export") {
      bad(`unknown registry subcommand: ${sub ?? "(none)"} — use export`);
      process.exitCode = 1;
      return;
    }
    const requestedMode = String(flags.mode ?? (flags.federated ? "federated_public_candidate" : "local_export"));
    const registryModes: RegistryMode[] = ["local_export", "federated_public_candidate", "cloud_upload_candidate"];
    if (!registryModes.includes(requestedMode as RegistryMode)) {
      bad(`invalid --mode value: ${requestedMode}`);
      process.exitCode = 1;
      return;
    }
    if (flags.federated && requestedMode !== "federated_public_candidate") {
      bad("--federated requires --mode federated_public_candidate when --mode is provided");
      process.exitCode = 1;
      return;
    }
    const entry = registryEntryFor(repo, requestedMode as RegistryMode);
    if (!entry) {
      bad(`no attestation at ${attestationPath(repo)} — run bootproof up first`);
      process.exitCode = 1;
      return;
    }
    if (flags.federated) {
      const receipt = buildFederatedReceipt(entry, { sign: true });
      const output = writeFederatedReceipt(repo, receipt);
      ok(`wrote redacted federated public candidate: ${output}`);
    } else {
      const output = writeRegistryEntry(repo, entry);
      ok(`wrote redacted registry entry: ${output}`);
    }
    console.log(`${DIM}redactions applied: ${entry.redactionsApplied.join(", ")}${RESET}`);
    console.log("Nothing has been uploaded. This export is local and opt-in.");
    if (flags.federated) {
      console.log("Review the receipt before deliberately committing it to the public repository.");
    } else if (requestedMode === "cloud_upload_candidate") {
      console.log("This is only a Cloud upload candidate. BootProof Cloud upload is not implemented here.");
    }
    return;
  }

  if (cmd === "attest") {
    const sub = positional[0];
    const repo = path.resolve(String(positional[1] ?? "."));
    if (sub === "export") {
      const entry = registryEntryFor(repo, "local_export");
      if (!entry) { bad(`no attestation at ${attestationPath(repo)} — run bootproof up first`); process.exitCode = 1; return; }
      const out = writeRegistryEntry(repo, entry);
      ok(`wrote redacted registry entry: ${out}`);
      console.log(`${DIM}redactions applied: ${entry.redactionsApplied.length ? entry.redactionsApplied.join(", ") : "none needed"}${RESET}`);
      console.log(`Nothing has been uploaded. Bootproof never uploads. To share this proof:`);
      console.log(`  1. review the file above — it is exactly what others will see;`);
      console.log(`  2. commit .bootproof/ to your repo (git is the registry), or attach it to a PR/issue.`);
      return;
    }
    if (sub === "check") {
      const ep = registryEntryPath(repo);
      if (!fs.existsSync(ep)) { bad(`no registry entry at ${ep}`); process.exitCode = 1; return; }
      const entry = JSON.parse(fs.readFileSync(ep, "utf8"));
      const valid = verifyRegistryEntry(entry);
      (valid ? ok : bad)(`registry entry signature ${valid ? "valid" : "INVALID"}`);
      console.log(`${DIM}verified=${entry.verified} class=${entry.failureClass ?? "none"} commit=${entry.commitHash?.slice(0, 8) ?? "?"}${RESET}`);
      if (!valid) process.exitCode = 1;
      return;
    }
    bad(`unknown attest subcommand: ${sub ?? "(none)"} — use export or check`);
    process.exitCode = 1;
    return;
  }

  if (cmd === "explain") {
    const p = positional[0] ? path.resolve(positional[0]) : attestationPath(target);
    const proof: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
    if (isRepairReceipt(proof)) {
      const valid = verifyRepairReceipt(proof);
      console.log(`${BOLD}Repair receipt explained${RESET}`);
      console.log(`Signature: ${valid ? "valid" : "INVALID"}`);
      if (!valid) {
        console.log("The receipt has been tampered with or is malformed. Its repair claims are not trusted.");
        process.exitCode = 1;
        return;
      }
      console.log(`Before: NOT VERIFIED — ${proof.beforeFailureClass}.`);
      console.log(`Repair: ${proof.repairId} (${proof.actionType}; scope=${proof.mutationScope}; risk=${proof.riskLevel}).`);
      if (proof.proposedAction.command) console.log(`Command: ${proof.proposedAction.command.display}`);
      if (proof.proposedAction.instruction) console.log(`Instruction: ${proof.proposedAction.instruction}`);
      console.log(`Applied: ${proof.applyResult.status}. Progressed: ${proof.progressed}. Verified: ${proof.verified}.`);
      if (proof.afterFailureClass) console.log(`After failure: ${proof.afterFailureClass}.`);
      console.log(`Description: ${proof.explanation}`);
      if (proof.repair) {
        if (proof.repair.filesChanged.length) console.log(`Files changed in sandbox: ${proof.repair.filesChanged.join(", ")}`);
        if (proof.repair.planDelta) console.log(`Plan delta: ${proof.repair.planDelta}`);
        if (proof.repair.envDelta) console.log(`Environment delta: ${proof.repair.envDelta}`);
      }
      return;
    }
    const att = proof as Attestation;
    console.log(`${BOLD}Attestation explained${RESET}`);
    if (att.verificationMode === "external-health") {
      console.log(att.result.healthVerified
        ? `This externally managed service was VERIFIED: ${att.result.healthObservation}.`
        : `This external health check did NOT verify. Classification: ${att.classification}.`);
      console.log("BootProof did not start or orchestrate this service.");
      console.log(att.result.explanation);
      if (att.plan.healthCandidates?.length) console.log(`Health candidates: ${att.plan.healthCandidates.join(", ")}`);
      for (const o of att.observed) console.log(`  ${o.ok ? "\u2713" : "\u2717"} ${o.id}: ${o.observation}`);
      return;
    }
    console.log(att.result.booted ? `This run BOOTED: ${att.result.healthObservation}.` : `This run did NOT verify. Failure class: ${att.result.failureClass}.`);
    console.log(`Trust level: ${att.trust?.level ?? "legacy_unspecified"}`);
    if (!att.result.booted && att.result.failureClass) {
      const diagnosis = diagnoseFailure(att.result.failureClass, att.result.failureEvidence, att.result.explanation);
      console.log(`What happened: ${diagnosis.whatHappened}`);
      console.log(`Why BootProof refused: ${diagnosis.whyRefused}`);
      console.log(`Safe next step: ${diagnosis.safeNextStep}`);
      console.log(`Evidence: ${p}`);
    } else {
      console.log(att.result.explanation);
    }
    if (att.plan.healthCandidates?.length) console.log(`Health candidates: ${att.plan.healthCandidates.join(", ")}`);
    if (att.result.observedHealthCandidates?.length) console.log(`Observed health candidates: ${att.result.observedHealthCandidates.join(", ")}`);
    for (const o of att.observed) console.log(`  ${o.ok ? "\u2713" : "\u2717"} ${o.id}: ${o.observation}`);
    return;
  }
}

main().catch(err => {
  const argv = process.argv.slice(2);
  if (argv.includes("--json") && (argv[0] === "up" || argv[0] === "verify-url")) {
    console.log(JSON.stringify(machineFailure(String(err?.message ?? err))));
  } else if (argv.includes("--json") && argv[0] === "fix") {
    const result: RepairResult = {
      schema: "bootproof/repair-result/v1",
      repaired: false,
      failureClass: null,
      repairId: null,
      receiptPath: null,
      patchPath: null,
      afterAttestationPath: null,
      explanation: String(err?.message ?? err),
    };
    console.log(JSON.stringify(result));
  } else if (argv.includes("--json") && argv[0] === "apply-repair") {
    const result: RepairApplyResult = {
      schema: "bootproof/repair-apply-result/v1",
      applied: false,
      receiptPath: ".bootproof/repair-receipt.json",
      filesChanged: [],
      explanation: String(err?.message ?? err),
    };
    console.log(JSON.stringify(result));
  } else {
    bad(String(err?.message ?? err));
  }
  process.exitCode = 1;
});
