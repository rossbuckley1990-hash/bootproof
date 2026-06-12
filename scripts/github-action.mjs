import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STICKY_MARKER = "<!-- bootproof-action:v1 -->";
const RESULT_SCHEMA = "bootproof/result/v1";
const ATTESTATION_SCHEMA = "bootproof/attestation/v1";
const DIFF_SCHEMA = "bootproof/diff-result/v1";
const AGENT_PLAN_SCHEMA = "bootproof/agent-plan/v1";
const MAX_EVIDENCE_LENGTH = 1200;
const ACTION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function bootproofPackageSpec() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ACTION_ROOT, "package.json"), "utf8"));
  if (manifest.name !== "bootproof" || typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("BootProof action package metadata is invalid");
  }
  return `bootproof@${manifest.version}`;
}

function npxBootproofPrefix() {
  return ["--yes", "--package", bootproofPackageSpec(), "--", "bootproof"];
}

function bootproofExecutable() {
  const bundledCli = path.join(ACTION_ROOT, "dist", "cli.js");
  if (fs.existsSync(bundledCli)) {
    return { command: process.execPath, prefix: [bundledCli], description: "bundled CLI" };
  }
  return { command: "npx", prefix: npxBootproofPrefix(), description: bootproofPackageSpec() };
}

export function parseBoolean(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function normalizeInputs(raw = {}) {
  const inputs = {
    install: parseBoolean(raw.install, "install", true),
    workingDirectory: String(raw.workingDirectory || "."),
    comment: parseBoolean(raw.comment, "comment", true),
    uploadArtifact: parseBoolean(raw.uploadArtifact, "upload-artifact", false),
    diff: parseBoolean(raw.diff, "diff", false),
    baseRef: String(raw.baseRef || ""),
    headRef: String(raw.headRef || ""),
    failOnDrift: parseBoolean(raw.failOnDrift, "fail-on-drift", false),
    failOnUnverified: parseBoolean(raw.failOnUnverified, "fail-on-unverified", true),
    registryExport: parseBoolean(raw.registryExport, "registry-export", false),
    federatedReceipt: parseBoolean(raw.federatedReceipt, "federated-receipt", false),
    cloudUpload: parseBoolean(raw.cloudUpload, "bootproof-cloud-upload", false),
    cloudToken: String(raw.cloudToken || ""),
    agentPlanSummary: parseBoolean(raw.agentPlanSummary, "agent-plan-summary", false),
    githubToken: String(raw.githubToken || ""),
  };
  if (inputs.cloudUpload) {
    throw new Error(
      "BootProof Cloud upload is not implemented in this OSS action. Use a separately configured private Cloud integration.",
    );
  }
  if (inputs.cloudToken) {
    throw new Error(
      "bootproof-cloud-token was provided, but this OSS action does not implement Cloud upload and will not use the token.",
    );
  }
  return inputs;
}

function rawInputs(env) {
  return {
    install: env.BOOTPROOF_ACTION_INSTALL,
    workingDirectory: env.BOOTPROOF_ACTION_WORKING_DIRECTORY,
    comment: env.BOOTPROOF_ACTION_COMMENT,
    uploadArtifact: env.BOOTPROOF_ACTION_UPLOAD_ARTIFACT,
    diff: env.BOOTPROOF_ACTION_DIFF,
    baseRef: env.BOOTPROOF_ACTION_BASE_REF,
    headRef: env.BOOTPROOF_ACTION_HEAD_REF,
    failOnDrift: env.BOOTPROOF_ACTION_FAIL_ON_DRIFT,
    failOnUnverified: env.BOOTPROOF_ACTION_FAIL_ON_UNVERIFIED,
    registryExport: env.BOOTPROOF_ACTION_REGISTRY_EXPORT,
    federatedReceipt: env.BOOTPROOF_ACTION_FEDERATED_RECEIPT,
    cloudUpload: env.BOOTPROOF_ACTION_CLOUD_UPLOAD,
    cloudToken: env.BOOTPROOF_ACTION_CLOUD_TOKEN,
    agentPlanSummary: env.BOOTPROOF_ACTION_AGENT_PLAN_SUMMARY,
    githubToken: env.BOOTPROOF_ACTION_GITHUB_TOKEN,
  };
}

export function resolveWorkingDirectory(workspace, requested) {
  const root = fs.realpathSync(workspace);
  const candidate = fs.realpathSync(path.resolve(root, requested));
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("working-directory must stay inside GITHUB_WORKSPACE");
  }
  return candidate;
}

export function buildUpInvocation(inputs, prefix = npxBootproofPrefix()) {
  return [
    ...prefix,
    "up",
    ".",
    "--ci",
    "--json",
    ...(inputs.install ? ["--install"] : []),
  ];
}

export function resolveDiffRefs(inputs, event = {}, env = {}) {
  let base = inputs.baseRef;
  let head = inputs.headRef;
  if (!base && event.pull_request?.base?.sha) base = String(event.pull_request.base.sha);
  if (!head && event.pull_request?.head?.sha) head = String(event.pull_request.head.sha);
  if (!base && event.before && !/^0+$/.test(String(event.before))) base = String(event.before);
  if (!head && env.GITHUB_SHA) head = String(env.GITHUB_SHA);
  return { base, head };
}

export function buildDiffInvocation(refs, prefix = npxBootproofPrefix()) {
  return [
    ...prefix,
    "diff",
    "--json",
    ...(refs.base ? ["--base", refs.base] : []),
    ...(refs.head ? ["--head", refs.head] : []),
  ];
}

function buildRegistryInvocation(federated, prefix = npxBootproofPrefix()) {
  return [
    ...prefix,
    "registry",
    "export",
    ".",
    "--ci",
    ...(federated ? ["--federated"] : []),
  ];
}

export function buildExecutionEnvironment(env = process.env) {
  const executionEnvironment = {
    ...env,
    CI: "true",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    TERM: "dumb",
    npm_config_yes: "true",
  };
  delete executionEnvironment.BOOTPROOF_ACTION_GITHUB_TOKEN;
  delete executionEnvironment.BOOTPROOF_ACTION_CLOUD_TOKEN;
  return executionEnvironment;
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const executable = windows ? "bash" : command;
    const processArgs = windows
      ? ["-c", 'exec "$@"', "bootproof-action", command, ...args]
      : args;
    const child = spawn(executable, processArgs, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function parseJsonResult(stdout, schema, label) {
  let value;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`${label} did not emit valid JSON`);
  }
  if (!value || typeof value !== "object" || value.schema !== schema) {
    throw new Error(`${label} emitted an unsupported schema`);
  }
  return value;
}

function readJson(file, schema, label) {
  const value = parseJsonResult(fs.readFileSync(file, "utf8"), schema, label);
  return value;
}

function safePathInside(root, requested) {
  const resolved = path.resolve(root, requested);
  const candidate = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  const canonicalRoot = fs.realpathSync(root);
  const relative = path.relative(canonicalRoot, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("BootProof returned an evidence path outside the working directory");
  }
  return candidate;
}

export function redactEvidence(value) {
  let text = String(value || "");
  text = text.replace(
    /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
    "[redacted-private-key]",
  );
  text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]");
  text = text.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1=[redacted]",
  );
  text = text.replace(/\/(?:Users|home)\/[^/\s]+/g, "[home]");
  text = text.replace(/[\u001b\u009b][[\\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
  return text.slice(0, MAX_EVIDENCE_LENGTH);
}

function markdownText(value) {
  return redactEvidence(value)
    .replace(/\\/g, "\\\\")
    .replace(/([`*[\]])/g, "\\$1")
    .replace(/[<>]/g, character => character === "<" ? "&lt;" : "&gt;");
}

function inlineCode(value) {
  return `\`${markdownText(value).replace(/`/g, "\\`")}\``;
}

function duration(attestation) {
  const started = Date.parse(attestation?.startedAt || "");
  const finished = Date.parse(attestation?.finishedAt || "");
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return "unknown";
  return `${((finished - started) / 1000).toFixed(2)}s`;
}

function failureEvidence(attestation, result) {
  const failed = attestation?.observed?.find(step => step?.ok === false);
  return attestation?.result?.failureEvidence
    || failed?.evidenceHead
    || failed?.evidenceTail
    || result?.explanation
    || "No additional evidence was recorded.";
}

function safeNextStep(failureClass) {
  const steps = {
    dependency_install_skipped: "Review the detected install command, then explicitly allow installation and rerun BootProof.",
    health_http_error: "Inspect the application logs and failing health route, then rerun BootProof.",
    health_check_timeout: "Check the reported health candidates and application logs, then rerun with a justified timeout or port.",
    missing_env_var: "Provide the documented local value through the process environment. BootProof will not invent secrets or write protected .env files.",
    orchestration_not_supported: "Follow the repository's documented runbook, then use BootProof external health verification.",
    auth_required: "Provide a separate unauthenticated health endpoint or verify authentication manually without exposing credentials.",
    external_health_unreachable: "Confirm the external service and endpoint are reachable, then rerun external health verification.",
  };
  return steps[failureClass]
    || "Inspect the signed attestation with `bootproof explain .bootproof/attestation.json`, address the reported cause, and rerun BootProof.";
}

function healthDetails(attestation, result) {
  const evidence = attestation?.result?.healthEvidence || {};
  return {
    status: evidence.statusCode ?? attestation?.observedStatus ?? null,
    statusText: evidence.statusText || "",
    url: evidence.requestedUrl || attestation?.externalHealthUrl || attestation?.plan?.healthUrl || "",
    redirect: evidence.redirectLocation || null,
    observation: attestation?.result?.healthObservation || result?.explanation || "",
  };
}

function driftMarkdown(diff) {
  if (!diff?.proofRequired) return [];
  const changed = [
    ...(diff.addedServices || []).map(value => `Added service: ${value}`),
    ...(diff.removedServices || []).map(value => `Removed service: ${value}`),
    ...(diff.addedPorts || []).map(value => `Added port: ${value}`),
    ...(diff.removedPorts || []).map(value => `Removed port: ${value}`),
    ...(diff.addedEnvVars || []).map(value => `Added environment variable: ${value}`),
    ...(diff.removedEnvVars || []).map(value => `Removed environment variable: ${value}`),
  ].slice(0, 12);
  return [
    "",
    "## ⚠️ BootProof: Infrastructure Drift Detected",
    "",
    "This PR changes how the repo boots.",
    "",
    `Risk: ${markdownText(diff.riskLevel || "unknown")}`,
    ...(changed.length ? ["", ...changed.map(value => `- ${markdownText(value)}`)] : []),
  ];
}

function agentPlanMarkdown(plan) {
  if (!plan) return [];
  const order = ["none", "low", "medium", "high", "blocked"];
  const actions = Array.isArray(plan.candidateNextActions) ? plan.candidateNextActions : [];
  const highest = actions.reduce((current, action) => {
    return order.indexOf(action.riskLevel) > order.indexOf(current) ? action.riskLevel : current;
  }, "none");
  const approvals = actions.filter(action => action.requiresApproval === true).length;
  return [
    "",
    "## 🧭 BootProof: Agent Plan Available",
    "",
    "BootProof did not execute actions.",
    "It produced a local plan with approval-required next steps.",
    `Highest Risk: ${markdownText(highest)}`,
    `Approval Required: ${approvals}`,
  ];
}

export function renderComment({ result, attestation = null, diff = null, agentPlan = null, sha = "" }) {
  const lines = [STICKY_MARKER];
  const external = attestation?.verificationMode === "external-health";
  const verified = Boolean(
    attestation
    && result?.healthVerified === true
    && attestation.result?.healthVerified === true
    && (
      (
        result?.booted === true
        && attestation.result?.booted === true
        && attestation.bootproofOrchestrated === true
      )
      || (
        external
        && attestation.bootproofOrchestrated === false
        && attestation.classification === "external_service_verified"
      )
    ),
  );
  const health = healthDetails(attestation, result);

  if (verified && external) {
    lines.push(
      "",
      "## 🥾 BootProof: External Health Verified",
      "",
      "BootProof did not start this service.",
      "It verified an already-running documented environment.",
      `Health URL: ${inlineCode(health.url || "not recorded")}`,
      `Status: ${health.status ?? "unknown"}${health.statusText ? ` ${markdownText(health.statusText)}` : ""}`,
    );
  } else if (verified) {
    lines.push(
      "",
      "## 🥾 BootProof: Verified Boot",
      "",
      "Status: ✅ Success",
      `Commit: ${inlineCode(sha || attestation?.repo?.commit || "unknown")}`,
      `Time to Boot: ${duration(attestation)}`,
      "",
      "### Verification",
      health.status !== null && health.url
        ? `BootProof observed HTTP ${health.status}${health.statusText ? ` ${markdownText(health.statusText)}` : ""} at ${inlineCode(health.url)}.`
        : `BootProof observed verified application health: ${markdownText(health.observation)}`,
    );
    if (health.redirect) {
      lines.push(
        "",
        `HTTP ${health.status} → ${markdownText(health.redirect)} accepted as healthy boot evidence.`,
      );
    }
  } else {
    const failureClass = result?.failureClass || attestation?.result?.failureClass || "unknown_failure";
    const explanation = attestation?.result?.explanation || result?.explanation || "BootProof did not observe verified health.";
    lines.push(
      "",
      "## 🥾 BootProof: Execution Halted",
      "",
      "Status: ❌ Failed to Boot",
      `Failure Class: ${markdownText(failureClass)}`,
      "",
      "### What Happened",
      markdownText(explanation),
      "",
      "### Evidence",
      "```text",
      redactEvidence(failureEvidence(attestation, result)).replace(/```/g, "'''"),
      "```",
      "",
      "### Safe Next Step",
      safeNextStep(failureClass),
    );
  }

  lines.push(...driftMarkdown(diff), ...agentPlanMarkdown(agentPlan));
  return `${lines.join("\n")}\n`;
}

function readEvent(env) {
  if (!env.GITHUB_EVENT_PATH || !fs.existsSync(env.GITHUB_EVENT_PATH)) return {};
  return JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
}

export async function postStickyComment({ markdown, token, event, env, fetchImpl = fetch }) {
  const number = event.pull_request?.number;
  const repository = env.GITHUB_REPOSITORY;
  if (!number || !repository || !token) {
    return { posted: false, url: "", reason: "Pull request context, repository, or comment token is unavailable." };
  }
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) return { posted: false, url: "", reason: "GITHUB_REPOSITORY is invalid." };
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const commentsUrl = `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`;
  const list = await fetchImpl(`${commentsUrl}?per_page=100`, { headers });
  if (!list.ok) {
    return { posted: false, url: "", reason: `GitHub comment lookup returned HTTP ${list.status}.` };
  }
  const comments = await list.json();
  const existing = Array.isArray(comments)
    ? comments.find(comment =>
      typeof comment?.body === "string"
      && comment.body.includes(STICKY_MARKER)
      && comment.user?.login === "github-actions[bot]"
    )
    : null;
  const response = await fetchImpl(
    existing ? `${commentsUrl}/${existing.id}` : commentsUrl,
    {
      method: existing ? "PATCH" : "POST",
      headers,
      body: JSON.stringify({ body: markdown }),
    },
  );
  if (!response.ok) {
    return { posted: false, url: "", reason: `GitHub comment write returned HTTP ${response.status}.` };
  }
  const body = await response.json();
  return { posted: true, url: String(body.html_url || ""), reason: "" };
}

function writeGithubOutput(file, values) {
  if (!file) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, "")}`);
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
}

function copyIfPresent(source, destinationDirectory, destinationName = path.basename(source)) {
  if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) return "";
  const destination = path.join(destinationDirectory, destinationName);
  fs.copyFileSync(source, destination);
  return destination;
}

function safeGeneratedPath(root, requested, label, errors) {
  if (!requested) return "";
  try {
    return safePathInside(root, requested);
  } catch (error) {
    errors.push(`${label}: ${error.message}`);
    return "";
  }
}

function federatedReceipts(repo) {
  const directory = path.join(repo, ".bootproof", "registry");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => name.endsWith(".json"))
    .sort()
    .map(name => path.join(directory, name));
}

function provenance(env) {
  return {
    schema: "bootproof/ci-context/v1",
    repository: env.GITHUB_REPOSITORY || "",
    workflow: env.GITHUB_WORKFLOW || "",
    runId: env.GITHUB_RUN_ID || "",
    runAttempt: env.GITHUB_RUN_ATTEMPT || "",
    sha: env.GITHUB_SHA || "",
    ref: env.GITHUB_REF || "",
    actor: env.GITHUB_ACTOR || "",
    eventName: env.GITHUB_EVENT_NAME || "",
    job: env.GITHUB_JOB || "",
    serverUrl: env.GITHUB_SERVER_URL || "",
    githubActions: env.GITHUB_ACTIONS === "true",
    oidcSigned: false,
  };
}

export async function executeAction({
  inputs,
  env = process.env,
  event = {},
  commandRunner = runProcess,
  fetchImpl = fetch,
}) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const workingDirectory = resolveWorkingDirectory(workspace, inputs.workingDirectory);
  const runnerTemp = env.RUNNER_TEMP || path.join(workspace, ".bootproof", "action-runtime");
  const artifactDirectory = path.join(runnerTemp, "bootproof-artifacts");
  fs.rmSync(artifactDirectory, { recursive: true, force: true });
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const executable = bootproofExecutable();
  const executionEnv = buildExecutionEnvironment(env);
  const calls = [];
  const run = async args => {
    calls.push(["bootproof", ...args.slice(executable.prefix.length)]);
    const completed = await commandRunner(executable.command, args, {
      cwd: workingDirectory,
      env: executionEnv,
    });
    if (completed.stderr) process.stderr.write(redactEvidence(completed.stderr));
    return completed;
  };

  const errors = [];
  const upResult = await run(buildUpInvocation(inputs, executable.prefix));
  let result;
  try {
    result = parseJsonResult(upResult.stdout, RESULT_SCHEMA, "bootproof up");
  } catch (error) {
    errors.push(error.message);
    result = {
      schema: RESULT_SCHEMA,
      booted: false,
      healthVerified: false,
      failureClass: "unknown_failure",
      attestationPath: null,
      explanation: error.message,
    };
  }
  const resultPath = path.join(artifactDirectory, "result.json");
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  let attestation = null;
  let sourceAttestationPath = "";
  if (typeof result.attestationPath === "string" && result.attestationPath) {
    try {
      sourceAttestationPath = safePathInside(workingDirectory, result.attestationPath);
      attestation = readJson(sourceAttestationPath, ATTESTATION_SCHEMA, "BootProof attestation");
    } catch (error) {
      errors.push(error.message);
    }
  }

  let diff = null;
  if (inputs.diff) {
    const refs = resolveDiffRefs(inputs, event, env);
    const diffRun = await run(buildDiffInvocation(refs, executable.prefix));
    try {
      diff = parseJsonResult(diffRun.stdout, DIFF_SCHEMA, "bootproof diff");
      if (diffRun.code !== 0) errors.push(`bootproof diff exited with code ${diffRun.code}`);
    } catch (error) {
      errors.push(error.message);
    }
    if (diff) fs.writeFileSync(path.join(artifactDirectory, "diff-result.json"), `${JSON.stringify(diff, null, 2)}\n`);
  }

  let registryPath = "";
  if (inputs.registryExport) {
    registryPath = path.join(workingDirectory, ".bootproof", "registry-entry.json");
    fs.rmSync(registryPath, { force: true });
    const exported = await run(buildRegistryInvocation(false, executable.prefix));
    if (exported.code !== 0) errors.push(`registry export exited with code ${exported.code}`);
    if (!fs.existsSync(registryPath)) errors.push("registry export did not produce .bootproof/registry-entry.json");
  }

  let federatedPath = "";
  if (inputs.federatedReceipt) {
    const before = new Set(federatedReceipts(workingDirectory));
    const exported = await run(buildRegistryInvocation(true, executable.prefix));
    if (exported.code !== 0) errors.push(`federated receipt export exited with code ${exported.code}`);
    federatedPath = federatedReceipts(workingDirectory)
      .filter(file => !before.has(file))
      .at(-1) || "";
    if (!federatedPath) errors.push("federated receipt export did not produce a receipt");
  }

  let agentPlan = null;
  if (inputs.agentPlanSummary) {
    const requestedPlanPath = path.join(workingDirectory, ".bootproof", "agent-plan.json");
    if (fs.existsSync(requestedPlanPath)) {
      try {
        const planPath = safePathInside(workingDirectory, requestedPlanPath);
        agentPlan = readJson(planPath, AGENT_PLAN_SCHEMA, "BootProof agent plan");
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  const markdown = renderComment({
    result,
    attestation,
    diff,
    agentPlan,
    sha: env.GITHUB_SHA || "",
  });
  const summaryPath = path.join(artifactDirectory, "summary.md");
  fs.writeFileSync(summaryPath, markdown);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);

  let commentUrl = "";
  if (inputs.comment) {
    try {
      const comment = await postStickyComment({
        markdown,
        token: inputs.githubToken,
        event,
        env,
        fetchImpl,
      });
      commentUrl = comment.url;
      if (!comment.posted && event.pull_request?.number) {
        console.warn(`BootProof PR comment skipped: ${comment.reason}`);
      }
    } catch (error) {
      console.warn(`BootProof PR comment skipped: ${redactEvidence(error.message)}`);
    }
  }

  const stagedAttestation = copyIfPresent(sourceAttestationPath, artifactDirectory, "attestation.json");
  copyIfPresent(
    safeGeneratedPath(workingDirectory, registryPath, "registry export", errors),
    artifactDirectory,
    "registry-entry.json",
  );
  copyIfPresent(
    safeGeneratedPath(workingDirectory, federatedPath, "federated receipt", errors),
    artifactDirectory,
    "federated-receipt.json",
  );
  const provenancePath = path.join(artifactDirectory, "ci-context.json");
  fs.writeFileSync(provenancePath, `${JSON.stringify(provenance(env), null, 2)}\n`);

  const external = attestation?.verificationMode === "external-health";
  const verified = Boolean(
    attestation
    && result.healthVerified === true
    && attestation.result?.healthVerified === true
    && (
      (
        result.booted === true
        && attestation.result?.booted === true
        && attestation.bootproofOrchestrated === true
      )
      || (
        external
        && attestation.bootproofOrchestrated === false
        && attestation.classification === "external_service_verified"
      )
    ),
  );
  if (result.healthVerified === true && !attestation) {
    errors.push("bootproof up reported verified health without a readable attestation");
  }
  if (upResult.code === 0 && !verified) errors.push("bootproof up exited zero without verified health evidence");
  if (upResult.code !== 0 && verified) errors.push("bootproof up reported verified health but exited unsuccessfully");
  const driftFailed = inputs.failOnDrift && diff?.proofRequired === true;
  const verificationFailed = inputs.failOnUnverified && !verified;
  const shouldFail = errors.length > 0 || driftFailed || verificationFailed;
  const failureReason = errors[0]
    || (driftFailed ? "BootProof detected infrastructure drift that requires fresh proof." : "")
    || (verificationFailed ? "BootProof did not observe verified boot or external health." : "");
  const verdict = {
    schema: "bootproof/action-verdict/v1",
    verified,
    shouldFail,
    failureReason,
    failureClass: result.failureClass || "",
    bootproofExitCode: upResult.code,
    driftDetected: diff?.proofRequired === true,
    commandsExecuted: calls,
    cloudUploadPerformed: false,
    federatedReceiptCommitted: false,
    agentActionsExecuted: false,
  };
  const verdictPath = path.join(artifactDirectory, "verdict.json");
  fs.writeFileSync(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`);
  return {
    verdict,
    verdictPath,
    artifactDirectory,
    summaryPath,
    stagedAttestation,
    commentUrl,
  };
}

async function main() {
  const env = process.env;
  let outcome;
  try {
    const inputs = normalizeInputs(rawInputs(env));
    outcome = await executeAction({
      inputs,
      env,
      event: readEvent(env),
    });
  } catch (error) {
    const workspace = env.GITHUB_WORKSPACE || process.cwd();
    const runnerTemp = env.RUNNER_TEMP || path.join(workspace, ".bootproof", "action-runtime");
    const artifactDirectory = path.join(runnerTemp, "bootproof-artifacts");
    fs.mkdirSync(artifactDirectory, { recursive: true });
    const message = redactEvidence(error instanceof Error ? error.message : String(error));
    const markdown = `${STICKY_MARKER}\n\n## 🥾 BootProof: Execution Halted\n\nStatus: ❌ Failed to Boot\nFailure Class: action_configuration_error\n\n### What Happened\n${markdownText(message)}\n`;
    const summaryPath = path.join(artifactDirectory, "summary.md");
    fs.writeFileSync(summaryPath, markdown);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
    const verdict = {
      schema: "bootproof/action-verdict/v1",
      verified: false,
      shouldFail: true,
      failureReason: message,
      failureClass: "action_configuration_error",
      bootproofExitCode: null,
      driftDetected: false,
      commandsExecuted: [],
      cloudUploadPerformed: false,
      federatedReceiptCommitted: false,
      agentActionsExecuted: false,
    };
    const verdictPath = path.join(artifactDirectory, "verdict.json");
    fs.writeFileSync(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`);
    outcome = {
      verdict,
      verdictPath,
      artifactDirectory,
      summaryPath,
      stagedAttestation: "",
      commentUrl: "",
    };
  }

  writeGithubOutput(env.GITHUB_OUTPUT, {
    verified: outcome.verdict.verified,
    failure_class: outcome.verdict.failureClass,
    attestation_path: outcome.stagedAttestation,
    artifact_directory: outcome.artifactDirectory,
    summary_path: outcome.summaryPath,
    comment_url: outcome.commentUrl,
    artifact_ready: fs.readdirSync(outcome.artifactDirectory).length > 0,
    verdict_path: outcome.verdictPath,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
