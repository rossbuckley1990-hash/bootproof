import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type RemoteProvider = "github" | "gitlab" | "bitbucket" | "codeberg";

export interface GitRemote {
  originalUrl: string;
  canonicalUrl: string;
  provider: RemoteProvider;
  host: string;
  namespace: string;
  repo: string;
}

export interface GithubRemote {
  originalUrl: string;
  canonicalUrl: string;
  owner: string;
  repo: string;
}

export interface RemoteClone extends GitRemote {
  repoPath: string;
}

interface RemoteSourceMarker {
  schema: "bootproof/remote-source/v1";
  canonicalUrl: string;
  provider?: RemoteProvider;
  repoDirectory: "repo";
}

const REMOTE_PROVIDERS: Record<string, RemoteProvider> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
  "codeberg.org": "codeberg",
};

export function isRemoteTarget(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^git@/i.test(value);
}

export function parseRemoteTarget(value: string): GitRemote {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Remote targets must be full HTTPS Git repository URLs.");
  }

  const host = url.hostname.toLowerCase();
  const provider = REMOTE_PROVIDERS[host];
  if (url.protocol !== "https:" || !provider) {
    throw new Error("Remote mode accepts credential-free HTTPS repositories from GitHub, GitLab, Bitbucket, or Codeberg.");
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("Remote URLs must not contain credentials, custom ports, query strings, or fragments.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || (provider !== "gitlab" && parts.length !== 2)) {
    throw new Error(
      provider === "gitlab"
        ? "GitLab URLs must identify a namespace and repository."
        : `Remote ${provider} URLs must identify exactly one namespace and repository.`,
    );
  }
  const repo = parts.at(-1)!.replace(/\.git$/i, "");
  const namespaceParts = parts.slice(0, -1);
  const safeSegment = /^[A-Za-z0-9_.-]+$/;
  if (
    !namespaceParts.length ||
    [...namespaceParts, repo].some(segment => !safeSegment.test(segment) || segment === "." || segment === ".." || segment === "-")
  ) {
    throw new Error("Remote namespace or repository names contain unsupported characters.");
  }
  const namespace = namespaceParts.join("/");

  return {
    originalUrl: value,
    canonicalUrl: `https://${host}/${namespace}/${repo}.git`,
    provider,
    host,
    namespace,
    repo,
  };
}

export function parseGithubRemote(value: string): GithubRemote {
  const remote = parseRemoteTarget(value);
  if (remote.provider !== "github") {
    throw new Error("Expected a public HTTPS GitHub repository URL.");
  }
  return {
    originalUrl: remote.originalUrl,
    canonicalUrl: remote.canonicalUrl,
    owner: remote.namespace,
    repo: remote.repo,
  };
}

export function cloneRemoteTarget(value: string, cwd: string): RemoteClone {
  const remote = parseRemoteTarget(value);
  const namespaceRoot = path.join(cwd, ".bootproof", "remotes", remote.host, ...remote.namespace.split("/"));
  fs.mkdirSync(namespaceRoot, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(namespaceRoot, `${remote.repo}-`));
  const repoPath = path.join(runRoot, "repo");

  try {
    execFileSync(
      "git",
      ["-c", "credential.helper=", "clone", "--depth", "1", "--single-branch", "--no-tags", "--", remote.canonicalUrl, repoPath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_ASKPASS: "",
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    const marker: RemoteSourceMarker = {
      schema: "bootproof/remote-source/v1",
      canonicalUrl: remote.canonicalUrl,
      provider: remote.provider,
      repoDirectory: "repo",
    };
    fs.writeFileSync(path.join(runRoot, "source.json"), JSON.stringify(marker, null, 2) + "\n");
  } catch (error) {
    fs.rmSync(runRoot, { recursive: true, force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not clone ${remote.canonicalUrl}: ${detail}`);
  }

  return { ...remote, repoPath };
}

export function cloneGithubRemote(value: string, cwd: string): RemoteClone {
  parseGithubRemote(value);
  return cloneRemoteTarget(value, cwd);
}

export function managedRemoteSource(repoPath: string): string | null {
  const markerPath = path.join(path.dirname(path.resolve(repoPath)), "source.json");
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<RemoteSourceMarker>;
    return marker.schema === "bootproof/remote-source/v1"
      && marker.repoDirectory === path.basename(path.resolve(repoPath))
      && typeof marker.canonicalUrl === "string"
      ? marker.canonicalUrl
      : null;
  } catch {
    return null;
  }
}
