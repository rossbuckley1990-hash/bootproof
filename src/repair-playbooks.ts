import fs from "node:fs";
import path from "node:path";
import { buildRepairAction, createRepairCommand, type RepairAction } from "./repair-safety.js";
import { classifyFailure, extractMissingEnvNames } from "./taxonomy.js";
import type { Attestation, FailureClass } from "./types.js";

export interface DeterministicRepairCandidate {
  id: string;
  failureClass: FailureClass;
  action: RepairAction;
}

export interface RepairCandidateOptions {
  homebrewAvailable?: boolean;
  environment?: NodeJS.ProcessEnv;
}

function environmentPath(environment: NodeJS.ProcessEnv): string {
  const key = Object.keys(environment).find(name => name.toLowerCase() === "path");
  return key ? environment[key] ?? "" : "";
}

export function executableAvailableOnPath(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const extensions = process.platform === "win32"
    ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of environmentPath(environment).split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${executable}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // Continue through PATH without executing discovery commands.
      }
    }
  }
  return false;
}

export function deterministicRepairCandidateFor(
  attestation: Attestation,
  options: RepairCandidateOptions = {},
): DeterministicRepairCandidate | null {
  const failureClass = attestation.result.failureClass;
  const evidence = attestation.result.failureEvidence ?? "";
  if (!failureClass || attestation.result.booted || attestation.result.healthVerified) return null;

  if (failureClass === "missing_build_tool") {
    const classified = classifyFailure(evidence);
    if (classified.class !== failureClass || classified.metadata?.tool !== "cmake") return null;
    return {
      id: "install-cmake-with-homebrew",
      failureClass,
      action: buildRepairAction({
        actionType: "command",
        mutationScope: "host",
        riskLevel: "medium",
        command: createRepairCommand("brew", ["install", "cmake"]),
        explanation: "Install the exact CMake build tool identified by the preserved failure evidence.",
        evidenceRefs: [".bootproof/attestation.json"],
      }),
    };
  }

  if (failureClass === "redis_unavailable") {
    const classified = classifyFailure(evidence);
    if (classified.class !== failureClass) return null;
    const homebrewAvailable = options.homebrewAvailable
      ?? executableAvailableOnPath("brew", options.environment);
    if (homebrewAvailable) {
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
      action: buildRepairAction({
        actionType: "instruction",
        mutationScope: "none",
        riskLevel: "medium",
        requiresApproval: false,
        instruction: "Start Redis using your local service manager, verify localhost:6379 is reachable, then rerun BootProof.",
        explanation: "Redis is required, but Homebrew was not detected, so BootProof will not guess a host command.",
        evidenceRefs: [".bootproof/attestation.json"],
      }),
    };
  }

  if (failureClass === "missing_env_var") {
    const missing = extractMissingEnvNames(evidence || attestation.result.explanation);
    if (missing.length !== 1 || missing[0] !== "RAILS_ENV") return null;
    const instruction = "RAILS_ENV=development bootproof up . --provider local --unsafe-local --install";
    return {
      id: "rerun-with-rails-development",
      failureClass,
      action: buildRepairAction({
        actionType: "instruction",
        mutationScope: "none",
        riskLevel: "low",
        requiresApproval: false,
        instruction,
        explanation: "RAILS_ENV has the known safe local development value; no environment file will be written.",
        evidenceRefs: [".bootproof/attestation.json"],
      }),
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
