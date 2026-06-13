import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { redactText } from "./redact.js";
import {
  buildRepairAction,
  createRepairCommand,
  type RepairAction,
} from "./repair-safety.js";
import { classifyFailure, extractMissingEnvNames } from "./taxonomy.js";
import type { Attestation, FailureClass } from "./types.js";

export interface DeterministicRepairFileChange {
  path: string;
  before: string | null;
  after: string;
}

export interface DeterministicRepairCandidate {
  id: string;
  failureClass: FailureClass;
  action: RepairAction;
  followUpActions?: RepairAction[];
  fileChanges?: DeterministicRepairFileChange[];
}

export interface RepairCandidateOptions {
  repoPath?: string;
  homebrewAvailable?: boolean;
  homebrewPrefix?: string | null;
  homebrewPostgresPackage?: string | null;
  environment?: NodeJS.ProcessEnv;
}

function environmentPath(environment: NodeJS.ProcessEnv): string {
  const key = Object.keys(environment).find(name => name.toLowerCase() === "path");
  return key ? environment[key] ?? "" : "";
}

function executablePath(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const extensions = process.platform === "win32"
    ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of environmentPath(environment).split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${executable}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Continue through PATH without executing discovery commands.
      }
    }
  }
  return null;
}

export function executableAvailableOnPath(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return executablePath(executable, environment) !== null;
}

function detectedHomebrewPrefix(options: RepairCandidateOptions): string | null {
  if (options.homebrewPrefix !== undefined) return options.homebrewPrefix;
  const brew = executablePath("brew", options.environment);
  return brew ? path.dirname(path.dirname(brew)) : null;
}

function homebrewAvailable(options: RepairCandidateOptions): boolean {
  if (options.homebrewAvailable !== undefined) return options.homebrewAvailable;
  return detectedHomebrewPrefix(options) !== null;
}

function detectedPostgresPackage(options: RepairCandidateOptions): string | null {
  if (options.homebrewPostgresPackage !== undefined) return options.homebrewPostgresPackage;
  const prefix = detectedHomebrewPrefix(options);
  if (!prefix) return null;
  const opt = path.join(prefix, "opt");
  try {
    const packages = fs.readdirSync(opt)
      .filter(name => name === "postgresql" || /^postgresql@\d+$/.test(name))
      .filter(name => fs.existsSync(path.join(opt, name)))
      .sort((left, right) => {
        if (left === "postgresql") return -1;
        if (right === "postgresql") return 1;
        return Number(right.split("@")[1]) - Number(left.split("@")[1]);
      });
    return packages[0] ?? null;
  } catch {
    return null;
  }
}

function normalizedRepoFile(repo: string, relative: string): string | null {
  const normalized = relative.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return null;
  }
  let file = repo;
  try {
    for (const segment of normalized.split("/")) {
      file = path.join(file, segment);
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) return null;
    }
  } catch {
    return null;
  }
  return file;
}

function safePatchContent(value: string): boolean {
  const literalSecret = /^[+-]?\s*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key):\s*(?!$|null\b|~\s*$|<%=|\$\{|\[redacted\])[^#\s].*$/im;
  return !literalSecret.test(value) && redactText(value).applied.length === 0;
}

function unifiedDiff(file: string, before: string | null, after: string): string {
  const beforeLines = before === null ? [] : before.replace(/\n$/, "").split("\n");
  const afterLines = after.replace(/\n$/, "").split("\n");
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const oldStart = before === null ? 0 : prefix + 1;
  const newStart = before === null ? 1 : prefix + 1;
  return [
    `--- ${before === null ? "/dev/null" : `a/${file}`}`,
    `+++ b/${file}`,
    `@@ -${oldStart},${removed.length} +${newStart},${added.length} @@`,
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
    "",
  ].join("\n");
}

function copyConfigCandidate(input: {
  repo: string;
  failureClass: FailureClass;
  id: string;
  source: string;
  destination: string;
  riskLevel: "low" | "medium";
  explanation: string;
}): DeterministicRepairCandidate | null {
  const sourceFile = normalizedRepoFile(input.repo, input.source);
  const destinationFile = normalizedRepoFile(input.repo, input.destination);
  if (!sourceFile || !destinationFile || !fs.existsSync(sourceFile) || fs.existsSync(destinationFile)) {
    return null;
  }
  if (!fs.statSync(sourceFile).isFile()) return null;
  const contents = fs.readFileSync(sourceFile, "utf8");
  const patch = unifiedDiff(input.destination, null, contents);
  if (!safePatchContent(patch)) return null;
  return {
    id: input.id,
    failureClass: input.failureClass,
    action: buildRepairAction({
      actionType: "patch",
      mutationScope: "repo_only",
      riskLevel: input.riskLevel,
      patch: {
        format: "unified-diff",
        content: patch,
        files: [input.destination],
      },
      explanation: input.explanation,
      evidenceRefs: [".bootproof/attestation.json", input.source],
    }),
    fileChanges: [{ path: input.destination, before: null, after: contents }],
  };
}

function removeTopLevelYamlSections(source: string, names: string[]): string | null {
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (names.some(name => !(name in record))) return null;

  const lines = source.split(/(?<=\n)/);
  const topLevel = lines
    .map((line, index) => ({ index, name: line.match(/^([A-Za-z0-9_-]+):(?:\s*(?:#.*)?)?(?:\r?\n)?$/)?.[1] }))
    .filter((entry): entry is { index: number; name: string } => Boolean(entry.name));
  const remove = new Set<number>();
  for (const name of names) {
    const startEntry = topLevel.find(entry => entry.name === name);
    if (!startEntry) return null;
    const next = topLevel.find(entry => entry.index > startEntry.index);
    const end = next?.index ?? lines.length;
    for (let index = startEntry.index; index < end; index += 1) remove.add(index);
  }
  const updated = lines.filter((_line, index) => !remove.has(index)).join("");
  try {
    const after = parse(updated);
    if (!after || typeof after !== "object" || Array.isArray(after)) return null;
    if (names.some(name => name in (after as Record<string, unknown>))) return null;
  } catch {
    return null;
  }
  return updated;
}

function postgresMajor(requiredVersion: unknown): string | null {
  if (typeof requiredVersion !== "string") return null;
  return requiredVersion.match(/\d+/)?.[0] ?? null;
}

function followUpInstruction(instruction: string, explanation: string): RepairAction {
  return buildRepairAction({
    actionType: "instruction",
    mutationScope: "none",
    riskLevel: "low",
    requiresApproval: false,
    instruction,
    explanation,
    evidenceRefs: [".bootproof/attestation.json"],
  });
}

function hostToolingSetupInstruction(instruction: string, explanation: string): RepairAction {
  return buildRepairAction({
    actionType: "instruction",
    mutationScope: "host_tool_install",
    riskLevel: "medium",
    requiresApproval: true,
    instruction,
    explanation,
    evidenceRefs: [".bootproof/attestation.json", "Makefile", "scripts/do.sh"],
    verificationStep: "Confirm devenv sync completed and direnv activated the project environment, then rerun BootProof.",
  });
}

export function deterministicRepairCandidateFor(
  attestation: Attestation,
  options: RepairCandidateOptions = {},
): DeterministicRepairCandidate | null {
  const failureClass = attestation.result.failureClass;
  const evidence = attestation.result.failureEvidence ?? "";
  if (!failureClass || attestation.result.booted || attestation.result.healthVerified) return null;
  const classified = classifyFailure(evidence);
  if (classified.class !== failureClass) return null;

  if (
    failureClass === "repo_requires_devenv"
    || failureClass === "missing_devenv_tool"
    || failureClass === "missing_direnv_tool"
    || failureClass === "sentry_virtualenv_not_activated"
  ) {
    return {
      id: "prepare-sentry-devenv-instruction",
      failureClass,
      action: hostToolingSetupInstruction(
        "Install and configure Sentry's documented devenv and direnv tools, review and run `devenv sync`, then activate the repository with `direnv allow`.",
        "Sentry's development environment requires host tooling and project synchronization. BootProof will not install tools or run setup automatically.",
      ),
    };
  }

  if (failureClass === "missing_ruby_version") {
    const requiredVersion = classified.metadata?.requiredVersion;
    if (typeof requiredVersion !== "string" || !/^\d+(?:\.\d+){1,3}(?:[-.][A-Za-z0-9]+)?$/.test(requiredVersion)) {
      return null;
    }
    return {
      id: "install-required-ruby-with-rbenv",
      failureClass,
      action: buildRepairAction({
        actionType: "command",
        mutationScope: "host_tool_install",
        riskLevel: "medium",
        command: createRepairCommand("rbenv", ["install", requiredVersion]),
        explanation: `Install the exact Ruby ${requiredVersion} version required by the preserved rbenv failure.`,
        evidenceRefs: [".bootproof/attestation.json"],
      }),
    };
  }

  if (failureClass === "missing_build_tool") {
    if (classified.metadata?.tool !== "cmake") return null;
    return {
      id: "install-cmake-with-homebrew",
      failureClass,
      action: buildRepairAction({
        actionType: "command",
        mutationScope: "host_tool_install",
        riskLevel: "medium",
        command: createRepairCommand("brew", ["install", "cmake"]),
        explanation: "Install the exact CMake build tool identified by the preserved failure evidence.",
        evidenceRefs: [".bootproof/attestation.json"],
      }),
    };
  }

  if (
    failureClass === "native_extension_compile_failed" &&
    classified.metadata?.affectedGem === "idn-ruby"
  ) {
    if (!homebrewAvailable(options)) {
      return {
        id: "install-idn-ruby-native-dependencies-instruction",
        failureClass,
        action: followUpInstruction(
          "Install libidn and pkg-config with your local package manager, configure Bundler for the libidn prefix, then rerun BootProof.",
          "Homebrew was not detected, so BootProof will not guess host package or configuration commands.",
        ),
      };
    }
    const prefix = detectedHomebrewPrefix(options);
    const libidnPrefix = prefix ? path.join(prefix, "opt", "libidn") : null;
    const configCommand = libidnPrefix
      ? createRepairCommand("bundle", [
          "config",
          "build.idn-ruby",
          `--with-idn-dir=${libidnPrefix}`,
        ])
      : null;
    const configCommandSafe = configCommand
      ? redactText(configCommand.display).applied.length === 0
      : false;
    if (libidnPrefix && fs.existsSync(libidnPrefix)) {
      if (!configCommandSafe) {
        return {
          id: "configure-idn-ruby-instruction",
          failureClass,
          action: followUpInstruction(
            'Run bundle config build.idn-ruby --with-idn-dir="$(brew --prefix libidn)" after reviewing the resolved path, then rerun BootProof.',
            "The detected Homebrew prefix contains a machine-identifying path, so BootProof will not persist or execute it.",
          ),
        };
      }
      return {
        id: "configure-idn-ruby-for-homebrew-libidn",
        failureClass,
        action: buildRepairAction({
          actionType: "command",
          mutationScope: "project_cache",
          riskLevel: "medium",
          command: configCommand,
          explanation: "Configure Bundler with the detected Homebrew libidn prefix without shell substitution.",
          evidenceRefs: [".bootproof/attestation.json"],
        }),
      };
    }
    const followUpActions = libidnPrefix && configCommandSafe
      ? [buildRepairAction({
          actionType: "command",
          mutationScope: "project_cache",
          riskLevel: "medium",
          command: configCommand!,
          explanation: "After libidn is installed, configure Bundler with its deterministic Homebrew prefix in a separately approved run.",
          evidenceRefs: [".bootproof/attestation.json"],
        })]
      : undefined;
    return {
      id: "install-idn-ruby-native-dependencies",
      failureClass,
      action: buildRepairAction({
        actionType: "command",
        mutationScope: "host_tool_install",
        riskLevel: "medium",
        command: createRepairCommand("brew", ["install", "libidn", "pkg-config"]),
        explanation: libidnPrefix && configCommandSafe
          ? `Install the exact native libraries required by idn-ruby. A later separately approved action will run bundle config build.idn-ruby --with-idn-dir=${libidnPrefix}.`
          : "Install the exact native libraries required by idn-ruby; the Bundler prefix action will be selected only after a safe Homebrew prefix is detectable.",
        evidenceRefs: [".bootproof/attestation.json"],
      }),
      ...(followUpActions ? { followUpActions } : {}),
    };
  }

  if (failureClass === "missing_database_config" && options.repoPath) {
    const source = fs.existsSync(path.join(options.repoPath, "config/database.yml.postgresql"))
      ? "config/database.yml.postgresql"
      : "config/database.yml.example";
    return copyConfigCandidate({
      repo: options.repoPath,
      failureClass,
      id: "copy-database-config-example",
      source,
      destination: "config/database.yml",
      riskLevel: "medium",
      explanation: `Copy ${source} to the missing config/database.yml in the repair sandbox for verification.`,
    });
  }

  if (
    failureClass === "missing_required_config" &&
    classified.metadata?.filePath === "config/gitlab.yml" &&
    options.repoPath
  ) {
    return copyConfigCandidate({
      repo: options.repoPath,
      failureClass,
      id: "copy-gitlab-config-example",
      source: "config/gitlab.yml.example",
      destination: "config/gitlab.yml",
      riskLevel: "medium",
      explanation: "Copy config/gitlab.yml.example to the missing config/gitlab.yml in the repair sandbox for verification.",
    });
  }

  if (failureClass === "laravel_sqlite_database_missing" && options.repoPath) {
    const databasePath = classified.metadata?.databasePath;
    const normalizedEvidencePath = typeof databasePath === "string"
      ? databasePath.replace(/\\/g, "/")
      : "";
    const relative = "database/database.sqlite";
    const databaseDirectory = normalizedRepoFile(options.repoPath, "database");
    const destination = normalizedRepoFile(options.repoPath, relative);
    const laravelMarkers =
      fs.existsSync(path.join(options.repoPath, "artisan"))
      && fs.existsSync(path.join(options.repoPath, "composer.json"));
    if (
      !normalizedEvidencePath.endsWith(`/${relative}`)
      && normalizedEvidencePath !== relative
    ) {
      return null;
    }
    if (
      !laravelMarkers
      || !databaseDirectory
      || !fs.existsSync(databaseDirectory)
      || !fs.statSync(databaseDirectory).isDirectory()
      || !destination
      || fs.existsSync(destination)
    ) {
      return null;
    }
    const patch = unifiedDiff(relative, null, "");
    if (!safePatchContent(patch)) return null;
    return {
      id: "create-laravel-sqlite-database",
      failureClass,
      action: buildRepairAction({
        actionType: "patch",
        mutationScope: "repo_only",
        riskLevel: "medium",
        patch: {
          format: "unified-diff",
          content: patch,
          files: [relative],
        },
        explanation: "Create the exact missing local SQLite database file as a reviewed repository patch.",
        evidenceRefs: [".bootproof/attestation.json", relative],
      }),
      followUpActions: [buildRepairAction({
        actionType: "command",
        mutationScope: "database",
        riskLevel: "high",
        command: createRepairCommand("php", ["artisan", "migrate"]),
        explanation: "After the SQLite file exists, run Laravel migrations in a separately approved step.",
        evidenceRefs: [".bootproof/attestation.json"],
      })],
      fileChanges: [{ path: relative, before: null, after: "" }],
    };
  }

  if (failureClass === "laravel_migrations_required") {
    return {
      id: "run-laravel-database-migrations",
      failureClass,
      action: buildRepairAction({
        actionType: "command",
        mutationScope: "database",
        riskLevel: "high",
        command: createRepairCommand("php", ["artisan", "migrate"]),
        explanation: "Run the exact Laravel migration command selected from preserved missing-table evidence.",
        evidenceRefs: [".bootproof/attestation.json"],
      }),
    };
  }

  if (failureClass === "postgres_unavailable") {
    const host = classified.metadata?.host;
    if (host && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return null;
    const postgresPackage = detectedPostgresPackage(options);
    if (homebrewAvailable(options) && postgresPackage) {
      return {
        id: "start-postgres-with-homebrew",
        failureClass,
        action: buildRepairAction({
          actionType: "command",
          mutationScope: "service",
          riskLevel: "medium",
          command: createRepairCommand("brew", ["services", "start", postgresPackage]),
          explanation: `Start the detected local Homebrew ${postgresPackage} service, then verify readiness with pg_isready.`,
          evidenceRefs: [".bootproof/attestation.json"],
        }),
        followUpActions: [followUpInstruction(
          "pg_isready",
          "Verify PostgreSQL readiness explicitly before relying on the BootProof application rerun.",
        )],
      };
    }
    return {
      id: "start-postgres-instruction",
      failureClass,
      action: followUpInstruction(
        "Start the configured local PostgreSQL service, run pg_isready, then rerun BootProof.",
        "No installed Homebrew PostgreSQL package was detected, so BootProof will not guess a service command.",
      ),
    };
  }

  if (failureClass === "postgres_role_missing") {
    const role = classified.metadata?.role;
    if (typeof role !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(role)) return null;
    return {
      id: "create-required-postgres-role",
      failureClass,
      action: buildRepairAction({
        actionType: "command",
        mutationScope: "database",
        riskLevel: "medium",
        command: createRepairCommand("createuser", ["-s", role]),
        explanation: `Create the exact PostgreSQL role ${role} identified by the preserved failure.`,
        evidenceRefs: [".bootproof/attestation.json"],
      }),
    };
  }

  if (failureClass === "database_schema_missing") {
    return {
      id: "run-rails-database-migrations",
      failureClass,
      action: buildRepairAction({
        actionType: "command",
        mutationScope: "database",
        riskLevel: "high",
        command: createRepairCommand("bundle", ["exec", "rails", "db:migrate"]),
        explanation: "Run the non-destructive Rails migration task selected for the missing schema evidence.",
        evidenceRefs: [".bootproof/attestation.json"],
      }),
    };
  }

  if (failureClass === "unsupported_database_version") {
    const major = postgresMajor(classified.metadata?.requiredVersion);
    if (!major || !homebrewAvailable(options)) {
      return {
        id: "install-supported-postgres-instruction",
        failureClass,
        action: followUpInstruction(
          `Install and start the required PostgreSQL ${major ?? "version"}, verify it with pg_isready, and select it explicitly without changing PATH automatically.`,
          "BootProof will not guess a platform package command or mutate PATH.",
        ),
      };
    }
    const formula = `postgresql@${major}`;
    const prefix = detectedHomebrewPrefix(options);
    const installed = options.homebrewPostgresPackage === formula
      || Boolean(prefix && fs.existsSync(path.join(prefix, "opt", formula)));
    if (installed) {
      return {
        id: "start-required-postgres-version",
        failureClass,
        action: buildRepairAction({
          actionType: "command",
          mutationScope: "service",
          riskLevel: "high",
          command: createRepairCommand("brew", ["services", "start", formula]),
          explanation: `Start the installed PostgreSQL ${major} service without changing PATH.`,
          evidenceRefs: [".bootproof/attestation.json"],
        }),
        followUpActions: [followUpInstruction(
          "pg_isready",
          "Verify the selected PostgreSQL service before relying on the BootProof application rerun.",
        )],
      };
    }
    return {
      id: "install-required-postgres-version",
      failureClass,
      action: buildRepairAction({
        actionType: "command",
        mutationScope: "host_tool_install",
        riskLevel: "high",
        command: createRepairCommand("brew", ["install", formula]),
        explanation: `Install PostgreSQL ${major} without changing PATH automatically. A later separately approved action will start ${formula}.`,
        evidenceRefs: [".bootproof/attestation.json"],
      }),
      followUpActions: [buildRepairAction({
        actionType: "command",
        mutationScope: "service",
        riskLevel: "high",
        command: createRepairCommand("brew", ["services", "start", formula]),
        explanation: `After installation, start PostgreSQL ${major} in a separately approved run.`,
        evidenceRefs: [".bootproof/attestation.json"],
      })],
    };
  }

  if (
    failureClass === "unsupported_database_config" &&
    options.repoPath &&
    Array.isArray(classified.metadata?.unsupportedNames)
  ) {
    const names = classified.metadata.unsupportedNames;
    if (
      names.length === 0 ||
      names.some(name => typeof name !== "string" || !["geo", "embedding"].includes(name))
    ) {
      return null;
    }
    const relative = "config/database.yml";
    const file = normalizedRepoFile(options.repoPath, relative);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    const before = fs.readFileSync(file, "utf8");
    const after = removeTopLevelYamlSections(before, names);
    if (after === null || after === before) return null;
    const patch = unifiedDiff(relative, before, after);
    if (!safePatchContent(patch)) return null;
    return {
      id: "remove-unsupported-database-sections",
      failureClass,
      action: buildRepairAction({
        actionType: "patch",
        mutationScope: "repo_only",
        riskLevel: "medium",
        patch: {
          format: "unified-diff",
          content: patch,
          files: [relative],
        },
        explanation: `Remove only the unsupported top-level database sections: ${names.join(", ")}.`,
        evidenceRefs: [".bootproof/attestation.json", relative],
      }),
      fileChanges: [{ path: relative, before, after }],
    };
  }

  if (failureClass === "redis_unavailable") {
    const homebrew = homebrewAvailable(options);
    if (homebrew) {
      return {
        id: "start-redis-with-homebrew",
        failureClass,
        action: buildRepairAction({
          actionType: "command",
          mutationScope: "service",
          riskLevel: "medium",
          command: createRepairCommand("brew", ["services", "start", "redis"]),
          explanation: "Start the local Redis service identified by the preserved connection failure.",
          evidenceRefs: [".bootproof/attestation.json"],
        }),
      };
    }
    return {
      id: "start-redis-instruction",
      failureClass,
      action: followUpInstruction(
        "Start Redis using your local service manager, verify localhost:6379 is reachable, then rerun BootProof.",
        "Redis is required, but Homebrew was not detected, so BootProof will not guess a host command.",
      ),
    };
  }

  if (failureClass === "missing_env_var") {
    const missing = extractMissingEnvNames(evidence || attestation.result.explanation);
    if (missing.length !== 1 || missing[0] !== "RAILS_ENV") return null;
    const instruction = "RAILS_ENV=development bootproof up . --provider local --unsafe-local --install";
    return {
      id: "rerun-with-rails-development",
      failureClass,
      action: followUpInstruction(
        instruction,
        "RAILS_ENV has the known safe local development value; no environment file will be written.",
      ),
    };
  }

  return null;
}

export function repairProgressed(
  beforeFailureClass: FailureClass,
  after: Attestation | null,
): boolean {
  if (!after) return false;
  if (after.result.booted && after.result.healthVerified) return true;
  return after.result.failureClass !== null && after.result.failureClass !== beforeFailureClass;
}
