import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { inferRepo } from "../dist/infer.js";
import { classifyFailure, extractMissingEnvNames, TAXONOMY_DOC_CLASSES } from "../dist/taxonomy.js";
import { buildPlan, composeFileFor, envExampleFor, PROTECTED_ENV, repoComposeRepairFile, writePlanFiles } from "../dist/plan.js";
import { buildAttestation, TOOL_ID, verifySignature } from "../dist/proof.js";
import { extractHealthCandidates, minimalEnv, pollHealth, superviseApp } from "../dist/exec.js";
import { packageManagerVersionMatches } from "../dist/run.js";
import { isRemoteTarget, managedRemoteSource, parseGithubRemote } from "../dist/remote.js";
import {
  assertRepairScope,
  assertRepairTargetPath,
  composePortRepair,
  packageManagerActivationCommand,
  prismaRepairCommand,
  registeredRemediationsFor,
} from "../dist/repair.js";

const FIX = path.resolve("fixtures");

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

async function waitForPortRelease(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const released = await new Promise(resolve => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
    if (released) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

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
  assert.equal(classifyFailure("/bin/sh: go: command not found").class, "missing_runtime_tool");
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
  assert.ok(inf.workspaces.every(candidate => !candidate.dir.includes("\\")), "workspace paths must be platform-neutral");
  assert.ok(root.score > productionPackage.score);
  assert.ok(productionPackage.score > testPlugin.score, "test plugin must rank below production candidates");
});

test("Memos-like repository is an application that requires unsupported orchestration", () => {
  const inf = inferRepo(path.join(FIX, "go-react-memos-like"));
  assert.equal(inf.isApplication, true);
  assert.equal(inf.appCommand, null);
  assert.ok(inf.stack.includes("go-backend"));
  assert.ok(inf.stack.includes("react-frontend"));
  assert.ok(inf.backendMarkers.includes("go.mod"));
  assert.ok(inf.frontendMarkers.includes("web/package.json"));
  assert.deepEqual(inf.healthCandidates, [], "no runnable command means no localhost candidate");
});

test("Ruby backend markers are detected without claiming orchestration support", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-ruby-"));
  fs.mkdirSync(path.join(repo, "config"), { recursive: true });
  fs.writeFileSync(path.join(repo, "Gemfile"), "source \"https://rubygems.org\"\ngem \"rails\"\n");
  fs.writeFileSync(path.join(repo, "config", "database.yml"), "development:\n  adapter: postgresql\n");
  const inf = inferRepo(repo);
  assert.equal(inf.isApplication, true);
  assert.ok(inf.stack.includes("ruby-backend"));
  assert.ok(inf.backendMarkers.includes("Gemfile"));
  assert.ok(inf.backendMarkers.includes("config/database.yml"));
  assert.equal(inf.appCommand, null);
});

test("custom Make-driven applications select only an explicit supported target", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-make-driven-"));
  fs.writeFileSync(path.join(repo, "Makefile"), "serve:\n\t./scripts/start-custom-stack\n");
  const inf = inferRepo(repo);
  assert.equal(inf.isApplication, true);
  assert.ok(inf.stack.includes("make-driven"));
  assert.ok(inf.backendMarkers.includes("Makefile"));
  assert.equal(inf.appCommand, "make serve");
  assert.match(inf.appCommandSource, /Makefile target: serve/);
  assert.deepEqual(inf.healthCandidates, ["http://localhost:3000/"]);
});

test("Go, Rails, and Make fixtures expose conservative repository commands", () => {
  const go = inferRepo(path.join(FIX, "go-react-runnable-like"));
  assert.equal(go.appCommand, "go run ./cmd/app --port 8081 --data .bootproof/runtime/go-app");
  assert.equal(go.appCommandSource, "Go main package: cmd/app/main.go");
  assert.deepEqual(go.preparationCommands.map(command => command.command), ["go mod download"]);
  assert.deepEqual(go.healthCandidates, ["http://localhost:8081/"]);

  const rails = inferRepo(path.join(FIX, "ruby-rails-runnable-like"));
  assert.equal(rails.appCommand, "bundle exec rails server -b 127.0.0.1 -p 3000");
  assert.equal(rails.appCommandSource, "Rails entrypoint: bin/rails");
  assert.deepEqual(rails.preparationCommands.map(command => command.command), ["bundle install"]);

  const make = inferRepo(path.join(FIX, "make-runnable-like"));
  assert.equal(make.appCommand, "make serve");
  assert.equal(make.commandScope, "repository-defined Make target");
});

test("source-built Compose applications are runnable but image-only services are not source proof", () => {
  const source = inferRepo(path.join(FIX, "source-compose-runnable-like"));
  assert.deepEqual(source.composeApplicationServices, [{
    name: "web",
    source: "build",
    healthCandidates: ["http://localhost:31999/ready"],
  }]);
  assert.deepEqual(source.composeHealthCandidates, ["http://localhost:31999/ready"]);
  const plan = buildPlan(source, "docker");
  assert.equal(plan.steps.find(step => step.kind === "service")?.command, "docker compose -f docker-compose.yml up -d");
  assert.deepEqual(plan.steps.filter(step => step.kind === "start-app"), []);
  assert.deepEqual(plan.healthCandidates, ["http://localhost:31999/ready"]);

  const imageOnly = fs.mkdtempSync(path.join(os.tmpdir(), "bp-compose-image-"));
  fs.writeFileSync(path.join(imageOnly, "docker-compose.yml"), [
    "services:",
    "  web:",
    "    image: example/web:latest",
    "    ports:",
    "      - \"3000:3000\"",
    "",
  ].join("\n"));
  const imageInference = inferRepo(imageOnly);
  assert.deepEqual(imageInference.composeApplicationServices, [{
    name: "web",
    source: "image",
    healthCandidates: ["http://localhost:3000/"],
  }]);
  assert.deepEqual(imageInference.composeHealthCandidates, [], "an image-only service cannot prove the checked-out source");
  assert.equal(imageInference.isApplication, false);
});

test("multiple source-built Compose HTTP services remain ambiguous", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-compose-multiple-"));
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
  const inf = inferRepo(repo);
  assert.equal(inf.isApplication, true);
  assert.equal(inf.composeApplicationServices.filter(service => service.source === "build").length, 2);
  assert.deepEqual(inf.composeHealthCandidates, [], "one responding service must not prove a multi-service application");
});

test("repository compose is deferred to and Storybook ranks below the production web app", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-formbricks-like-"));
  fs.cpSync(path.join(FIX, "formbricks-like"), repo, { recursive: true });
  const inf = inferRepo(repo);
  assert.equal(inf.repoComposeFile, "docker-compose.yml");
  assert.ok(inf.services.some(service => service.kind === "postgres"));

  const plan = buildPlan(inf, "docker");
  const service = plan.steps.find(step => step.kind === "service");
  assert.equal(service?.command, "docker compose -f docker-compose.yml up -d");
  assert.equal(service?.description, "defer to the repository's own compose file");
  assert.equal(composeFileFor(inf), null);
  assert.ok(!plan.generatedFiles.some(file => file.path === "docker-compose.bootproof.yml"));

  const written = writePlanFiles(inf, repo);
  assert.ok(!written.includes("docker-compose.bootproof.yml"));
  assert.equal(fs.existsSync(path.join(repo, "docker-compose.bootproof.yml")), false);

  const web = inf.workspaces.find(candidate => candidate.dir === "apps/web");
  const storybook = inf.workspaces.find(candidate => candidate.dir === "apps/storybook");
  assert.ok(web && storybook);
  assert.ok(web.score > storybook.score);
  assert.match(storybook.reason, /documentation\/storybook downranked/);
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

test("missing environment names are extracted only from explicit failure contexts", () => {
  assert.deepEqual(extractMissingEnvNames("DATABASE_URL is not set"), ["DATABASE_URL"]);
  assert.deepEqual(extractMissingEnvNames("API_TOKEN is required"), ["API_TOKEN"]);
  assert.deepEqual(extractMissingEnvNames("Missing required secret: SESSION_SECRET"), ["SESSION_SECRET"]);
  assert.deepEqual(extractMissingEnvNames("Invalid environment variables:\n  SMTP_PASSWORD: Required"), ["SMTP_PASSWORD"]);
  assert.deepEqual(extractMissingEnvNames("Startup refused; please set REDIS_URL."), ["REDIS_URL"]);
  assert.deepEqual(
    extractMissingEnvNames("See https://example.com/API_TOKEN and compare against CONSTANT_VALUE."),
    [],
    "all-caps URL segments and constants are not missing-env evidence",
  );
  assert.deepEqual(
    extractMissingEnvNames("API_TOKEN is required\nAPI_TOKEN is missing\nMissing required secret: API_TOKEN"),
    ["API_TOKEN"],
    "names are deduplicated",
  );
  const many = Array.from({ length: 12 }, (_, index) => `SECRET_${index} is required`).join("\n");
  assert.equal(extractMissingEnvNames(many).length, 10, "extraction is capped at ten names");
});

test("taxonomy documentation and tool version stay synchronized", () => {
  const taxonomyDoc = fs.readFileSync(path.resolve("docs/FAILURE_TAXONOMY.md"), "utf8");
  for (const failureClass of TAXONOMY_DOC_CLASSES) {
    assert.ok(taxonomyDoc.includes(`\`${failureClass}\``), `missing taxonomy documentation for ${failureClass}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  assert.equal(TOOL_ID, `bootproof@${pkg.version}`);
});

test("repair scope whitelist permits boot plumbing and rejects application edits", () => {
  assert.doesNotThrow(() => assertRepairScope([
    {
      path: "docker-compose.bootproof.override.yml",
      before: null,
      after: "services:\n  web:\n    ports:\n      - \"4000:3000\"\n",
    },
    {
      path: "package.json",
      before: JSON.stringify({ name: "app", scripts: { start: "node server.js" }, packageManager: "pnpm@9.0.0" }),
      after: JSON.stringify({ name: "app", scripts: { start: "node server.js" }, packageManager: "pnpm@10.0.0" }),
    },
  ]));
  assert.throws(
    () => assertRepairScope([{ path: "src/server.js", before: "old", after: "patched" }]),
    /honesty contract violation: repair attempted to edit application file/,
  );
  assert.throws(
    () => assertRepairScope([{
      path: "package.json",
      before: JSON.stringify({ scripts: { start: "node old.js" } }),
      after: JSON.stringify({ scripts: { start: "node patched.js" } }),
    }]),
    /package\.json repair exceeded engines\/packageManager scope/,
  );
  assert.throws(
    () => assertRepairScope([{ path: "../outside.bootproof.yml", before: null, after: "no" }]),
    /repair path escapes repository/,
  );
  if (process.platform !== "win32") {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-repair-link-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bp-repair-outside-"));
    fs.symlinkSync(outside, path.join(repo, "linked"));
    assert.throws(
      () => assertRepairTargetPath(repo, "linked/docker-compose.bootproof.override.yml"),
      /repair target traverses symbolic link/,
    );
  }
});

test("repair registry exposes only deterministic v0.3 remediations", () => {
  assert.deepEqual(registeredRemediationsFor("service_port_allocated"), [{
    id: "remap-conflicting-service-port",
    kind: "plan-step",
  }]);
  assert.deepEqual(registeredRemediationsFor("package_manager_version_mismatch"), [{
    id: "activate-declared-package-manager",
    kind: "environment",
  }]);
  assert.deepEqual(registeredRemediationsFor("migrations_missing"), [{
    id: "deploy-prisma-migrations",
    kind: "plan-step",
  }]);
  assert.deepEqual(registeredRemediationsFor("missing_env_var"), []);
  assert.equal(
    packageManagerActivationCommand("pnpm", "10.24.0"),
    "corepack prepare pnpm@10.24.0 --activate",
  );
  assert.equal(packageManagerActivationCommand("pnpm", "^10.24.0"), null);
  const repairedCompose = composePortRepair(
    "services:\n  web:\n    build: .\n    ports:\n      - \"4000:3000\"\n",
    "web",
    4000,
    4100,
    3000,
  );
  assert.match(repairedCompose, /complete repaired copy/);
  assert.match(repairedCompose, /4100:3000/);
  assert.doesNotMatch(repairedCompose, /!override/);
  assert.match(repairedCompose, /build: \./);
  assert.equal(repoComposeRepairFile("docker/docker-compose.yml"), "docker/docker-compose.bootproof.override.yml");
  const prisma = fs.mkdtempSync(path.join(os.tmpdir(), "bp-repair-prisma-"));
  fs.mkdirSync(path.join(prisma, "prisma"), { recursive: true });
  assert.equal(prismaRepairCommand(prisma), "npx prisma db push --skip-generate");
  fs.mkdirSync(path.join(prisma, "prisma", "migrations"));
  assert.equal(prismaRepairCommand(prisma), "npx prisma migrate deploy");
});

test("repair receipt schema and honesty additions are documented", () => {
  const schema = fs.readFileSync(path.resolve("docs/REPAIR_RECEIPT.md"), "utf8");
  assert.match(schema, /bootproof\/repair-receipt\/v1/);
  assert.match(schema, /bootproof apply-repair/);
  assert.match(schema, /fileChanges/);
  assert.match(schema, /beforeAttestationSha256/);
  const honesty = fs.readFileSync(path.resolve("docs/HONESTY_CONTRACT.md"), "utf8");
  assert.match(honesty, /only ever proposed with a verified before and after attestation/i);
  assert.match(honesty, /repair generation never touches the user's working tree/i);
  assert.match(honesty, /application logic is never edited/i);
  assert.match(honesty, /never proposed on hope/i);
  assert.match(honesty, /stale or tampered receipts write nothing/i);
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

test("supervisor stop terminates the process tree and releases its port", async () => {
  const port = await getFreePort();
  const app = superviseApp(
    "node server.js",
    path.join(FIX, "hello-app"),
    minimalEnv({ PORT: String(port) }),
  );
  const health = await pollHealth(`http://127.0.0.1:${port}/`, 10_000, 100);
  assert.equal(health.responded, true, "fixture server must start before cleanup is tested");

  await app.stop();

  assert.equal(await waitForPortRelease(port), true, `port ${port} remained bound after supervisor stop`);
});

test("remote URL parsing accepts only credential-free HTTPS GitHub repositories", () => {
  assert.equal(isRemoteTarget("https://github.com/example/app"), true);
  assert.deepEqual(parseGithubRemote("https://github.com/example/app"), {
    originalUrl: "https://github.com/example/app",
    canonicalUrl: "https://github.com/example/app.git",
    owner: "example",
    repo: "app",
  });
  assert.throws(() => parseGithubRemote("http://github.com/example/app"), /only public HTTPS GitHub/);
  assert.throws(() => parseGithubRemote("https://token@github.com/example/app"), /must not contain credentials/);
  assert.throws(() => parseGithubRemote("https://gitlab.com/example/app"), /only public HTTPS GitHub/);
  assert.throws(() => parseGithubRemote("https://github.com/example/app/tree/main"), /exactly one repository/);

  const managed = fs.mkdtempSync(path.join(os.tmpdir(), "bp-managed-remote-"));
  const repo = path.join(managed, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(managed, "source.json"), JSON.stringify({
    schema: "bootproof/remote-source/v1",
    canonicalUrl: "https://github.com/example/app.git",
    repoDirectory: "repo",
  }));
  assert.equal(managedRemoteSource(repo), "https://github.com/example/app.git");
  assert.equal(managedRemoteSource(path.join(managed, "ordinary-repo")), null);
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
