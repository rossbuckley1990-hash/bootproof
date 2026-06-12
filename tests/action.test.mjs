import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  STICKY_MARKER,
  buildExecutionEnvironment,
  buildUpInvocation,
  executeAction,
  normalizeInputs,
  postStickyComment,
  renderComment,
} from "../scripts/github-action.mjs";

function healthEvidence(overrides = {}) {
  return {
    requestedUrl: "http://localhost:3000/",
    statusCode: 200,
    statusText: "OK",
    headers: { "content-type": "text/plain" },
    redirectLocation: null,
    bodyExcerpt: "healthy",
    timestamp: "2026-06-12T10:00:01.000Z",
    acceptedAsHealthy: true,
    connectionError: null,
    ...overrides,
  };
}

function attestation(overrides = {}) {
  return {
    schema: "bootproof/attestation/v1",
    verificationMode: "bootproof-orchestrated",
    bootproofOrchestrated: true,
    externalHealthUrl: null,
    observedStatus: null,
    observedFinalUrl: null,
    observedAt: null,
    responseSnippet: "",
    classification: null,
    repo: { path: "/workspace", remote: null, commit: "abc123", dirty: false },
    environment: { os: "linux", arch: "x64", node: "v22.0.0" },
    trust: { level: "local_developer_signed", signer: "local_ed25519", oidc: null },
    plan: {
      provider: "docker",
      steps: [],
      healthUrl: "http://localhost:3000/",
      healthCandidates: ["http://localhost:3000/"],
      generatedFiles: [],
    },
    observed: [],
    result: {
      booted: true,
      healthVerified: true,
      healthObservation: "HTTP 200 OK at http://localhost:3000/",
      healthEvidence: healthEvidence(),
      observedHealthCandidates: ["http://localhost:3000/"],
      failureClass: null,
      failureEvidence: null,
      explanation: "Observed healthy HTTP response.",
    },
    startedAt: "2026-06-12T10:00:00.000Z",
    finishedAt: "2026-06-12T10:00:01.250Z",
    signer: null,
    signature: null,
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    schema: "bootproof/result/v1",
    booted: true,
    healthVerified: true,
    failureClass: null,
    attestationPath: ".bootproof/attestation.json",
    explanation: "Observed healthy HTTP response.",
    ...overrides,
  };
}

test("GitHub Action comment markdown reports verified boot and redirect evidence", () => {
  const proof = attestation({
    result: {
      ...attestation().result,
      healthObservation: "HTTP 302 Found at http://localhost:3000/",
      healthEvidence: healthEvidence({
        statusCode: 302,
        statusText: "Found",
        redirectLocation: "/users/sign_in",
      }),
    },
  });
  const markdown = renderComment({ result: result(), attestation: proof, sha: "abc123" });
  assert.match(markdown, /🥾 BootProof: Verified Boot/);
  assert.match(markdown, /Status: ✅ Success/);
  assert.match(markdown, /Commit: `abc123`/);
  assert.match(markdown, /Time to Boot: 1\.25s/);
  assert.match(markdown, /BootProof observed HTTP 302 Found/);
  assert.match(markdown, /HTTP 302 → \/users\/sign_in accepted as healthy boot evidence\./);
  assert.ok(markdown.startsWith(STICKY_MARKER));
});

test("GitHub Action comment markdown reports honest redacted failure", () => {
  const proof = attestation({
    observed: [{
      id: "start-app",
      ok: false,
      evidenceHead: "API_TOKEN=should-not-leak\nError: application exited",
    }],
    result: {
      ...attestation().result,
      booted: false,
      healthVerified: false,
      healthObservation: null,
      healthEvidence: null,
      failureClass: "app_exited_early",
      failureEvidence: "API_TOKEN=should-not-leak\nError: application exited",
      explanation: "The application exited before health was observed.",
    },
  });
  const markdown = renderComment({
    result: result({
      booted: false,
      healthVerified: false,
      failureClass: "app_exited_early",
    }),
    attestation: proof,
  });
  assert.match(markdown, /🥾 BootProof: Execution Halted/);
  assert.match(markdown, /Status: ❌ Failed to Boot/);
  assert.match(markdown, /Failure Class: app_exited_early/);
  assert.match(markdown, /What Happened/);
  assert.match(markdown, /Evidence/);
  assert.match(markdown, /Safe Next Step/);
  assert.match(markdown, /API_TOKEN=\[redacted\]/);
  assert.doesNotMatch(markdown, /should-not-leak/);
});

test("GitHub Action comment markdown includes infrastructure drift", () => {
  const markdown = renderComment({
    result: result(),
    attestation: attestation(),
    diff: {
      schema: "bootproof/diff-result/v1",
      riskLevel: "high",
      proofRequired: true,
      addedServices: ["docker-compose.yml:worker"],
      removedServices: [],
      addedPorts: ["docker-compose.yml:worker:5000->5000/tcp"],
      removedPorts: [],
      addedEnvVars: ["WORKER_URL"],
      removedEnvVars: [],
    },
  });
  assert.match(markdown, /⚠️ BootProof: Infrastructure Drift Detected/);
  assert.match(markdown, /This PR changes how the repo boots\./);
  assert.match(markdown, /Risk: high/);
});

test("GitHub Action comment markdown distinguishes external health verification", () => {
  const proof = attestation({
    verificationMode: "external-health",
    bootproofOrchestrated: false,
    externalHealthUrl: "http://localhost:8001/api/v1/health",
    observedStatus: 200,
    observedFinalUrl: "http://localhost:8001/api/v1/health",
    classification: "external_service_verified",
    result: {
      ...attestation().result,
      booted: false,
      healthEvidence: healthEvidence({
        requestedUrl: "http://localhost:8001/api/v1/health",
      }),
      explanation: "BootProof did not start or orchestrate this service.",
    },
  });
  const markdown = renderComment({
    result: result({
      booted: false,
      verificationMode: "external-health",
      classification: "external_service_verified",
    }),
    attestation: proof,
  });
  assert.match(markdown, /🥾 BootProof: External Health Verified/);
  assert.match(markdown, /BootProof did not start this service\./);
  assert.match(markdown, /already-running documented environment/);
  assert.match(markdown, /localhost:8001\/api\/v1\/health/);
});

test("GitHub Action comment markdown summarises an existing agent plan without execution", () => {
  const markdown = renderComment({
    result: result(),
    attestation: attestation(),
    agentPlan: {
      schema: "bootproof/agent-plan/v1",
      candidateNextActions: [
        { riskLevel: "medium", requiresApproval: true },
        { riskLevel: "high", requiresApproval: true },
        { riskLevel: "none", requiresApproval: false },
      ],
    },
  });
  assert.match(markdown, /🧭 BootProof: Agent Plan Available/);
  assert.match(markdown, /BootProof did not execute actions\./);
  assert.match(markdown, /Highest Risk: high/);
  assert.match(markdown, /Approval Required: 2/);
});

test("GitHub Action defaults keep registry, federated, artifact, and Cloud upload disabled", () => {
  const inputs = normalizeInputs();
  assert.equal(inputs.registryExport, false);
  assert.equal(inputs.federatedReceipt, false);
  assert.equal(inputs.uploadArtifact, false);
  assert.equal(inputs.cloudUpload, false);
  assert.equal(inputs.cloudToken, "");
  assert.throws(
    () => normalizeInputs({ cloudUpload: "true" }),
    /Cloud upload is not implemented/,
  );
  assert.throws(
    () => normalizeInputs({ cloudToken: "must-not-be-used" }),
    /will not use the token/,
  );
});

test("GitHub Action never renders a green result without a readable attestation", () => {
  const markdown = renderComment({ result: result(), attestation: null });
  assert.match(markdown, /Execution Halted/);
  assert.doesNotMatch(markdown, /Verified Boot/);
});

test("GitHub Action CI invocation is non-interactive and preserves the zero-AI boundary", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bp-action-"));
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "bp-action-runner-"));
  try {
    fs.mkdirSync(path.join(workspace, ".bootproof"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".bootproof", "attestation.json"),
      `${JSON.stringify(attestation(), null, 2)}\n`,
    );
    const calls = [];
    const commandRunner = async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return { code: 0, stdout: JSON.stringify(result()), stderr: "" };
    };
    const outcome = await executeAction({
      inputs: normalizeInputs({ comment: "false" }),
      env: {
        ...process.env,
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: "abc123",
        BOOTPROOF_ACTION_GITHUB_TOKEN: "comment-token-must-not-reach-repo-code",
        BOOTPROOF_ACTION_CLOUD_TOKEN: "cloud-token-must-not-reach-repo-code",
      },
      commandRunner,
    });

    assert.equal(outcome.verdict.verified, true);
    assert.equal(fs.existsSync(outcome.stagedAttestation), true);
    assert.deepEqual(
      calls[0].args.slice(-5),
      ["up", ".", "--ci", "--json", "--install"],
    );
    assert.deepEqual(
      buildUpInvocation(normalizeInputs()).slice(0, 5),
      ["--yes", "--package", "bootproof@0.3.0", "--", "bootproof"],
    );
    assert.ok(calls[0].args.includes("--ci"));
    assert.ok(calls[0].args.includes("--json"));
    assert.ok(calls[0].args.includes("--install"));
    assert.equal(calls[0].env.CI, "true");
    assert.equal(calls[0].env.NO_COLOR, "1");
    assert.equal(calls[0].env.FORCE_COLOR, "0");
    assert.equal(calls[0].env.npm_config_yes, "true");
    assert.equal(calls[0].env.BOOTPROOF_ACTION_GITHUB_TOKEN, undefined);
    assert.equal(calls[0].env.BOOTPROOF_ACTION_CLOUD_TOKEN, undefined);
    assert.equal(calls.some(call => call.args.includes("plan-agent")), false);
    assert.equal(calls.some(call => call.args.includes("fix")), false);
    assert.equal(calls.some(call => call.args.includes("apply-repair")), false);
    assert.equal(calls.some(call => call.command === "git" || call.args.includes("commit")), false);
    assert.equal(outcome.verdict.agentActionsExecuted, false);
    assert.equal(outcome.verdict.federatedReceiptCommitted, false);
    assert.equal(outcome.verdict.cloudUploadPerformed, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("GitHub Action execution environment disables colour and prompts", () => {
  const env = buildExecutionEnvironment({
    PATH: "/test/bin",
    BOOTPROOF_ACTION_GITHUB_TOKEN: "comment-token",
    BOOTPROOF_ACTION_CLOUD_TOKEN: "cloud-token",
  });
  assert.equal(env.PATH, "/test/bin");
  assert.equal(env.CI, "true");
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.FORCE_COLOR, "0");
  assert.equal(env.npm_config_yes, "true");
  assert.equal(env.BOOTPROOF_ACTION_GITHUB_TOKEN, undefined);
  assert.equal(env.BOOTPROOF_ACTION_CLOUD_TOKEN, undefined);
});

test("optional diff and registry artifacts use only deterministic CLI commands", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bp-action-options-"));
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "bp-action-options-runner-"));
  try {
    fs.mkdirSync(path.join(workspace, ".bootproof"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".bootproof", "attestation.json"),
      `${JSON.stringify(attestation(), null, 2)}\n`,
    );
    const calls = [];
    const commandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes("diff")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            schema: "bootproof/diff-result/v1",
            base: "base",
            head: "head",
            changedFiles: ["package.json"],
            addedServices: [],
            removedServices: [],
            addedPorts: [],
            removedPorts: [],
            addedEnvVars: [],
            removedEnvVars: [],
            changedCommands: [],
            changedPackageManagers: [],
            riskLevel: "medium",
            proofRequired: true,
            suggestedReviewNotes: [],
            redactionsApplied: [],
          }),
          stderr: "",
        };
      }
      if (args.includes("registry")) {
        if (args.includes("--federated")) {
          const directory = path.join(workspace, ".bootproof", "registry");
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, "receipt.json"), '{"schema":"bootproof/federated-receipt/v1"}\n');
        } else {
          fs.writeFileSync(
            path.join(workspace, ".bootproof", "registry-entry.json"),
            '{"schema":"bootproof/registry-entry/v1"}\n',
          );
        }
        return { code: 0, stdout: "Nothing has been uploaded.\n", stderr: "" };
      }
      return { code: 0, stdout: JSON.stringify(result()), stderr: "" };
    };
    const outcome = await executeAction({
      inputs: normalizeInputs({
        comment: "false",
        diff: "true",
        baseRef: "base",
        headRef: "head",
        registryExport: "true",
        federatedReceipt: "true",
      }),
      env: {
        ...process.env,
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: "head",
      },
      commandRunner,
    });

    assert.equal(fs.existsSync(path.join(outcome.artifactDirectory, "diff-result.json")), true);
    assert.equal(fs.existsSync(path.join(outcome.artifactDirectory, "registry-entry.json")), true);
    assert.equal(fs.existsSync(path.join(outcome.artifactDirectory, "federated-receipt.json")), true);
    assert.equal(calls.some(call => call.includes("diff")), true);
    assert.equal(calls.filter(call => call.includes("registry")).length, 2);
    assert.equal(calls.some(call => call.includes("commit") || call.includes("push")), false);
    assert.equal(calls.some(call => call.includes("plan-agent") || call.includes("fix")), false);
    assert.equal(outcome.verdict.driftDetected, true);
    assert.equal(outcome.verdict.shouldFail, false, "drift is informational unless fail-on-drift is enabled");
    assert.equal(outcome.verdict.federatedReceiptCommitted, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("sticky pull request comment updates the existing BootProof bot comment", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (!options.method) {
      return new Response(JSON.stringify([{
        id: 42,
        body: `${STICKY_MARKER}\nold`,
        user: { type: "Bot", login: "github-actions[bot]" },
      }]), { status: 200 });
    }
    return new Response(JSON.stringify({ html_url: "https://github.com/bootproof/bootproof/pull/1#issuecomment-42" }), {
      status: 200,
    });
  };
  const posted = await postStickyComment({
    markdown: `${STICKY_MARKER}\nnew`,
    token: "test-token",
    event: { pull_request: { number: 1 } },
    env: {
      GITHUB_REPOSITORY: "bootproof/bootproof",
      GITHUB_API_URL: "https://api.github.test",
    },
    fetchImpl,
  });
  assert.equal(posted.posted, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.method, "PATCH");
  assert.match(requests[1].url, /comments\/42$/);
});

test("action metadata makes evidence upload explicit and never invokes agent execution", () => {
  const metadata = fs.readFileSync(path.resolve("action.yml"), "utf8");
  assert.match(metadata, /upload-artifact:[\s\S]*default: "false"/);
  assert.match(
    metadata,
    /uses: actions\/upload-artifact@[0-9a-f]{40} # v4/,
  );
  assert.match(metadata, /scripts\/github-action\.mjs/);
  assert.doesNotMatch(metadata, /plan-agent|apply-repair|bootproof fix/);
  assert.doesNotMatch(metadata, /git commit|git push/);
});

test("GitHub Action verdict and CI context schemas are strict", () => {
  for (const [file, schema] of [
    ["action-verdict-v1.schema.json", "bootproof/action-verdict/v1"],
    ["ci-context-v1.schema.json", "bootproof/ci-context/v1"],
  ]) {
    const document = JSON.parse(
      fs.readFileSync(path.resolve("docs", "schemas", file), "utf8"),
    );
    assert.equal(document.type, "object");
    assert.equal(document.additionalProperties, false);
    assert.equal(document.properties.schema.const, schema);
  }
});
