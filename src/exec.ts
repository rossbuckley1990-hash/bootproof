import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { redactText } from "./redact.js";
import type { HealthEvidence } from "./types.js";

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stdoutHead: string;
  stdout: string;
  stderrHead: string;
  stderr: string;
}

export interface ProcessEvidence {
  evidenceHead: string;
  evidenceTail: string;
  firstErrorLine?: string;
  firstExceptionLine?: string;
  detectedCause?: string;
}

const EVIDENCE_LIMIT = 4000;
const head = (s: string) => (s.length > EVIDENCE_LIMIT ? s.slice(0, EVIDENCE_LIMIT) : s);
const tail = (s: string) => (s.length > EVIDENCE_LIMIT ? s.slice(-EVIDENCE_LIMIT) : s);

function meaningfulLines(evidenceHead: string, evidenceTail: string): string[] {
  return `${evidenceHead}\n${evidenceTail}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line =>
      line.length > 0 &&
      !/^(?:from\s+)?\S+:\d+(?::in\b|$)/i.test(line) &&
      !/^at\s+\S+/i.test(line) &&
      !/^#\d+\s+/i.test(line)
    );
}

function detectCause(text: string): string | undefined {
  const checks: [RegExp, string][] = [
    [/(?:missing|no such file|does not exist|could not find)[^\n]*config\/database\.yml|config\/database\.yml[^\n]*(?:missing|no such file|does not exist|could not find)/i, "missing config/database.yml"],
    [/(?:missing|no such file|does not exist|could not find)[^\n]*config\/gitlab\.yml|config\/gitlab\.yml[^\n]*(?:missing|no such file|does not exist|could not find)/i, "missing config/gitlab.yml"],
    [/(?:PG::ConnectionBad|postgres(?:ql)?|port 5432)[^\n]*(?:connection refused|could not connect)|(?:connection refused|could not connect)[^\n]*(?:postgres(?:ql)?|port 5432)/i, "PostgreSQL connection refused"],
    [/(?:postgres(?:ql)?[^\n]*)?role\s+["']?[^"'\n]+["']?\s+does not exist/i, "PostgreSQL role missing"],
    [/(?:database schema|relation\s+\S+\s+does not exist|no such table|pending migrations?)/i, "database schema missing"],
    [/(?:unsupported|not supported)[^\n]*(?:postgres(?:ql)?|database)[^\n]*version|(?:postgres(?:ql)?|database)[^\n]*version[^\n]*(?:unsupported|not supported)/i, "unsupported database version"],
    [/(?:unsupported|not supported)[^\n]*database (?:config|configuration)|database (?:config|configuration)[^\n]*(?:unsupported|not supported)/i, "unsupported database configuration"],
  ];
  return checks.find(([pattern]) => pattern.test(text))?.[1];
}

export function extractProcessEvidence(evidenceHead: string, evidenceTail: string): ProcessEvidence {
  const lines = meaningfulLines(evidenceHead, evidenceTail);
  const firstExceptionLine = lines.find(line =>
    /\b(?:[A-Z]\w*(?:::[A-Z]\w*)*(?:Error|Exception)|PG::\w+|ActiveRecord::\w+|Errno::\w+|RuntimeError|LoadError|NameError|NoMethodError)\b/.test(line)
  );
  const firstErrorLine = lines.find(line =>
    /\b(?:error|fatal|failed|failure|refused|missing|unsupported|could not|cannot|no such file|does not exist)\b/i.test(line)
  );
  const combined = `${evidenceHead}\n${evidenceTail}`;
  const detectedCause = detectCause(combined);
  return {
    evidenceHead,
    evidenceTail,
    ...(firstErrorLine ? { firstErrorLine: redactText(firstErrorLine).text } : {}),
    ...(firstExceptionLine ? { firstExceptionLine: redactText(firstExceptionLine).text } : {}),
    ...(detectedCause ? { detectedCause } : {}),
  };
}

export function execResultEvidence(result: ExecResult): ProcessEvidence {
  const evidenceHead = [result.stderrHead, result.stdoutHead].filter(Boolean).join("\n");
  const evidenceTail = result.stderr || result.stdout;
  return extractProcessEvidence(evidenceHead, evidenceTail);
}

export function processEvidenceText(evidence: ProcessEvidence): string {
  return [
    evidence.evidenceHead,
    evidence.evidenceTail,
    evidence.firstErrorLine ? `First error: ${evidence.firstErrorLine}` : "",
    evidence.firstExceptionLine ? `First exception: ${evidence.firstExceptionLine}` : "",
    evidence.detectedCause ? `Detected cause: ${evidence.detectedCause}` : "",
  ].filter(Boolean).join("\n");
}

function setExecutionEnvValue(env: NodeJS.ProcessEnv, name: string, value: string | undefined): void {
  for (const existing of Object.keys(env)) {
    if (existing !== name && existing.toLowerCase() === name.toLowerCase()) delete env[existing];
  }
  if (value === undefined) delete env[name];
  else env[name] = value;
}

export function buildExecutionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["PATH", "HOME", "SHELL"]) {
    const inherited = Object.keys(process.env).find(existing => existing.toLowerCase() === name.toLowerCase());
    if (inherited) setExecutionEnvValue(env, name, process.env[inherited]);
  }
  setExecutionEnvValue(env, "CI", "true");
  setExecutionEnvValue(env, "BOOTPROOF", "1");
  for (const [name, value] of Object.entries(overrides)) {
    setExecutionEnvValue(env, name, value);
  }
  return env;
}

export function extractLeadingEnvironmentAssignments(command: string): {
  command: string;
  environment: Record<string, string>;
} {
  const environment: Record<string, string> = {};
  let remaining = command;
  while (true) {
    const match = remaining.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|<>]+))\s+/,
    );
    if (!match) break;
    environment[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
    remaining = remaining.slice(match[0].length);
  }
  if (!remaining.trim() || Object.keys(environment).length === 0) {
    return { command, environment: {} };
  }
  return { command: remaining, environment };
}

function shellInvocation(command: string, env: NodeJS.ProcessEnv): { command: string; env: NodeJS.ProcessEnv } {
  if (process.platform !== "win32") return { command, env: buildExecutionEnv(env) };
  const extracted = extractLeadingEnvironmentAssignments(command);
  return {
    command: extracted.command,
    env: buildExecutionEnv({ ...env, ...extracted.environment }),
  };
}

export function runToCompletion(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise(resolve => {
    const invocation = shellInvocation(command, env);
    const child = spawn(invocation.command, { cwd, shell: true, detached: process.platform !== "win32", env: invocation.env });
    let stdoutHead = "", stdout = "", stderrHead = "", stderr = "", timedOut = false;
    child.stdout?.on("data", d => {
      const chunk = String(d);
      stdoutHead = head(stdoutHead + chunk);
      stdout = tail(stdout + chunk);
    });
    child.stderr?.on("data", d => {
      const chunk = String(d);
      stderrHead = head(stderrHead + chunk);
      stderr = tail(stderr + chunk);
    });
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.on("close", code => { clearTimeout(timer); resolve({ exitCode: code, timedOut, stdoutHead, stdout, stderrHead, stderr }); });
    child.on("error", err => {
      clearTimeout(timer);
      const error = String(err);
      resolve({
        exitCode: null,
        timedOut,
        stdoutHead,
        stdout,
        stderrHead: head(stderrHead + error),
        stderr: tail(stderr + error),
      });
    });
  });
}

export interface SupervisedApp {
  stop: () => Promise<void>;
  exited: () => { code: number | null; early: boolean } | null;
  output: () => string;
  evidence: () => ProcessEvidence;
}

export function superviseApp(command: string, cwd: string, env: NodeJS.ProcessEnv): SupervisedApp {
  const invocation = shellInvocation(command, env);
  const child = spawn(invocation.command, { cwd, shell: true, detached: process.platform !== "win32", env: invocation.env });
  let outHead = "", outTail = "", exit: { code: number | null; early: boolean } | null = null;
  const capture = (data: unknown) => {
    const chunk = String(data);
    outHead = head(outHead + chunk);
    outTail = tail(outTail + chunk);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.on("close", code => { exit = { code, early: true }; });
  return {
    output: () => outTail,
    evidence: () => extractProcessEvidence(outHead, outTail),
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
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", env: buildExecutionEnv() });
    }
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
  evidence: HealthEvidence | null;
}

const EXPECTED_REDIRECT_PATHS = ["/users/sign_in", "/login", "/signin", "/auth", "/session/new"];
const BODY_EXCERPT_LIMIT = 1000;

function acceptedAsHealthy(statusCode: number | null, redirectLocation: string | null): boolean {
  if (statusCode !== null && statusCode >= 200 && statusCode < 300) return true;
  if (statusCode === null || statusCode < 300 || statusCode >= 400 || !redirectLocation) return false;
  const normalizedLocation = redirectLocation.toLowerCase();
  return EXPECTED_REDIRECT_PATHS.some(expected => normalizedLocation.includes(expected));
}

function normalizedHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (["authorization", "cookie", "proxy-authorization", "set-cookie"].includes(name.toLowerCase())) {
      normalized[name] = "[redacted]";
      continue;
    }
    normalized[name] = redactText(Array.isArray(value) ? value.join(", ") : value).text;
  }
  return normalized;
}

function connectionErrorMessage(error: Error): string {
  return error.message || (error as NodeJS.ErrnoException).code || "connection failed";
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
  let latestResponse: HealthEvidence | null = null;
  let latestConnectionError: HealthEvidence | null = null;
  while (Date.now() - started < timeoutMs) {
    for (const candidate of extractHealthCandidates(output())) {
      if (!candidates.has(candidate)) discoveredCandidates.add(candidate);
      candidates.add(candidate);
    }
    for (const url of candidates) {
      attempts++;
      const evidence = await probe(url);
      if (evidence.statusCode !== null) latestResponse = evidence;
      else if (evidence.connectionError || !latestConnectionError) latestConnectionError = evidence;
      if (evidence.acceptedAsHealthy) {
        return {
          responded: true,
          status: evidence.statusCode,
          attempts,
          elapsedMs: Date.now() - started,
          url,
          candidates: [...candidates],
          discoveredCandidates: [...discoveredCandidates],
          evidence,
        };
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  for (const candidate of extractHealthCandidates(output())) {
    if (!candidates.has(candidate)) discoveredCandidates.add(candidate);
    candidates.add(candidate);
  }
  const evidence = latestResponse ?? latestConnectionError;
  return {
    responded: evidence?.statusCode !== null && evidence?.statusCode !== undefined,
    status: evidence?.statusCode ?? null,
    attempts,
    elapsedMs: Date.now() - started,
    url: evidence?.requestedUrl ?? null,
    candidates: [...candidates],
    discoveredCandidates: [...discoveredCandidates],
    evidence,
  };
}

export function pollHealth(url: string, timeoutMs: number, intervalMs = 1000): Promise<HealthObservation> {
  return pollHealthCandidates([url], timeoutMs, () => "", intervalMs);
}

function probe(url: string): Promise<HealthEvidence> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (evidence: HealthEvidence) => {
      if (settled) return;
      settled = true;
      resolve(evidence);
    };
    const connectionFailure = (message: string): HealthEvidence => ({
      requestedUrl: url,
      statusCode: null,
      statusText: null,
      headers: {},
      redirectLocation: null,
      bodyExcerpt: "",
      timestamp: new Date().toISOString(),
      acceptedAsHealthy: false,
      connectionError: redactText(message).text,
    });
    const req = http.get(url, { timeout: 3000 }, res => {
      let bodyExcerpt = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        if (bodyExcerpt.length < BODY_EXCERPT_LIMIT) {
          bodyExcerpt += String(chunk).slice(0, BODY_EXCERPT_LIMIT - bodyExcerpt.length);
        }
      });
      res.on("end", () => {
        const statusCode = res.statusCode ?? null;
        const headers = normalizedHeaders(res.headers);
        const redirectLocation = headers.location ?? null;
        finish({
          requestedUrl: url,
          statusCode,
          statusText: statusCode === null ? null : res.statusMessage || http.STATUS_CODES[statusCode] || null,
          headers,
          redirectLocation,
          bodyExcerpt: redactText(bodyExcerpt).text,
          timestamp: new Date().toISOString(),
          acceptedAsHealthy: acceptedAsHealthy(statusCode, redirectLocation),
          connectionError: null,
        });
      });
      res.on("error", error => finish(connectionFailure(connectionErrorMessage(error))));
    });
    req.on("timeout", () => {
      finish(connectionFailure("request timed out after 3000ms"));
      req.destroy();
    });
    req.on("error", error => finish(connectionFailure(connectionErrorMessage(error))));
  });
}
