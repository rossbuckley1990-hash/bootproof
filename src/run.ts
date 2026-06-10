import type { Inference, RunPlan, ObservedStep, FailureClass, Attestation } from "./types.js";
import { execFileSync } from "node:child_process";
import { inferRepo } from "./infer.js";
import { buildPlan, writePlanFiles } from "./plan.js";
import { runToCompletion, superviseApp, pollHealthCandidates, minimalEnv } from "./exec.js";
import { classifyFailure } from "./taxonomy.js";
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
  workspace?: string;
  timeoutMs: number;
  install: boolean;
  port?: number;
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

function packageManagerVersionEvidence(inference: Inference): string | null {
  if (inference.packageManager === "unknown" || !inference.packageManagerVersion) return null;
  try {
    const actual = execFileSync(inference.packageManager, ["--version"], { cwd: inference.repoPath, encoding: "utf8" }).trim();
    if (packageManagerVersionMatches(inference.packageManagerVersion, actual)) return null;
    return `packageManager field or engines.${inference.packageManager} expected version: ${inference.packageManagerVersion}\nGot: ${actual}`;
  } catch {
    return null;
  }
}

export async function up(repoPath: string, opts: UpOptions): Promise<UpOutcome> {
  const startedAt = new Date().toISOString();
  const inference = inferRepo(repoPath, { workspace: opts.workspace });
  if (opts.port) {
    inference.port = opts.port;
    inference.portEvidence = "set by --port flag";
    inference.healthCandidates = inference.healthCandidates.map(candidate => candidate.replace(/:\d{2,5}(?=\/)/, `:${opts.port}`));
  }
  const plan = buildPlan(inference, opts.provider);
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
  if (!opts.workspace && inference.workspaces.length > 1 && !inference.appCommand) {
    return refuse("workspace_ambiguous", `This is a monorepo with ${inference.workspaces.length} workspace candidates. Choose one with --workspace <dir> instead of letting bootproof guess.`);
  }
  if (opts.provider === "local" && !opts.unsafeLocal) {
    return refuse("unknown_failure", "Local provider runs repository code directly on your machine. Re-run with --unsafe-local to acknowledge this, or use --provider docker.");
  }
  if (opts.dryRun) return { ...base, attestation: null, refusal: null };
  if (inference.dependencyInstallRequired && !opts.install) {
    const skipped = step(
      "install",
      "install",
      inference.installCommand ?? undefined,
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
  if (opts.install) {
    const versionEvidence = packageManagerVersionEvidence(inference);
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
  if (inference.multiAppCommand) {
    return refuse(
      "workspace_ambiguous",
      "BootProof detected a root command that starts multiple workspaces in parallel. Choose a specific application with --workspace <dir>; one responding workspace is not proof that the whole repository booted.",
    );
  }
  if (inference.incompleteAppCommand) {
    return refuse(
      "unknown_failure",
      "BootProof detected a hybrid backend/frontend repository, but the inferred command starts only the frontend development pipeline. Complete application orchestration is not implemented, so no boot was attempted.",
    );
  }

  const writtenFiles = writePlanFiles(inference, inference.repoPath);
  const observed: ObservedStep[] = [];
  const env = minimalEnv({ PORT: String(inference.port) });
  const fail = (failureClass: FailureClass, evidence: string, explanation: string): UpOutcome => {
    const att = buildAttestation({ repo: inference.repoPath, plan, observed, startedAt, booted: false, healthVerified: false, healthObservation: null, observedHealthCandidates: [], failureClass, failureEvidence: evidence.slice(-2000), explanation });
    writeAttestation(inference.repoPath, att);
    return { inference, plan, writtenFiles, attestation: att, refusal: null };
  };

  for (const planned of plan.steps) {
    if (planned.kind === "service" && planned.command) {
      const t = new Date().toISOString();
      const r = await runToCompletion(planned.command, inference.repoPath, 120_000, env);
      const ok = r.exitCode === 0;
      observed.push(step(planned.id, "service", planned.command, t, r.exitCode, ok, ok ? "services started (docker compose exit 0)" : "docker compose failed", r.stderr || r.stdout));
      if (!ok) {
        const c = classifyFailure(r.stderr + r.stdout);
        return fail(c.class, r.stderr + r.stdout, c.explanation);
      }
    }
    if (planned.kind === "install" && planned.command) {
      if (!opts.install) {
        observed.push(step(planned.id, "install", planned.command, new Date().toISOString(), null, false, "skipped by default — optional install was not needed for the observed boot"));
        continue;
      }
      const t = new Date().toISOString();
      const r = await runToCompletion(planned.command, inference.repoPath, 600_000, env);
      const ok = r.exitCode === 0 && !r.timedOut;
      observed.push(step(planned.id, "install", planned.command, t, r.exitCode, ok, ok ? "dependencies installed (exit 0)" : r.timedOut ? "install timed out" : `install failed (exit ${r.exitCode})`, ok ? undefined : r.stderr || r.stdout));
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
        explanation: healthExplanation,
      });
      writeAttestation(inference.repoPath, att);
      return { inference, plan, writtenFiles, attestation: att, refusal: null };
    }
  }
  return fail("not_an_application", "", "Plan contained no runnable app step.");
}
