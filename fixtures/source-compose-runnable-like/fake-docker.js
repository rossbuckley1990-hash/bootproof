const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
const statePath = path.join(".bootproof", "fake-compose.pid");
const healthy = fs.existsSync(".fake-compose-healthy");
const compose = fs.readFileSync("docker-compose.yml", "utf8");
const port = Number(compose.match(/"(\d+):3000"/)?.[1]);

if (args.includes("up")) {
  if (healthy) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const child = spawn(process.execPath, ["server.js"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PORT: String(port) },
    });
    fs.writeFileSync(statePath, String(child.pid));
    child.unref();
  }
  console.log("compose start request accepted");
  process.exit(0);
}

if (args.includes("ps")) {
  console.log(fs.existsSync(statePath) ? "web running" : "web exited");
  process.exit(0);
}

if (args.includes("logs")) {
  console.log(healthy
    ? "web | listening"
    : "web | source-built fixture did not become healthy");
  process.exit(0);
}

console.error(`unsupported fake docker invocation: ${args.join(" ")}`);
process.exit(2);
