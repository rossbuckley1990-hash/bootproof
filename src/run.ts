import type { Inference, RunPlan, ObservedStep, FailureClass, Attestation, PreparationCommand } from "./types.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { inferRepo } from "./infer.js";
import { buildPlan, writePlanFiles } from "./plan.js";
import { runToCompletion, superviseApp, pollHealthCandidates, minimalEnv } from "./exec.js";
import { classifyFailure, extractMissingEnvNames } from "./taxonomy.js";
import { buildAttestation, writeAttestation } from "./proof.js";

function classifyHealthFailure(evidence: string): "health_http_error" | "health_check_timeout" {
  if (/(only HTTP 5\d\d observed|HTTP 5\d\d|status\s*5\d\d|returned 5\d\d)/i.test(evidence)) {
    return "health_http_error";
  }
  return "health_check_timeout";
}


export interface UpOptions {
  provider: "docker" | "local";
  unsafeLocal: boolean;
  dryRun: boolean;
  remoteSource?: string;
  workspace?: string;
  timeoutMs: number;
  install: boolean;
  port?: number;
  environment?: Record<string, string>;
  additionalPreparationCommands?: PreparationCommand[];
}

export interface UpOutcome {
  inference: Inference;
  plan: RunPlan;
  attestation: Attestation | null; // null only for dry runs
  refusal: { failureClass: FailureClass; explanation: string } | null;
  writtenFiles: string[];
}

function step(id: string, kind: ObservedStep["kind"], command: string | undefined, startedAt: string, exitCode: number | null, ok: boolean, observation: string, evidenceTail?: string): ObservedStep {
  return { id, kind, command, startedAt, finishedAt: new Date().toISOString(), exitCode, ok, observation, evidenceTail };
}

export function packageManagerVersionMatches(expected: string, actual: string): boolean {
  const expectedMatch = expected.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  const actualMatch = actual.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!expectedMatch || !actualMatch) return true;
  const expectedParts = expectedMatch.slice(1).filter((part): part is string => part !== undefined);
  const actualParts = actualMatch.slice(1, 1 + expectedParts.length);
  return expectedParts.every((part, index) => part === actualParts[index]);
}

function commandUsesExecutable(command: string | undefined, executable: string): boolean {
  if (!command) return false;
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|&&|\\|\\||;)\\s*${escaped}(?:\\s|$)`).test(command);
}

function packageManagerVersionEvidence(inference: Inference, plan: RunPlan, env: NodeJS.ProcessEnv): string | null {
  if (inference.packageManager === "unknown" || !inference.packageManagerVersion) return null;
  if (!plan.steps.some(planned => commandUsesExecutable(planned.command, inference.packageManager))) return null;
  try {
    const actual = process.platform === "win32"
      ? execFileSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", `${inference.packageManager} --version`],
          { cwd: inference.repoPath, encoding: "utf8", env },
        ).trim()
      : execFileSync(inference.packageManager, ["--version"], { cwd: inference.repoPath, encoding: "utf8", env }).trim();
    if (packageManagerVersionMatches(inference.packageManagerVersion, actual)) return null;
    return `packageManager field or engines.${inference.packageManager} expected version: ${inference.packageManagerVersion}\nGot: ${actual}`;
  } catch {
    return null;
  }
}

function commandWithPort(command: string, port: number): string {
  return command
    .replace(/((?:--port(?:=|\s+)|-p\s+))\d{2,5}\b/, `$1${port}`)
    .replace(/(\bmanage\.py\s+runserver\s+(?:127\.0\.0\.1|localhost):)\d{2,5}\b/, `$1${port}`);
}

function unsupportedOrchestrationExplanation(inference: Inference): string | null {
  if (inference.appCommand) return null;
  const sourceComposeServices = inference.composeApplicationServices.filter(service => service.source === "build");
  if (sourceComposeServices.length > 1) {
    return `Detected multiple source-built HTTP services in ${inference.repoComposeFile}: ${sourceComposeServices.map(service => service.name).join(", ")}. BootProof will not treat one responding service as proof that the repository booted. Diagnosis only — no localhost claim.`;
  }
  if (sourceComposeServices.length === 1 && inference.composeHealthCandidates.length === 0) {
    return `Detected source-built service ${sourceComposeServices[0].name} in ${inference.repoComposeFile}, but no unambiguous published HTTP candidate. Diagnosis only — no localhost claim.`;
  }
  const backend = inference.stack.includes("go-backend")
    ? { stack: "go-backend", markers: inference.backendMarkers.filter(marker => marker === "go.mod" || marker === "go.work") }
    : inference.stack.includes("ruby-backend")
      ? { stack: "ruby-backend", markers: inference.backendMarkers.filter(marker => marker === "Gemfile" || marker === "config/database.yml") }
      : inference.stack.includes("make-driven")
        ? { stack: "make-driven", markers: inference.backendMarkers.filter(marker => marker === "Makefile") }
        : null;
  if (!backend) return null;
  const frontendStack = inference.stack.includes("react-frontend")
    ? "react-frontend"
    : inference.stack.includes("node-frontend")
      ? "node-frontend"
      : null;
  const frontendMarker = inference.frontendMarkers.find(marker => marker.endsWith("/package.json"))
    ?? inference.frontendMarkers.find(marker => marker === "package.json");
  const frontend = frontendStack && frontendMarker ? ` with ${frontendStack} (${frontendMarker})` : "";
  return `Detected ${backend.stack} (${backend.markers.join(", ")})${frontend}. BootProof can diagnose this stack but does not yet orchestrate its boot. Diagnosis only — no localhost claim.`;
}

export async function up(repoPath: string, opts: UpOptions): Promise<UpOutcome> {
  const startedAt = new Date().toISOString();
  const inference = inferRepo(repoPath, { workspace: opts.workspace });
  if (opts.additionalPreparationCommands?.length) {
    inference.preparationCommands.push(...opts.additionalPreparationCommands);
    inference.dependencyInstallRequired = true;
  }
  if (opts.port) {
    if (inference.appCommand) {
      inference.port = opts.port;
      inference.portEvidence = "set by --port flag";
      inference.appCommand = commandWithPort(inference.appCommand, opts.port);
      if (inference.backendCommand) inference.backendCommand = commandWithPort(inference.backendCommand, opts.port);
      inference.healthCandidates = inference.healthCandidates.map(candidate => candidate.replace(/:\d{2,5}(?=\/)/, `:${opts.port}`));
    } else if (inference.composeHealthCandidates.length) {
      inference.portEvidence = `repository Compose published port retained; --port ${opts.port} was not applied`;
    }
  }
  const plan = buildPlan(inference, opts.provider);
  const env = minimalEnv({ PORT: String(inference.port), ...opts.environment });
  const runsSourceComposeApplication =
    opts.provider === "docker" &&
    Boolean(inference.repoComposeFile) &&
    inference.composeHealthCandidates.length > 0;
  const base: Omit<UpOutcome, "refusal" | "attestation"> = { inference, plan, writtenFiles: [] };
  const refuse = (
    failureClass: FailureClass,
    explanation: string,
    observed: ObservedStep[] = [],
    failureEvidence: string = explanation,
  ): UpOutcome => {
    const refusal = { failureClass, explanation };
    if (opts.dryRun) return { ...base, attestation: null, refusal };
    const ungeneratedPaths = plan.generatedFiles.map(file => file.path);
    const refusalPlan: RunPlan = {
      ...plan,
      steps: plan.steps.filter(planned => !ungeneratedPaths.some(file => planned.command?.includes(file))),
      generatedFiles: [],
    };
    const attestation = buildAttestation({
      repo: inference.repoPath,
      plan: refusalPlan,
      observed,
      startedAt,
      booted: false,
      healthVerified: false,
      healthObservation: null,
      observedHealthCandidates: [],
      failureClass,
      failureEvidence: failureEvidence.slice(-2000),
      explanation,
    });
    writeAttestation(inference.repoPath, attestation);
    return { inference, plan: refusalPlan, writtenFiles: [], attestation, refusal };
  };

  if (!inference.isApplication) {
    return refuse("not_an_application", inference.notAppReason!);
  }
  if (inference.stack.includes("python-backend") && inference.stack.includes("flask") && inference.setupSteps.length > 0) {
    return refuse(
      "python_flask_setup_required",
      "BootProof detected a Python/Flask + React application with setup steps. This repository requires database migration/init and service orchestration before it can be verified.",
    );
  }
  const orchestrationExplanation = unsupportedOrchestrationExplanation(inference);
  if (orchestrationExplanation && !runsSourceComposeApplication) {
    return refuse("orchestration_not_supported", orchestrationExplanation);
  }
  if (!inference.appCommand && inference.composeHealthCandidates.length > 0 && opts.provider !== "docker") {
    return refuse(
      "orchestration_not_supported",
      `Detected a source-built application in ${inference.repoComposeFile} with published HTTP candidates, but repository Compose requires --provider docker. Diagnosis only — no localhost claim.`,
    );
  }
  if (!opts.workspace && inference.workspaces.length > 1 && !inference.appCommand) {
    return refuse("workspace_ambiguous", `This is a monorepo with ${inference.workspaces.length} workspace candidates. Choose one with --workspace <dir> instead of letting bootproof guess.`);
  }
  if (opts.remoteSource && !opts.dryRun && (opts.provider !== "local" || !opts.unsafeLocal)) {
    return refuse(
      "unknown_failure",
      `BootProof cloned ${opts.remoteSource} for inspection but will not execute remote repository code without --provider local --unsafe-local.`,
    );
  }
  if (opts.provider === "local" && !opts.unsafeLocal) {
    return refuse("unknown_failure", "Local provider runs repository code directly on your machine. Re-run with --unsafe-local to acknowledge this, or use --provider docker.");
  }
  if (opts.dryRun) return { ...base, attestation: null, refusal: null };
  if (inference.multiAppCommand) {
    return refuse(
      "workspace_ambiguous",
      "BootProof detected a root command that starts multiple workspaces in parallel. Choose a specific application with --workspace <dir>; one responding workspace is not proof that the whole repository booted.",
    );
  }
  const preparationSteps = plan.steps.filter(planned => planned.kind === "install" || planned.kind === "build");
  if (preparationSteps.length > 0 && !opts.install) {
    const skipped = step(
      preparationSteps[0].id,
      preparationSteps[0].kind,
      preparationSteps[0].command,
      new Date().toISOString(),
      null,
      false,
      "skipped by default — dependency-backed application was not started; pass --install to run dependency installation",
    );
    return refuse(
      "dependency_install_skipped",
      "The inferred application command depends on project packages, but dependency installation was not requested. BootProof did not start the partial application pipeline.",
      [skipped],
    );
  }
  const hostExecutionSteps = plan.steps.filter(planned =>
    planned.kind === "install" ||
    planned.kind === "build" ||
    planned.kind === "start-app"
  );
  if (opts.provider === "docker" && !runsSourceComposeApplication && hostExecutionSteps.length > 0) {
    return refuse(
      "orchestration_not_supported",
      `Docker provider selected, but the inferred plan contains host commands (${hostExecutionSteps.map(planned => planned.command).filter(Boolean).join("; ")}). BootProof will not silently run them on the host. Use a source-built repository Compose application, or explicitly choose --provider local --unsafe-local after review.`,
    );
  }
  if (opts.install) {
    const versionEvidence = packageManagerVersionEvidence(inference, plan, env);
    if (versionEvidence) {
      const observed = step(
        "package-manager-version",
        "install",
        `${inference.packageManager} --version`,
        new Date().toISOString(),
        0,
        false,
        `declared ${inference.packageManager} ${inference.packageManagerVersion}, but found ${versionEvidence.split("Got: ")[1]}`,
        versionEvidence,
      );
      return refuse(
        "package_manager_version_mismatch",
        "The repository declares a package manager version that does not match the version available in the current environment. Enable Corepack or install the required package manager version before rerunning BootProof.",
        [observed],
        versionEvidence,
      );
    }
  }
  if (inference.incompleteAppCommand) {
    return refuse(
      "unknown_failure",
      "BootProof detected a hybrid backend/frontend repository, but the inferred command starts only the frontend development pipeline. Complete application orchestration is not implemented, so no boot was attempted.",
    );
  }

  const writtenFiles = writePlanFiles(inference, inference.repoPath);
  if (inference.appCommand?.includes(".bootproof/runtime/")) {
    fs.mkdirSync(path.join(inference.repoPath, ".bootproof", "runtime"), { recursive: true });
  }
  const observed: ObservedStep[] = [];
  const explanationWithMissingEnv = (failureClass: FailureClass, evidence: string, explanation: string): string => {
    if (failureClass !== "missing_env_var") return explanation;
    const names = extractMissingEnvNames(evidence);
    if (!names.length) return explanation;
    const generatedExample = path.join(inference.repoPath, ".env.bootproof.example");
    const suffix = fs.existsSync(generatedExample)
      ? `Missing: ${names.join(", ")} — see .env.bootproof.example; bootproof will not invent values.`
      : `Missing: ${names.join(", ")}; bootproof will not invent values.`;
    return `${explanation} ${suffix}`;
  };
  const fail = (failureClass: FailureClass, evidence: string, explanation: string): UpOutcome => {
    const preciseExplanation = explanationWithMissingEnv(failureClass, evidence, explanation);
    const att = buildAttestation({ repo: inference.repoPath, plan, observed, startedAt, booted: false, healthVerified: false, healthObservation: null, observedHealthCandidates: [], failureClass, failureEvidence: evidence.slice(-2000), explanation: preciseExplanation });
    writeAttestation(inference.repoPath, att);
    return { inference, plan, writtenFiles, attestation: att, refusal: null };
  };
  const composeDiagnostics = async (): Promise<string> => {
    if (!inference.repoComposeFile) return "";
    const commands = [
      {
        id: "compose-ps",
        command: `docker compose -f ${inference.repoComposeFile} ps --all`,
        observation: "captured repository Compose service state",
      },
      {
        id: "compose-logs",
        command: `docker compose -f ${inference.repoComposeFile} logs --no-color --tail 200`,
        observation: "captured repository Compose logs",
      },
    ];
    const evidence: string[] = [];
    for (const diagnostic of commands) {
      const t = new Date().toISOString();
      const result = await runToCompletion(diagnostic.command, inference.repoPath, 30_000, env);
      const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
      observed.push(step(
        diagnostic.id,
        "service",
        diagnostic.command,
        t,
        result.exitCode,
        result.exitCode === 0,
        result.exitCode === 0 ? diagnostic.observation : `${diagnostic.observation} failed`,
        text || undefined,
      ));
      if (text) evidence.push(`${diagnostic.command}\n${text}`);
    }
    return evidence.join("\n");
  };

  for (const planned of plan.steps) {
    if (planned.kind === "service" && planned.command) {
      const t = new Date().toISOString();
      const r = await runToCompletion(planned.command, inference.repoPath, 120_000, env);
      const ok = r.exitCode === 0;
      observed.push(step(
        planned.id,
        "service",
        planned.command,
        t,
        r.exitCode,
        ok,
        ok ? "docker compose accepted the start request (exit 0); HTTP health not yet verified" : "docker compose failed",
        r.stderr || r.stdout,
      ));
      if (!ok) {
        const c = classifyFailure(r.stderr + r.stdout);
        return fail(c.class, r.stderr + r.stdout, c.explanation);
      }
    }
    if ((planned.kind === "install" || planned.kind === "build") && planned.command) {
      if (!opts.install) {
        observed.push(step(planned.id, planned.kind, planned.command, new Date().toISOString(), null, false, "skipped by default — preparation was not authorized"));
        continue;
      }
      const t = new Date().toISOString();
      const r = await runToCompletion(planned.command, inference.repoPath, 600_000, env);
      const ok = r.exitCode === 0 && !r.timedOut;
      observed.push(step(
        planned.id,
        planned.kind,
        planned.command,
        t,
        r.exitCode,
        ok,
        ok ? `${planned.kind === "install" ? "dependency preparation" : "build"} completed (exit 0)` : r.timedOut ? `${planned.kind} timed out` : `${planned.kind} failed (exit ${r.exitCode})`,
        ok ? undefined : r.stderr || r.stdout,
      ));
      if (!ok) {
        const c = classifyFailure(r.stderr + r.stdout);
        return fail(c.class === "unknown_failure" ? "install_failed" : c.class, r.stderr + r.stdout, c.explanation);
      }
    }
    if (planned.kind === "start-app" && planned.command) {
      const t = new Date().toISOString();
      const app = superviseApp(planned.command, inference.repoPath, env);
      const health = await pollHealthCandidates(plan.healthCandidates, opts.timeoutMs, app.output);
      plan.healthCandidates = health.candidates;
      if (health.url) plan.healthUrl = health.url;
      const exit = app.exited();
      if (exit && !health.responded) {
        observed.push(step(planned.id, "start-app", planned.command, t, exit.code, false, `app process exited (code ${exit.code}) before responding`, app.output()));
        const c = classifyFailure(app.output());
        await app.stop();
        return fail(c.class === "unknown_failure" ? "app_exited_early" : c.class, app.output(), c.explanation);
      }
      observed.push(step(planned.id, "start-app", planned.command, t, null, true, "app process started and was supervised"));
      const ht = new Date().toISOString();
      if (health.responded && health.status !== null && health.status < 500) {
        const observedUrl = health.url ?? plan.healthUrl;
        observed.push(step("health", "health", undefined, ht, null, true, `observed HTTP ${health.status} at ${observedUrl} after ${health.elapsedMs}ms (${health.attempts} attempts)`));
        await app.stop();
        const att = buildAttestation({ repo: inference.repoPath, plan, observed, startedAt, booted: true, healthVerified: true, healthObservation: `HTTP ${health.status} at ${observedUrl}`, observedHealthCandidates: health.discoveredCandidates, failureClass: null, failureEvidence: null, explanation: `Verified: ${observedUrl} responded HTTP ${health.status}. This attestation records what was observed, not a guarantee the app is fully functional.` });
        writeAttestation(inference.repoPath, att);
        return { inference, plan, writtenFiles, attestation: att, refusal: null };
      }
      const evidence = app.output();
      const healthFailureMessage = health.responded
        ? `only HTTP ${health.status} observed at ${health.url ?? plan.healthUrl}`
        : `no HTTP response at candidates ${health.candidates.join(", ")} within ${opts.timeoutMs}ms`;
      observed.push(step("health", "health", undefined, ht, null, false, healthFailureMessage, evidence));
      const c = classifyFailure(`${healthFailureMessage}\n${evidence}`);
      const healthClass = health.responded && health.status !== null && health.status >= 500
        ? "health_http_error"
        : c.class === "unknown_failure"
          ? classifyHealthFailure(healthFailureMessage)
          : c.class;
      const healthExplanation = healthClass === "health_http_error"
        ? "The app responded on the configured health URL, but returned HTTP 5xx. BootProof observed a running server, but not a verified healthy boot."
        : c.explanation;
      const preciseHealthExplanation = explanationWithMissingEnv(healthClass, `${healthFailureMessage}\n${evidence}`, healthExplanation);
      await app.stop();
      const att = buildAttestation({
        repo: inference.repoPath,
        plan,
        observed,
        startedAt,
        booted: false,
        healthVerified: false,
        healthObservation: null,
        observedHealthCandidates: health.discoveredCandidates,
        failureClass: healthClass,
        failureEvidence: `${healthFailureMessage}\n${evidence}`.slice(-2000),
        explanation: preciseHealthExplanation,
      });
      writeAttestation(inference.repoPath, att);
      return { inference, plan, writtenFiles, attestation: att, refusal: null };
    }
    if (planned.kind === "health" && runsSourceComposeApplication) {
      const ht = new Date().toISOString();
      const health = await pollHealthCandidates(plan.healthCandidates, opts.timeoutMs);
      plan.healthCandidates = health.candidates;
      if (health.url) plan.healthUrl = health.url;
      if (health.responded && health.status !== null && health.status < 500) {
        const observedUrl = health.url ?? plan.healthUrl;
        observed.push(step("health", "health", undefined, ht, null, true, `observed HTTP ${health.status} at ${observedUrl} after ${health.elapsedMs}ms (${health.attempts} attempts)`));
        const att = buildAttestation({
          repo: inference.repoPath,
          plan,
          observed,
          startedAt,
          booted: true,
          healthVerified: true,
          healthObservation: `HTTP ${health.status} at ${observedUrl}`,
          observedHealthCandidates: health.discoveredCandidates,
          failureClass: null,
          failureEvidence: null,
          explanation: `Verified: repository Compose started and ${observedUrl} responded HTTP ${health.status}. This proves the observed web boot, not every service or feature.`,
        });
        writeAttestation(inference.repoPath, att);
        return { inference, plan, writtenFiles, attestation: att, refusal: null };
      }
      const healthFailureMessage = health.responded
        ? `only HTTP ${health.status} observed at ${health.url ?? plan.healthUrl}`
        : `no HTTP response at candidates ${health.candidates.join(", ")} within ${opts.timeoutMs}ms`;
      observed.push(step("health", "health", undefined, ht, null, false, healthFailureMessage));
      const diagnostics = await composeDiagnostics();
      const evidence = [healthFailureMessage, diagnostics].filter(Boolean).join("\n");
      const classified = classifyFailure(evidence);
      const failureClass = health.responded && health.status !== null && health.status >= 500
        ? "health_http_error"
        : classified.class === "unknown_failure"
          ? classifyHealthFailure(healthFailureMessage)
          : classified.class;
      const explanation = failureClass === "health_http_error"
        ? "The Compose application responded on the configured health URL, but returned HTTP 5xx. BootProof observed a server, but not a verified healthy boot."
        : failureClass === "health_check_timeout"
          ? "Repository Compose accepted the start request, but no HTTP response was observed. Compose service state and logs are preserved in the attestation."
          : classified.explanation;
      return fail(failureClass, evidence, explanation);
    }
  }
  return fail("unknown_failure", "", "Inference identified an application, but the plan contained no supported runnable app or source-built Compose health step.");
}
