import fs from "node:fs";

const verdictPath = process.env.BOOTPROOF_ACTION_VERDICT_PATH;
if (!verdictPath || !fs.existsSync(verdictPath)) {
  console.error("BootProof action did not produce a verdict file.");
  process.exit(1);
}

const verdict = JSON.parse(fs.readFileSync(verdictPath, "utf8"));
if (verdict.shouldFail) {
  console.error(verdict.failureReason || "BootProof verification did not pass.");
  process.exit(1);
}
