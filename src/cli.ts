#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { inferRepo } from "./infer.js";
import { buildPlan, composeFileFor, envExampleFor } from "./plan.js";
import { up, type UpOptions, type UpOutcome } from "./run.js";
import { verifySignature, attestationPath, TOOL_ID } from "./proof.js";
import { pollHealth } from "./exec.js";
import { buildRegistryEntry, verifyRegistryEntry, writeRegistryEntry, registryEntryPath } from "./registry.js";
import { normalizeDockerBindPath, detectHostPlatform } from "./platform.js";
import { diagnoseFailure, type FailureDiagnosis } from "./diagnosis.js";
import { cloneGithubRemote, isRemoteTarget, managedRemoteSource, type RemoteClone } from "./remote.js";
import { repairRepo, verifyRepairReceipt, type RepairReceipt, type RepairResult } from "./repair.js";
import type { Attestation } from "./types.js";

let GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RESET = "\x1b[0m";
const ok = (s: string) => console.log(`${GREEN}\u2713 ${s}${RESET}`);
const would = (s: string) => console.log(`${DIM}\u25cb would: ${s}${RESET}`);
const warn = (s: string) => console.log(`${YELLOW}! ${s}${RESET}`);
const bad = (s: string) => console.log(`${RED}\u2717 ${s}${RESET}`);
const disableColor = () => { GREEN = ""; YELLOW = ""; RED = ""; DIM = ""; BOLD = ""; RESET = ""; };
const portableRelative = (from: string, to: string) => path.relative(from, to).replace(/\\/g, "/");

const COMMANDS = ["up", "fix", "analyze", "plan", "verify", "explain", "attest", "help", "version", "--help", "-h", "--version"];
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
  bootproof analyze <path|github-url> [--workspace dir] [--json]
                                                            inspect a repo, show evidence-based inference
  bootproof plan <path|github-url> [--workspace dir]        show the run plan and files that WOULD be generated
  bootproof up <path|github-url> [options]                  execute the plan, verify localhost, write signed proof
  bootproof fix <path> [options]                            test a deterministic repair in a sandbox
  bootproof verify <path|proof.json>                        validate an attestation or repair-receipt signature
  bootproof explain <proof.json>                            explain an attestation or repair receipt
  bootproof attest export <path>                        redacted, re-signed shareable registry entry (never uploads)
  bootproof attest check <path>                         verify a registry entry signature
  bootproof version

Options for up:
  --provider docker|local   execution provider (default docker)
  --unsafe-local            required acknowledgement for --provider local
  --install                 run the dependency install step (off by default)
  --workspace <dir>         pick a monorepo workspace
  --port <n>                override inferred port
  --timeout <ms>            health verification timeout (default 60000)
  --dry-run                 show what would happen; executes nothing, writes nothing
  --json                    one bootproof/result/v1 JSON object on stdout
  --ci                      no prompts, colours, or interactive UI; fail closed

Options for fix:
  --provider docker|local   execution provider (default docker)
  --unsafe-local            required acknowledgement for local sandbox execution
  --timeout <ms>            before/after health timeout (default 60000)
  --dry-run                 execute nothing, write nothing, produce no repair proof
  --json                    one bootproof/repair-result/v1 object on stdout

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
  const targetInput = String(positional[0] ?? ".");
  let target = path.resolve(targetInput);
  let remote: RemoteClone | null = null;
  let remoteSource: string | null = null;
  if (["analyze", "plan", "up"].includes(cmd) && isRemoteTarget(targetInput)) {
    if (flags["dry-run"]) {
      const explanation = "Remote dry runs are refused because cloning would write files, while BootProof dry runs promise to write nothing.";
      if (flags.json) console.log(JSON.stringify(machineFailure(explanation)));
      else bad(explanation);
      process.exitCode = 1;
      return;
    }
    try {
      remote = cloneGithubRemote(targetInput, process.cwd());
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
  if (!remote && ["analyze", "plan", "up"].includes(cmd)) {
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

  if (cmd === "fix") {
    if (isRemoteTarget(targetInput)) {
      const result: RepairResult = {
        schema: "bootproof/repair-result/v1",
        repaired: false,
        failureClass: null,
        repairId: null,
        receiptPath: null,
        patchPath: null,
        afterAttestationPath: null,
        explanation: "bootproof fix accepts a local repository path; remote repair execution is not implemented",
      };
      if (flags.json) console.log(JSON.stringify(result));
      else printRepairResult(result);
      process.exitCode = 1;
      return;
    }
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
    const optionError =
      provider !== undefined && provider !== "docker" && provider !== "local"
        ? `invalid --provider value: ${String(provider)} (expected docker or local)`
        : !Number.isFinite(timeoutMs) || timeoutMs <= 0
          ? `invalid --timeout value: ${String(flags.timeout)} (expected a positive number)`
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
    const result = await repairRepo(target, {
      provider: provider as "docker" | "local" | undefined,
      unsafeLocal: Boolean(flags["unsafe-local"]),
      timeoutMs,
    });
    if (flags.json) console.log(JSON.stringify(result));
    else printRepairResult(result);
    process.exitCode = result.repaired ? 0 : 1;
    return;
  }

  if (cmd === "up") {
    const provider = flags.provider ?? "docker";
    const timeoutMs = Number(flags.timeout ?? 60_000);
    const port = flags.port === undefined ? undefined : Number(flags.port);
    const optionError =
      provider !== "docker" && provider !== "local"
        ? `invalid --provider value: ${String(provider)} (expected docker or local)`
        : !Number.isFinite(timeoutMs) || timeoutMs <= 0
          ? `invalid --timeout value: ${String(flags.timeout)} (expected a positive number)`
          : port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)
            ? `invalid --port value: ${String(flags.port)} (expected an integer from 1 to 65535)`
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
      console.log(`${DIM}failure=${proof.verification.before.failureClass} repair=${proof.repair.id} after=${proof.verification.after.healthObservation}${RESET}`);
      if (!valid) process.exitCode = 1;
      return;
    }
    const att = proof as Attestation;
    const sig = verifySignature(att);
    (sig ? ok : bad)(`signature ${sig ? "valid" : "INVALID"} (ed25519, trust-on-first-use)`);
    console.log(`Trust level: ${att.trust?.level ?? "legacy_unspecified"}`);
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

  if (cmd === "attest") {
    const sub = positional[0];
    const repo = path.resolve(String(positional[1] ?? "."));
    if (sub === "export") {
      const ap = attestationPath(repo);
      if (!fs.existsSync(ap)) { bad(`no attestation at ${ap} — run bootproof up first`); process.exitCode = 1; return; }
      const att: Attestation = JSON.parse(fs.readFileSync(ap, "utf8"));
      const entry = buildRegistryEntry(att);
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
      console.log(`${DIM}booted=${entry.result.booted} class=${entry.result.failureClass ?? "none"} commit=${entry.repo.commit?.slice(0, 8) ?? "?"}${RESET}`);
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
      console.log(`Before: NOT VERIFIED — ${proof.verification.before.failureClass}.`);
      console.log(`Repair: ${proof.repair.id} (${proof.repair.kind}).`);
      console.log(`After: BOOTED — ${proof.verification.after.healthObservation}.`);
      console.log(`Description: ${proof.repair.description}`);
      if (proof.repair.filesChanged.length) console.log(`Files changed in sandbox: ${proof.repair.filesChanged.join(", ")}`);
      if (proof.repair.planDelta) console.log(`Plan delta: ${proof.repair.planDelta}`);
      if (proof.repair.envDelta) console.log(`Environment delta: ${proof.repair.envDelta}`);
      return;
    }
    const att = proof as Attestation;
    console.log(`${BOLD}Attestation explained${RESET}`);
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
  if (argv.includes("--json") && argv[0] === "up") {
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
  } else {
    bad(String(err?.message ?? err));
  }
  process.exitCode = 1;
});
