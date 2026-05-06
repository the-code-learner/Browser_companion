#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

let inputBuffer = Buffer.alloc(0);

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

  writeMessage({
    connected: false,
    status: "unsupported",
    message: `Unsupported bridge message: ${message?.type || "missing"}`
  });
}

function getHealth() {
  const codexVersion = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32"
  });

  if (codexVersion.error || codexVersion.status !== 0) {
    return {
      connected: false,
      status: "codex_missing",
      message: "Codex CLI was not found on PATH. Install Codex and sign in with ChatGPT to continue."
    };
  }

  return {
    connected: true,
    status: "ready",
    codexVersion: codexVersion.stdout.trim(),
    message: "Local connector can reach Codex CLI. Login/session checks are the next integration step."
  };
}

function writeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([length, payload]));
}

