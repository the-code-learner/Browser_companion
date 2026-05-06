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
const codexBin = resolveCodexBin();

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

  if (message?.type === "extract_attachment") {
    extractAttachment(message.payload)
      .then(writeMessage)
      .catch((error) => writeMessage({
        type: "attachment_extraction",
        status: "error",
        text: "",
        message: error.message || "Attachment extraction failed."
      }));
    return;
  }

  writeMessage({
    connected: false,
    status: "unsupported",
    message: `Unsupported bridge message: ${message?.type || "missing"}`
  });
}

async function extractAttachment(payload = {}) {
  const fileName = payload.name || "attachment";
  const extension = path.extname(fileName).toLowerCase();
  const mimeType = payload.type || "";
  const bytes = Buffer.from(payload.base64 || "", "base64");

  if (!bytes.length) {
    return {
      type: "attachment_extraction",
      status: "empty",
      text: "",
      message: "Attachment did not contain readable bytes."
    };
  }

  if (isTextLike(fileName, mimeType)) {
    return extractionResult(bytes.toString("utf8"), "text ready");
  }

  if (extension === ".docx" || mimeType.includes("wordprocessingml")) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: bytes });
    return extractionResult(result.value, "docx text ready", result.messages?.map((item) => item.message));
  }

  if (extension === ".pdf" || mimeType === "application/pdf") {
    const pdfParse = await import("pdf-parse");
    const parser = pdfParse.default || pdfParse;
    const result = await parser(bytes);
    return extractionResult(result.text, "pdf text ready");
  }

  if (extension === ".xlsx" || mimeType.includes("spreadsheetml")) {
    const exceljs = await import("exceljs");
    const workbook = new exceljs.default.Workbook();
    await workbook.xlsx.load(bytes);
    const parts = [];
    workbook.eachSheet((worksheet) => {
      const lines = [`Sheet: ${worksheet.name}`];
      worksheet.eachRow((row) => {
        const values = row.values.slice(1).map((value) => cellToText(value));
        lines.push(values.join(","));
      });
      parts.push(lines.join("\n"));
    });
    return extractionResult(parts.join("\n\n"), "spreadsheet text ready");
  }

  if ([".xls", ".ods"].includes(extension)) {
    return {
      type: "attachment_extraction",
      status: "registered",
      text: "",
      message: "Legacy spreadsheet formats are registered but not extracted. Save the file as XLSX or CSV."
    };
  }

  if (/^image\//.test(mimeType) || [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"].includes(extension)) {
    const tesseract = await import("tesseract.js");
    const worker = await tesseract.createWorker("eng");
    try {
      const result = await worker.recognize(bytes);
      return extractionResult(result.data.text, "ocr text ready");
    } finally {
      await worker.terminate();
    }
  }

  return {
    type: "attachment_extraction",
    status: "registered",
    text: "",
    message: "This attachment type is registered but no extractor is available yet."
  };
}

function extractionResult(text, status, warnings = []) {
  const cleanText = compact(text).slice(0, 120000);
  return {
    type: "attachment_extraction",
    status,
    text: cleanText,
    warnings,
    message: cleanText ? `Extracted ${cleanText.length} characters.` : "No text was extracted."
  };
}

function isTextLike(fileName, mimeType) {
  return /^text\//i.test(mimeType) || /json|csv|xml|markdown|javascript|typescript|html|css/i.test(mimeType) || /\.(txt|md|csv|json|xml|html|css|js|ts)$/i.test(fileName);
}

function getHealth() {
  const codexVersion = runCodex(["--version"]);

  if (codexVersion.error || codexVersion.status !== 0) {
    return {
      connected: false,
      status: "codex_missing",
      codexPath: codexBin,
      message: "Codex CLI was not found by the native connector. Re-run the connector install command from a terminal where codex works, or edit CODEX_BIN in native-host/bridge-launcher.cmd."
    };
  }

  const loginStatus = runCodex(["login", "status"]);
  const loginText = `${loginStatus.stdout || ""}\n${loginStatus.stderr || ""}`;
  const loggedIn = loginStatus.status === 0 && !/not logged in|not authenticated|no login/i.test(loginText);

  return {
    connected: loggedIn,
    status: loggedIn ? "ready" : "login_required",
    codexVersion: codexVersion.stdout.trim(),
    codexPath: codexBin,
    capabilities: getCapabilities(),
    message: loggedIn
      ? "Local connector can reach Codex CLI and a login session appears to be available."
      : "Codex CLI is installed, but ChatGPT/Codex sign-in is required."
  };
}

function getCapabilities() {
  return {
    codexExec: true,
    attachmentExtraction: {
      text: true,
      docx: hasPackage("mammoth"),
      pdf: hasPackage("pdf-parse"),
      spreadsheet: hasPackage("exceljs"),
      imageOcr: hasPackage("tesseract.js")
    },
    protocolVersion: 2
  };
}

function hasPackage(packageName) {
  try {
    import.meta.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

function connectCodex() {
  const health = getHealth();

  if (health.connected) {
    return health;
  }

  if (health.status === "codex_missing") {
    return health;
  }

  const child = spawnLoginProcess();
  child.unref();

  return {
    connected: false,
    status: "login_started",
    message: "Codex login was started. Complete the ChatGPT sign-in flow, then check the connector again."
  };
}

function spawnLoginProcess() {
  const loginCommand = `"${codexBin}" login --device-auth`;

  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/c", "start", "Browser Companion Codex Login", "cmd.exe", "/k", loginCommand], {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
  }

  if (process.platform === "darwin") {
    return spawn("osascript", ["-e", 'tell application "Terminal" to do script "codex login --device-auth"'], {
      detached: true,
      stdio: "ignore"
    });
  }

  return spawn("sh", ["-lc", 'x-terminal-emulator -e "codex login --device-auth" || gnome-terminal -- sh -lc "codex login --device-auth; read -p Press\\\\ Enter" || codex login --device-auth'], {
    detached: true,
    stdio: "ignore"
  });
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
    "Response language:",
    payload.responseLanguage || "same language as the user",
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
  return spawnSync(codexBin, args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: 1024 * 1024 * 12,
    ...options
  });
}

function resolveCodexBin() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) {
    return process.env.CODEX_BIN;
  }

  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.USERPROFILE || "", ".vscode", "extensions"),
      path.join(process.env.LOCALAPPDATA || "", "Programs")
    ];

    for (const base of candidates) {
      const found = findFile(base, "codex.exe", 4);
      if (found) return found;
    }

    return "codex.exe";
  }

  return "codex";
}

function findFile(root, fileName, maxDepth, depth = 0) {
  if (!root || depth > maxDepth || !fs.existsSync(root)) {
    return null;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      return fullPath;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFile(path.join(root, entry.name), fileName, maxDepth, depth + 1);
    if (found) return found;
  }

  return null;
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

function cellToText(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.text) return value.text;
    if (value.result != null) return String(value.result);
    if (value.richText) return value.richText.map((part) => part.text).join("");
    if (value.hyperlink) return value.hyperlink;
    return JSON.stringify(value);
  }
  return String(value);
}
