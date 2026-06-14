// Redaction for shareable artifacts. Rule: anything that leaves the machine goes
// through here first, and the user is shown the exact redacted output before sharing.
import os from "node:os";

const PATTERNS: { name: string; re: RegExp; replace: string }[] = [
  { name: "private keys", re: /-----BEGIN ((?:(?:RSA|EC|OPENSSH) )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, replace: "[redacted-private-key]" },
  { name: "openai keys", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}(?=$|[^A-Za-z0-9_-])/g, replace: "[redacted]" },
  { name: "stripe keys", re: /\b(?:stripe_(?:live|test|restricted)_key_(?:example|placeholder)_[A-Za-z0-9_-]{3,}|(?:s[k]|r[k])_(?:live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,})\b/gi, replace: "[redacted]" },
  { name: "slack tokens", re: /\bxox[bpar]-[A-Za-z0-9-]{12,}\b/g, replace: "[redacted-slack-token]" },
  { name: "google api keys", re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replace: "[redacted-google-api-key]" },
  { name: "webhook secrets", re: /\bwebhook_secret_(?:example|placeholder)_[A-Za-z0-9_-]{3,}\b/gi, replace: "[redacted]" },
  { name: "secret placeholder values", re: /\b(?:secret|token|api[_-]?key|password)_(?:example|placeholder)_[A-Za-z0-9_-]{3,}\b/gi, replace: "[redacted]" },
  { name: "env assignment secrets", re: /\b((?=[A-Z0-9_]*(?:STRIPE|SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY))[A-Z][A-Z0-9_]*)=([^\s'"]+)/g, replace: "$1=[redacted]" },
  { name: "json secret fields", re: /("(?:stripe|secret|token|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|database[_-]?url|authorization|cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, replace: '$1"[redacted]"' },
  { name: "query secret fields", re: /([?&](?:secret|token|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key)=)[^&\s]+/gi, replace: "$1[redacted]" },
  { name: "url credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@\/]+):([^\s@\/]+)@/g, replace: "$1[redacted]:[redacted]@" },
  { name: "database url values", re: /\b((?:[A-Z][A-Z0-9_]*_)?DATABASE_URL(?:_[A-Z0-9_]+)?)=((?![a-z][a-z0-9+.-]*:\/\/\[redacted\]:\[redacted\]@)[^\s'"]+)/g, replace: "$1=[redacted]" },
  { name: "bearer tokens", re: /\b(Bearer|token)\s+[A-Za-z0-9\-._~+/]{16,}={0,2}/g, replace: "$1 [redacted]" },
  { name: "github tokens", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: "[redacted-github-token]" },
  { name: "aws access keys", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[redacted-aws-key]" },
  { name: "jwt-like", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: "[redacted-jwt]" },
  { name: "long hex secrets", re: /\b[0-9a-f]{40,}\b/gi, replace: "[redacted-hex]" },
];

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function redactHighEntropyTokens(input: string): { text: string; applied: boolean } {
  let applied = false;
  const text = input.replace(/[A-Za-z0-9_-]{32,}/g, (candidate, offset: number, source: string) => {
    if (
      !/[a-z]/.test(candidate) ||
      !/[A-Z]/.test(candidate) ||
      !/\d/.test(candidate) ||
      /^[0-9a-f]+$/i.test(candidate) ||
      new Set(candidate).size < 16 ||
      shannonEntropy(candidate) < 4.5
    ) {
      return candidate;
    }

    const before = source.slice(0, offset);
    const after = source.slice(offset + candidate.length);
    const leftContext = before.match(/\S+$/)?.[0] ?? "";
    const contextStart = offset - leftContext.length;
    const contextEndMatch = after.match(/\s/);
    const contextEnd = offset + candidate.length + (contextEndMatch?.index ?? after.length);
    const context = source.slice(contextStart, contextEnd);
    // This deliberately conservative heuristic skips URL/path contexts and
    // borderline entropy. Named provider patterns remain the reliable path.
    if (/[\\/]/.test(context) || /(?:https?|file):\/\//i.test(context)) return candidate;

    applied = true;
    return "[redacted-high-entropy-token]";
  });
  return { text, applied };
}

export function redactText(input: string): { text: string; applied: string[] } {
  let text = input;
  const applied: string[] = [];
  for (const p of PATTERNS) {
    if (p.re.test(text)) { applied.push(p.name); text = text.replace(p.re, p.replace); }
    p.re.lastIndex = 0;
  }
  const entropyRedaction = redactHighEntropyTokens(text);
  text = entropyRedaction.text;
  if (entropyRedaction.applied) applied.push("high-entropy token");
  // machine-identifying paths
  const home = os.homedir();
  if (home && text.includes(home)) { text = text.split(home).join("~"); applied.push("home directory path"); }
  const userPath = /\/(?:Users|home)\/[^/\s]+/g;
  if (userPath.test(text)) {
    applied.push("local username path");
    text = text.replace(userPath, "~");
  }
  userPath.lastIndex = 0;
  return { text, applied };
}

const SENSITIVE_FIELD = /^(?:stripe|[a-z0-9_-]*[_-]stripe|secret|[a-z0-9_-]*[_-]secret|token|[a-z0-9_-]*[_-]token|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|database[_-]?url|credential|credentials|authorization|cookie|set-cookie)$/i;

export function redactJsonValue(input: unknown): { value: unknown; applied: string[] } {
  const applied = new Set<string>();
  const visit = (value: unknown, key = ""): unknown => {
    if (SENSITIVE_FIELD.test(key) && value !== null && value !== undefined) {
      applied.add("sensitive field value");
      return "[redacted]";
    }
    if (typeof value === "string") {
      if (
        /(?:hash|sha256|commit)$/i.test(key) &&
        /^[0-9a-f]{40,64}$/i.test(value)
      ) {
        return value;
      }
      const redacted = redactText(value);
      for (const rule of redacted.applied) applied.add(rule);
      return redacted.text;
    }
    if (Array.isArray(value)) return value.map(item => visit(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [childKey, visit(childValue, childKey)]),
      );
    }
    return value;
  };
  return { value: visit(input), applied: [...applied].sort() };
}
