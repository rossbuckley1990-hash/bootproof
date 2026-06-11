import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

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
  assert.equal(result.explanation, "no verified remediation is known for not_an_application yet");
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
  assert.match(fs.readFileSync(generated, "utf8"), /# API_SECRET= \(secret with no safe local default/);
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
