import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { buildAttestation } from "./proof.js";
import { redactText } from "./redact.js";
import type {
  Attestation,
  ExternalVerificationClassification,
  HealthEvidence,
} from "./types.js";

const RESPONSE_SNIPPET_LIMIT = 1000;
const SENSITIVE_HEADER_NAME = /authorization|cookie|token|secret|api[-_]?key|password|passwd|credential|private[-_]?key|signature/i;
const SENSITIVE_FIELD_NAME = String.raw`(?:access[_-]?token|refresh[_-]?token|token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|cookie|session)`;

interface HttpResponseObservation {
  requestedUrl: string;
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  redirectLocation: string | null;
  responseSnippet: string;
  observedAt: string;
}

export interface ExternalHealthObservation {
  requestedUrl: string;
  statusCode: number | null;
  statusText: string | null;
  finalUrl: string;
  headers: Record<string, string>;
  redirectLocation: string | null;
  responseSnippet: string;
  observedAt: string;
  classification: ExternalVerificationClassification;
  verified: boolean;
  connectionError: string | null;
}

function parsedExternalUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported external health URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("external health URLs must not contain credentials");
  }
  return url;
}

function safeRecordedUrl(value: string | URL): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const name of new Set(url.searchParams.keys())) {
    url.searchParams.set(name, "[redacted]");
  }
  return url.toString();
}

function safeRedirectLocation(location: string, baseUrl: string): string {
  try {
    const sanitized = new URL(location, baseUrl);
    const safe = safeRecordedUrl(sanitized);
    if (location.startsWith("/")) {
      const parsed = new URL(safe);
      return `${parsed.pathname}${parsed.search}`;
    }
    return safe;
  } catch {
    return redactText(location).text;
  }
}

function redactExternalText(value: string): string {
  return redactText(value).text
    .replace(new RegExp(`("${SENSITIVE_FIELD_NAME}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "gi"), '$1"[redacted]"')
    .replace(new RegExp(`\\b(${SENSITIVE_FIELD_NAME}=)[^&\\s]+`, "gi"), "$1[redacted]");
}

function safeResponseHeaders(headers: IncomingHttpHeaders, baseUrl: string): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (SENSITIVE_HEADER_NAME.test(name)) {
      safe[name] = "[redacted]";
      continue;
    }
    const joined = Array.isArray(value) ? value.join(", ") : value;
    safe[name] = name.toLowerCase() === "location"
      ? safeRedirectLocation(joined, baseUrl)
      : redactExternalText(joined);
  }
  return safe;
}

function requestOnce(url: URL, timeoutMs: number): Promise<HttpResponseObservation> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.get(url, { timeout: timeoutMs }, response => {
      let responseSnippet = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        if (responseSnippet.length >= RESPONSE_SNIPPET_LIMIT) return;
        responseSnippet += String(chunk).slice(0, RESPONSE_SNIPPET_LIMIT - responseSnippet.length);
      });
      response.on("end", () => {
        const statusCode = response.statusCode ?? 0;
        const headers = safeResponseHeaders(response.headers, url.toString());
        resolve({
          requestedUrl: safeRecordedUrl(url),
          statusCode,
          statusText: response.statusMessage || http.STATUS_CODES[statusCode] || "",
          headers,
          redirectLocation: headers.location ?? null,
          responseSnippet: redactExternalText(responseSnippet).slice(0, RESPONSE_SNIPPET_LIMIT),
          observedAt: new Date().toISOString(),
        });
      });
      response.on("error", reject);
    });
    request.on("timeout", () => {
      request.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    request.on("error", reject);
  });
}

export async function observeExternalHealth(
  value: string,
  timeoutMs = 5000,
): Promise<ExternalHealthObservation> {
  const initialUrl = parsedExternalUrl(value);
  try {
    const response = await requestOnce(initialUrl, timeoutMs);
    const finalUrl = response.requestedUrl;
    const authRequired = response.statusCode === 401 || response.statusCode === 403;
    const verified = response.statusCode >= 200 && response.statusCode < 400;
    const classification: ExternalVerificationClassification = authRequired
      ? "auth_required"
      : verified
        ? "external_service_verified"
        : "external_health_unreachable";
    return {
      requestedUrl: response.requestedUrl,
      statusCode: response.statusCode,
      statusText: response.statusText,
      finalUrl,
      headers: response.headers,
      redirectLocation: response.redirectLocation,
      responseSnippet: response.responseSnippet,
      observedAt: response.observedAt,
      classification,
      verified,
      connectionError: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      requestedUrl: safeRecordedUrl(initialUrl),
      statusCode: null,
      statusText: null,
      finalUrl: safeRecordedUrl(initialUrl),
      headers: {},
      redirectLocation: null,
      responseSnippet: "",
      observedAt: new Date().toISOString(),
      classification: "external_health_unreachable",
      verified: false,
      connectionError: redactExternalText(message),
    };
  }
}

function statusLabel(observation: ExternalHealthObservation): string {
  if (observation.statusCode === null) return "no HTTP response";
  return `HTTP ${observation.statusCode}${observation.statusText ? ` ${observation.statusText}` : ""}`;
}

export async function buildExternalHealthAttestation(
  repo: string,
  url: string,
  timeoutMs = 5000,
): Promise<Attestation> {
  const startedAt = new Date().toISOString();
  const observation = await observeExternalHealth(url, timeoutMs);
  const status = statusLabel(observation);
  const healthEvidence: HealthEvidence = {
    requestedUrl: observation.requestedUrl,
    statusCode: observation.statusCode,
    statusText: observation.statusText,
    headers: observation.headers,
    redirectLocation: observation.redirectLocation,
    bodyExcerpt: observation.responseSnippet,
    timestamp: observation.observedAt,
    acceptedAsHealthy: observation.verified,
    connectionError: observation.connectionError,
  };
  const explanation = observation.verified
    ? `Observed ${status} from an externally managed service. BootProof did not start or orchestrate the service.`
    : observation.classification === "auth_required"
      ? `Observed ${status}; authentication is required, so external health was not fully verified. BootProof did not start or orchestrate the service.`
      : `External health was not verified: ${observation.connectionError ?? status}. BootProof did not start or orchestrate the service.`;

  return buildAttestation({
    repo,
    plan: {
      provider: "local",
      steps: [{
        id: "external-health",
        kind: "health",
        description: "Observe an externally managed HTTP health endpoint",
        required: true,
      }],
      healthUrl: observation.requestedUrl,
      healthCandidates: [observation.requestedUrl],
      observedPort: observation.statusCode === null
        ? null
        : Number(new URL(observation.finalUrl).port || (new URL(observation.finalUrl).protocol === "https:" ? 443 : 80)),
      healthCandidateSource: observation.statusCode === null ? "inferred" : "observed",
      generatedFiles: [],
    },
    observed: [{
      id: "external-health",
      kind: "health",
      startedAt,
      finishedAt: observation.observedAt,
      exitCode: null,
      ok: observation.verified,
      observation: observation.verified
        ? `${status} observed at ${observation.finalUrl}; service ownership is external`
        : `${observation.classification}: ${observation.connectionError ?? status}; service ownership is external`,
    }],
    startedAt,
    booted: false,
    healthVerified: observation.verified,
    healthObservation: observation.verified ? `${status} at ${observation.finalUrl}` : null,
    healthEvidence,
    observedHealthCandidates: [observation.requestedUrl],
    failureClass: observation.classification === "external_service_verified"
      ? null
      : observation.classification,
    failureEvidence: observation.verified
      ? null
      : observation.connectionError ?? `${status} at ${observation.finalUrl}`,
    explanation,
    verificationMode: "external-health",
    bootproofOrchestrated: false,
    externalHealthUrl: observation.requestedUrl,
    observedStatus: observation.statusCode,
    observedFinalUrl: observation.finalUrl,
    observedAt: observation.observedAt,
    responseSnippet: observation.responseSnippet,
    classification: observation.classification,
  });
}
