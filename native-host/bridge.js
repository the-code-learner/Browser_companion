#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import crypto from "node:crypto";

let inputBuffer = Buffer.alloc(0);
const bridgeDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(bridgeDir, "..");
const userMemoryPath = path.join(projectRoot, "USER_MEMORY.md");
const providerDefinitions = createProviderDefinitions();
const codexBin = providerDefinitions["openai-codex"].command;
const npmBin = resolveNpmBin();

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
    writeMessage(connectProvider(message.payload));
    return;
  }

  if (message?.type === "provider_install") {
    writeMessage(installProvider(message.payload));
    return;
  }

  if (message?.type === "nodejs_install") {
    writeMessage(installNodejs());
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

  if (message?.type === "user_memory_get") {
    writeMessage(getUserMemory());
    return;
  }

  if (message?.type === "user_memory_save") {
    try {
      writeMessage(saveUserMemory(message.payload));
    } catch (error) {
      writeMessage({
        type: "user_memory",
        status: "error",
        items: readUserMemoryItems(),
        message: error.message || "User memory could not be saved."
      });
    }
    return;
  }

  if (message?.type === "user_memory_delete") {
    try {
      writeMessage(deleteUserMemory(message.payload));
    } catch (error) {
      writeMessage({
        type: "user_memory",
        status: "error",
        items: readUserMemoryItems(),
        message: error.message || "User memory could not be deleted."
      });
    }
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

  if (extension === ".docx" || mimeType.includes("wordprocessingml")) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: bytes });
    return extractionResult(result.value, "docx text ready", result.messages?.map((item) => item.message));
  }

  if (extension === ".pdf" || mimeType === "application/pdf") {
    const pdfParse = await import("pdf-parse");

    if (typeof pdfParse.PDFParse !== "function") {
      throw new Error("PDF extraction is unavailable because the installed pdf-parse package does not expose PDFParse.");
    }

    const parser = new pdfParse.PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
      return extractionResult(result.text, "pdf text ready");
    } finally {
      await parser.destroy();
    }
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

  if (isTextLike(fileName, mimeType)) {
    return extractionResult(bytes.toString("utf8"), "text ready");
  }

  if (/^image\//.test(mimeType) || [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"].includes(extension)) {
    const tesseract = await import("tesseract.js");
    const worker = await tesseract.createWorker("eng", 1, {
      cachePath: path.join(os.tmpdir(), "browser-companion-tessdata")
    });
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

function getUserMemory() {
  const items = readUserMemoryItems();
  return {
    type: "user_memory",
    status: "ready",
    path: userMemoryPath,
    items,
    message: `Loaded ${items.length} user memory item${items.length === 1 ? "" : "s"}.`
  };
}

function saveUserMemory(payload = {}) {
  const title = compact(payload.title || "User note").slice(0, 120) || "User note";
  const content = compact(payload.content || payload.text || "").slice(0, 5000);

  if (!content) {
    throw new Error("Memory content is empty.");
  }

  const now = new Date().toISOString();
  const items = readUserMemoryItems();
  const id = payload.id && /^[a-z0-9-]{8,80}$/i.test(payload.id)
    ? payload.id
    : crypto.randomUUID();
  const existingIndex = items.findIndex((item) => item.id === id);
  const nextItem = {
    id,
    title,
    content,
    createdAt: existingIndex >= 0 ? items[existingIndex].createdAt : now,
    updatedAt: now
  };

  if (existingIndex >= 0) {
    items[existingIndex] = nextItem;
  } else {
    items.push(nextItem);
  }

  writeUserMemoryItems(items);

  return {
    type: "user_memory",
    status: "saved",
    path: userMemoryPath,
    item: nextItem,
    items,
    message: `Saved memory item "${title}".`
  };
}

function deleteUserMemory(payload = {}) {
  const id = String(payload.id || "");
  const items = readUserMemoryItems();
  const nextItems = items.filter((item) => item.id !== id);

  if (nextItems.length === items.length) {
    throw new Error("Memory item was not found.");
  }

  writeUserMemoryItems(nextItems);

  return {
    type: "user_memory",
    status: "deleted",
    path: userMemoryPath,
    items: nextItems,
    message: "Deleted memory item."
  };
}

function readUserMemoryItems() {
  if (!fs.existsSync(userMemoryPath)) {
    writeUserMemoryItems([]);
    return [];
  }

  const markdown = fs.readFileSync(userMemoryPath, "utf8");
  const items = [];
  const pattern = /<!-- memory:([a-z0-9-]+) -->\s*## ([^\n]+)\n([\s\S]*?)<!-- \/memory:\1 -->/gi;
  let match;

  while ((match = pattern.exec(markdown))) {
    const body = match[3].trim();
    const createdAt = body.match(/\*\*Created:\*\* ([^\n]+)/)?.[1]?.trim() || "";
    const updatedAt = body.match(/\*\*Updated:\*\* ([^\n]+)/)?.[1]?.trim() || "";
    const content = body
      .replace(/\*\*Created:\*\* [^\n]+\n?/i, "")
      .replace(/\*\*Updated:\*\* [^\n]+\n?/i, "")
      .trim();

    items.push({
      id: match[1],
      title: match[2].trim(),
      content,
      createdAt,
      updatedAt
    });
  }

  return items;
}

function writeUserMemoryItems(items) {
  const now = new Date().toISOString();
  const body = items.map((item) => {
    const title = sanitizeMemoryLine(item.title || "User note");
    const content = sanitizeMemoryContent(item.content || "");
    const createdAt = sanitizeMemoryLine(item.createdAt || now);
    const updatedAt = sanitizeMemoryLine(item.updatedAt || now);

    return [
      `<!-- memory:${item.id} -->`,
      `## ${title}`,
      `**Created:** ${createdAt}`,
      `**Updated:** ${updatedAt}`,
      "",
      content,
      `<!-- /memory:${item.id} -->`
    ].join("\n");
  }).join("\n\n");

  fs.writeFileSync(userMemoryPath, [
    "# Browser Companion User Memory",
    "",
    `Last updated: ${now}`,
    "Scope: local user-requested memory, ignored by git.",
    "",
    "This file stores general information about the user only when the user explicitly asks Browser Companion to remember it.",
    "",
    body
  ].join("\n").trimEnd() + "\n", "utf8");
}

function sanitizeMemoryLine(value) {
  return compact(value).replace(/[#<>]/g, "").slice(0, 160);
}

function sanitizeMemoryContent(value) {
  return String(value || "")
    .replace(/<!--\s*memory:[\s\S]*?-->/gi, "")
    .replace(/<!--\s*\/memory:[\s\S]*?-->/gi, "")
    .trim()
    .slice(0, 5000);
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
  const providers = getProviderStatuses();
  const codex = providers.find((provider) => provider.id === "openai-codex");
  const connectedProviders = providers.filter((provider) => provider.connected);
  const primary = codex?.connected ? codex : connectedProviders[0] || codex;

  return {
    connected: connectedProviders.length > 0,
    status: primary?.status || "missing",
    codexVersion: codex?.version || "",
    codexPath: codex?.command || codexBin,
    selectedProvider: primary?.id || "openai-codex",
    providers,
    capabilities: getCapabilities(),
    message: summarizeProviders(providers)
  };
}

function getProviderStatuses() {
  return Object.values(providerDefinitions).map(getProviderStatus);
}

function getProviderStatus(provider) {
  const version = runCommand(provider.command, provider.versionArgs || ["--version"], { timeout: 10000 });
  const installed = !version.error && version.status === 0;

  if (!installed) {
    return {
      id: provider.id,
      label: provider.label,
      installed: false,
      connected: false,
      status: "missing",
      command: provider.command,
      installCommand: provider.installCommand,
      models: provider.models,
      defaultModel: provider.defaultModel,
      message: `${provider.label} CLI was not found.`
    };
  }

  if (provider.id !== "openai-codex") {
    return {
      id: provider.id,
      label: provider.label,
      installed: true,
      connected: true,
      status: "ready",
      command: provider.command,
      version: compact(version.stdout || version.stderr),
      installCommand: provider.installCommand,
      models: provider.models,
      defaultModel: provider.defaultModel,
      message: `${provider.label} CLI is installed. Browser Companion will use its cached login when selected.`
    };
  }

  const loginStatus = runCodex(["login", "status"]);
  const loginText = `${loginStatus.stdout || ""}\n${loginStatus.stderr || ""}`;
  const loggedIn = loginStatus.status === 0 && !/not logged in|not authenticated|no login/i.test(loginText);

  return {
    id: provider.id,
    label: provider.label,
    installed: true,
    connected: loggedIn,
    status: loggedIn ? "ready" : "login_required",
    command: provider.command,
    version: compact(version.stdout || version.stderr),
    installCommand: provider.installCommand,
    models: provider.models,
    defaultModel: provider.defaultModel,
    message: loggedIn
      ? "Codex CLI is installed and signed in."
      : "Codex CLI is installed, but sign-in is required."
  };
}

function summarizeProviders(providers) {
  const connected = providers.filter((provider) => provider.connected).map((provider) => provider.label);
  if (connected.length) {
    return `Connected providers: ${connected.join(", ")}.`;
  }

  return "No connected provider is ready yet.";
}

function getCapabilities() {
  return {
    providers: Object.keys(providerDefinitions),
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

function createProviderDefinitions() {
  return {
    "openai-codex": {
      id: "openai-codex",
      label: "Codex",
      command: resolveCodexBin(),
      installCommand: "npm install -g @openai/codex",
      models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"],
      defaultModel: "gpt-5.5"
    },
    "anthropic-claude-code": {
      id: "anthropic-claude-code",
      label: "Claude Code",
      command: process.platform === "win32" ? "claude.cmd" : "claude",
      installCommand: "npm install -g @anthropic-ai/claude-code",
      models: ["default", "opus", "sonnet", "haiku"],
      defaultModel: "default"
    },
    "google-gemini-cli": {
      id: "google-gemini-cli",
      label: "Gemini CLI",
      command: process.platform === "win32" ? "gemini.cmd" : "gemini",
      installCommand: "npm install -g @google/gemini-cli",
      models: ["default", "gemini-3-pro", "gemini-2.5-pro", "gemini-2.5-flash"],
      defaultModel: "default"
    }
  };
}

function getProviderDefinition(providerId) {
  return providerDefinitions[providerId] || providerDefinitions["openai-codex"];
}

function hasPackage(packageName) {
  try {
    import.meta.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

function connectProvider(payload = {}) {
  const provider = getProviderDefinition(payload.provider || payload.providerId || "openai-codex");
  if (provider.id !== "openai-codex") {
    const status = getProviderStatus(provider);
    if (!status.installed) return status;
    const child = spawnInteractiveProvider(provider);
    child?.unref?.();
    return {
      ...getHealth(),
      status: "login_started",
      message: `${provider.label} was opened in a terminal. Complete the provider sign-in flow there, then check the connector again.`
    };
  }

  const health = getHealth();

  if (health.connected) {
    return health;
  }

  if (health.status === "missing") {
    return health;
  }

  const child = spawnLoginProcess();
  child.unref();

  return {
    ...getHealth(),
    connected: false,
    status: "login_started",
    message: "Codex login was started. Complete the ChatGPT sign-in flow, then check the connector again."
  };
}

function installProvider(payload = {}) {
  const provider = getProviderDefinition(payload.provider || payload.providerId || "openai-codex");
  const command = provider.installCommand;

  if (!command) {
    return {
      ...getHealth(),
      status: "install_unavailable",
      message: `${provider.label} does not have an install command configured.`
    };
  }

  if (!hasNpm()) {
    return {
      ...getHealth(),
      status: "install_blocked",
      provider: provider.id,
      installCommand: command,
      message: "Node/npm was not found on the native host PATH. Install Node.js from https://nodejs.org/en/download, restart Chrome, then click Install again or run the displayed npm command manually."
    };
  }

  const runnableCommand = makeRunnableNpmCommand(command);
  const child = spawnVisibleShell(`${runnableCommand} && echo. && echo Installation finished. Run the provider login/connect step next.`);
  child?.unref?.();

  return {
    ...getHealth(),
    status: "install_started",
    provider: provider.id,
    installCommand: command,
    message: `Started opt-in installation for ${provider.label} in a visible terminal.`
  };
}

function installNodejs() {
  if (hasNpm()) {
    return {
      ...getHealth(),
      status: "ready",
      message: "Node.js/npm is already available to the native host."
    };
  }

  if (hasWinget()) {
    const command = [
      "winget install --id OpenJS.NodeJS.LTS -e --source winget",
      "echo.",
      "echo Node.js installation finished. Restart Chrome, then check the connector again."
    ].join(" && ");
    const child = spawnVisibleShell(command);
    child?.unref?.();

    return {
      ...getHealth(),
      status: "nodejs_install_started",
      message: "Started Node.js/npm installation in a visible terminal. Approve any Windows prompts, then restart Chrome."
    };
  }

  openExternalUrl("https://nodejs.org/en/download");
  return {
    ...getHealth(),
    status: "nodejs_download_opened",
    message: "Winget was not found, so the official Node.js download page was opened. Install Node.js, restart Chrome, then check the connector again."
  };
}

function hasNpm() {
  const result = runCommand(npmBin, ["--version"], { timeout: 10000 });
  return !result.error && result.status === 0;
}

function makeRunnableNpmCommand(command) {
  if (!/^npm\s+/i.test(command)) {
    return command;
  }

  return `${quoteShellPath(npmBin)} ${command.replace(/^npm\s+/i, "")}`;
}

function quoteShellPath(value) {
  const raw = String(value || "");
  if (process.platform === "win32") {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return `'${raw.replace(/'/g, "'\\''")}'`;
}

function hasWinget() {
  if (process.platform !== "win32") {
    return false;
  }

  const result = runCommand("winget.exe", ["--version"], { timeout: 10000 });
  return !result.error && result.status === 0;
}

function openExternalUrl(url) {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
  }

  if (process.platform === "darwin") {
    return spawn("open", [url], {
      detached: true,
      stdio: "ignore"
    });
  }

  return spawn("xdg-open", [url], {
    detached: true,
    stdio: "ignore"
  });
}

function spawnInteractiveProvider(provider) {
  return spawnVisibleShell(provider.command);
}

function spawnVisibleShell(command) {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/c", "start", "Browser Companion Provider Setup", "cmd.exe", "/k", command], {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
  }

  if (process.platform === "darwin") {
    return spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(command)}`], {
      detached: true,
      stdio: "ignore"
    });
  }

  return spawn("sh", ["-lc", `x-terminal-emulator -e ${JSON.stringify(command)} || gnome-terminal -- sh -lc ${JSON.stringify(`${command}; read -p "Press Enter"`)}`], {
    detached: true,
    stdio: "ignore"
  });
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
  const provider = getProviderDefinition(payload.provider || payload.providerId || "openai-codex");
  if (provider.id !== "openai-codex") {
    return runCliAgentRequest(provider, payload);
  }

  const health = getHealth();
  const codexStatus = health.providers.find((item) => item.id === "openai-codex");

  if (!codexStatus?.connected) {
    return {
      type: "agent_unavailable",
      ...health,
      status: codexStatus?.status || "missing",
      message: codexStatus?.message || "Codex is not connected."
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
  const provider = getProviderDefinition(payload.provider || payload.providerId || "openai-codex");
  if (provider.id !== "openai-codex") {
    return runCliSynthesisRequest(provider, payload);
  }

  const health = getHealth();
  const codexStatus = health.providers.find((item) => item.id === "openai-codex");

  if (!codexStatus?.connected) {
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

function runCliAgentRequest(provider, payload = {}) {
  const status = getProviderStatus(provider);
  if (!status.installed) {
    return {
      type: "agent_unavailable",
      ...status
    };
  }

  const prompt = buildAgentPrompt(payload);
  const result = runProviderPrompt(provider, prompt, payload.model, true);
  if (result.error || result.status !== 0) {
    return {
      type: "agent_error",
      message: summarizeProviderFailure(provider, result)
    };
  }

  const output = compactProviderOutput(result.stdout || result.stderr || "");
  try {
    return JSON.parse(extractJsonObject(output));
  } catch {
    return {
      type: "agent_error",
      message: `${provider.label} responded, but the response was not valid Browser Companion JSON.`
    };
  }
}

function runCliSynthesisRequest(provider, payload = {}) {
  const status = getProviderStatus(provider);
  if (!status.installed) {
    return {
      type: "natural_response",
      text: `${provider.label} is not installed.`
    };
  }

  const prompt = buildSynthesisPrompt(payload);
  const result = runProviderPrompt(provider, prompt, payload.model, false);
  if (result.error || result.status !== 0) {
    return {
      type: "natural_response",
      text: summarizeProviderFailure(provider, result)
    };
  }

  return {
    type: "natural_response",
    text: compactProviderOutput(result.stdout || result.stderr || "")
  };
}

function runProviderPrompt(provider, prompt, model, needsJson) {
  if (provider.id === "anthropic-claude-code") {
    const args = ["-p", prompt];
    const normalized = normalizeProviderModel(provider, model);
    if (normalized !== "default") args.unshift("--model", normalized);
    return runCommand(provider.command, args, { timeout: 120000 });
  }

  if (provider.id === "google-gemini-cli") {
    const args = ["-p", prompt];
    const normalized = normalizeProviderModel(provider, model);
    if (normalized !== "default") args.unshift("-m", normalized);
    return runCommand(provider.command, args, { timeout: 120000 });
  }

  return runCodex(["exec", "--model", normalizeModel(model), "-"], { input: prompt, timeout: 120000 });
}

function normalizeProviderModel(provider, model) {
  return provider.models.includes(model) ? model : provider.defaultModel;
}

function compactProviderOutput(output) {
  const text = String(output || "").trim();
  try {
    const parsed = JSON.parse(text);
    return parsed.text || parsed.response || parsed.result || parsed.output || text;
  } catch {
    return text;
  }
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (raw.startsWith("{") && raw.endsWith("}")) return raw;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found.");
  return match[0];
}

function summarizeProviderFailure(provider, result) {
  const combined = compact(`${result.error?.message || ""} ${result.stderr || ""} ${result.stdout || ""}`);
  if (/auth|login|sign in|unauthorized|permission/i.test(combined)) {
    return `${provider.label} appears to need sign-in. Open Connector and click Connect for this provider.`;
  }
  return combined.slice(-800) || `${provider.label} request failed.`;
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
    "Local user memory JSON:",
    JSON.stringify(payload.userMemory || [], null, 2),
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
    "Local user memory JSON:",
    JSON.stringify(payload.userMemory || [], null, 2),
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
  return runCommand(codexBin, args, options);
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
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

function resolveNpmBin() {
  const executableDir = path.dirname(process.execPath || "");
  const localNpm = path.join(executableDir, process.platform === "win32" ? "npm.cmd" : "npm");

  if (fs.existsSync(localNpm)) {
    return localNpm;
  }

  return process.platform === "win32" ? "npm.cmd" : "npm";
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
