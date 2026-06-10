// Redaction for shareable artifacts. Rule: anything that leaves the machine goes
// through here first, and the user is shown the exact redacted output before sharing.
import os from "node:os";

const PATTERNS: { name: string; re: RegExp; replace: string }[] = [
  { name: "env assignment secrets", re: /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)=([^\s'"]+)/g, replace: "$1=[redacted]" },
  { name: "url credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@\/]+):([^\s@\/]+)@/g, replace: "$1[redacted]:[redacted]@" },
  { name: "bearer tokens", re: /\b(Bearer|token)\s+[A-Za-z0-9\-._~+/]{16,}={0,2}/g, replace: "$1 [redacted]" },
  { name: "github tokens", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: "[redacted-github-token]" },
  { name: "aws access keys", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[redacted-aws-key]" },
  { name: "jwt-like", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: "[redacted-jwt]" },
  { name: "long hex secrets", re: /\b[0-9a-f]{40,}\b/gi, replace: "[redacted-hex]" },
];

export function redactText(input: string): { text: string; applied: string[] } {
  let text = input;
  const applied: string[] = [];
  for (const p of PATTERNS) {
    if (p.re.test(text)) { applied.push(p.name); text = text.replace(p.re, p.replace); }
    p.re.lastIndex = 0;
  }
  // machine-identifying paths
  const home = os.homedir();
  if (home && text.includes(home)) { text = text.split(home).join("~"); applied.push("home directory path"); }
  text = text.replace(/\/(?:Users|home)\/[^/\s]+/g, "~");
  return { text, applied };
}
