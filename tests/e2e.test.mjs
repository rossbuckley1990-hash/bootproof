import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";

const CLI = path.resolve("dist/cli.js");
const FIX = path.resolve("fixtures");
const REAL_GIT = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" })
  .trim()
  .split(/\r?\n/)[0];
const run = (args, allowFail = false, env = {}, cwd = process.cwd()) => {
  try { return { out: execFileSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env }, cwd }), code: 0 }; }
  catch (e) { if (!allowFail) throw e; return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 }; }
};

function freshCopy(name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bp-e2e-"));
  fs.cpSync(path.join(FIX, name), tmp, { recursive: true });
  return tmp;
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function fakeGithubRemote(fixture) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bp-remote-cwd-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "bp-remote-bin-"));
  const driver = path.join(bin, "fake-git.cjs");
  fs.writeFileSync(driver, `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const realGit = process.env.BOOTPROOF_REAL_GIT;
if (args[0] === "clone") {
  const remote = args.at(-2);
  const destination = args.at(-1);
  fs.cpSync(process.env.BOOTPROOF_FAKE_REMOTE, destination, { recursive: true });
  const commands = [
    ["init", "-q"],
    ["config", "user.name", "BootProof Test"],
    ["config", "user.email", "bootproof@example.invalid"],
    ["config", "commit.gpgsign", "false"],
    ["add", "."],
    ["commit", "-q", "-m", "fixture"],
    ["remote", "add", "origin", remote],
  ];
  for (const command of commands) {
    const result = spawnSync(realGit, ["-C", destination, ...command], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}
const result = spawnSync(realGit, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "git.cmd"), `@node "%~dp0\\fake-git.cjs" %*\r\n`);
  } else {
    const fakeGit = path.join(bin, "git");
    fs.writeFileSync(fakeGit, `#!/bin/sh\nexec node "$(dirname "$0")/fake-git.cjs" "$@"\n`);
    fs.chmodSync(fakeGit, 0o755);
  }
  return {
    cwd,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      BOOTPROOF_REAL_GIT: REAL_GIT,
      BOOTPROOF_FAKE_REMOTE: path.join(FIX, fixture),
    },
  };
}

test("honesty: dry run prints 'would', never a green check, writes nothing", () => {
  const repo = freshCopy("hello-app");
  const { out } = run(["up", repo, "--provider", "local", "--unsafe-local", "--dry-run"]);
  assert.match(out, /Dry run — nothing was executed/);
  assert.match(out, /would:/);
  assert.doesNotMatch(out, /\u2713/, "dry run must not contain any green check");
  assert.ok(!fs.existsSync(path.join(repo, ".bootproof")), "dry run must not write proof");
  assert.ok(!fs.existsSync(path.join(repo, ".env.bootproof.example")), "dry run must not write files");
});

test("honesty: local provider refuses without --unsafe-local", () => {
  const repo = freshCopy("hello-app");
  const { out, code } = run(["up", repo, "--provider", "local"], true);
  assert.equal(code, 1);
  assert.match(out, /--unsafe-local/);
  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.booted, false);
  assert.equal(att.result.healthVerified, false);
  assert.equal(att.result.failureClass, "unknown_failure");
  assert.deepEqual(att.observed, [], "a refusal must not pretend any step executed");
});

test("e2e: real boot, observed health, signed attestation that verifies", async () => {
  const repo = freshCopy("hello-app");
  const port = await getFreePort();
  const { out } = run(["up", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "20000"]);
  assert.match(out, /BOOTED/);
  assert.match(out, new RegExp(`observed HTTP 200 at http://localhost:${port}/`));
  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.booted, true);
  assert.equal(att.result.healthVerified, true);
  assert.ok(att.signature, "attestation must be signed");
  assert.ok(att.observed.some(o => o.kind === "health" && o.ok), "health must be an observed step");
  const v = run(["verify", repo]);
  assert.match(v.out, /signature valid/);
});

test("honesty: early refusal fixture writes signed proof that explains and verifies without touching env", () => {
  const repo = freshCopy("early-refusal-attestation");
  const { out, code } = run(["up", repo, "--provider", "local", "--unsafe-local"], true);
  assert.equal(code, 1);
  assert.match(out, /not_an_application/);
  assert.doesNotMatch(out, /localhost:\d+\/?\s*$/m, "must not advertise a URL for a library");
  const attestation = path.join(repo, ".bootproof", "attestation.json");
  const att = JSON.parse(fs.readFileSync(attestation, "utf8"));
  assert.equal(att.result.booted, false);
  assert.equal(att.result.healthVerified, false);
  assert.equal(att.result.failureClass, "not_an_application");
  assert.deepEqual(att.observed, [], "a refusal must not pretend any step executed");
  assert.deepEqual(att.trust, { level: "local_developer_signed", signer: "local_ed25519", oidc: null });
  assert.ok(att.signature, "failed refusal attestation must be signed");

  const explained = run(["explain", attestation]);
  assert.match(explained.out, /Failure class: not_an_application/);
  assert.match(explained.out, /Trust level: local_developer_signed/);
  assert.match(explained.out, /What happened:/);
  assert.match(explained.out, /Why BootProof refused:/);
  assert.match(explained.out, /Safe next step:/);
  assert.match(explained.out, /Evidence:/);

  const verified = run(["verify", attestation]);
  assert.equal(verified.code, 0);
  assert.match(verified.out, /signature valid/);

  for (const name of [".env", ".env.local", ".env.development", ".env.production"]) {
    assert.ok(!fs.existsSync(path.join(repo, name)), `${name} must not be written`);
  }
});

test("machine interface: --json emits one strict failed result object", () => {
  const repo = freshCopy("library-only");
  const { out, code } = run(["up", repo, "--json"], true);
  assert.equal(code, 1);
  assert.equal(out.trim().split("\n").length, 1, "stdout must contain exactly one JSON object");
  assert.doesNotMatch(out, /\x1b\[/, "JSON output must not contain ANSI colours");
  assert.doesNotMatch(out, /What happened:|Why BootProof refused:|Safe next step:/, "human diagnosis must stay out of JSON mode");
  const result = JSON.parse(out);
  assert.equal(result.schema, "bootproof/result/v1");
  assert.equal(result.booted, false);
  assert.equal(result.healthVerified, false);
  assert.equal(result.failureClass, "not_an_application");
  assert.equal(result.attestationPath, ".bootproof/attestation.json");
  assert.deepEqual(result.observed, []);
  assert.equal(result.trust.level, "local_developer_signed");
  assert.ok(result.inference);
  assert.ok(result.plan);
});

test("machine interface: --ci --json fails closed for refusals", () => {
  const repo = freshCopy("library-only");
  const { out, code } = run(["up", repo, "--ci", "--json"], true);
  assert.equal(code, 1);
  assert.doesNotMatch(out, /\x1b\[/);
  const result = JSON.parse(out);
  assert.equal(result.schema, "bootproof/result/v1");
  assert.equal(result.booted, false);
  assert.equal(result.healthVerified, false);
  assert.equal(result.failureClass, "not_an_application");
});

test("machine interface: --ci --json exits zero only for observed healthy boot", async () => {
  const repo = freshCopy("hello-app");
  const port = await getFreePort();
  const { out, code } = run(["up", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "20000", "--ci", "--json"], true);
  assert.equal(code, 0);
  assert.doesNotMatch(out, /\x1b\[/);
  const result = JSON.parse(out);
  assert.equal(result.booted, true);
  assert.equal(result.healthVerified, true);
  assert.equal(result.failureClass, null);
  assert.ok(result.observed.some(o => o.kind === "health" && o.ok));
});

test("machine interface: --ci human output has no ANSI and refuses unsafe local execution", () => {
  const repo = freshCopy("hello-app");
  const { out, code } = run(["up", repo, "--provider", "local", "--ci"], true);
  assert.equal(code, 1);
  assert.doesNotMatch(out, /\x1b\[/);
  assert.match(out, /--unsafe-local/);
});

test("machine interface: --ci rejects invalid providers before execution", () => {
  const repo = freshCopy("hello-app");
  const { out, code } = run(["up", repo, "--provider", "anything", "--ci", "--json"], true);
  assert.equal(code, 1);
  const result = JSON.parse(out);
  assert.equal(result.failureClass, "unknown_failure");
  assert.equal(result.attestationPath, null);
  assert.match(result.explanation, /invalid --provider/);
  assert.ok(!fs.existsSync(path.join(repo, ".bootproof")), "invalid options must not start a run");
});

test("remote mode clones GitHub sources but refuses execution without the existing host safety gate", () => {
  const remote = fakeGithubRemote("hello-app");
  const url = "https://github.com/example/hello-app";
  const { out, code } = run(["up", url, "--ci", "--json"], true, remote.env, remote.cwd);
  assert.equal(code, 1);
  assert.equal(out.trim().split("\n").length, 1);
  const result = JSON.parse(out);
  assert.equal(result.failureClass, "unknown_failure");
  assert.match(result.explanation, /will not execute remote repository code/);
  assert.match(result.attestationPath, /^\.bootproof\/remotes\/github\.com\/example\/hello-app-/);
  const attestationPath = path.join(remote.cwd, result.attestationPath);
  assert.ok(fs.existsSync(attestationPath));
  const att = JSON.parse(fs.readFileSync(attestationPath, "utf8"));
  assert.equal(att.repo.remote, "https://github.com/example/hello-app.git");
  assert.equal(att.repo.dirty, false);
  assert.equal(att.result.booted, false);
  assert.equal(att.result.healthVerified, false);
  assert.deepEqual(att.observed, []);
  const verified = run(["verify", attestationPath], false, remote.env, remote.cwd);
  assert.match(verified.out, /signature valid/);
  assert.match(verified.out, /Replay requires explicit host execution acknowledgement/);

  const replay = run(["up", att.repo.path, "--ci", "--json"], true, remote.env, remote.cwd);
  assert.equal(replay.code, 1);
  assert.match(JSON.parse(replay.out).explanation, /will not execute remote repository code/);
});

test("remote mode executes only after --provider local --unsafe-local and requires observed health", async () => {
  const remote = fakeGithubRemote("hello-app");
  const port = await getFreePort();
  const url = "https://github.com/example/hello-app";
  const { out, code } = run(
    ["up", url, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "20000", "--ci", "--json"],
    true,
    remote.env,
    remote.cwd,
  );
  assert.equal(code, 0);
  const result = JSON.parse(out);
  assert.equal(result.booted, true);
  assert.equal(result.healthVerified, true);
  assert.ok(result.observed.some(observed => observed.kind === "health" && observed.ok));
  const clonedRepo = path.dirname(path.dirname(path.join(remote.cwd, result.attestationPath)));
  for (const name of [".env", ".env.local", ".env.development", ".env.production"]) {
    assert.ok(!fs.existsSync(path.join(clonedRepo, name)), `${name} must not be written in a remote clone`);
  }
});

test("remote dry runs refuse before cloning because dry runs write nothing", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bp-remote-dry-"));
  const { out, code } = run(
    ["up", "https://github.com/example/hello-app", "--provider", "local", "--unsafe-local", "--dry-run"],
    true,
    {},
    cwd,
  );
  assert.equal(code, 1);
  assert.match(out, /dry runs promise to write nothing/i);
  assert.equal(fs.existsSync(path.join(cwd, ".bootproof")), false);
});

test("Superset-like app writes a signed python_flask_setup_required refusal", () => {
  const repo = freshCopy("python-flask-superset-like");
  const { out, code } = run(["up", repo, "--ci"], true);
  assert.equal(code, 1);
  assert.match(out, /application: yes/);
  assert.match(out, /python-backend, flask, react-frontend, docker-compose, celery/);
  assert.match(out, /backend command: flask run -p 8088/);
  assert.match(out, /NOT VERIFIED — python_flask_setup_required/);
  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.failureClass, "python_flask_setup_required");
  assert.equal(att.result.booted, false);
  assert.equal(att.result.healthVerified, false);
  assert.deepEqual(att.observed, []);
  assert.deepEqual(att.plan.generatedFiles, [], "refusal must not claim ungenerated scaffolding");
  assert.doesNotMatch(JSON.stringify(att.plan), /docker-compose\.bootproof\.yml/, "refusal plan must not reference ungenerated scaffolding");
  assert.ok(!fs.existsSync(path.join(repo, "docker-compose.bootproof.yml")));
  assert.ok(att.signature);
});

test("Grafana-like hybrid fails closed when dependency installation is skipped", () => {
  const repo = freshCopy("go-node-grafana-like");
  const { out, code } = run(["up", repo, "--ci"], true);
  assert.equal(code, 1);
  assert.match(out, /go-backend, node-frontend, react/);
  assert.match(out, /frontend\/dev pipeline only/);
  assert.match(out, /NOT VERIFIED — dependency_install_skipped/);
  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.failureClass, "dependency_install_skipped");
  assert.equal(att.result.booted, false);
  assert.equal(att.observed[0].ok, false);
  assert.match(att.observed[0].observation, /skipped/);
  assert.ok(att.plan.healthCandidates.includes("http://localhost:3000/api/health"));
});

test("package manager version mismatch is signed before install runs", () => {
  const repo = freshCopy("pnpm-version-mismatch");
  const bin = path.join(repo, "bin");
  fs.mkdirSync(bin);
  const fakePnpm = path.join(bin, "pnpm");
  fs.writeFileSync(fakePnpm, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 9.15.4; exit 0; fi\necho install-must-not-run >&2\nexit 99\n");
  fs.chmodSync(fakePnpm, 0o755);

  const { out, code } = run(
    ["up", repo, "--provider", "local", "--unsafe-local", "--install", "--ci"],
    true,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(code, 1);
  assert.match(out, /NOT VERIFIED — package_manager_version_mismatch/);
  assert.match(out, /What happened: The repository requires pnpm 10\.24\.0, but this environment has pnpm 9\.15\.4\./);
  assert.match(out, /Why BootProof refused:/);
  assert.match(out, /Safe next step: Run corepack enable && corepack prepare pnpm@10\.24\.0 --activate/);
  assert.match(out, /Evidence: \.bootproof\/attestation\.json/);
  assert.doesNotMatch(out, /install-must-not-run/);
  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.failureClass, "package_manager_version_mismatch");
  assert.match(att.result.failureEvidence, /expected version: 10\.24\.0/);
  assert.match(att.result.failureEvidence, /Got: 9\.15\.4/);
  assert.equal(att.observed[0].command, "pnpm --version");
});

test("health HTTP error fixture is not mislabeled as a timeout", async () => {
  const repo = freshCopy("health-http-error");
  const port = await getFreePort();
  const { out, code } = run(["up", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "10000", "--ci"], true);
  assert.equal(code, 1);
  assert.match(out, /NOT VERIFIED — health_http_error/);
  assert.match(out, /What happened: The application responded to a health candidate with HTTP 5xx\./);
  assert.doesNotMatch(out, /NOT VERIFIED — health_check_timeout/);
  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.failureClass, "health_http_error");
  assert.ok(att.observed.some(step => step.kind === "health" && step.ok === false));
});

test("matching package manager does not make a parallel monorepo health target unambiguous", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-parallel-up-"));
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
  const bin = path.join(repo, "bin");
  fs.mkdirSync(bin);
  const fakePnpm = path.join(bin, "pnpm");
  fs.writeFileSync(fakePnpm, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 10.24.0; exit 0; fi\necho install-must-not-run >&2\nexit 99\n");
  fs.chmodSync(fakePnpm, 0o755);

  const { out, code } = run(
    ["up", repo, "--install", "--ci"],
    true,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(code, 1);
  assert.match(out, /NOT VERIFIED — workspace_ambiguous/);
  assert.match(out, /multiple workspaces in parallel/);
  assert.doesNotMatch(out, /install-must-not-run/);
  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.failureClass, "workspace_ambiguous");
  assert.deepEqual(att.observed, []);
});

test("health URLs discovered from app logs are polled and preserved in signed proof", async () => {
  const repo = freshCopy("hello-app");
  const actualPort = await getFreePort();
  let inferredPort = await getFreePort();
  while (inferredPort === actualPort) inferredPort = await getFreePort();
  fs.writeFileSync(path.join(repo, "server.js"), `
const http = require("http");
const port = ${actualPort};
console.log("Local: http://127.0.0.1:" + port + "/ready");
http.createServer((_req, res) => { res.statusCode = 200; res.end("ok"); }).listen(port);
`);
  const { out, code } = run(["up", repo, "--provider", "local", "--unsafe-local", "--port", String(inferredPort), "--timeout", "10000"], true);
  assert.equal(code, 0);
  assert.match(out, new RegExp(`observed HTTP 200 at http://127\\.0\\.0\\.1:${actualPort}/ready`));
  const attestation = path.join(repo, ".bootproof", "attestation.json");
  const att = JSON.parse(fs.readFileSync(attestation, "utf8"));
  assert.deepEqual(att.result.observedHealthCandidates, [`http://127.0.0.1:${actualPort}/ready`]);
  assert.ok(att.plan.healthCandidates.includes(`http://127.0.0.1:${actualPort}/ready`));
  const explained = run(["explain", attestation]);
  assert.match(explained.out, /Observed health candidates:/);
  assert.match(explained.out, new RegExp(`127\\.0\\.0\\.1:${actualPort}/ready`));
});

test("honesty: failed boot writes failed attestation with classified evidence", () => {
  const repo = freshCopy("hello-app");
  fs.writeFileSync(path.join(repo, "server.js"), "console.error('Error: listen EADDRINUSE: address already in use :::3000'); process.exit(1);");
  const { out, code } = run(["up", repo, "--provider", "local", "--unsafe-local", "--timeout", "8000", "--ci"], true);
  assert.equal(code, 1);
  assert.doesNotMatch(out, /\x1b\[/);
  assert.match(out, /NOT VERIFIED/);
  assert.match(out, /port_in_use/);
  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.booted, false);
  assert.equal(att.result.failureClass, "port_in_use");
  assert.ok(att.result.failureEvidence.includes("EADDRINUSE"), "raw evidence must be preserved");
});

test("honesty: real env files are never touched by a full run", async () => {
  const repo = freshCopy("hello-app");
  const port = await getFreePort();
  const protectedEnv = {
    ".env": "REAL_SECRET=do-not-touch\n",
    ".env.local": "ALSO_REAL=untouchable\n",
    ".env.development": "DEVELOPMENT_SECRET=preserve-me\n",
    ".env.production": "PRODUCTION_SECRET=preserve-me-too\n",
  };
  for (const [name, contents] of Object.entries(protectedEnv)) fs.writeFileSync(path.join(repo, name), contents);
  run(["up", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "20000"]);
  for (const [name, contents] of Object.entries(protectedEnv)) {
    assert.equal(fs.readFileSync(path.join(repo, name), "utf8"), contents, `${name} must remain untouched`);
  }
});

test("honesty: skipped steps are never rendered with a green check", async () => {
  const repo = freshCopy("hello-app");
  const port = await getFreePort();
  const { out } = run(["up", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "20000"]);
  for (const line of out.split("\n")) if (line.includes("skipped")) assert.ok(!line.includes("\u2713"), `skipped step rendered as success: ${line}`);
});

test("unknown commands are rejected, not guessed", () => {
  const { out, code } = run(["lanch", "."], true);
  assert.equal(code, 1);
  assert.match(out, /unknown command: lanch/);
});

test("monorepo ambiguity is surfaced, not guessed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bp-mono-"));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }));
  for (const app of ["web", "api"]) {
    fs.mkdirSync(path.join(tmp, "apps", app), { recursive: true });
    fs.writeFileSync(path.join(tmp, "apps", app, "package.json"), JSON.stringify({ name: app, scripts: { dev: "node x.js" } }));
  }
  const { out, code } = run(["up", tmp, "--provider", "local", "--unsafe-local"], true);
  assert.equal(code, 1);
  assert.match(out, /workspace_ambiguous/);
  assert.match(out, /--workspace/);
  const att = JSON.parse(fs.readFileSync(path.join(tmp, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.failureClass, "workspace_ambiguous");
  assert.equal(att.result.booted, false);
  assert.deepEqual(att.observed, []);
});

test("attest export: redacted entry written locally, nothing uploaded, consent messaging shown", async () => {
  const repo = freshCopy("hello-app");
  const port = await getFreePort();
  run(["up", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "20000"]);
  const { out } = run(["attest", "export", repo]);
  assert.match(out, /Nothing has been uploaded/);
  assert.ok(fs.existsSync(path.join(repo, ".bootproof", "registry-entry.json")));
  const check = run(["attest", "check", repo]);
  assert.match(check.out, /signature valid/);
});
