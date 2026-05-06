import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const requiredFiles = [
  "manifest.json",
  "src/background/service-worker.js",
  "src/sidepanel/index.html",
  "src/sidepanel/App.js",
  "src/content/page-probe.js",
  "src/content/actions.js",
  "src/shared/messages.js",
  "src/shared/policy.js",
  "src/shared/schemas.js",
  "codex/system-prompt.md",
  "codex/tool-schema.json",
  "native-host/host-manifest.json",
  "native-host/bridge.js",
  "native-host/install-windows.ps1"
];

const missing = [];

for (const file of requiredFiles) {
  try {
    await fs.access(path.join(root, file));
  } catch {
    missing.push(file);
  }
}

const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));

if (manifest.manifest_version !== 3) {
  throw new Error("manifest.json must use Manifest V3.");
}

if (missing.length > 0) {
  throw new Error(`Missing required files:\n${missing.join("\n")}`);
}

console.log("Browser Companion extension scaffold looks consistent.");
