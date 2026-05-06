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

  if (message?.type === "synthesis_request") {
    writeMessage(runSynthesisRequest(message.payload));
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

  if (message?.type === "http_request") {
    runHttpRequest(message.payload)
      .then(writeMessage)
      .catch((error) => writeMessage({
        type: "http_response",
        status: "error",
        message: error.message || "HTTP request failed."
      }));
    return;
  }

  if (message?.type === "web_search") {
    runWebSearch(message.payload)
      .then(writeMessage)
      .catch((error) => writeMessage({
        type: "web_search",
        status: "error",
        results: [],
        message: error.message || "Web search failed."
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

async function runHttpRequest(payload = {}) {
  const method = String(payload.method || "GET").toUpperCase();
  const allowedMethods = new Set(["GET", "HEAD", "OPTIONS"]);

  if (!allowedMethods.has(method)) {
    throw new Error("Only GET, HEAD, and OPTIONS HTTP requests are supported by the safe HTTP tool.");
  }

  const url = normalizeHttpUrl(payload.url || payload.value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: sanitizeHeaders(payload.headers || {})
    });
    const headers = Object.fromEntries(response.headers.entries());
    const contentType = response.headers.get("content-type") || "";
    const bodyText = method === "HEAD" ? "" : await readLimitedResponseText(response, 200000);

    return {
      type: "http_response",
      status: response.ok ? "success" : "http_error",
      url,
      finalUrl: response.url,
      statusCode: response.status,
      ok: response.ok,
      contentType,
      headers,
      bodyPreview: bodyText,
      message: `Fetched ${response.status} ${response.url} (${bodyText.length} characters captured).`
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runWebSearch(payload = {}) {
  const query = compact(payload.query || payload.value);
  const limit = Math.min(Math.max(Number(payload.limit || 8), 1), 10);

  if (!query) {
    throw new Error("Web search query is missing.");
  }

  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "BrowserCompanion/0.1",
      "Accept": "text/html"
    },
    redirect: "follow"
  });
  const html = await response.text();
  const results = parseDuckDuckGoResults(html).slice(0, limit);

  return {
    type: "web_search",
    status: "success",
    query,
    results,
    message: `Found ${results.length} public web result${results.length === 1 ? "" : "s"} for "${query}".`
  };
}

function parseDuckDuckGoResults(html) {
  const results = [];
  const resultBlocks = html.match(/<div class="result[\s\S]*?<\/div>\s*<\/div>/g) || [];

  for (const block of resultBlocks) {
    const linkMatch = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/);
    const rawUrl = decodeHtml(linkMatch[1]);
    const url = unwrapDuckDuckGoUrl(rawUrl);
    results.push({
      title: cleanHtml(linkMatch[2]),
      url,
      snippet: cleanHtml(snippetMatch?.[1] || snippetMatch?.[2] || "")
    });
  }

  return results;
}

function unwrapDuckDuckGoUrl(url) {
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg || parsed.href;
  } catch {
    return url;
  }
}

function cleanHtml(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeHttpUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    throw new Error("HTTP request URL is missing.");
  }

  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }

  return url.href;
}

function sanitizeHeaders(headers) {
  const blocked = new Set(["cookie", "authorization", "proxy-authorization", "host", "content-length"]);
  const clean = {};

  for (const [key, value] of Object.entries(headers || {})) {
    const lowerKey = key.toLowerCase();
    if (blocked.has(lowerKey)) continue;
    clean[key] = String(value);
  }

  clean["User-Agent"] ||= "BrowserCompanion/0.1";
  return clean;
}

async function readLimitedResponseText(response, limit) {
  const reader = response.body?.getReader();

  if (!reader) {
    return "";
  }

  const chunks = [];
  let received = 0;

  while (received < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
  }

  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
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
    "--model",
    normalizeModel(payload.model),
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
      message: summarizeCodexFailure(result)
    };
  }

  try {
    const responseText = fs.readFileSync(outputPath, "utf8").trim();
    return JSON.parse(responseText);
  } catch (error) {
    return {
      type: "natural_response",
      text: "Codex responded, but the response was not valid Browser Companion JSON."
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runSynthesisRequest(payload = {}) {
  const health = getHealth();

  if (!health.connected) {
    return {
      type: "natural_response",
      text: "I gathered tool results, but Codex is not available to synthesize them."
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-companion-"));
  const outputPath = path.join(tempDir, "codex-synthesis.txt");
  const prompt = buildSynthesisPrompt(payload);

  const result = runCodex([
    "exec",
    "--model",
    normalizeModel(payload.model),
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--output-last-message",
    outputPath,
    "-"
  ], {
    input: prompt,
    timeout: 120000
  });

  if (result.error || result.status !== 0) {
    return {
      type: "natural_response",
      text: summarizeCodexFailure(result)
    };
  }

  try {
    return {
      type: "natural_response",
      text: fs.readFileSync(outputPath, "utf8").trim()
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

function buildSynthesisPrompt(payload) {
  const systemPrompt = fs.readFileSync(path.join(projectRoot, "codex", "system-prompt.md"), "utf8");

  return [
    systemPrompt,
    "",
    "Task: Produce a concise answer-focused synthesis for the user. Do not return JSON. Do not dump raw search results. Explain what is known, what sources indicate, and any uncertainty.",
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
    "Tool execution results JSON:",
    JSON.stringify(payload.results || [], null, 2)
  ].join("\n");
}

function normalizeModel(model) {
  const allowed = new Set([
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.2"
  ]);

  return allowed.has(model) ? model : "gpt-5.5";
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

function summarizeCodexFailure(result) {
  const combined = compact(`${result.error?.message || ""} ${result.stderr || ""} ${result.stdout || ""}`);
  const schemaMessage = combined.match(/Invalid schema[^"]*|invalid_json_schema[^"]*/i)?.[0];

  if (schemaMessage) {
    return `Codex rejected the response schema: ${schemaMessage}`;
  }

  const errorMessage = combined.match(/ERROR:\s*(\{.*?\})(?=\s*ERROR:|\s*$)/i)?.[1];
  if (errorMessage) {
    try {
      const parsed = JSON.parse(errorMessage);
      return parsed.error?.message || "Codex returned an error.";
    } catch {
      return compact(errorMessage).slice(0, 500);
    }
  }

  return combined.slice(-800) || "Codex agent request failed.";
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
