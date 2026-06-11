import type { FailureClass, Inference } from "./types.js";

export interface FailureDiagnosis {
  whatHappened: string;
  whyRefused: string;
  safeNextStep: string;
}

function packageManagerMismatch(evidence: string | null, inference?: Inference): FailureDiagnosis {
  const expected = evidence?.match(/expected version:\s*([^\n]+)/i)?.[1]?.trim() ?? inference?.packageManagerVersion ?? "the declared version";
  const actual = evidence?.match(/Got:\s*([^\n]+)/i)?.[1]?.trim() ?? "a different version";
  const evidencedManager = evidence?.match(/engines\.(npm|pnpm|yarn|bun)/i)?.[1]?.toLowerCase();
  const manager = inference?.packageManager && inference.packageManager !== "unknown"
    ? inference.packageManager
    : evidencedManager ?? "package manager";
  const activation = manager === "pnpm"
    ? `Run corepack enable && corepack prepare pnpm@${expected} --activate, then rerun BootProof.`
    : `Install or activate ${manager} ${expected}, then rerun BootProof.`;
  return {
    whatHappened: `The repository requires ${manager} ${expected}, but this environment has ${manager} ${actual}.`,
    whyRefused: "The dependency install cannot be trusted with the wrong package manager version.",
    safeNextStep: activation,
  };
}

export function diagnoseFailure(
  failureClass: FailureClass | null,
  evidence: string | null,
  explanation: string,
  inference?: Inference,
): FailureDiagnosis {
  switch (failureClass) {
    case "package_manager_version_mismatch":
      return packageManagerMismatch(evidence, inference);
    case "dependency_install_skipped":
      return {
        whatHappened: "The inferred application depends on project packages, but dependency installation was not requested.",
        whyRefused: "Starting the application without its declared dependencies would not be a trustworthy boot attempt.",
        safeNextStep: "Review the inferred install command, then rerun with --install if you want BootProof to execute it.",
      };
    case "python_flask_setup_required":
      return {
        whatHappened: "BootProof detected a Python/Flask application with migration, initialization, frontend, or worker setup steps.",
        whyRefused: "BootProof cannot yet orchestrate that multi-step application safely enough to claim a verified boot.",
        safeNextStep: "Review the detected setup and service commands, complete the repository's documented initialization, then rerun when orchestration support is available.",
      };
    case "orchestration_not_supported":
      return {
        whatHappened: explanation,
        whyRefused: "The detected application requires backend/frontend or repository-specific orchestration that BootProof cannot yet execute safely.",
        safeNextStep: "Use the repository's documented runbook. Treat this attestation as diagnosis only, not proof of a localhost boot.",
      };
    case "workspace_ambiguous":
      if (/multiple workspaces in parallel|starts multiple workspaces in parallel/i.test(explanation)) {
        return {
          whatHappened: "The root command starts multiple workspaces in parallel, so there is no single application verdict.",
          whyRefused: "One responding workspace would not prove that the whole repository booted.",
          safeNextStep: "Choose the intended application with --workspace <dir>, then rerun BootProof.",
        };
      }
      return {
        whatHappened: "More than one plausible application or health target was detected.",
        whyRefused: "Choosing one automatically could verify the wrong workspace or mistake one responding service for the whole repository.",
        safeNextStep: "Choose the intended application with --workspace <dir>, then rerun BootProof.",
      };
    case "service_port_allocated":
      return {
        whatHappened: "Docker reached the daemon, but a required service port could not be bound.",
        whyRefused: "The planned service did not start, so the application boot could not be verified.",
        safeNextStep: "Stop the process or container using the reported port, then rerun BootProof.",
      };
    case "health_http_error":
      return {
        whatHappened: "The application responded to a health candidate with HTTP 5xx.",
        whyRefused: "A responding server is not a verified healthy boot when the observed response is a server error.",
        safeNextStep: "Inspect the application logs and failing health route, fix the server error, then rerun BootProof.",
      };
    case "health_check_timeout":
      return {
        whatHappened: "No successful HTTP response was observed before the health timeout.",
        whyRefused: "A running process alone is not proof that the application became reachable and healthy.",
        safeNextStep: "Check the reported health candidates and application logs, then rerun with the correct port or a longer --timeout if justified.",
      };
    case "postgres_auth_env_missing":
      return {
        whatHappened: "Postgres was reached, but authentication or database environment configuration did not match.",
        whyRefused: "The application could not establish the database connection required for a trustworthy boot.",
        safeNextStep: "Check the repository's real database configuration and credentials. BootProof will not edit .env or invent a password.",
      };
    case "not_an_application":
      return {
        whatHappened: "No trustworthy runnable application entrypoint was found.",
        whyRefused: "BootProof will not invent a command or advertise a localhost URL for a library or unrecognized repository.",
        safeNextStep: "Point BootProof at a runnable workspace, or add an explicit documented start command to the repository.",
      };
    case "missing_package_manager":
      return {
        whatHappened: "The package manager required by the repository is not available.",
        whyRefused: "BootProof cannot run the declared install or start command without that executable.",
        safeNextStep: "Enable Corepack or install the repository's declared package manager, then rerun BootProof.",
      };
    case "runtime_engine_mismatch":
      return {
        whatHappened: "The available Node.js runtime does not satisfy the repository's declared engine requirement.",
        whyRefused: "Continuing under an unsupported runtime would make install and boot evidence unreliable.",
        safeNextStep: "Switch to a compatible Node.js version, then rerun BootProof.",
      };
    case "missing_env_var":
      return {
        whatHappened: explanation,
        whyRefused: "BootProof will not invent secrets or write protected .env files to force startup.",
        safeNextStep: "Provide the real required values using the repository's documented configuration path, then rerun BootProof.",
      };
    case "port_in_use":
      return {
        whatHappened: "The application port is already in use.",
        whyRefused: "BootProof could not observe the inferred application owning and serving that port.",
        safeNextStep: "Stop the process using the port or rerun with an explicit --port value supported by the application.",
      };
    case "docker_unavailable":
      return {
        whatHappened: "The run plan requires Docker, but the Docker daemon or command is unavailable.",
        whyRefused: "Required services could not be started, so BootProof could not verify the application.",
        safeNextStep: "Start Docker and rerun, or explicitly choose local execution only when it is safe with --provider local --unsafe-local.",
      };
    case "install_failed":
      return {
        whatHappened: "The dependency install command exited unsuccessfully.",
        whyRefused: "BootProof cannot trust an application boot when its declared dependency installation failed.",
        safeNextStep: "Inspect the preserved install evidence, fix the underlying package or environment problem, then rerun BootProof.",
      };
    case "app_exited_early":
      return {
        whatHappened: "The application process exited before any health response was observed.",
        whyRefused: "No live application health signal was available to verify.",
        safeNextStep: "Inspect the preserved process output, fix the startup error, then rerun BootProof.",
      };
    default:
      if (/cloned .* but will not execute remote repository code/i.test(explanation)) {
        return {
          whatHappened: explanation,
          whyRefused: "A remote clone is untrusted code, and BootProof requires explicit acknowledgement before running it on the host.",
          safeNextStep: "Review the cloned repository, then rerun with --provider local --unsafe-local only if you accept host execution.",
        };
      }
      if (/Local provider runs repository code directly/i.test(explanation)) {
        return {
          whatHappened: explanation,
          whyRefused: "Host execution was selected without the required explicit acknowledgement.",
          safeNextStep: "Review the inferred commands, then rerun with --provider local --unsafe-local only if you accept host execution.",
        };
      }
      return {
        whatHappened: explanation,
        whyRefused: "BootProof did not observe enough evidence to issue a verified boot result.",
        safeNextStep: "Inspect the signed attestation and raw evidence, address the reported cause, then rerun BootProof.",
      };
  }
}
