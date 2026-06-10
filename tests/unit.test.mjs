import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { inferRepo } from "../dist/infer.js";
import { classifyFailure } from "../dist/taxonomy.js";
import { buildPlan, envExampleFor, PROTECTED_ENV } from "../dist/plan.js";
import { buildAttestation, verifySignature } from "../dist/proof.js";
import { extractHealthCandidates } from "../dist/exec.js";
import { packageManagerVersionMatches } from "../dist/run.js";

const FIX = path.resolve("fixtures");

test("infers a runnable node app with evidence", () => {
  const inf = inferRepo(path.join(FIX, "hello-app"));
  assert.equal(inf.isApplication, true);
  assert.equal(inf.appCommand, "npm run start");
  assert.match(inf.appCommandSource, /scripts\.start/);
  assert.equal(inf.port, 3000);
  assert.match(inf.portEvidence, /assumption/, "default port must be labeled as an assumption, not evidence");
});

test("classifies a library as not_an_application instead of pretending", () => {
  const inf = inferRepo(path.join(FIX, "library-only"));
  assert.equal(inf.isApplication, false);
  assert.match(inf.notAppReason, /library|nothing to boot/);
});

test("failure taxonomy classifies real-world evidence strings", () => {
  assert.equal(classifyFailure("error TS: The engine \"node\" is incompatible with this module").class, "runtime_engine_mismatch");
  assert.equal(classifyFailure("sh: yarn: command not found").class, "missing_package_manager");
  assert.equal(classifyFailure("npm ERR! code E401 Unauthorized").class, "private_registry_or_auth");
  assert.equal(classifyFailure("Error: connect ECONNREFUSED 127.0.0.1:5432").class, "database_unreachable");
  assert.equal(classifyFailure("Error: listen EADDRINUSE: address already in use :::3000").class, "port_in_use");
  assert.equal(classifyFailure("Cannot connect to the Docker daemon at unix:///var/run/docker.sock").class, "docker_unavailable");
  assert.equal(classifyFailure("Error: self-signed certificate SELF_SIGNED_CERT_IN_CHAIN").class, "tls_or_proxy_interception");
  assert.equal(classifyFailure(fs.readFileSync(path.join(FIX, "service-port-allocated", "evidence.txt"), "utf8")).class, "service_port_allocated");
  assert.equal(classifyFailure("only HTTP 503 observed at http://localhost:3000/").class, "health_http_error");
  assert.equal(classifyFailure("gibberish nobody has seen").class, "unknown_failure");
});

test("Superset-like repository is recognized as a setup-heavy Python/Flask application", () => {
  const inf = inferRepo(path.join(FIX, "python-flask-superset-like"));
  assert.equal(inf.isApplication, true);
  for (const stack of ["python-backend", "flask", "react-frontend", "docker-compose", "celery"]) {
    assert.ok(inf.stack.includes(stack), `missing stack marker ${stack}`);
  }
  assert.deepEqual(inf.setupSteps, ["superset db upgrade", "superset init"]);
  assert.equal(inf.backendCommand, "flask run -p 8088 --reload --debugger");
  assert.equal(inf.frontendCommand, "cd superset-frontend; npm run dev-server");
  assert.equal(inf.workerCommand, "celery --app=superset.tasks.celery_app:app worker");
  assert.equal(inf.port, 8088);
  assert.deepEqual(inf.healthCandidates, ["http://localhost:8088/"]);
});

test("Grafana-like repository is recognized as a Go/backend + Node/frontend hybrid", () => {
  const inf = inferRepo(path.join(FIX, "go-node-grafana-like"));
  assert.equal(inf.isApplication, true);
  for (const stack of ["go-backend", "node-frontend", "react"]) {
    assert.ok(inf.stack.includes(stack), `missing stack marker ${stack}`);
  }
  assert.equal(inf.packageManager, "yarn");
  assert.match(inf.packageManagerEvidence, /yarn@4\.15\.0/);
  assert.equal(inf.frontendCommand, "yarn dev");
  assert.equal(inf.backendCommand, "make run");
  assert.equal(inf.incompleteAppCommand, true);
  assert.match(inf.commandScope, /frontend\/dev pipeline only/);
  assert.ok(inf.healthCandidates.includes("http://localhost:3000/api/health"));

  const root = inf.workspaces.find(candidate => candidate.dir === ".");
  const productionPackage = inf.workspaces.find(candidate => candidate.dir === "packages/runtime");
  const testPlugin = inf.workspaces.find(candidate => candidate.dir.includes("test-plugins"));
  assert.ok(root && productionPackage && testPlugin);
  assert.ok(root.score > productionPackage.score);
  assert.ok(productionPackage.score > testPlugin.score, "test plugin must rank below production candidates");
});

test("parallel monorepo root commands are not treated as a single application boot", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-parallel-workspaces-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    name: "parallel-root",
    private: true,
    packageManager: "pnpm@10.24.0",
    workspaces: ["apps/*"],
    scripts: { dev: "turbo run dev --parallel" },
    devDependencies: { turbo: "2.0.0" },
  }));
  for (const app of ["studio", "docs"]) {
    fs.mkdirSync(path.join(repo, "apps", app), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps", app, "package.json"), JSON.stringify({
      name: app,
      private: true,
      scripts: { dev: "next dev" },
      dependencies: { next: "15.0.0" },
    }));
  }
  const inf = inferRepo(repo);
  assert.equal(inf.multiAppCommand, true);
  assert.match(inf.commandScope, /multi-workspace/);
  assert.equal(inf.workspaces[0].dir, ".");
});

test("pnpm engine mismatch is classified specifically", () => {
  const evidence = fs.readFileSync(path.join(FIX, "pnpm-version-mismatch", "evidence.txt"), "utf8");
  const result = classifyFailure(evidence);
  assert.equal(result.class, "package_manager_version_mismatch");
  assert.match(result.explanation, /Enable Corepack/);
});

test("package manager version preflight compares only exact declarations conservatively", () => {
  assert.equal(packageManagerVersionMatches("10.24.0", "10.24.0"), true);
  assert.equal(packageManagerVersionMatches("10.24", "10.24.7"), true);
  assert.equal(packageManagerVersionMatches("10.24", "9.15.4"), false);
  assert.equal(packageManagerVersionMatches("^10.24.0", "9.15.4"), true, "ranges are left to the package manager");
});

test("health candidates are extracted from common application log formats", () => {
  assert.deepEqual(
    extractHealthCandidates("Local: http://127.0.0.1:5173/\nserver listening on port 8088\nserver listening on 9090"),
    ["http://127.0.0.1:5173/", "http://localhost:8088/", "http://localhost:9090/"],
  );
});

test("env example never invents secrets", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bp-"));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "x", scripts: { dev: "node s.js" } }));
  fs.writeFileSync(path.join(tmp, ".env.example"), "PORT=4000\nAPI_SECRET=\nDATABASE_URL=\n");
  const inf = inferRepo(tmp);
  const ex = envExampleFor(inf);
  assert.match(ex, /# API_SECRET= \(secret with no safe local default/);
  assert.doesNotMatch(ex, /API_SECRET=[a-zA-Z0-9]/, "must not fabricate a secret value");
});

test("plan never targets protected env files", () => {
  const inf = inferRepo(path.join(FIX, "hello-app"));
  const plan = buildPlan(inf, "docker");
  for (const f of plan.generatedFiles) assert.ok(!PROTECTED_ENV.includes(f.path), `${f.path} is protected`);
});

test("attestation signature verifies and tamper is detected", () => {
  const inf = inferRepo(path.join(FIX, "hello-app"));
  const plan = buildPlan(inf, "local");
  const att = buildAttestation({ repo: inf.repoPath, plan, observed: [], startedAt: new Date().toISOString(), booted: false, healthVerified: false, healthObservation: null, failureClass: "unknown_failure", failureEvidence: "x", explanation: "test" });
  assert.deepEqual(att.trust, { level: "local_developer_signed", signer: "local_ed25519", oidc: null });
  assert.equal(verifySignature(att), true);
  att.result.booted = true; // tamper: claim it booted
  assert.equal(verifySignature(att), false, "a tampered 'booted' claim must fail signature verification");
  att.result.booted = false;
  att.trust.level = "ci_oidc_signed"; // tamper: upgrade local proof to a stronger trust claim
  assert.equal(verifySignature(att), false, "a tampered trust level must fail signature verification");
});

test("redaction masks secrets, urls credentials and home paths", async () => {
  const { redactText } = await import("../dist/redact.js");
  const r = redactText("DATABASE_URL=postgresql://admin:SuperSecret@db:5432/x STRIPE_SECRET_KEY=sk_live_abc123 in /Users/ross/code");
  assert.doesNotMatch(r.text, /SuperSecret|sk_live_abc123|\/Users\/ross/);
  assert.match(r.text, /\[redacted\]/);
  assert.ok(r.applied.length >= 2);
});

test("registry entry: redacted, re-signed, tamper-detectable", async () => {
  const { buildRegistryEntry, verifyRegistryEntry } = await import("../dist/registry.js");
  const inf = inferRepo(path.join(FIX, "hello-app"));
  const plan = buildPlan(inf, "local");
  const att = buildAttestation({ repo: inf.repoPath, plan, observed: [], startedAt: new Date().toISOString(), booted: false, healthVerified: false, healthObservation: null, failureClass: "database_unreachable", failureEvidence: "postgresql://admin:Pw123@host/db refused", explanation: "t" });
  const entry = buildRegistryEntry(att);
  assert.doesNotMatch(JSON.stringify(entry), /Pw123/, "registry entry must not leak credentials");
  assert.equal(verifyRegistryEntry(entry), true);
  entry.result.booted = true;
  assert.equal(verifyRegistryEntry(entry), false, "tampered registry entry must fail verification");
});

test("ported: docker bind path normalization (windows + wsl2 literals)", async () => {
  const { normalizeDockerBindPath } = await import("../dist/platform.js");
  assert.equal(normalizeDockerBindPath("C:\\Users\\Ross\\app", "windows"), "/c/Users/Ross/app");
  assert.equal(normalizeDockerBindPath("/mnt/c/Users/Ross/app", "wsl2"), "/mnt/c/Users/Ross/app");
  assert.equal(normalizeDockerBindPath("/home/ross/app", "linux"), "/home/ross/app");
});

test("ported: postgres auth taxonomy from cal.com lessons", () => {
  assert.equal(classifyFailure("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string").class, "postgres_auth_env_missing");
  assert.equal(classifyFailure("FATAL: password authentication failed for user calendso").class, "postgres_auth_env_missing");
});
