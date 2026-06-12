import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { buildAttestation, writeAttestation } from "../dist/proof.js";
import { createRepairCommand } from "../dist/repair-safety.js";

const CLI = path.resolve("dist/cli.js");
const FIX = path.resolve("fixtures");

function mergeEnv(overrides = {}) {
  const merged = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = Object.keys(merged).find(candidate => candidate.toLowerCase() === key.toLowerCase());
    if (existing && existing !== key) delete merged[existing];
    merged[key] = value;
  }
  return merged;
}

const run = (args, allowFail = false, env = {}, cwd = process.cwd()) => {
  try { return { out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: mergeEnv(env), cwd }), code: 0 }; }
  catch (e) { if (!allowFail) throw e; return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 }; }
};

const runWithInput = (args, input, env = {}, cwd = process.cwd()) => {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: mergeEnv(env),
    cwd,
    input,
  });
  return {
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    code: result.status ?? 1,
  };
};

const runAsync = (args, env = {}, cwd = process.cwd()) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: mergeEnv(env),
    cwd,
  }, (error, stdout, stderr) => {
    resolve({
      out: `${stdout ?? ""}${stderr ?? ""}`,
      code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
    });
  });
});

const runWithPromptResponses = (args, responses, env = {}, cwd = process.cwd()) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: mergeEnv(env),
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let responseIndex = 0;
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`interactive command timed out:\n${out}`));
  }, 10_000);
  const capture = chunk => {
    out += String(chunk);
    const response = responses[responseIndex];
    if (response && out.includes(response.prompt)) {
      child.stdin.write(`${response.answer}\n`);
      responseIndex += 1;
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", error => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", code => {
    clearTimeout(timer);
    resolve({ out, code: code ?? 1 });
  });
});

function freshCopy(name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bp-e2e-"));
  fs.cpSync(path.join(FIX, name), tmp, { recursive: true });
  return tmp;
}

function createCliDiffRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-diff-e2e-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "BootProof Test");
  git("config", "user.email", "bootproof@example.invalid");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    name: "cli-diff",
    scripts: {
      start: "API_TOKEN=first-secret node -e \"require('node:fs').writeFileSync('.executed','bad')\"",
    },
  }, null, 2));
  fs.writeFileSync(path.join(repo, ".env.example"), "OLD_ENV=first-secret\n");
  fs.writeFileSync(path.join(repo, "docker-compose.yml"), [
    "services:",
    "  old:",
    "    image: example/old",
    "    ports:",
    '      - "3000:3000"',
    "",
  ].join("\n"));
  git("add", ".");
  git("commit", "-q", "-m", "base");

  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    name: "cli-diff",
    dependencies: { express: "5.0.0" },
    scripts: {
      start: "API_TOKEN=second-secret node -e \"require('node:fs').writeFileSync('.executed','worse')\"",
    },
  }, null, 2));
  fs.writeFileSync(path.join(repo, ".env.example"), "NEW_ENV=second-secret\n");
  fs.writeFileSync(path.join(repo, "docker-compose.yml"), [
    "services:",
    "  new:",
    "    image: example/new",
    "    ports:",
    '      - "4000:4000"',
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "head");
  return repo;
}

function writeFailedAttestation(repo, failureClass, failureEvidence, provider = "local") {
  const attestation = buildAttestation({
    repo,
    plan: {
      provider,
      steps: [],
      healthUrl: "http://localhost:3000/",
      healthCandidates: ["http://localhost:3000/"],
      generatedFiles: [],
    },
    observed: [],
    startedAt: new Date().toISOString(),
    booted: false,
    healthVerified: false,
    healthObservation: null,
    failureClass,
    failureEvidence,
    explanation: failureEvidence,
  });
  writeAttestation(repo, attestation);
  return attestation;
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

async function withHttpServer(handler, runWithUrl) {
  const server = await new Promise((resolve, reject) => {
    const candidate = http.createServer(handler);
    candidate.once("error", reject);
    candidate.listen(0, "127.0.0.1", () => resolve(candidate));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    return await runWithUrl(`http://127.0.0.1:${address.port}/`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function fakeRemote(fixture, canonicalUrl, setup) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bp-remote-cwd-"));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "bp-remote-source-"));
  fs.cpSync(path.join(FIX, fixture), source, { recursive: true });
  setup?.(source);
  const git = (...args) => execFileSync("git", args, { cwd: source, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "BootProof Test");
  git("config", "user.email", "bootproof@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");

  return {
    cwd,
    source,
    url: canonicalUrl,
    env: {
      GIT_ALLOW_PROTOCOL: "file",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(source).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: canonicalUrl,
    },
  };
}

function fakeGithubRemote(fixture, setup) {
  return fakeRemote(fixture, "https://github.com/example/hello-app.git", setup);
}

function writeNodeTool(bin, name, source) {
  const script = path.join(bin, `${name}-tool.cjs`);
  fs.writeFileSync(script, source);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\nnode "%~dp0${name}-tool.cjs" %*\r\n`);
    return;
  }
  const executable = path.join(bin, name);
  fs.writeFileSync(executable, `#!/bin/sh\nexec node "$(dirname "$0")/${name}-tool.cjs" "$@"\n`);
  fs.chmodSync(executable, 0o755);
}

function writeRepairBrew(bin) {
  fs.mkdirSync(bin, { recursive: true });
  writeNodeTool(bin, "brew", `
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
if (!["install cmake", "services start redis"].includes(args)) process.exit(2);
if (process.env.BOOTPROOF_REPAIR_MARKER) {
  fs.writeFileSync(process.env.BOOTPROOF_REPAIR_MARKER, args + "\\n");
}
`);
}

function writeAiFetchShim(repo, suggestion, marker) {
  const shim = path.join(repo, "ai-fetch-shim.mjs");
  fs.writeFileSync(shim, `
import fs from "node:fs";
globalThis.fetch = async (_url, options) => {
  fs.writeFileSync(${JSON.stringify(marker)}, String(options?.body ?? ""));
  return new Response(JSON.stringify({
    output_text: ${JSON.stringify(JSON.stringify(suggestion))}
  }), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  return shim;
}

function writePackageRepairTools(bin) {
  fs.mkdirSync(bin, { recursive: true });
  writeNodeTool(bin, "corepack", `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.join(" ") !== "prepare pnpm@10.24.0 --activate" || !process.env.COREPACK_HOME) process.exit(2);
fs.mkdirSync(process.env.COREPACK_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.COREPACK_HOME, "pnpm-10.24.0"), "activated\\n");
`);
  writeNodeTool(bin, "pnpm", `
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const marker = process.env.COREPACK_HOME && path.join(process.env.COREPACK_HOME, "pnpm-10.24.0");
const active = Boolean(marker && fs.existsSync(marker));
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(active ? "10.24.0" : "9.15.4"); process.exit(0); }
if (args[0] === "install") {
  if (active) process.exit(0);
  console.error("ERR_PNPM_UNSUPPORTED_ENGINE Unsupported environment (bad pnpm and/or Node.js version)\\nExpected version: 10.24\\nGot: 9.15.4");
  process.exit(1);
}
if (args[0] === "dev") {
  const child = spawnSync(process.execPath, ["server.js"], { stdio: "inherit", env: process.env });
  process.exit(child.status ?? 1);
}
process.exit(2);
`);
}

function writePrismaRepairTools(bin) {
  fs.mkdirSync(bin, { recursive: true });
  writeNodeTool(bin, "npm", `
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "install") process.exit(0);
if (args[0] === "run" && args[1] === "start") {
  const child = spawnSync(process.execPath, ["server.js"], { stdio: "inherit", env: process.env });
  process.exit(child.status ?? 1);
}
process.exit(2);
`);
  writeNodeTool(bin, "npx", `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.join(" ") !== "prisma migrate deploy") process.exit(2);
fs.mkdirSync(path.join(process.cwd(), ".bootproof"), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), ".bootproof", "prisma-ready"), "migrated\\n");
`);
}

function writeDjangoRepairTools(bin) {
  fs.mkdirSync(bin, { recursive: true });
  writeNodeTool(bin, "python", `
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const marker = path.join(process.cwd(), ".bootproof", "django-ready");
if (args.join(" ") === "manage.py migrate --noinput") {
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "migrated\\n");
  process.exit(0);
}
if (args[0] === "manage.py" && args[1] === "runserver") {
  if (!fs.existsSync(marker)) {
    console.error("django.db.utils.OperationalError: no such table: app_widget");
    process.exit(1);
  }
  const port = args[2].split(":").at(-1);
  const child = spawnSync(process.execPath, ["server.js"], {
    stdio: "inherit",
    env: { ...process.env, PORT: port },
  });
  process.exit(child.status ?? 1);
}
process.exit(2);
`);
}

function writeFakePnpm(bin, version) {
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(bin, "pnpm.cmd"),
      `@echo off\r\nif "%~1"=="--version" (\r\n  echo ${version}\r\n  exit /b 0\r\n)\r\necho install-must-not-run 1>&2\r\nexit /b 99\r\n`,
    );
    return;
  }
  const fakePnpm = path.join(bin, "pnpm");
  fs.writeFileSync(fakePnpm, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\necho install-must-not-run >&2\nexit 99\n`);
  fs.chmodSync(fakePnpm, 0o755);
}

function pathWith(bin) {
  return `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
}

function writeRuntimeShim(bin, name) {
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(bin, `${name}.cmd`),
      [
        "@echo off",
        "if \"%~1\"==\"mod\" if \"%~2\"==\"download\" exit /b 0",
        "if \"%~1\"==\"install\" exit /b 0",
        "node server.js %*",
        "",
      ].join("\r\n"),
    );
    return;
  }
  const executable = path.join(bin, name);
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    "if [ \"$1\" = \"mod\" ] && [ \"$2\" = \"download\" ]; then exit 0; fi",
    "if [ \"$1\" = \"install\" ]; then exit 0; fi",
    "exec node server.js \"$@\"",
    "",
  ].join("\n"));
  fs.chmodSync(executable, 0o755);
}

function writeDockerShim(bin) {
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "docker.cmd"), "@echo off\r\nnode fake-docker.js %*\r\n");
    return;
  }
  const executable = path.join(bin, "docker");
  fs.writeFileSync(executable, "#!/bin/sh\nexec node fake-docker.js \"$@\"\n");
  fs.chmodSync(executable, 0o755);
}

function stopFixtureProcess(repo) {
  const pidPath = path.join(repo, ".bootproof", "fake-compose.pid");
  if (!fs.existsSync(pidPath)) return;
  const pid = Number(fs.readFileSync(pidPath, "utf8"));
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {
    // The fixture process may already have exited.
  }
}

function hashWorkingTree(repo) {
  const hash = crypto.createHash("sha256");
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.name !== ".bootproof")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(repo, absolute).replace(/\\/g, "/");
      hash.update(relative);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isSymbolicLink()) hash.update(`link:${fs.readlinkSync(absolute)}`);
      else hash.update(fs.readFileSync(absolute));
    }
  };
  walk(repo);
  return hash.digest("hex");
}

async function occupyPort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
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
  assert.equal(att.result.healthEvidence.requestedUrl, `http://localhost:${port}/`);
  assert.equal(att.result.healthEvidence.statusCode, 200);
  assert.equal(att.result.healthEvidence.statusText, "OK");
  assert.equal(att.result.healthEvidence.acceptedAsHealthy, true);
  assert.equal(att.result.healthEvidence.connectionError, null);
  assert.ok(att.signature, "attestation must be signed");
  assert.ok(att.observed.some(o => o.kind === "health" && o.ok), "health must be an observed step");
  const v = run(["verify", repo]);
  assert.match(v.out, /signature valid/);
});

test("parent environment including RAILS_ENV and PATH reaches the app process", async () => {
  const repo = freshCopy("hello-app");
  const port = await getFreePort();
  fs.writeFileSync(path.join(repo, "server.js"), `
const http = require("http");
const required = {
  BOOTPROOF_PARENT_TEST: "inherited",
  RAILS_ENV: "development",
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://localhost/mastodon",
  REDIS_URL: "redis://localhost:6379",
  BUNDLE_PATH: "/tmp/bootproof-bundle",
  GEM_HOME: "/tmp/bootproof-gems",
  RBENV_VERSION: "3.3.0",
  RUBYOPT: "-W0",
};
for (const [name, expected] of Object.entries(required)) {
  if (process.env[name] !== expected) {
    console.error(name + " was not preserved");
    process.exit(1);
  }
}
if (!process.env.PATH) {
  console.error("PATH was not preserved");
  process.exit(1);
}
http.createServer((_request, response) => response.end("env ok")).listen(process.env.PORT);
`);
  const { out, code } = run(
    ["up", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "10000"],
    true,
    {
      BOOTPROOF_PARENT_TEST: "inherited",
      RAILS_ENV: "development",
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://localhost/mastodon",
      REDIS_URL: "redis://localhost:6379",
      BUNDLE_PATH: "/tmp/bootproof-bundle",
      GEM_HOME: "/tmp/bootproof-gems",
      RBENV_VERSION: "3.3.0",
      RUBYOPT: "-W0",
    },
  );
  assert.equal(code, 0);
  assert.match(out, /BOOTED/);
});

test("--command is executed and reflected in terminal output, plan, and attestation", async () => {
  const repo = freshCopy("hello-app");
  const port = await getFreePort();
  const command = "RAILS_ENV=development node override-server.cjs";
  fs.writeFileSync(path.join(repo, "server.js"), "throw new Error('inferred command must not run');");
  fs.writeFileSync(path.join(repo, "override-server.cjs"), `
const http = require("http");
if (process.env.RAILS_ENV !== "development") process.exit(2);
http.createServer((_request, response) => response.end("override ok")).listen(process.env.PORT);
`);
  const { out, code } = run(
    ["up", repo, "--provider", "local", "--unsafe-local", "--command", command, "--port", String(port), "--timeout", "10000"],
    true,
  );
  assert.equal(code, 0);
  assert.match(out, /selected command: RAILS_ENV=development node override-server\.cjs/);
  assert.match(out, /--command override/);

  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  const plannedStart = att.plan.steps.find(step => step.kind === "start-app");
  const observedStart = att.observed.find(step => step.kind === "start-app");
  assert.equal(plannedStart.command, command);
  assert.equal(observedStart.command, command);
  assert.equal(att.result.booted, true);
  assert.equal(att.result.healthVerified, true);
});

test("GitLab-style sign-in redirect verifies and replaces transient health errors", async () => {
  const repo = freshCopy("hello-app");
  const port = await getFreePort();
  fs.writeFileSync(path.join(repo, "server.js"), `
const http = require("http");
const port = process.env.PORT || 3000;
let requests = 0;
http.createServer((_request, response) => {
  requests++;
  if (requests === 1) {
    response.statusCode = 500;
    response.end("warming up");
    return;
  }
  response.writeHead(302, { location: "/users/sign_in", "x-app": "gitlab" });
  response.end("redirecting");
}).listen(port);
`);
  const { out, code } = run(["up", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "10000"], true);
  assert.equal(code, 0);
  assert.match(out, /✓ health: HTTP 302 Found → \/users\/sign_in/);

  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.booted, true);
  assert.equal(att.result.healthVerified, true);
  assert.equal(att.result.healthEvidence.requestedUrl, `http://localhost:${port}/`);
  assert.equal(att.result.healthEvidence.statusCode, 302);
  assert.equal(att.result.healthEvidence.statusText, "Found");
  assert.equal(att.result.healthEvidence.headers.location, "/users/sign_in");
  assert.equal(att.result.healthEvidence.headers["x-app"], "gitlab");
  assert.equal(att.result.healthEvidence.redirectLocation, "/users/sign_in");
  assert.equal(att.result.healthEvidence.bodyExcerpt, "redirecting");
  assert.equal(att.result.healthEvidence.acceptedAsHealthy, true);
  assert.equal(att.result.healthEvidence.connectionError, null);
  assert.ok(!Number.isNaN(Date.parse(att.result.healthEvidence.timestamp)));
  assert.doesNotMatch(JSON.stringify(att.result.healthEvidence), /500|warming up/);
  assert.doesNotMatch(JSON.stringify(att.observed.filter(step => step.kind === "health")), /500|warming up/);
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

test("verify-url emits signed external health proof without writing repository files", async () => {
  await withHttpServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("x-airbyte-health", "available");
    response.end('{"available":true}');
  }, async url => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bp-verify-url-"));
    const { out, code } = await runAsync(["verify-url", url, "--json"], {}, cwd);
    assert.equal(code, 0);
    const attestation = JSON.parse(out);
    assert.equal(attestation.schema, "bootproof/attestation/v1");
    assert.equal(attestation.verificationMode, "external-health");
    assert.equal(attestation.bootproofOrchestrated, false);
    assert.equal(attestation.classification, "external_service_verified");
    assert.equal(attestation.result.booted, false);
    assert.equal(attestation.result.healthVerified, true);
    assert.equal(attestation.result.healthEvidence.headers["x-airbyte-health"], "available");
    assert.equal(attestation.responseSnippet, '{"available":true}');
    assert.equal(fs.existsSync(path.join(cwd, ".bootproof")), false);
  });
});

test("up --external-health writes external attestation and never claims orchestration", async () => {
  await withHttpServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader("location", "/login");
    response.end("redirecting");
  }, async url => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-up-external-"));
    const { out, code } = await runAsync(["up", repo, "--external-health", url]);
    assert.equal(code, 0);
    assert.match(out, /EXTERNAL SERVICE VERIFIED/);
    assert.match(out, /bootproofOrchestrated=false/);
    assert.doesNotMatch(out, /\bBOOTED\b|started and supervised/);
    const attestation = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
    assert.equal(attestation.verificationMode, "external-health");
    assert.equal(attestation.bootproofOrchestrated, false);
    assert.equal(attestation.observedStatus, 302);
    assert.equal(attestation.observedFinalUrl, url);
    assert.equal(attestation.result.healthEvidence.redirectLocation, "/login");
    assert.equal(attestation.classification, "external_service_verified");
    assert.equal(attestation.result.booted, false);
    assert.equal(attestation.result.healthVerified, true);
    assert.match(attestation.result.explanation, /did not start or orchestrate/);
  });
});

test("up --external-health rejects execution flags instead of ignoring them", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-up-external-flags-"));
  const { out, code } = await runAsync([
    "up",
    repo,
    "--external-health",
    "http://127.0.0.1:8001/health",
    "--provider",
    "local",
  ]);
  assert.equal(code, 1);
  assert.match(out, /cannot be combined with --provider/);
  assert.equal(fs.existsSync(path.join(repo, ".bootproof")), false);
});

test("plan-agent writes a local plan and executes no repository command", () => {
  const repo = freshCopy("agent-plan-orchestrated-like");
  const { out, code } = run(["plan-agent", repo]);
  assert.equal(code, 0);
  assert.match(out, /Agent plan \(planning only\)/);
  assert.match(out, /No candidate action was executed\. Verification remains pending\./);
  assert.doesNotMatch(out, /\bBOOTED\b|EXTERNAL SERVICE VERIFIED/);
  assert.equal(fs.existsSync(path.join(repo, "PLAN_AGENT_MUST_NOT_EXECUTE")), false);
  const planPath = path.join(repo, ".bootproof", "agent-plan.json");
  assert.equal(fs.existsSync(planPath), true);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  assert.equal(plan.schema, "bootproof/agent-plan/v1");
  assert.equal(plan.mode, "agent-plan");
  assert.equal(plan.canBootProofOrchestrateDirectly, false);
  assert.equal(plan.canBootProofVerifyExternally, true);
  assert.ok(plan.candidateNextActions.some(candidate =>
    candidate.command === "abctl local install --port 8001" &&
    candidate.riskLevel === "high" &&
    candidate.mutationScope === "kubernetes_cluster" &&
    candidate.requiresApproval === true
  ));
  assert.ok(plan.candidateNextActions.some(candidate =>
    candidate.command === "bootproof verify-url http://localhost:8001/api/v1/health" &&
    candidate.riskLevel === "low" &&
    candidate.mutationScope === "none" &&
    candidate.requiresApproval === false
  ));
  const runsDirectory = path.join(repo, ".bootproof", "agent-runs");
  const runIds = fs.readdirSync(runsDirectory);
  assert.equal(runIds.length, 1);
  const runDirectory = path.join(runsDirectory, runIds[0]);
  assert.equal(fs.existsSync(path.join(runDirectory, "initial-attestation.json")), true);
  assert.equal(fs.existsSync(path.join(runDirectory, "agent-plan.json")), true);
  assert.equal(fs.existsSync(path.join(runDirectory, "actions")), true);
  assert.equal(fs.existsSync(path.join(runDirectory, "verifications")), true);
  const summary = JSON.parse(fs.readFileSync(path.join(runDirectory, "final-summary.json"), "utf8"));
  assert.equal(summary.onlyPlanned, true);
  assert.equal(summary.verified, false);
  assert.equal(summary.bootproofOrchestrated, false);
  assert.ok(["stopped_for_approval", "stopped_blocked"].includes(summary.status));

  const explained = run(["explain-run", runIds[0]], false, {}, repo);
  assert.match(explained.out, /Receipt chain: valid/);
  assert.match(explained.out, /BootProof only planned; no action was executed/);
  assert.match(explained.out, /Verified: no/);
  assert.equal(fs.existsSync(path.join(repo, ".bootproof", "attestation.json")), false);
});

test("plan-agent --json emits the same valid plan written to disk", () => {
  const repo = freshCopy("agent-plan-orchestrated-like");
  const { out, code } = run(["plan-agent", repo, "--json"]);
  assert.equal(code, 0);
  assert.equal(out.trim().split("\n").length, 1);
  const stdoutPlan = JSON.parse(out);
  const filePlan = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "agent-plan.json"), "utf8"));
  assert.deepEqual(stdoutPlan, filePlan);
  assert.doesNotMatch(out, /"booted":true|"verified":true|"success":true/i);
});

test("plan-agent emits an Airbyte runbook plan and executes no Airbyte command", () => {
  const repo = freshCopy("airbyte");
  const { out, code } = run(["plan-agent", repo]);
  assert.equal(code, 0, out);
  assert.match(out, /airbyte_abctl_managed/);
  assert.match(out, /Command: abctl local install --port 8001/);
  assert.match(out, /Risk: high/);
  assert.match(out, /Mutation scope: kubernetes_cluster/);
  assert.match(out, /Secret-sensitive: yes; command output must not be saved/);
  assert.equal(fs.existsSync(path.join(repo, "PLAN_AGENT_MUST_NOT_EXECUTE")), false);

  const plan = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "agent-plan.json"), "utf8"));
  assert.ok(plan.classifications.includes("airbyte_abctl_managed"));
  assert.ok(plan.classifications.includes("external_orchestrator_required"));
  assert.ok(plan.verificationSteps.includes("curl -i http://localhost:8001/api/v1/health"));
  assert.ok(plan.candidateNextActions.some(candidate =>
    candidate.command === "abctl local install --port 8001" &&
    candidate.riskLevel === "high" &&
    candidate.mutationScope === "kubernetes_cluster" &&
    candidate.requiresApproval === true
  ));
  assert.ok(plan.candidateNextActions.some(candidate =>
    candidate.command === "abctl local credentials" &&
    candidate.secretSensitive === true &&
    candidate.mutationScope === "credentials"
  ));
});

test("external health verification appends to the latest local agent run", async () => {
  await withHttpServer((_request, response) => {
    response.statusCode = 200;
    response.end('{"available":true}');
  }, async url => {
    const repo = freshCopy("airbyte");
    const planned = run(["plan-agent", repo]);
    assert.equal(planned.code, 0);
    const runsDirectory = path.join(repo, ".bootproof", "agent-runs");
    const [runId] = fs.readdirSync(runsDirectory);

    const verified = await runAsync(["up", repo, "--external-health", url]);
    assert.equal(verified.code, 0, verified.out);
    assert.match(verified.out, new RegExp(`Agent run verification: ${runId}`));
    const runDirectory = path.join(runsDirectory, runId);
    const verificationFiles = fs.readdirSync(path.join(runDirectory, "verifications"));
    assert.equal(verificationFiles.length, 1);
    const verification = JSON.parse(fs.readFileSync(
      path.join(runDirectory, "verifications", verificationFiles[0]),
      "utf8",
    ));
    assert.equal(verification.verificationMode, "external-health");
    assert.equal(verification.bootproofOrchestrated, false);
    assert.equal(verification.result, "verified");
    assert.equal(verification.classification, "external_service_verified");

    const summary = JSON.parse(fs.readFileSync(path.join(runDirectory, "final-summary.json"), "utf8"));
    assert.equal(summary.status, "verified_external_health");
    assert.equal(summary.verifiedExternalHealth, true);
    assert.equal(summary.bootproofOrchestrated, false);
    assert.equal(summary.verified, true);
    assert.match(summary.explanation, /did not start or orchestrate/);

    const explained = run(["explain-run", runId], false, {}, repo);
    assert.match(explained.out, /verified external health and did not start/);
    assert.match(explained.out, /Receipt chain: valid/);
  });
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

test("unsupported CLI flags are rejected before execution", () => {
  const repo = freshCopy("hello-app");
  const { out, code } = run(["up", repo, "--unsupported-test-flag", "--json"], true);
  assert.equal(code, 1);
  const result = JSON.parse(out);
  assert.match(result.explanation, /unsupported flag for up: --unsupported-test-flag/);
  assert.equal(result.attestationPath, null);
  assert.ok(!fs.existsSync(path.join(repo, ".bootproof")), "unsupported flags must not start a run");
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
  const upResult = run(
    ["up", "https://github.com/example/hello-app", "--provider", "local", "--unsafe-local", "--dry-run"],
    true,
    {},
    cwd,
  );
  assert.equal(upResult.code, 1);
  assert.match(upResult.out, /dry runs promise to write nothing/i);
  const fixResult = run(
    ["fix", "https://github.com/example/hello-app", "--provider", "local", "--unsafe-local", "--dry-run", "--json"],
    true,
    {},
    cwd,
  );
  assert.equal(fixResult.code, 1);
  assert.match(JSON.parse(fixResult.out).explanation, /dry runs promise to write nothing/i);
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

test("Memos-like app writes a signed orchestration_not_supported diagnosis", () => {
  const repo = freshCopy("go-react-memos-like");
  const { out, code } = run(["up", repo, "--provider", "local", "--unsafe-local", "--ci"], true);
  assert.equal(code, 1);
  assert.match(out, /application: yes/);
  assert.match(out, /go-backend, react-frontend/);
  assert.match(out, /NOT VERIFIED — orchestration_not_supported/);
  assert.match(out, /Detected go-backend \(go\.mod\) with react-frontend \(web\/package\.json\)/);
  assert.match(out, /Diagnosis only — no localhost claim/);
  assert.doesNotMatch(out, /health candidates: http:\/\/localhost/);

  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.failureClass, "orchestration_not_supported");
  assert.equal(att.result.booted, false);
  assert.equal(att.result.healthVerified, false);
  assert.match(att.result.explanation, /go\.mod/);
  assert.match(att.result.explanation, /web\/package\.json/);
  assert.deepEqual(att.observed, []);
  assert.ok(att.signature);
});

test("Ruby and custom Make backends refuse as unsupported orchestration, not libraries", () => {
  const cases = [
    {
      name: "ruby",
      setup(repo) {
        fs.mkdirSync(path.join(repo, "config"), { recursive: true });
        fs.writeFileSync(path.join(repo, "Gemfile"), "source \"https://rubygems.org\"\ngem \"rails\"\n");
        fs.writeFileSync(path.join(repo, "config", "database.yml"), "development:\n  adapter: postgresql\n");
      },
      evidence: /Detected ruby-backend \(Gemfile, config\/database\.yml\)/,
    },
    {
      name: "make",
      setup(repo) {
        fs.writeFileSync(path.join(repo, "Makefile"), "bootstrap:\n\t./scripts/start-custom-stack\n");
      },
      evidence: /Detected make-driven \(Makefile\)/,
    },
  ];

  for (const fixture of cases) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), `bp-${fixture.name}-orchestration-`));
    fixture.setup(repo);
    const { out, code } = run(["up", repo, "--provider", "local", "--unsafe-local", "--ci"], true);
    assert.equal(code, 1);
    assert.match(out, /application: yes/);
    assert.match(out, /NOT VERIFIED — orchestration_not_supported/);
    assert.match(out, fixture.evidence);
    assert.doesNotMatch(out, /NOT VERIFIED — not_an_application/);
    const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
    assert.equal(att.result.failureClass, "orchestration_not_supported");
    assert.deepEqual(att.observed, []);
  }
});

test("Go, Rails, and Make repository entrypoints require observed HTTP health", async () => {
  const cases = [
    { fixture: "go-react-runnable-like", executable: "go", install: true, command: /go run \.\/cmd\/app --port/ },
    { fixture: "ruby-rails-runnable-like", executable: "bundle", install: true, command: /bundle exec rails server/ },
    { fixture: "make-runnable-like", executable: "make", install: false, command: /make serve/ },
  ];

  for (const item of cases) {
    const repo = freshCopy(item.fixture);
    const port = await getFreePort();
    const bin = path.join(repo, "bin-tools");
    fs.mkdirSync(bin);
    writeRuntimeShim(bin, item.executable);
    const args = ["up", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "10000", "--ci"];
    if (item.install) args.push("--install");

    const { out, code } = run(args, true, { PATH: pathWith(bin) });
    assert.equal(code, 0, `${item.fixture} failed:\n${out}`);
    assert.match(out, /BOOTED/);
    assert.match(out, item.command);
    assert.match(out, new RegExp(`observed HTTP 200 at http://localhost:${port}/`));
    const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
    assert.equal(att.result.booted, true);
    assert.equal(att.result.healthVerified, true);
    assert.ok(att.observed.some(observed => observed.kind === "health" && observed.ok));
    assert.ok(att.signature);
  }
});

test("an unavailable repository runtime is classified without guessing", () => {
  const repo = freshCopy("go-react-runnable-like");
  const emptyBin = path.join(repo, "empty-bin");
  fs.mkdirSync(emptyBin);
  const { out, code } = run(
    ["up", repo, "--provider", "local", "--unsafe-local", "--install", "--ci"],
    true,
    { PATH: emptyBin },
  );
  assert.equal(code, 1);
  assert.match(out, /NOT VERIFIED — missing_runtime_tool/);
  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.failureClass, "missing_runtime_tool");
  assert.match(att.result.failureEvidence, /go.*not found|go.*not recognized/i);
  assert.equal(att.result.booted, false);
  assert.equal(att.result.healthVerified, false);
});

test("honesty: docker provider never silently executes a host application command", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-docker-host-refusal-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    name: "docker-host-refusal",
    private: true,
    scripts: {
      start: "node -e \"require('node:fs').writeFileSync('host-command-ran', 'yes')\"",
    },
  }));

  const { out, code } = run(["up", repo, "--provider", "docker", "--ci"], true);
  assert.equal(code, 1);
  assert.match(out, /NOT VERIFIED — orchestration_not_supported/);
  assert.match(out, /will not silently run them on the host/);
  assert.equal(fs.existsSync(path.join(repo, "host-command-ran")), false);
  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.failureClass, "orchestration_not_supported");
  assert.deepEqual(att.observed, []);
});

test("source-built repository Compose verifies only after observed HTTP health", async () => {
  const repo = freshCopy("source-compose-runnable-like");
  const port = await getFreePort();
  fs.writeFileSync(
    path.join(repo, "docker-compose.yml"),
    fs.readFileSync(path.join(repo, "docker-compose.yml"), "utf8").replace("31999", String(port)),
  );
  const bin = path.join(repo, "bin-tools");
  fs.mkdirSync(bin);
  writeDockerShim(bin);
  fs.writeFileSync(path.join(repo, ".fake-compose-healthy"), "fixture mode\n");

  try {
    const { out, code } = run(
      ["up", repo, "--provider", "docker", "--timeout", "10000", "--ci"],
      true,
      { PATH: pathWith(bin) },
    );
    assert.equal(code, 0, out);
    assert.match(out, /compose HTTP services: web \(builds checked-out source\)/);
    assert.match(out, /docker compose accepted the start request \(exit 0\); HTTP health not yet verified/);
    assert.match(out, new RegExp(`observed HTTP 200 at http://localhost:${port}/ready`));
    const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
    assert.equal(att.result.booted, true);
    assert.equal(att.result.healthVerified, true);
    assert.ok(att.observed.some(observed => observed.kind === "service" && observed.exitCode === 0));
    assert.ok(att.observed.some(observed => observed.kind === "health" && observed.ok));
    assert.equal(fs.existsSync(path.join(repo, "docker-compose.bootproof.yml")), false);
  } finally {
    stopFixtureProcess(repo);
  }
});

test("source-built repository Compose failure preserves ps and log evidence", async () => {
  const repo = freshCopy("source-compose-runnable-like");
  const port = await getFreePort();
  fs.writeFileSync(
    path.join(repo, "docker-compose.yml"),
    fs.readFileSync(path.join(repo, "docker-compose.yml"), "utf8").replace("31999", String(port)),
  );
  const bin = path.join(repo, "bin-tools");
  fs.mkdirSync(bin);
  writeDockerShim(bin);

  const { out, code } = run(
    ["up", repo, "--provider", "docker", "--timeout", "500", "--ci"],
    true,
    { PATH: pathWith(bin) },
  );
  assert.equal(code, 1);
  assert.match(out, /NOT VERIFIED — health_check_timeout/);
  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.booted, false);
  assert.equal(att.result.healthVerified, false);
  assert.equal(att.result.failureClass, "health_check_timeout");
  assert.match(att.result.failureEvidence, /source-built fixture did not become healthy/);
  assert.ok(att.observed.some(observed => observed.id === "compose-ps"));
  assert.ok(att.observed.some(observed => observed.id === "compose-logs"));
  assert.ok(att.signature);
});

test("multiple source-built Compose HTTP services refuse before Docker executes", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-compose-ambiguous-"));
  fs.writeFileSync(path.join(repo, "docker-compose.yml"), [
    "services:",
    "  web:",
    "    build: ./web",
    "    ports:",
    "      - \"3101:3000\"",
    "  admin:",
    "    build: ./admin",
    "    ports:",
    "      - \"3102:3000\"",
    "",
  ].join("\n"));
  fs.mkdirSync(path.join(repo, "web"));
  fs.mkdirSync(path.join(repo, "admin"));

  const { out, code } = run(["up", repo, "--provider", "docker", "--ci"], true, { PATH: "" });
  assert.equal(code, 1);
  assert.match(out, /NOT VERIFIED — orchestration_not_supported/);
  assert.match(out, /multiple source-built HTTP services/);
  assert.match(out, /will not treat one responding service as proof/);
  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.failureClass, "orchestration_not_supported");
  assert.deepEqual(att.observed, [], "Docker must not execute for an ambiguous Compose application");
});

test("fix MVP requires uppercase Y, writes receipts, and records changed-failure progress", () => {
  const repo = freshCopy("library-only");
  const bin = path.join(repo, "bin-tools");
  const marker = path.join(repo, "brew-ran.txt");
  const protectedEnv = path.join(repo, ".env");
  writeRepairBrew(bin);
  fs.writeFileSync(protectedEnv, "REAL_SECRET=preserve\n");
  writeFailedAttestation(repo, "missing_build_tool", "ERROR: CMake is required to build Rugged");
  const env = {
    PATH: pathWith(bin),
    BOOTPROOF_REPAIR_MARKER: marker,
  };

  const nonInteractive = run(
    ["fix", repo, "--provider", "local", "--unsafe-local", "--json"],
    true,
    env,
  );
  assert.equal(nonInteractive.code, 1);
  assert.equal(fs.existsSync(marker), false, "JSON mode must not approve host mutation");
  let receipt = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "repair-receipt.json"), "utf8"));
  assert.equal(receipt.applyResult.status, "not_applied");
  assert.equal(receipt.approvedAt, undefined);

  const declined = runWithInput(
    ["fix", repo, "--provider", "local", "--unsafe-local"],
    "y\n",
    env,
  );
  assert.equal(declined.code, 1);
  assert.match(declined.out, /may install or change tools on your local machine/);
  assert.match(declined.out, /Command: brew install cmake/);
  assert.match(declined.out, /Mutation scope: host_tool_install/);
  assert.match(declined.out, /Risk: high/);
  assert.match(declined.out, /Run this command\? Type Y to approve:/);
  assert.equal(fs.existsSync(marker), false, "lowercase y must not approve");
  receipt = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "repair-receipt.json"), "utf8"));
  assert.equal(receipt.applyResult.status, "not_applied");
  assert.equal(receipt.progressed, false);

  const approved = runWithInput(
    ["fix", repo, "--provider", "local", "--unsafe-local", "--timeout", "1000"],
    "Y\n",
    env,
  );
  assert.equal(approved.code, 1, approved.out);
  receipt = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "repair-receipt.json"), "utf8"));
  assert.ok(receipt.approvedAt);
  if (process.platform === "win32") {
    assert.equal(fs.existsSync(marker), false, "the shell-free runner must not execute a .cmd shim");
    assert.equal(receipt.applyResult.status, "failed");
    assert.equal(receipt.appliedAt, undefined);
  } else {
    assert.equal(fs.readFileSync(marker, "utf8"), "install cmake\n");
    assert.equal(receipt.applyResult.status, "applied");
    assert.ok(receipt.appliedAt);
  }
  assert.equal(receipt.afterFailureClass, "not_an_application");
  assert.equal(receipt.progressed, true);
  assert.equal(receipt.verified, false);
  assert.equal(fs.readFileSync(protectedEnv, "utf8"), "REAL_SECRET=preserve\n");
  assert.match(run(["verify", path.join(repo, ".bootproof", "repair-receipt.json")]).out, /signature valid/);
});

test("fix MVP records the safe RAILS_ENV instruction without mutating protected env files", () => {
  const repo = freshCopy("library-only");
  const protectedEnv = path.join(repo, ".env");
  const embeddedPassword = "embedded-password";
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", [
    "remote",
    "add",
    "origin",
    `https://fixture-user:${embeddedPassword}@example.com/bootproof/fixture.git`,
  ], { cwd: repo });
  execFileSync("git", [
    "-c",
    "user.name=BootProof Test",
    "-c",
    "user.email=bootproof@example.invalid",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "fixture",
  ], { cwd: repo });
  fs.writeFileSync(protectedEnv, "DATABASE_PASSWORD=preserve\n");
  writeFailedAttestation(repo, "missing_env_var", "The RAILS_ENV environment variable is not set.");

  const { out, code } = run(["fix", repo, "--json"], true);
  assert.equal(code, 1);
  const result = JSON.parse(out);
  assert.equal(result.repairId, "rerun-with-rails-development");
  assert.equal(result.receiptPath, ".bootproof/repair-receipt.json");
  const receipt = JSON.parse(fs.readFileSync(path.join(repo, result.receiptPath), "utf8"));
  assert.equal(receipt.actionType, "instruction");
  assert.equal(receipt.mutationScope, "none");
  assert.equal(receipt.riskLevel, "low");
  assert.equal(receipt.userApprovalRequired, false);
  assert.equal(receipt.applyResult.status, "not_applied");
  assert.equal(
    receipt.proposedAction.instruction,
    "RAILS_ENV=development bootproof up . --provider local --unsafe-local --install",
  );
  assert.equal(
    receipt.repo.remote,
    "https://[redacted]:[redacted]@example.com/bootproof/fixture.git",
  );
  assert.equal(JSON.stringify(receipt).includes(embeddedPassword), false);
  assert.ok(receipt.redactionsApplied.includes("url credentials"));
  assert.equal(fs.readFileSync(protectedEnv, "utf8"), "DATABASE_PASSWORD=preserve\n");
});

test("fix MVP refuses unknown signed failures without guessing", () => {
  const repo = freshCopy("library-only");
  writeFailedAttestation(repo, "unknown_failure", "unclassified fixture failure");
  const { out, code } = run(["fix", repo, "--json"], true);
  assert.equal(code, 1);
  const result = JSON.parse(out);
  assert.equal(
    result.explanation,
    "No verified deterministic remediation is known for unknown_failure yet.",
  );
  assert.equal(result.receiptPath, null);
  assert.equal(fs.existsSync(path.join(repo, ".bootproof", "repair-receipt.json")), false);
});

test("fix --ai is optional and fails gracefully without a BYOK provider key", () => {
  const repo = freshCopy("library-only");
  writeFailedAttestation(repo, "unknown_failure", "unclassified fixture failure");
  const { out, code } = run(
    ["fix", repo, "--ai"],
    true,
    { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", BOOTPROOF_AI_PROVIDER: "" },
  );
  assert.equal(code, 1);
  assert.match(
    out,
    /AI-assisted repair is optional and requires your own OPENAI_API_KEY or ANTHROPIC_API_KEY/,
  );
  assert.match(out, /deterministic fix work without AI/);
  assert.equal(fs.existsSync(path.join(repo, ".bootproof", "repair-receipt.json")), false);

  const deterministicRepo = freshCopy("library-only");
  writeFailedAttestation(
    deterministicRepo,
    "missing_build_tool",
    "ERROR: CMake is required to build Rugged",
  );
  const deterministic = run(
    ["fix", deterministicRepo, "--ai", "--provider", "local", "--unsafe-local", "--json"],
    true,
    { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" },
  );
  assert.equal(deterministic.code, 1);
  assert.equal(JSON.parse(deterministic.out).repairId, "install-cmake-with-homebrew");
  const receipt = JSON.parse(fs.readFileSync(
    path.join(deterministicRepo, ".bootproof", "repair-receipt.json"),
    "utf8",
  ));
  assert.equal(receipt.source, "deterministic_playbook");
});

test("fix --ai requires two uppercase approvals, reruns BootProof, and records ai_suggested", async () => {
  const repo = freshCopy("library-only");
  const commandMarker = path.join(repo, "ai-command-ran.txt");
  const fetchMarker = path.join(repo, "ai-request.json");
  const protectedEnv = path.join(repo, ".env");
  const command = createRepairCommand(process.execPath, [
    "-e",
    'require("node:fs").writeFileSync(process.argv[1],"ran")',
    path.basename(commandMarker),
  ]);
  const suggestion = {
    schema: "bootproof/ai-repair-suggestion/v1",
    confidence: 0.6,
    failure_class: "unknown_failure",
    suggested_action_type: "command",
    suggested_command: command,
    suggested_patch: null,
    explanation_for_user: "Run one local fixture repair step, then let BootProof verify.",
    risk_level: "low",
    requires_human_approval: true,
    why_this_is_safe: "The exact command is visible and BootProof applies the shared validator.",
    what_to_check_after: "Rerun BootProof and require observed health evidence.",
  };
  const shim = writeAiFetchShim(repo, suggestion, fetchMarker);
  fs.writeFileSync(protectedEnv, "REAL_SECRET=preserve\n");
  writeFailedAttestation(
    repo,
    "unknown_failure",
    "API_SECRET=should-not-leave-machine unclassified fixture failure",
  );
  const env = {
    OPENAI_API_KEY: "fixture-key",
    ANTHROPIC_API_KEY: "",
    NODE_OPTIONS: `--import=${pathToFileURL(shim).href}`,
  };

  const declined = await runWithPromptResponses(
    ["fix", repo, "--ai", "--provider", "local", "--unsafe-local", "--timeout", "1000"],
    [
      { prompt: "Request an AI suggestion using your BYOK provider? Type Y to approve:", answer: "Y" },
      { prompt: "Run this AI-suggested command? Type Y to approve:", answer: "n" },
    ],
    env,
  );
  assert.equal(declined.code, 1, declined.out);
  assert.match(declined.out, /AI-suggested unverified repair/);
  assert.match(declined.out, /Risk: medium/, "shared risk model must upgrade an unknown command");
  assert.equal(fs.existsSync(fetchMarker), true, "the user approved the provider request");
  assert.equal(fs.readFileSync(fetchMarker, "utf8").includes("should-not-leave-machine"), false);
  assert.equal(fs.existsSync(commandMarker), false, "lowercase approval must not execute");
  let receipt = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "repair-receipt.json"), "utf8"));
  assert.equal(receipt.source, "ai_suggested");
  assert.equal(receipt.proposedAction.source, "ai_suggested");
  assert.equal(receipt.applyResult.status, "not_applied");
  assert.equal(receipt.approvedAt, undefined);
  assert.equal(fs.readFileSync(protectedEnv, "utf8"), "REAL_SECRET=preserve\n");

  fs.rmSync(fetchMarker, { force: true });
  const approved = await runWithPromptResponses(
    ["fix", repo, "--ai", "--provider", "local", "--unsafe-local", "--timeout", "1000"],
    [
      { prompt: "Request an AI suggestion using your BYOK provider? Type Y to approve:", answer: "Y" },
      { prompt: "Run this AI-suggested command? Type Y to approve:", answer: "Y" },
    ],
    env,
  );
  assert.equal(approved.code, 1, approved.out);
  assert.equal(fs.readFileSync(commandMarker, "utf8"), "ran");
  receipt = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "repair-receipt.json"), "utf8"));
  assert.equal(receipt.source, "ai_suggested");
  assert.equal(receipt.applyResult.status, "applied");
  assert.ok(receipt.approvedAt);
  assert.ok(receipt.appliedAt);
  assert.equal(receipt.afterFailureClass, "not_an_application");
  assert.equal(receipt.progressed, true);
  assert.equal(receipt.verified, false);
  assert.equal(fs.existsSync(path.join(repo, ".bootproof", "repair-after-attestation.json")), true);
  assert.equal(fs.readFileSync(protectedEnv, "utf8"), "REAL_SECRET=preserve\n");
  assert.match(run(["verify", path.join(repo, ".bootproof", "repair-receipt.json")]).out, /signature valid/);
});

test("bootproof up remains zero-AI even when a provider key and fetch shim exist", () => {
  const repo = freshCopy("library-only");
  const fetchMarker = path.join(repo, "unexpected-ai-request.txt");
  const shim = writeAiFetchShim(repo, {
    schema: "bootproof/ai-repair-suggestion/v1",
  }, fetchMarker);
  const { code } = run(
    ["up", repo, "--provider", "local", "--unsafe-local"],
    true,
    {
      OPENAI_API_KEY: "fixture-key",
      NODE_OPTIONS: `--import=${pathToFileURL(shim).href}`,
    },
  );
  assert.equal(code, 1);
  assert.equal(fs.existsSync(fetchMarker), false, "bootproof up must never call an AI provider");
});

test("expanded fix previews repository patches and never overwrites without approval", () => {
  const repo = freshCopy("library-only");
  const config = path.join(repo, "config");
  const destination = path.join(config, "database.yml");
  fs.mkdirSync(config);
  fs.writeFileSync(
    path.join(config, "database.yml.example"),
    "development:\n  adapter: postgresql\n",
  );
  writeFailedAttestation(repo, "missing_database_config", "Could not load database configuration");

  const declined = runWithInput(
    ["fix", repo, "--provider", "local", "--unsafe-local"],
    "y\n",
  );
  assert.equal(declined.code, 1);
  assert.match(declined.out, /Patch preview:/);
  assert.match(declined.out, /\+\+\+ b\/config\/database\.yml/);
  assert.match(declined.out, /Test this patch in the repair sandbox\? Type Y to approve:/);
  assert.equal(fs.existsSync(destination), false, "lowercase y must not apply or test the patch");
  let receipt = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "repair-receipt.json"), "utf8"));
  assert.equal(receipt.actionType, "patch");
  assert.equal(receipt.applyResult.status, "not_applied");
  assert.equal(receipt.userApprovalRequired, true);

  const approved = runWithInput(
    ["fix", repo, "--provider", "local", "--unsafe-local", "--timeout", "1000"],
    "Y\n",
  );
  assert.equal(approved.code, 1, approved.out);
  assert.equal(fs.existsSync(destination), false, "approved fix must test the patch only in its sandbox");
  receipt = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "repair-receipt.json"), "utf8"));
  assert.equal(receipt.applyResult.status, "applied");
  assert.deepEqual(receipt.applyResult.filesChanged, ["config/database.yml"]);
  assert.equal(receipt.afterFailureClass, "not_an_application");
  assert.equal(receipt.progressed, true);
  assert.equal(receipt.verified, false);
  assert.ok(fs.existsSync(path.join(repo, ".bootproof", "repair-copy-database-config-example.patch")));

  const apply = run(
    ["apply-repair", repo, "--receipt", path.join(repo, ".bootproof", "repair-receipt.json"), "--json"],
    true,
  );
  assert.equal(apply.code, 1);
  assert.match(apply.out, /repair receipt is not verified/);
  assert.equal(fs.existsSync(destination), false);
});

test("repair: conflicting repository Compose port produces signed verified receipt without touching the working tree", async () => {
  const repo = freshCopy("repair-service-port-conflict");
  for (const [name, contents] of Object.entries({
    ".env": "REAL_SECRET=preserve\n",
    ".env.local": "LOCAL_SECRET=preserve\n",
    ".env.development": "DEV_SECRET=preserve\n",
    ".env.production": "PROD_SECRET=preserve\n",
  })) {
    fs.writeFileSync(path.join(repo, name), contents);
  }
  const occupied = await getFreePort();
  fs.writeFileSync(
    path.join(repo, "docker-compose.yml"),
    fs.readFileSync(path.join(repo, "docker-compose.yml"), "utf8").replace("31998", String(occupied)),
  );
  const bin = path.join(repo, "bin-tools");
  fs.mkdirSync(bin);
  writeDockerShim(bin);
  const blocker = await occupyPort(occupied);
  const beforeHash = hashWorkingTree(repo);

  try {
    const { out, code } = run(
      ["fix", repo, "--provider", "docker", "--timeout", "10000", "--json"],
      true,
      { PATH: pathWith(bin) },
    );
    assert.equal(code, 0, out);
    assert.equal(out.trim().split("\n").length, 1, "repair JSON mode must emit one object");
    const result = JSON.parse(out);
    assert.equal(result.schema, "bootproof/repair-result/v1");
    assert.equal(result.repaired, true);
    assert.equal(result.failureClass, "service_port_allocated");
    assert.equal(result.repairId, "remap-conflicting-service-port");
    assert.equal(result.receiptPath, ".bootproof/repair-receipt.json");
    assert.equal(result.patchPath, ".bootproof/repair-remap-conflicting-service-port.patch");

    assert.equal(hashWorkingTree(repo), beforeHash, "repair must not mutate any original working-tree byte");
    assert.equal(fs.existsSync(path.join(repo, "docker-compose.bootproof.override.yml")), false);
    const receiptPath = path.join(repo, result.receiptPath);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.schema, "bootproof/repair-receipt/v1");
    assert.equal(receipt.repairId, "remap-conflicting-service-port");
    assert.equal(receipt.actionType, "patch");
    assert.equal(receipt.mutationScope, "repo_only");
    assert.equal(receipt.riskLevel, "low");
    assert.equal(receipt.userApprovalRequired, true);
    assert.equal(receipt.applyResult.status, "applied");
    assert.equal(receipt.progressed, true);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.proposedAction.source, "deterministic_playbook");
    assert.equal(receipt.repair.kind, "plan-step");
    assert.deepEqual(receipt.repair.filesChanged, ["docker-compose.bootproof.override.yml"]);
    assert.equal(receipt.repair.diff, null);
    assert.equal(receipt.repair.fileChanges.length, 1);
    assert.equal(receipt.repair.fileChanges[0].beforeSha256, null);
    assert.match(receipt.repair.fileChanges[0].afterContent, /complete repaired copy/);
    assert.match(receipt.repair.fileChanges[0].afterContent, /build:/);
    assert.doesNotMatch(receipt.repair.fileChanges[0].afterContent, /!override/);
    assert.deepEqual(receipt.repair.preconditions.map(precondition => precondition.path), ["docker-compose.yml"]);
    assert.match(receipt.repair.planDelta, /complete repaired copy/);
    assert.equal(receipt.verification.before.booted, false);
    assert.equal(receipt.verification.before.failureClass, "service_port_allocated");
    assert.equal(receipt.verification.after.booted, true);
    assert.match(receipt.verification.after.healthObservation, /HTTP 200/);
    assert.ok(receipt.signature);

    const after = JSON.parse(fs.readFileSync(path.join(repo, result.afterAttestationPath), "utf8"));
    assert.equal(after.result.booted, true);
    assert.equal(after.result.healthVerified, true);
    assert.ok(after.observed.some(observed => observed.kind === "health" && observed.ok));
    const before = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
    const beforeAttestationHash = crypto.createHash("sha256").update(JSON.stringify(before)).digest("hex");
    const afterAttestationHash = crypto.createHash("sha256").update(JSON.stringify(after)).digest("hex");
    assert.equal(receipt.failure.beforeAttestationSha256, beforeAttestationHash);
    assert.equal(receipt.verification.before.attestationSha256, beforeAttestationHash);
    assert.equal(receipt.verification.after.attestationSha256, afterAttestationHash);
    assert.match(run(["verify", path.join(repo, result.afterAttestationPath)]).out, /signature valid/);

    const patch = fs.readFileSync(path.join(repo, result.patchPath), "utf8");
    assert.match(patch, /docker-compose\.bootproof\.override\.yml/);
    assert.match(patch, /complete repaired copy/);
    assert.doesNotMatch(patch, /!override/);
    assert.match(run(["verify", receiptPath]).out, /repair receipt signature valid/);
    assert.match(run(["explain", receiptPath]).out, /Before: NOT VERIFIED — service_port_allocated/);

    const applyDryRun = run(["apply-repair", repo, "--dry-run", "--json"], true);
    assert.equal(applyDryRun.code, 1);
    assert.match(JSON.parse(applyDryRun.out).explanation, /no repair files were applied/i);
    assert.equal(fs.existsSync(path.join(repo, "docker-compose.bootproof.override.yml")), false);

    const sourceCompose = fs.readFileSync(path.join(repo, "docker-compose.yml"), "utf8");
    fs.writeFileSync(path.join(repo, "docker-compose.yml"), `${sourceCompose}# changed after verification\n`);
    const staleInput = run(["apply-repair", repo, "--json"], true);
    assert.equal(staleInput.code, 1);
    assert.match(JSON.parse(staleInput.out).explanation, /prerequisite mismatch/);
    assert.equal(fs.existsSync(path.join(repo, "docker-compose.bootproof.override.yml")), false);
    fs.writeFileSync(path.join(repo, "docker-compose.yml"), sourceCompose);

    const applied = run(["apply-repair", repo, "--json"], true);
    assert.equal(applied.code, 0, applied.out);
    const applyResult = JSON.parse(applied.out);
    assert.equal(applyResult.schema, "bootproof/repair-apply-result/v1");
    assert.equal(applyResult.applied, true);
    assert.deepEqual(applyResult.filesChanged, ["docker-compose.bootproof.override.yml"]);
    const appliedCompose = fs.readFileSync(path.join(repo, "docker-compose.bootproof.override.yml"), "utf8");
    assert.match(appliedCompose, /complete repaired copy/);
    assert.doesNotMatch(appliedCompose, /!override/);
    for (const [name, contents] of Object.entries({
      ".env": "REAL_SECRET=preserve\n",
      ".env.local": "LOCAL_SECRET=preserve\n",
      ".env.development": "DEV_SECRET=preserve\n",
      ".env.production": "PROD_SECRET=preserve\n",
    })) {
      assert.equal(fs.readFileSync(path.join(repo, name), "utf8"), contents);
    }
    const stale = run(["apply-repair", repo, "--json"], true);
    assert.equal(stale.code, 1);
    assert.match(JSON.parse(stale.out).explanation, /preimage mismatch/);

    receipt.verification.after.booted = false;
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    const tampered = run(["verify", receiptPath], true);
    assert.equal(tampered.code, 1);
    assert.match(tampered.out, /signature INVALID/);
  } finally {
    blocker.close();
  }
});

test("repair: local sandbox execution still requires explicit unsafe acknowledgement", () => {
  const repo = freshCopy("hello-app");
  const beforeHash = hashWorkingTree(repo);
  const { out, code } = run(["fix", repo, "--provider", "local", "--json"], true);
  assert.equal(code, 1);
  const result = JSON.parse(out);
  assert.equal(result.repaired, false);
  assert.match(result.explanation, /--unsafe-local/);
  assert.equal(hashWorkingTree(repo), beforeHash);
  assert.equal(fs.existsSync(path.join(repo, ".bootproof")), false, "refused repair must not write evidence for an execution that never ran");
});

test("repair: declared package manager activation is verified end to end", async () => {
  const repo = freshCopy("pnpm-version-mismatch");
  const bin = path.join(repo, "bin-tools");
  writePackageRepairTools(bin);
  const port = await getFreePort();
  const beforeHash = hashWorkingTree(repo);

  const { out, code } = run(
    ["fix", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "10000", "--json"],
    true,
    { PATH: pathWith(bin) },
  );
  assert.equal(code, 0, out);
  const result = JSON.parse(out);
  assert.equal(result.repaired, true);
  assert.equal(result.failureClass, "package_manager_version_mismatch");
  assert.equal(result.repairId, "activate-declared-package-manager");
  assert.equal(result.patchPath, null);
  assert.equal(hashWorkingTree(repo), beforeHash);

  const receipt = JSON.parse(fs.readFileSync(path.join(repo, result.receiptPath), "utf8"));
  assert.equal(receipt.actionType, "command");
  assert.equal(receipt.mutationScope, "project_cache");
  assert.equal(receipt.riskLevel, "medium");
  assert.equal(receipt.userApprovalRequired, true);
  assert.equal(receipt.proposedAction.command.display, "corepack prepare pnpm@10.24.0 --activate");
  assert.equal(receipt.repair.kind, "environment");
  assert.equal(receipt.repair.envDelta, "corepack prepare pnpm@10.24.0 --activate");
  assert.deepEqual(receipt.repair.fileChanges, []);
  assert.equal(receipt.verification.after.booted, true);
  assert.match(receipt.verification.after.healthObservation, /HTTP 200/);
  assert.match(run(["verify", path.join(repo, result.receiptPath)]).out, /repair receipt signature valid/);
});

test("repair: Prisma migration preparation is verified end to end", async () => {
  const repo = freshCopy("repair-prisma-migrations");
  const bin = path.join(repo, "bin-tools");
  writePrismaRepairTools(bin);
  const port = await getFreePort();
  const beforeHash = hashWorkingTree(repo);

  const { out, code } = run(
    ["fix", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "10000", "--json"],
    true,
    { PATH: pathWith(bin) },
  );
  assert.equal(code, 0, out);
  const result = JSON.parse(out);
  assert.equal(result.repaired, true);
  assert.equal(result.failureClass, "migrations_missing");
  assert.equal(result.repairId, "deploy-prisma-migrations");
  assert.equal(result.patchPath, null);
  assert.equal(hashWorkingTree(repo), beforeHash);

  const receipt = JSON.parse(fs.readFileSync(path.join(repo, result.receiptPath), "utf8"));
  assert.equal(receipt.repair.kind, "plan-step");
  assert.match(receipt.repair.planDelta, /npx prisma migrate deploy/);
  assert.deepEqual(receipt.repair.fileChanges, []);
  assert.equal(receipt.verification.after.booted, true);
  assert.match(receipt.verification.after.healthObservation, /HTTP 200/);
});

test("repair: Django migration preparation is selected from markers and verified end to end", async () => {
  const repo = freshCopy("repair-django-migrations");
  const bin = path.join(repo, "bin-tools");
  writeDjangoRepairTools(bin);
  const port = await getFreePort();
  const beforeHash = hashWorkingTree(repo);

  const { out, code } = run(
    ["fix", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "10000", "--json"],
    true,
    { PATH: pathWith(bin) },
  );
  assert.equal(code, 0, out);
  const result = JSON.parse(out);
  assert.equal(result.repaired, true);
  assert.equal(result.failureClass, "migrations_missing");
  assert.equal(result.repairId, "apply-django-migrations");
  assert.equal(result.patchPath, null);
  assert.equal(hashWorkingTree(repo), beforeHash);

  const receipt = JSON.parse(fs.readFileSync(path.join(repo, result.receiptPath), "utf8"));
  assert.equal(receipt.repair.kind, "plan-step");
  assert.match(receipt.repair.planDelta, /python manage\.py migrate --noinput/);
  assert.equal(receipt.verification.after.booted, true);
  assert.match(receipt.verification.after.healthObservation, /HTTP 200/);
});

test("repair: public GitHub URL runs only through the retained managed clone and current local safety gate", async () => {
  const remote = fakeGithubRemote("pnpm-version-mismatch", source => {
    writePackageRepairTools(path.join(source, "bin-tools"));
    fs.writeFileSync(path.join(source, ".gitignore"), ".bootproof/\n");
  });
  const port = await getFreePort();
  const sourceHash = hashWorkingTree(remote.source);
  const bin = path.join(remote.source, "bin-tools");

  const refused = run(
    ["fix", remote.url, "--provider", "local", "--port", String(port), "--json"],
    true,
    { ...remote.env, PATH: pathWith(bin) },
    remote.cwd,
  );
  assert.equal(refused.code, 1);
  assert.match(JSON.parse(refused.out).explanation, /--unsafe-local/);

  const repaired = run(
    ["fix", remote.url, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "10000", "--json"],
    true,
    { ...remote.env, PATH: pathWith(bin) },
    remote.cwd,
  );
  assert.equal(repaired.code, 0, repaired.out);
  const result = JSON.parse(repaired.out);
  assert.equal(result.repaired, true);
  assert.match(result.receiptPath, /^\.bootproof\/remotes\/github\.com\/example\/hello-app-[^/]+\/repo\/\.bootproof\/repair-receipt\.json$/);
  assert.equal(fs.existsSync(path.join(remote.cwd, result.receiptPath)), true);
  assert.equal(fs.existsSync(path.join(remote.source, ".bootproof")), false);
  assert.equal(hashWorkingTree(remote.source), sourceHash);
  assert.match(run(["verify", path.join(remote.cwd, result.receiptPath)]).out, /repair receipt signature valid/);
});

test("repair: public GitLab URL uses the same retained-clone and execution safety gates", async () => {
  const remote = fakeRemote(
    "pnpm-version-mismatch",
    "https://gitlab.com/example/platform/hello-app.git",
    source => {
      writePackageRepairTools(path.join(source, "bin-tools"));
      fs.writeFileSync(path.join(source, ".gitignore"), ".bootproof/\n");
    },
  );
  const port = await getFreePort();
  const bin = path.join(remote.source, "bin-tools");

  const refused = run(
    ["fix", remote.url, "--provider", "local", "--port", String(port), "--json"],
    true,
    { ...remote.env, PATH: pathWith(bin) },
    remote.cwd,
  );
  assert.equal(refused.code, 1);
  assert.match(JSON.parse(refused.out).explanation, /--unsafe-local/);

  const repaired = run(
    ["fix", remote.url, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "10000", "--json"],
    true,
    { ...remote.env, PATH: pathWith(bin) },
    remote.cwd,
  );
  assert.equal(repaired.code, 0, repaired.out);
  const result = JSON.parse(repaired.out);
  assert.match(result.receiptPath, /^\.bootproof\/remotes\/gitlab\.com\/example\/platform\/hello-app-[^/]+\/repo\/\.bootproof\/repair-receipt\.json$/);
  assert.equal(fs.existsSync(path.join(remote.cwd, result.receiptPath)), true);
});

test("repair: dry run executes nothing, writes nothing, and proves nothing", () => {
  const repo = freshCopy("repair-service-port-conflict");
  const beforeHash = hashWorkingTree(repo);
  const { out, code } = run(["fix", repo, "--dry-run", "--json"], true, { PATH: "" });
  assert.equal(code, 1);
  const result = JSON.parse(out);
  assert.equal(result.repaired, false);
  assert.match(result.explanation, /nothing was executed, nothing was written/i);
  assert.equal(hashWorkingTree(repo), beforeHash);
  assert.equal(fs.existsSync(path.join(repo, ".bootproof")), false);
});

test("repair: fresh signed failure at the exact clean commit is reused", async () => {
  const repo = freshCopy("repair-service-port-conflict");
  const occupied = await getFreePort();
  fs.writeFileSync(
    path.join(repo, "docker-compose.yml"),
    fs.readFileSync(path.join(repo, "docker-compose.yml"), "utf8").replace("31998", String(occupied)),
  );
  fs.writeFileSync(path.join(repo, ".gitignore"), ".bootproof/\n");
  const bin = path.join(repo, "bin-tools");
  fs.mkdirSync(bin);
  writeDockerShim(bin);
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "BootProof Test");
  git("config", "user.email", "bootproof@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  const blocker = await occupyPort(occupied);

  try {
    const baseline = run(
      ["up", repo, "--provider", "docker", "--timeout", "500", "--ci", "--json"],
      true,
      { PATH: pathWith(bin) },
    );
    assert.equal(baseline.code, 1);
    assert.equal(JSON.parse(baseline.out).failureClass, "service_port_allocated");
    const beforeAttestation = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
    assert.equal(beforeAttestation.repo.dirty, false);
    const treeHash = hashWorkingTree(repo);

    const fixed = run(
      ["fix", repo, "--timeout", "10000", "--json"],
      true,
      { PATH: pathWith(bin), BOOTPROOF_FAIL_IF_BASELINE_RERUN: "1" },
    );
    assert.equal(fixed.code, 0, fixed.out);
    const result = JSON.parse(fixed.out);
    assert.equal(result.repaired, true);
    assert.equal(result.failureClass, "service_port_allocated");
    assert.equal(hashWorkingTree(repo), treeHash);
  } finally {
    blocker.close();
  }
});

test("repair: known remediation that does not boot writes no receipt and preserves attempt evidence", async () => {
  const repo = freshCopy("repair-service-port-conflict");
  const occupied = await getFreePort();
  fs.writeFileSync(
    path.join(repo, "docker-compose.yml"),
    fs.readFileSync(path.join(repo, "docker-compose.yml"), "utf8").replace("31998", String(occupied)),
  );
  fs.writeFileSync(path.join(repo, ".fake-repair-stall"), "remain unhealthy\n");
  const bin = path.join(repo, "bin-tools");
  fs.mkdirSync(bin);
  writeDockerShim(bin);
  const blocker = await occupyPort(occupied);
  const beforeHash = hashWorkingTree(repo);

  try {
    const { out, code } = run(
      ["fix", repo, "--provider", "docker", "--timeout", "500", "--json"],
      true,
      { PATH: pathWith(bin) },
    );
    assert.equal(code, 1);
    const result = JSON.parse(out);
    assert.equal(result.repaired, false);
    assert.equal(result.failureClass, "service_port_allocated");
    assert.match(result.explanation, /known remediation .* did not resolve it; evidence preserved/);
    assert.equal(fs.existsSync(path.join(repo, ".bootproof", "repair-receipt.json")), false);
    assert.equal(fs.existsSync(path.join(repo, ".bootproof", "repair-remap-conflicting-service-port.patch")), false);
    assert.equal(hashWorkingTree(repo), beforeHash);
    const failed = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
    assert.equal(failed.result.failureClass, "service_port_allocated");
    assert.match(failed.result.failureEvidence, /Repair attempt remap-conflicting-service-port/);
    assert.match(failed.result.failureEvidence, /did not resolve it; evidence preserved/);
    assert.ok(failed.signature);
  } finally {
    blocker.close();
  }
});

test("repair: unregistered failure exits honestly without a receipt", () => {
  const repo = freshCopy("library-only");
  const { out, code } = run(["fix", repo, "--json"], true);
  assert.equal(code, 1);
  const result = JSON.parse(out);
  assert.equal(result.schema, "bootproof/repair-result/v1");
  assert.equal(result.repaired, false);
  assert.equal(result.failureClass, "not_an_application");
  assert.equal(result.receiptPath, null);
  assert.equal(result.patchPath, null);
  assert.equal(
    result.explanation,
    "No verified deterministic remediation is known for not_an_application yet.",
  );
  assert.equal(fs.existsSync(path.join(repo, ".bootproof", "repair-receipt.json")), false);
  const attestation = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(attestation.result.failureClass, "not_an_application");
  assert.ok(attestation.signature);
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
  writeFakePnpm(bin, "9.15.4");

  const { out, code } = run(
    ["up", repo, "--provider", "local", "--unsafe-local", "--install", "--ci"],
    true,
    { PATH: pathWith(bin) },
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

test("missing environment failures name extracted secrets without inventing values", async () => {
  const repo = freshCopy("missing-env-failure");
  const port = await getFreePort();
  const { out, code } = run(
    ["up", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "10000", "--ci"],
    true,
  );
  assert.equal(code, 1);
  assert.match(out, /NOT VERIFIED — missing_env_var/);
  assert.match(out, /Missing: API_SECRET — see \.env\.bootproof\.example; bootproof will not invent values\./);

  const generated = path.join(repo, ".env.bootproof.example");
  assert.ok(fs.existsSync(generated), "referenced generated env example must exist");
  const generatedContents = fs.readFileSync(generated, "utf8");
  assert.match(generatedContents, /# API_SECRET= \(secret with no safe local default/);
  assert.doesNotMatch(generatedContents, /^API_SECRET=.+/m, "secret-looking variables must not receive invented values");
  assert.doesNotMatch(out, /API_SECRET=[^\s]/, "terminal guidance must not invent a secret value");
  for (const name of [".env", ".env.local", ".env.development", ".env.production"]) {
    assert.equal(fs.existsSync(path.join(repo, name)), false, `${name} must not be written`);
  }

  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.failureClass, "missing_env_var");
  assert.match(att.result.failureEvidence, /Missing required secret: API_SECRET/);
  assert.match(att.result.explanation, /Missing: API_SECRET/);
  assert.equal(att.result.booted, false);
  assert.equal(att.result.healthVerified, false);
});

test("missing RAILS_ENV gives a safe local value without claiming an env example exists", async () => {
  const repo = freshCopy("hello-app");
  const port = await getFreePort();
  const protectedFiles = {
    ".env": "KEEP_ENV=unchanged\n",
    ".env.local": "KEEP_LOCAL=unchanged\n",
    ".env.development": "KEEP_DEVELOPMENT=unchanged\n",
    ".env.production": "KEEP_PRODUCTION=unchanged\n",
  };
  for (const [name, contents] of Object.entries(protectedFiles)) {
    fs.writeFileSync(path.join(repo, name), contents);
  }
  fs.writeFileSync(path.join(repo, "server.js"), `
console.error("The RAILS_ENV environment variable is not set.");
process.exit(1);
`);

  const { out, code } = run(
    ["up", repo, "--provider", "local", "--unsafe-local", "--install", "--port", String(port), "--timeout", "1200", "--ci"],
    true,
    { RAILS_ENV: "" },
  );
  assert.equal(code, 1);
  assert.match(out, /NOT VERIFIED — missing_env_var/);
  assert.match(out, /What happened: Missing variable: RAILS_ENV\. Safe local value: development\./);
  assert.match(out, /Safe next step: RAILS_ENV=development bootproof up \. --provider local --unsafe-local --install/);
  assert.doesNotMatch(out, /\.env\.bootproof\.example/);
  assert.equal(fs.existsSync(path.join(repo, ".env.bootproof.example")), false);

  for (const [name, contents] of Object.entries(protectedFiles)) {
    assert.equal(fs.readFileSync(path.join(repo, name), "utf8"), contents, `${name} must not be mutated`);
  }

  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.failureClass, "missing_env_var");
  assert.match(att.result.failureEvidence, /RAILS_ENV environment variable is not set/);
  assert.match(att.result.explanation, /Missing variable: RAILS_ENV\. Safe local value: development\./);
  assert.doesNotMatch(att.result.explanation, /\.env\.bootproof\.example/);
});

test("app exited early preserves evidence head, tail, and extracted Rails cause", async () => {
  const repo = freshCopy("app-exited-rails-backtrace");
  const port = await getFreePort();
  const { code } = run(
    ["up", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "1200", "--ci"],
    true,
  );
  assert.equal(code, 1);

  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.failureClass, "app_exited_early");
  const start = att.observed.find(step => step.kind === "start-app");
  assert.equal(start.ok, false);
  assert.match(start.evidenceHead, /config\/database\.yml is missing \(RuntimeError\)/);
  assert.match(start.evidenceTail, /rails-\d+\.rb:\d+:in 'boot'/);
  assert.doesNotMatch(start.evidenceTail, /config\/database\.yml is missing/, "the fixture must prove the cause fell outside the retained tail");
  assert.equal(start.firstErrorLine, "config/database.yml is missing (RuntimeError)");
  assert.equal(start.firstExceptionLine, "config/database.yml is missing (RuntimeError)");
  assert.equal(start.detectedCause, "missing config/database.yml");
  assert.ok(start.evidenceTail.length <= 4000, "existing bounded evidenceTail behavior must remain intact");
  assert.match(att.result.failureEvidence, /Detected cause: missing config\/database\.yml/);
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
  assert.equal(att.result.healthEvidence.requestedUrl, `http://localhost:${port}/`);
  assert.equal(att.result.healthEvidence.statusCode, 500);
  assert.equal(att.result.healthEvidence.statusText, "Internal Server Error");
  assert.equal(att.result.healthEvidence.bodyExcerpt, "fixture failure");
  assert.equal(att.result.healthEvidence.acceptedAsHealthy, false);
  assert.equal(att.result.healthEvidence.connectionError, null);
  assert.ok(att.observed.some(step => step.kind === "health" && step.ok === false));
});

test("connection refusal is not verified and is preserved in health evidence", async () => {
  const repo = freshCopy("hello-app");
  const port = await getFreePort();
  fs.writeFileSync(path.join(repo, "server.js"), "setInterval(() => {}, 1000);");
  const { code } = run(
    ["up", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "1200", "--ci"],
    true,
  );
  assert.equal(code, 1);
  const att = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"));
  assert.equal(att.result.booted, false);
  assert.equal(att.result.healthVerified, false);
  assert.equal(att.result.healthEvidence.requestedUrl, `http://localhost:${port}/`);
  assert.equal(att.result.healthEvidence.statusCode, null);
  assert.equal(att.result.healthEvidence.statusText, null);
  assert.deepEqual(att.result.healthEvidence.headers, {});
  assert.equal(att.result.healthEvidence.redirectLocation, null);
  assert.equal(att.result.healthEvidence.bodyExcerpt, "");
  assert.equal(att.result.healthEvidence.acceptedAsHealthy, false);
  assert.match(att.result.healthEvidence.connectionError, /ECONNREFUSED|connect/i);
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
  writeFakePnpm(bin, "10.24.0");

  const { out, code } = run(
    ["up", repo, "--install", "--ci"],
    true,
    { PATH: pathWith(bin) },
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

test("advertised Vite port mismatch is preserved as a precise failed attestation", async () => {
  const repo = freshCopy("hello-app");
  const inferredPort = await getFreePort();
  let advertisedPort = await getFreePort();
  while (advertisedPort === inferredPort) advertisedPort = await getFreePort();
  fs.writeFileSync(path.join(repo, "server.js"), `
console.log("Local: https://localhost:${advertisedPort}/");
setInterval(() => {}, 1000);
`);
  const { code } = run(
    [
      "up",
      repo,
      "--provider",
      "local",
      "--unsafe-local",
      "--port",
      String(inferredPort),
      "--timeout",
      "500",
      "--ci",
    ],
    true,
  );
  assert.equal(code, 1);
  const att = JSON.parse(
    fs.readFileSync(path.join(repo, ".bootproof", "attestation.json"), "utf8"),
  );
  assert.equal(att.result.failureClass, "health_candidate_port_mismatch");
  assert.ok(att.result.observedHealthCandidates.includes(`https://localhost:${advertisedPort}/`));
  assert.match(att.result.failureEvidence, new RegExp(`inferredHealthUrl: http://localhost:${inferredPort}/`));
  assert.match(att.result.failureEvidence, new RegExp(`advertisedHealthUrl: https://localhost:${advertisedPort}/`));
  assert.match(att.result.failureEvidence, /selectedCommand: npm run start/);
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

test("diff CLI emits static human and JSON drift results without executing code", () => {
  const repo = createCliDiffRepo();
  const human = run(["diff"], false, {}, repo);
  assert.equal(human.code, 0);
  assert.match(human.out, /Static infrastructure diff/);
  assert.match(human.out, /Base: HEAD\^/);
  assert.match(human.out, /Added services:/);
  assert.match(human.out, /docker-compose\.yml:new/);
  assert.match(human.out, /Removed services:/);
  assert.match(human.out, /docker-compose\.yml:old/);
  assert.match(human.out, /Static analysis only\. No repository code was executed/);
  assert.doesNotMatch(human.out, /first-secret|second-secret/);
  assert.equal(fs.existsSync(path.join(repo, ".executed")), false);

  const machine = run(["diff", "--base", "HEAD^", "--head", "HEAD", "--json"], false, {}, repo);
  const result = JSON.parse(machine.out);
  assert.equal(result.schema, "bootproof/diff-result/v1");
  assert.deepEqual(result.addedEnvVars, ["NEW_ENV"]);
  assert.deepEqual(result.removedEnvVars, ["OLD_ENV"]);
  assert.ok(result.changedFiles.includes("package.json"));
  assert.equal(result.changedCommands.length, 1);
  assert.equal(result.proofRequired, true);
  assert.doesNotMatch(machine.out, /first-secret|second-secret/);
  assert.equal(fs.existsSync(path.join(repo, ".executed")), false);
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
  assert.equal(fs.existsSync(path.join(repo, ".bootproof", "registry-entry.json")), false);
  const { out } = run(["attest", "export", repo]);
  assert.match(out, /Nothing has been uploaded/);
  assert.ok(fs.existsSync(path.join(repo, ".bootproof", "registry-entry.json")));
  const entry = JSON.parse(fs.readFileSync(path.join(repo, ".bootproof", "registry-entry.json"), "utf8"));
  assert.equal(entry.schema, "bootproof/registry-entry/v1");
  assert.equal(entry.optInRequired, true);
  const check = run(["attest", "check", repo]);
  assert.match(check.out, /signature valid/);
});

test("registry export: explicit federated receipt write is local, signed, and opt-in", async () => {
  const repo = freshCopy("hello-app");
  const port = await getFreePort();
  run(["up", repo, "--provider", "local", "--unsafe-local", "--port", String(port), "--timeout", "20000"]);
  assert.equal(fs.existsSync(path.join(repo, ".bootproof", "registry")), false);

  const { out, code } = run(["registry", "export", repo, "--federated"]);
  assert.equal(code, 0, out);
  assert.match(out, /Nothing has been uploaded/);
  assert.match(out, /public candidate/);
  const registryDir = path.join(repo, ".bootproof", "registry");
  const files = fs.readdirSync(registryDir);
  assert.equal(files.length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(registryDir, files[0]), "utf8"));
  assert.equal(receipt.schema, "bootproof/federated-receipt/v1");
  assert.equal(receipt.registryEntry.registryMode, "federated_public_candidate");
  assert.equal(receipt.registryEntry.optInRequired, true);
  assert.equal(receipt.publicRepoDeclaration, true);
  assert.equal(receipt.noSecretsIncluded, true);
  assert.equal(receipt.signature.algorithm, "ed25519");
});
