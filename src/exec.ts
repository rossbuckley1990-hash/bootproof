import { spawn } from "node:child_process";
import http from "node:http";

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const TAIL = 4000;
const tail = (s: string) => (s.length > TAIL ? s.slice(-TAIL) : s);

export function runToCompletion(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== "win32", env });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout?.on("data", d => (stdout += d));
    child.stderr?.on("data", d => (stderr += d));
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.on("close", code => { clearTimeout(timer); resolve({ exitCode: code, timedOut, stdout: tail(stdout), stderr: tail(stderr) }); });
    child.on("error", err => { clearTimeout(timer); resolve({ exitCode: null, timedOut, stdout: tail(stdout), stderr: tail(stderr + String(err)) }); });
  });
}

export interface SupervisedApp {
  stop: () => Promise<void>;
  exited: () => { code: number | null; early: boolean } | null;
  output: () => string;
}

export function superviseApp(command: string, cwd: string, env: NodeJS.ProcessEnv): SupervisedApp {
  const child = spawn(command, { cwd, shell: true, detached: process.platform !== "win32", env });
  let out = "", exit: { code: number | null; early: boolean } | null = null;
  child.stdout?.on("data", d => (out += d));
  child.stderr?.on("data", d => (out += d));
  child.on("close", code => { exit = { code, early: true }; });
  return {
    output: () => tail(out),
    exited: () => exit,
    stop: async () => {
      if (exit) return;
      killTree(child.pid);
      await new Promise<void>(res => {
        const t = setTimeout(() => { killTree(child.pid, "SIGKILL"); res(); }, 5000);
        child.on("close", () => { clearTimeout(t); res(); });
      });
      if (exit) (exit as { early: boolean }).early = false;
    },
  };
}

function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal); // negative pid = whole process group
  } catch { /* already gone */ }
}

export interface HealthObservation {
  responded: boolean;
  status: number | null;
  attempts: number;
  elapsedMs: number;
  url: string | null;
  candidates: string[];
  discoveredCandidates: string[];
}

function cleanUrl(value: string): string {
  return value.replace(/[),.;\]}]+$/, "");
}

export function extractHealthCandidates(output: string): string[] {
  const candidates = new Set<string>();
  for (const match of output.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/[^\s"'<>]*)?/gi)) {
    candidates.add(cleanUrl(match[0]));
  }
  for (const match of output.matchAll(/\b(?:server\s+)?listening\s+(?:on|at)\s+(?:(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?(?::|port\s+))(\d{2,5})\b/gi)) {
    candidates.add(`http://localhost:${match[1]}/`);
  }
  for (const match of output.matchAll(/\b(?:server\s+)?listening\s+(?:on|at)\s+(\d{2,5})\b/gi)) {
    candidates.add(`http://localhost:${match[1]}/`);
  }
  return [...candidates];
}

export async function pollHealthCandidates(
  initialUrls: string[],
  timeoutMs: number,
  output: () => string = () => "",
  intervalMs = 1000,
): Promise<HealthObservation> {
  const started = Date.now();
  let attempts = 0;
  const candidates = new Set(initialUrls);
  const discoveredCandidates = new Set<string>();
  while (Date.now() - started < timeoutMs) {
    for (const candidate of extractHealthCandidates(output())) {
      if (!candidates.has(candidate)) discoveredCandidates.add(candidate);
      candidates.add(candidate);
    }
    for (const url of candidates) {
      attempts++;
      const status = await probe(url);
      if (status !== null) {
        return {
          responded: true,
          status,
          attempts,
          elapsedMs: Date.now() - started,
          url,
          candidates: [...candidates],
          discoveredCandidates: [...discoveredCandidates],
        };
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  for (const candidate of extractHealthCandidates(output())) {
    if (!candidates.has(candidate)) discoveredCandidates.add(candidate);
    candidates.add(candidate);
  }
  return {
    responded: false,
    status: null,
    attempts,
    elapsedMs: Date.now() - started,
    url: null,
    candidates: [...candidates],
    discoveredCandidates: [...discoveredCandidates],
  };
}

export function pollHealth(url: string, timeoutMs: number, intervalMs = 1000): Promise<HealthObservation> {
  return pollHealthCandidates([url], timeoutMs, () => "", intervalMs);
}

function probe(url: string): Promise<number | null> {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: 3000 }, res => { res.resume(); resolve(res.statusCode ?? null); });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

export function minimalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "TEMP", "LANG", "TERM", "NODE_OPTIONS", "COREPACK_HOME", "npm_config_cache"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra, CI: "true", BOOTPROOF: "1" };
}
