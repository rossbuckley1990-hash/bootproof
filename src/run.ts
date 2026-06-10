import type { Inference, RunPlan, ObservedStep, FailureClass, Attestation } from "./types.js";
import { inferRepo } from "./infer.js";
import { buildPlan, writePlanFiles } from "./plan.js";
import { runToCompletion, superviseApp, pollHealth, minimalEnv } from "./exec.js";
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
  attestation: Attestation | null; // null only for dry runs and pre-execution refusals
  refusal: { failureClass: FailureClass; explanation: string } | null;
  writtenFiles: string[];
}

function step(id: string, kind: ObservedStep["kind"], command: string | undefined, startedAt: string, exitCode: number | null, ok: boolean, observation: string, evidenceTail?: string): ObservedStep {
  return { id, kind, command, startedAt, finishedAt: new Date().toISOString(), exitCode, ok, observation, evidenceTail };
}

export async function up(repoPath: string, opts: UpOptions): Promise<UpOutcome> {
  const inference = inferRepo(repoPath, { workspace: opts.workspace });
  if (opts.port) { inference.port = opts.port; inference.portEvidence = "set by --port flag"; }
  const plan = buildPlan(inference, opts.provider);
  const base: Omit<UpOutcome, "refusal" | "attestation"> = { inference, plan, writtenFiles: [] };

  // Pre-execution refusals: honest, no attestation written because nothing executed.
  if (!inference.isApplication) {
    return { ...base, attestation: null, refusal: { failureClass: "not_an_application", explanation: inference.notAppReason! } };
  }
  if (!opts.workspace && inference.workspaces.length > 1 && !inference.appCommand) {
    return { ...base, attestation: null, refusal: { failureClass: "workspace_ambiguous", explanation: `This is a monorepo with ${inference.workspaces.length} workspace candidates. Choose one with --workspace <dir> instead of letting bootproof guess.` } };
  }
  if (opts.provider === "local" && !opts.unsafeLocal) {
    return { ...base, attestation: null, refusal: { failureClass: "unknown_failure", explanation: "Local provider runs repository code directly on your machine. Re-run with --unsafe-local to acknowledge this, or use --provider docker." } };
  }
  if (opts.dryRun) return { ...base, attestation: null, refusal: null };

  const writtenFiles = writePlanFiles(inference, inference.repoPath);
  const observed: ObservedStep[] = [];
  const startedAt = new Date().toISOString();
  const env = minimalEnv({ PORT: String(inference.port) });
  const fail = (failureClass: FailureClass, evidence: string, explanation: string): UpOutcome => {
    const att = buildAttestation({ repo: inference.repoPath, plan, observed, startedAt, booted: false, healthVerified: false, healthObservation: null, failureClass, failureEvidence: evidence.slice(-2000), explanation });
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
        observed.push(step(planned.id, "install", planned.command, new Date().toISOString(), null, true, "skipped by default — pass --install to run dependency installation"));
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
      const health = await pollHealth(plan.healthUrl, opts.timeoutMs);
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
        observed.push(step("health", "health", undefined, ht, null, true, `observed HTTP ${health.status} at ${plan.healthUrl} after ${health.elapsedMs}ms (${health.attempts} attempts)`));
        await app.stop();
        const att = buildAttestation({ repo: inference.repoPath, plan, observed, startedAt, booted: true, healthVerified: true, healthObservation: `HTTP ${health.status} at ${plan.healthUrl}`, failureClass: null, failureEvidence: null, explanation: `Verified: ${plan.healthUrl} responded HTTP ${health.status}. This attestation records what was observed, not a guarantee the app is fully functional.` });
        writeAttestation(inference.repoPath, att);
        return { inference, plan, writtenFiles, attestation: att, refusal: null };
      }
      const evidence = app.output();
      const healthFailureMessage = health.responded
        ? `only HTTP ${health.status} observed at ${plan.healthUrl}`
        : `no HTTP response at ${plan.healthUrl} within ${opts.timeoutMs}ms`;
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
      return fail(healthClass, `${healthFailureMessage}\n${evidence}`, healthExplanation);
    }
  }
  return fail("not_an_application", "", "Plan contained no runnable app step.");
}
