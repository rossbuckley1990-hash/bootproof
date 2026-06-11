import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bootproof-pack-"));
const packDir = path.join(tempRoot, "pack");
const installDir = path.join(tempRoot, "consumer");
const homeDir = path.join(tempRoot, "home");
const targetsDir = path.join(tempRoot, "targets");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

for (const dir of [packDir, installDir, homeDir, targetsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const env = {
  ...process.env,
  HOME: homeDir,
  NO_COLOR: "1",
  npm_config_audit: "false",
  npm_config_fund: "false",
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
  });

  if (result.error) throw result.error;
  if (options.expectedStatus !== undefined) {
    assert.equal(
      result.status,
      options.expectedStatus,
      `${command} ${args.join(" ")} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } else {
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function copyFixture(name, destinationName = name) {
  const destination = path.join(targetsDir, destinationName);
  fs.cpSync(path.join(repoRoot, "fixtures", name), destination, { recursive: true });
  return destination;
}

function installFakeGit(remoteSource) {
  const bin = path.join(tempRoot, "fake-git-bin");
  fs.mkdirSync(bin);
  const locator = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" });
  assert.equal(locator.status, 0, `could not locate git: ${locator.stderr}`);
  const realGit = locator.stdout.trim().split(/\r?\n/)[0];
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
    ["config", "user.name", "BootProof Pack Test"],
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
    const wrapper = path.join(bin, "git");
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec node "$(dirname "$0")/fake-git.cjs" "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
  }
  env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  env.BOOTPROOF_REAL_GIT = realGit;
  env.BOOTPROOF_FAKE_REMOTE = remoteSource;
}

function assertProtectedEnvFilesUntouched(target) {
  for (const name of [".env", ".env.local", ".env.development", ".env.production"]) {
    assert.equal(fs.existsSync(path.join(target, name)), false, `${name} must not be written`);
  }
}

async function unusedPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      const port = address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

try {
  const packed = run(npmCommand, ["pack", "--json", "--pack-destination", packDir]);
  const packInfo = JSON.parse(packed.stdout)[0];
  const fileNames = packInfo.files.map(file => file.path);
  const forbidden = fileNames.filter(file =>
    /(^|\/)(?:\.git|node_modules|\.DS_Store|\.bootproof)(?:\/|$)/.test(file)
    || file.endsWith(".tgz")
    || file.startsWith("fixtures/")
    || file.startsWith("src/")
    || file.startsWith("tests/")
  );

  assert.deepEqual(forbidden, [], `forbidden package entries: ${forbidden.join(", ")}`);
  assert(fileNames.includes("dist/cli.js"), "package must contain dist/cli.js");
  assert(fileNames.includes("README.md"), "package must contain README.md");
  assert(fileNames.includes("LICENSE"), "package must contain LICENSE");

  const tarball = path.join(packDir, packInfo.filename);
  fs.writeFileSync(
    path.join(installDir, "package.json"),
    JSON.stringify({ name: "bootproof-packed-smoke", private: true }, null, 2),
  );
  run(npmCommand, ["install", tarball, "--no-audit", "--no-fund"], { cwd: installDir });

  const binary = path.join(
    installDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "bootproof.cmd" : "bootproof",
  );
  assert(fs.existsSync(binary), "installed package must expose the bootproof executable");
  if (process.platform !== "win32") {
    assert((fs.statSync(binary).mode & 0o111) !== 0, "installed bootproof executable must have an execute bit");
  }

  const help = run(binary, ["--help"], { cwd: installDir });
  assert.match(help.stdout, /Human diagnosis\. Machine proof\. One engine\./);
  assert.match(help.stdout, /bootproof fix <path>/);

  const refusalTarget = copyFixture("early-refusal-attestation");
  const refusal = run(binary, ["up", refusalTarget, "--ci", "--json"], {
    cwd: installDir,
    expectedStatus: 1,
  });
  const refusalResult = JSON.parse(refusal.stdout);
  assert.equal(refusalResult.failureClass, "not_an_application");
  assert.equal(refusalResult.booted, false);
  assert.equal(refusalResult.healthVerified, false);
  const refusalAttestation = path.join(refusalTarget, ".bootproof", "attestation.json");
  assert(fs.existsSync(refusalAttestation), "early refusal must write an attestation");
  assert.match(run(binary, ["verify", refusalAttestation], { cwd: installDir }).stdout, /signature valid/);
  assert.match(run(binary, ["explain", refusalAttestation], { cwd: installDir }).stdout, /Failure class: not_an_application/);
  assertProtectedEnvFilesUntouched(refusalTarget);

  const repairTarget = copyFixture("library-only", "repair-library");
  const repair = run(binary, ["fix", repairTarget, "--json"], {
    cwd: installDir,
    expectedStatus: 1,
  });
  const repairResult = JSON.parse(repair.stdout);
  assert.equal(repairResult.schema, "bootproof/repair-result/v1");
  assert.equal(repairResult.repaired, false);
  assert.equal(repairResult.failureClass, "not_an_application");
  assert.equal(repairResult.receiptPath, null);

  const helloTarget = copyFixture("hello-app");
  const port = await unusedPort();
  const healthy = run(
    binary,
    [
      "up",
      helloTarget,
      "--provider",
      "local",
      "--unsafe-local",
      "--port",
      String(port),
      "--timeout",
      "20000",
      "--ci",
      "--json",
    ],
    { cwd: installDir, timeout: 40_000 },
  );
  const healthyResult = JSON.parse(healthy.stdout);
  assert.equal(healthyResult.booted, true);
  assert.equal(healthyResult.healthVerified, true);
  assertProtectedEnvFilesUntouched(helloTarget);

  const remoteSource = copyFixture("hello-app", "remote-hello-source");
  installFakeGit(remoteSource);
  const remote = run(binary, ["up", "https://github.com/example/hello-app", "--ci", "--json"], {
    cwd: installDir,
    expectedStatus: 1,
  });
  const remoteResult = JSON.parse(remote.stdout);
  assert.equal(remoteResult.failureClass, "unknown_failure");
  assert.match(remoteResult.explanation, /will not execute remote repository code/);
  const remoteAttestation = path.join(installDir, remoteResult.attestationPath);
  assert(fs.existsSync(remoteAttestation), "remote safety refusal must write an attestation");
  assert.match(run(binary, ["verify", remoteAttestation], { cwd: installDir }).stdout, /signature valid/);

  console.log(`packed: ${packInfo.filename} (${packInfo.size} bytes, ${fileNames.length} files)`);
  console.log("help: ok");
  console.log("early refusal: exit 1, signed not_an_application attestation verified and explained");
  console.log("repair refusal: exit 1, no unverified repair receipt emitted");
  console.log(`healthy fixture: exit 0, HTTP health verified on port ${port}`);
  console.log("remote URL: cloned, exit 1 before execution, signed safety refusal verified");
  console.log("protected env files: untouched");
} finally {
  if (process.env.BOOTPROOF_KEEP_PACK_TMP === "1") {
    console.log(`temporary smoke-test directory retained: ${tempRoot}`);
  } else {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
