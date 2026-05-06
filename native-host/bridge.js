#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

let inputBuffer = Buffer.alloc(0);
const bridgeDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(bridgeDir, "..");

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  readMessages();
});

function readMessages() {
  while (inputBuffer.length >= 4) {
    const messageLength = inputBuffer.readUInt32LE(0);

    if (inputBuffer.length < messageLength + 4) {
      return;
    }

    const rawMessage = inputBuffer.subarray(4, 4 + messageLength).toString("utf8");
    inputBuffer = inputBuffer.subarray(4 + messageLength);

    handleMessage(JSON.parse(rawMessage));
  }
}

function handleMessage(message) {
  if (message?.type === "health") {
    writeMessage(getHealth());
    return;
  }

  if (message?.type === "connect") {
    writeMessage(connectCodex());
    return;
  }

  if (message?.type === "agent_request") {
    writeMessage(runAgentRequest(message.payload));
    return;
  }

  writeMessage({
    connected: false,
    status: "unsupported",
    message: `Unsupported bridge message: ${message?.type || "missing"}`
  });
}

function getHealth() {
  const codexVersion = runCodex(["--version"]);

  if (codexVersion.error || codexVersion.status !== 0) {
    return {
      connected: false,
      status: "codex_missing",
      message: "Codex CLI was not found on PATH. Install Codex and sign in with ChatGPT to continue."
    };
  }

  const loginStatus = runCodex(["login", "status"]);
  const loginText = `${loginStatus.stdout || ""}\n${loginStatus.stderr || ""}`;
  const loggedIn = loginStatus.status === 0 && !/not logged in|not authenticated|no login/i.test(loginText);

  return {
    connected: loggedIn,
    status: loggedIn ? "ready" : "login_required",
    codexVersion: codexVersion.stdout.trim(),
    message: loggedIn
      ? "Local connector can reach Codex CLI and a login session appears to be available."
      : "Codex CLI is installed, but ChatGPT/Codex sign-in is required."
  };
}

function connectCodex() {
  const health = getHealth();

  if (health.connected) {
    return health;
  }

  if (health.status === "codex_missing") {
    return health;
  }

  const child = spawn("codex", ["login", "--device-auth"], {
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32"
  });
  child.unref();

  return {
    connected: false,
    status: "login_started",
    message: "Codex login was started. Complete the ChatGPT sign-in flow, then check the connector again."
  };
}

function runAgentRequest(payload = {}) {
  const health = getHealth();

  if (!health.connected) {
    return {
      type: "agent_unavailable",
      ...health
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-companion-"));
  const outputPath = path.join(tempDir, "codex-response.txt");
  const prompt = buildAgentPrompt(payload);
  const schemaPath = path.join(projectRoot, "codex", "tool-schema.json");

  const result = runCodex([
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-"
  ], {
    input: prompt,
    timeout: 120000
  });

  if (result.error || result.status !== 0) {
    return {
      type: "agent_error",
      message: compact(`${result.error?.message || ""} ${result.stderr || ""}`) || "Codex agent request failed."
    };
  }

  try {
    const responseText = fs.readFileSync(outputPath, "utf8").trim();
    return JSON.parse(responseText);
  } catch (error) {
    return {
      type: "natural_response",
      text: "Codex responded, but the response was not a valid Browser Companion plan."
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildAgentPrompt(payload) {
  const systemPrompt = fs.readFileSync(path.join(projectRoot, "codex", "system-prompt.md"), "utf8");

  return [
    systemPrompt,
    "",
    "User goal:",
    payload.goal || "",
    "",
    "Current page observation JSON:",
    JSON.stringify(payload.observation || {}, null, 2),
    "",
    "Local attachment context JSON:",
    JSON.stringify(payload.attachments || [], null, 2),
    "",
    "Return only a JSON object that matches the Browser Companion tool schema when actions are needed."
  ].join("\n");
}

function runCodex(args, options = {}) {
  return spawnSync("codex", args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 1024 * 1024 * 12,
    ...options
  });
}

function writeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([length, payload]));
}

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
