// Ported from OpenRun's Windows/WSL work: normalize host paths for Docker bind mounts.
// WSL2 paths (/mnt/c/...) are already Docker-native inside WSL: pass through.
// Windows drive paths (C:\\Users\\x) become /c/Users/x for Docker Desktop binds.
export type HostPlatform = "windows" | "wsl2" | "linux" | "macos";

export function normalizeDockerBindPath(p: string, platform: HostPlatform): string {
  if (platform === "wsl2" && /^\/mnt\/[^/]+\//.test(p)) return p;
  if (platform === "windows") {
    const m = p.match(/^([A-Za-z]):[\\/](.*)$/);
    if (m) return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
  }
  return p;
}

export function detectHostPlatform(): HostPlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  try {
    const fs = require("node:fs");
    if (/microsoft/i.test(fs.readFileSync("/proc/version", "utf8"))) return "wsl2";
  } catch { /* not linux-with-procfs */ }
  return "linux";
}
