import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface GithubRemote {
  originalUrl: string;
  canonicalUrl: string;
  owner: string;
  repo: string;
}

export interface RemoteClone extends GithubRemote {
  repoPath: string;
}

interface RemoteSourceMarker {
  schema: "bootproof/remote-source/v1";
  canonicalUrl: string;
  repoDirectory: "repo";
}

export function isRemoteTarget(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^git@/i.test(value);
}

export function parseGithubRemote(value: string): GithubRemote {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Remote targets must be full HTTPS GitHub repository URLs.");
  }

  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Remote mode currently accepts only public HTTPS GitHub repository URLs.");
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("Remote URLs must not contain credentials, custom ports, query strings, or fragments.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error("Remote GitHub URLs must identify exactly one repository: https://github.com/owner/repo.");
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  const safeSegment = /^[A-Za-z0-9_.-]+$/;
  if (!safeSegment.test(owner) || !safeSegment.test(repo) || owner === "." || owner === ".." || repo === "." || repo === "..") {
    throw new Error("Remote GitHub owner and repository names contain unsupported characters.");
  }

  return {
    originalUrl: value,
    canonicalUrl: `https://github.com/${owner}/${repo}.git`,
    owner,
    repo,
  };
}

export function cloneGithubRemote(value: string, cwd: string): RemoteClone {
  const remote = parseGithubRemote(value);
  const ownerRoot = path.join(cwd, ".bootproof", "remotes", "github.com", remote.owner);
  fs.mkdirSync(ownerRoot, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(ownerRoot, `${remote.repo}-`));
  const repoPath = path.join(runRoot, "repo");

  try {
    execFileSync(
      "git",
      ["clone", "--depth", "1", "--single-branch", "--no-tags", "--", remote.canonicalUrl, repoPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const marker: RemoteSourceMarker = {
      schema: "bootproof/remote-source/v1",
      canonicalUrl: remote.canonicalUrl,
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
