const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
const base = fs.readFileSync("docker-compose.yml", "utf8");
const basePort = Number(base.match(/"(\d+):3000"/)?.[1]);
const overrideName = "docker-compose.bootproof.override.yml";
const hasOverride = args.includes(overrideName) && fs.existsSync(overrideName);
const override = hasOverride ? fs.readFileSync(overrideName, "utf8") : "";
const repairedPort = Number(override.match(/"(\d+):3000"/)?.[1]);
const pidPath = path.join(".bootproof", "fake-repair.pid");

if (args.includes("up")) {
  if (!hasOverride) {
    if (process.env.BOOTPROOF_FAIL_IF_BASELINE_RERUN === "1") {
      console.error("baseline rerun forbidden by fixture");
      process.exit(77);
    }
    console.error(`Bind for 0.0.0.0:${basePort} failed: port is already allocated`);
    process.exit(1);
  }
  if (!fs.existsSync(".fake-repair-stall")) {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    const child = spawn(process.execPath, ["server.js"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PORT: String(repairedPort) },
    });
    fs.writeFileSync(pidPath, String(child.pid));
    child.unref();
  }
  console.log("compose start request accepted with BootProof override");
  process.exit(0);
}

if (args.includes("ps")) {
  console.log(fs.existsSync(pidPath) ? "web running" : "web exited");
  process.exit(0);
}

if (args.includes("logs")) {
  console.log(fs.existsSync(".fake-repair-stall")
    ? "web | override applied but fixture remained unhealthy"
    : "web | listening after override");
  process.exit(0);
}

if (args.includes("down")) {
  if (fs.existsSync(pidPath)) {
    const pid = Number(fs.readFileSync(pidPath, "utf8"));
    try { process.kill(pid, "SIGTERM"); } catch {}
    fs.rmSync(pidPath, { force: true });
  }
  process.exit(0);
}

console.error(`unsupported fake docker invocation: ${args.join(" ")}`);
process.exit(2);
