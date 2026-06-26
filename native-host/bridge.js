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
const npmCliPath = resolveNpmCliPath();
const providerInstallLogPath = path.join(projectRoot, "native-host", "provider-install.log");
const providerModelCache = new Map();
const providerRuntimeAlerts = new Map();
const geminiQuotaCache = {
  checkedAt: 0,
  value: null,
  pending: null
};
const httpProviderDebugRequestPath = path.join(projectRoot, "tmp-http-provider-request.json");
const httpProviderDebugErrorPath = path.join(projectRoot, "tmp-http-provider-error.json");
const activeRequestControllers = new Map();
const HTTP_PROVIDER_DEFAULT_TIMEOUT_MS = 0;
const CLI_PROVIDER_INACTIVITY_TIMEOUT_MS = 300000;
const GEMINI_QUOTA_CACHE_TTL_MS = 30000;
const COMMAND_MAX_BUFFER_BYTES = 1024 * 1024 * 12;
const COMMAND_FORCE_KILL_GRACE_MS = 2000;

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
  const requestId = message?.requestId || "";

  if (message?.type === "health") {
    getHealthDetailed()
      .then((response) => writeResponse(requestId, response))
      .catch(() => writeResponse(requestId, getHealth()));
    return;
  }

  if (message?.type === "connect") {
    writeResponse(requestId, connectProvider(message.payload));
    return;
  }

  if (message?.type === "provider_logout") {
    writeResponse(requestId, logoutProvider(message.payload));
    return;
  }

  if (message?.type === "provider_install") {
    writeResponse(requestId, installProvider(message.payload));
    return;
  }

  if (message?.type === "http_provider_test") {
    testHttpProvider(message.payload)
      .then((response) => writeResponse(requestId, response))
      .catch((error) => writeResponse(requestId, {
        type: "http_provider_test",
        status: "error",
        models: [],
        message: error.message || "HTTP provider test failed."
      }));
    return;
  }

  if (message?.type === "http_provider_unload") {
    unloadHttpProviderModel(message.payload)
      .then((response) => writeResponse(requestId, response))
      .catch((error) => writeResponse(requestId, {
        type: "http_provider_unload",
        status: "error",
        message: error.message || "HTTP provider model unload failed."
      }));
    return;
  }

  if (message?.type === "nodejs_install") {
    writeResponse(requestId, installNodejs());
    return;
  }

  if (message?.type === "agent_request") {
    const controller = new AbortController();
    if (requestId) {
      activeRequestControllers.set(requestId, controller);
    }
    Promise.resolve(runAgentRequest(message.payload, {
      abortSignal: controller.signal,
      requestId,
      onProgress: (progress) => writeResponse(requestId, {
        type: "provider_progress",
        requestId,
        thinking: progress.thinking || "",
        content: progress.content || ""
      })
    }))
      .then((response) => writeResponse(requestId, response))
      .catch((error) => writeResponse(requestId, {
        type: "agent_error",
        message: error.message || "Agent request failed."
      }))
      .finally(() => {
        if (requestId) {
          activeRequestControllers.delete(requestId);
        }
      });
    return;
  }

  if (message?.type === "synthesis_request") {
    const controller = new AbortController();
    if (requestId) {
      activeRequestControllers.set(requestId, controller);
    }
    Promise.resolve(runSynthesisRequest(message.payload, {
      abortSignal: controller.signal,
      requestId,
      onProgress: (progress) => writeResponse(requestId, {
        type: "provider_progress",
        requestId,
        thinking: progress.thinking || "",
        content: progress.content || ""
      })
    }))
      .then((response) => writeResponse(requestId, response))
      .catch((error) => writeResponse(requestId, {
        type: "natural_response",
        text: error.message || "Synthesis request failed."
      }))
      .finally(() => {
        if (requestId) {
          activeRequestControllers.delete(requestId);
        }
      });
    return;
  }

  if (message?.type === "deep_search_plan_request") {
    const controller = new AbortController();
    if (requestId) {
      activeRequestControllers.set(requestId, controller);
    }
    Promise.resolve(runDeepSearchPlanRequest(message.payload, {
      abortSignal: controller.signal,
      requestId
    }))
      .then((response) => writeResponse(requestId, response))
      .catch((error) => writeResponse(requestId, {
        type: "deep_search_plan_result",
        status: "error",
        message: error.message || "Deep Search planning failed."
      }))
      .finally(() => {
        if (requestId) {
          activeRequestControllers.delete(requestId);
        }
      });
    return;
  }

  if (message?.type === "deep_search_digest_request") {
    const controller = new AbortController();
    if (requestId) {
      activeRequestControllers.set(requestId, controller);
    }
    Promise.resolve(runDeepSearchDigestRequest(message.payload, {
      abortSignal: controller.signal,
      requestId
    }))
      .then((response) => writeResponse(requestId, response))
      .catch((error) => writeResponse(requestId, {
        type: "deep_search_digest_result",
        status: "error",
        message: error.message || "Deep Search digest compression failed."
      }))
      .finally(() => {
        if (requestId) {
          activeRequestControllers.delete(requestId);
        }
      });
    return;
  }

  if (message?.type === "deep_search_batch_synthesis_request") {
    const controller = new AbortController();
    if (requestId) {
      activeRequestControllers.set(requestId, controller);
    }
    Promise.resolve(runDeepSearchBatchSynthesisRequest(message.payload, {
      abortSignal: controller.signal,
      requestId
    }))
      .then((response) => writeResponse(requestId, response))
      .catch((error) => writeResponse(requestId, {
        type: "deep_search_batch_synthesis_result",
        status: "error",
        message: error.message || "Deep Search batch synthesis failed."
      }))
      .finally(() => {
        if (requestId) {
          activeRequestControllers.delete(requestId);
        }
      });
    return;
  }

  if (message?.type === "deep_search_report_request") {
    const controller = new AbortController();
    if (requestId) {
      activeRequestControllers.set(requestId, controller);
    }
    Promise.resolve(runDeepSearchReportRequest(message.payload, {
      abortSignal: controller.signal,
      requestId
    }))
      .then((response) => writeResponse(requestId, response))
      .catch((error) => writeResponse(requestId, {
        type: "deep_search_report_result",
        status: "error",
        message: error.message || "Deep Search final report failed."
      }))
      .finally(() => {
        if (requestId) {
          activeRequestControllers.delete(requestId);
        }
      });
    return;
  }

  if (message?.type === "deep_search_chat_request") {
    const controller = new AbortController();
    if (requestId) {
      activeRequestControllers.set(requestId, controller);
    }
    Promise.resolve(runDeepSearchChatRequest(message.payload, {
      abortSignal: controller.signal,
      requestId
    }))
      .then((response) => writeResponse(requestId, response))
      .catch((error) => writeResponse(requestId, {
        type: "deep_search_chat_result",
        status: "error",
        message: error.message || "Deep Search chat failed."
      }))
      .finally(() => {
        if (requestId) {
          activeRequestControllers.delete(requestId);
        }
      });
    return;
  }

  if (message?.type === "stop_active_request") {
    const targetRequestId = String(message.payload?.targetRequestId || "");
    const controller = targetRequestId ? activeRequestControllers.get(targetRequestId) : null;
    if (controller && !controller.signal.aborted) {
      controller.abort("user_stop");
      writeResponse(requestId, {
        type: "stop_active_request",
        status: "stopping",
        targetRequestId,
        message: "Stop signal sent to the active provider request."
      });
      return;
    }

    writeResponse(requestId, {
      type: "stop_active_request",
      status: "idle",
      targetRequestId,
      message: "No matching active provider request was found."
    });
    return;
  }

  if (message?.type === "extract_attachment") {
    extractAttachment(message.payload)
      .then((response) => writeResponse(requestId, response))
      .catch((error) => writeResponse(requestId, {
        type: "attachment_extraction",
        status: "error",
        text: "",
        message: error.message || "Attachment extraction failed."
      }));
    return;
  }

  if (message?.type === "http_request") {
    runHttpRequest(message.payload)
      .then((response) => writeResponse(requestId, response))
      .catch((error) => writeResponse(requestId, {
        type: "http_response",
        status: "error",
        message: error.message || "HTTP request failed."
      }));
    return;
  }

  if (message?.type === "web_search") {
    runWebSearch(message.payload)
      .then((response) => writeResponse(requestId, response))
      .catch((error) => writeResponse(requestId, {
        type: "web_search",
        status: "error",
        results: [],
        message: error.message || "Web search failed."
      }));
    return;
  }

  if (message?.type === "dev_watch_status") {
    try {
      writeResponse(requestId, getDevWatchStatus());
    } catch (error) {
      writeResponse(requestId, {
        type: "dev_watch_status",
        enabled: false,
        fingerprint: "",
        changedAt: "",
        message: error.message || "Dev watch status failed."
      });
    }
    return;
  }

  if (message?.type === "user_memory_get") {
    writeResponse(requestId, getUserMemory());
    return;
  }

  if (message?.type === "user_memory_save") {
    try {
      writeResponse(requestId, saveUserMemory(message.payload));
    } catch (error) {
      writeResponse(requestId, {
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
      writeResponse(requestId, deleteUserMemory(message.payload));
    } catch (error) {
      writeResponse(requestId, {
        type: "user_memory",
        status: "error",
        items: readUserMemoryItems(),
        message: error.message || "User memory could not be deleted."
      });
    }
    return;
  }

  writeResponse(requestId, {
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
  const limit = Math.min(Math.max(Number(payload.limit || 8), 1), 16);

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
  return buildHealthPayload(getProviderStatuses());
}

async function getHealthDetailed() {
  return buildHealthPayload(await getProviderStatusesDetailed());
}

function buildHealthPayload(providers) {
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

function createCodexUnavailableResponse(health, codexStatus, type = null) {
  const response = {
    ...health,
    connected: false,
    status: codexStatus?.status || "missing",
    codexVersion: codexStatus?.version || "",
    codexPath: codexStatus?.command || codexBin,
    selectedProvider: "openai-codex",
    message: codexStatus?.message || "Codex is not connected."
  };

  if (type) {
    response.type = type;
  }

  return response;
}

function getProviderStatuses() {
  return Object.values(providerDefinitions).map((provider) => applyProviderRuntimeState(getProviderStatus(provider)));
}

async function getProviderStatusesDetailed() {
  const providers = await Promise.all(Object.values(providerDefinitions).map((provider) => getProviderStatusDetailed(provider)));
  return providers.map((provider) => applyProviderRuntimeState(provider));
}

async function getProviderStatusDetailed(provider) {
  const status = getProviderStatus(provider);
  if (provider.id !== "google-gemini-cli" || !status.connected) {
    return status;
  }

  const quota = await getGeminiQuotaSnapshot();
  if (!quota) {
    return status;
  }

  return {
    ...status,
    quota
  };
}

function getProviderStatus(provider) {
  const version = runCommand(provider.command, provider.versionArgs || ["--version"], { timeout: 10000 });
  const installed = (!version.error && version.status === 0) || commandExists(provider.command);
  const modelInfo = getProviderModelInfo(provider, installed);

  if (!installed) {
    return {
      id: provider.id,
      label: provider.label,
      installed: false,
      connected: false,
      status: "missing",
      command: provider.command,
      installCommand: provider.installCommand,
      models: modelInfo.models,
      defaultModel: modelInfo.defaultModel,
      modelDiscovery: modelInfo.discovery,
      message: `${provider.label} CLI was not found.`
    };
  }

  if (provider.id === "anthropic-claude-code") {
    return getClaudeProviderStatus(provider, version, modelInfo);
  }

  if (provider.id === "google-gemini-cli") {
    return getGeminiProviderStatus(provider, version, modelInfo);
  }

  if (provider.id !== "openai-codex") {
    return {
      id: provider.id,
      label: provider.label,
      installed: true,
      connected: false,
      status: "auth_unknown",
      command: provider.command,
      version: compact(version.stdout || version.stderr),
      installCommand: provider.installCommand,
      models: modelInfo.models,
      defaultModel: modelInfo.defaultModel,
      modelDiscovery: modelInfo.discovery,
      message: `${provider.label} CLI is installed, but Browser Companion could not determine its authentication status.`
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
    models: modelInfo.models,
    defaultModel: modelInfo.defaultModel,
    modelDiscovery: modelInfo.discovery,
    message: loggedIn
      ? "Codex CLI is installed and signed in."
      : "Codex CLI is installed, but sign-in is required."
  };
}

function getClaudeProviderStatus(provider, version, modelInfo) {
  const authStatus = runCommand(provider.command, ["auth", "status", "--text"], { timeout: 10000 });
  const authText = compact(`${authStatus.stdout || ""}\n${authStatus.stderr || ""}`);
  const loggedIn = authStatus.status === 0;
  const authKnown = authStatus.status === 0 || authStatus.status === 1;
  const loginRequired = !loggedIn && /not logged in|logged out|sign in required|authentication required/i.test(authText);

  return {
    id: provider.id,
    label: provider.label,
    installed: true,
    connected: loggedIn,
    status: loggedIn ? "ready" : (authKnown || loginRequired ? "login_required" : "auth_unknown"),
    command: provider.command,
    version: compact(version.stdout || version.stderr),
    installCommand: provider.installCommand,
    models: modelInfo.models,
    defaultModel: modelInfo.defaultModel,
    modelDiscovery: modelInfo.discovery,
    message: loggedIn
      ? "Claude Code CLI is installed and signed in."
      : (authKnown || loginRequired
          ? "Claude Code CLI is installed, but sign-in is required."
          : "Claude Code CLI is installed, but authentication status could not be determined.")
  };
}

function getGeminiProviderStatus(provider, version, modelInfo) {
  const authState = getGeminiAuthState();
  const connected = authState.hasCachedAuth || authState.hasEnvironmentAuth;
  const status = connected
    ? "ready"
    : (authState.checked ? "login_required" : "auth_unknown");

  return {
    id: provider.id,
    label: provider.label,
    installed: true,
    connected,
    status,
    command: provider.command,
    version: compact(version.stdout || version.stderr),
    installCommand: provider.installCommand,
    models: modelInfo.models,
    defaultModel: modelInfo.defaultModel,
    modelDiscovery: modelInfo.discovery,
    message: authState.hasEnvironmentAuth
      ? "Gemini CLI is installed and environment-based authentication was detected."
      : (connected
          ? "Gemini CLI is installed and cached authentication was found."
          : (authState.checked
              ? "Gemini CLI is installed, but cached authentication was not found."
              : "Gemini CLI is installed, but authentication status could not be determined."))
  };
}

function getGeminiAuthState() {
  const homeDir = os.homedir();
  const authFiles = [
    path.join(homeDir, ".gemini", "oauth_creds.json"),
    path.join(homeDir, ".gemini", "google_accounts.json")
  ];
  const hasCachedAuth = authFiles.some((filePath) => fileExistsWithContent(filePath));
  const hasEnvironmentAuth = Boolean(
    compact(process.env.GEMINI_API_KEY)
    || compact(process.env.GOOGLE_API_KEY)
    || compact(process.env.GOOGLE_APPLICATION_CREDENTIALS)
    || compact(process.env.GOOGLE_GENAI_USE_VERTEXAI)
  );

  return {
    checked: true,
    hasCachedAuth,
    hasEnvironmentAuth
  };
}

function getGeminiSelectedAuthType() {
  try {
    const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    return compact(parsed?.security?.auth?.selectedType || "");
  } catch {
    return "";
  }
}

async function getGeminiQuotaSnapshot() {
  const now = Date.now();
  if (geminiQuotaCache.value && now - geminiQuotaCache.checkedAt < GEMINI_QUOTA_CACHE_TTL_MS) {
    return geminiQuotaCache.value;
  }

  if (geminiQuotaCache.pending) {
    return geminiQuotaCache.pending;
  }

  const authType = getGeminiSelectedAuthType();
  if (!authType || authType !== "oauth-personal") {
    return geminiQuotaCache.value;
  }

  geminiQuotaCache.pending = probeGeminiQuotaSnapshot(authType)
    .then((quota) => {
      geminiQuotaCache.checkedAt = Date.now();
      if (quota) {
        geminiQuotaCache.value = quota;
      }
      return geminiQuotaCache.value;
    })
    .catch(() => {
      geminiQuotaCache.checkedAt = Date.now();
      return geminiQuotaCache.value;
    })
    .finally(() => {
      geminiQuotaCache.pending = null;
    });

  return geminiQuotaCache.pending;
}

async function probeGeminiQuotaSnapshot(authType) {
  const result = await runCommandWithActivityTimeout(process.execPath, ["-e", buildGeminiQuotaProbeScript(authType)], {
    idleTimeout: 15000,
    maxBuffer: 1024 * 256
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  const parsed = tryParseJson(compact(result.stdout || ""));
  if (!parsed || parsed.error) {
    return null;
  }

  const remaining = Number(parsed.remaining);
  const limit = Number(parsed.limit);
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }

  const usedPercent = Math.max(0, Math.min(100, Math.round((1 - remaining / limit) * 100)));
  return {
    source: "gemini-cli",
    authType: compact(parsed.authType || authType),
    modelSetting: compact(parsed.modelSetting || ""),
    activeModel: compact(parsed.activeModel || ""),
    remaining,
    limit,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetTime: compact(parsed.resetTime || ""),
    tierName: compact(parsed.tierName || ""),
    checkedAt: new Date().toISOString()
  };
}

function buildGeminiQuotaProbeScript(authType) {
  const targetDir = JSON.stringify(projectRoot);
  const authTypeLiteral = JSON.stringify(authType);
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { pathToFileURL } = require('node:url');",
    `const targetDir = ${targetDir};`,
    `const authType = ${authTypeLiteral};`,
    "const originalStdoutWrite = process.stdout.write.bind(process.stdout);",
    "const originalStderrWrite = process.stderr.write.bind(process.stderr);",
    "process.stdout.write = () => true;",
    "process.stderr.write = () => true;",
    "const finish = (payload, exitCode = 0) => {",
    "  process.stdout.write = originalStdoutWrite;",
    "  process.stderr.write = originalStderrWrite;",
    "  originalStdoutWrite(JSON.stringify(payload));",
    "  process.exitCode = exitCode;",
    "};",
    "(async () => {",
    "  const bundleDir = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle');",
    "  const coreEntry = fs.readdirSync(bundleDir).find((name) => /^core-.*\\.js$/i.test(name));",
    "  if (!coreEntry) throw new Error('Gemini core bundle was not found.');",
    "  const mod = await import(pathToFileURL(path.join(bundleDir, coreEntry)).href);",
    "  const modelSetting = mod.PREVIEW_GEMINI_MODEL_AUTO || mod.DEFAULT_GEMINI_MODEL_AUTO;",
    "  const config = new mod.Config({",
    "    sessionId: 'browser-companion-quota-health',",
    "    targetDir,",
    "    cwd: targetDir,",
    "    model: modelSetting,",
    "    usageStatisticsEnabled: true,",
    "    debugMode: false",
    "  });",
    "  await config.initialize();",
    "  await config.refreshAuth(authType);",
    "  await config.refreshUserQuota();",
    "  finish({",
    "    authType,",
    "    modelSetting,",
    "    activeModel: typeof config.getActiveModel === 'function' ? config.getActiveModel() : '',",
    "    remaining: typeof config.getQuotaRemaining === 'function' ? config.getQuotaRemaining() : null,",
    "    limit: typeof config.getQuotaLimit === 'function' ? config.getQuotaLimit() : null,",
    "    resetTime: typeof config.getQuotaResetTime === 'function' ? config.getQuotaResetTime() : '',",
    "    tierName: typeof config.getUserTierName === 'function' ? config.getUserTierName() : ''",
    "  });",
    "})().catch((error) => {",
    "  finish({ error: String(error?.message || error || 'Gemini quota probe failed.') }, 1);",
    "});"
  ].join("\n");
}

function fileExistsWithContent(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function getProviderModelInfo(provider, installed) {
  const fallback = {
    models: provider.models,
    defaultModel: provider.defaultModel,
    discovery: {
      status: "static",
      message: "Using the provider's built-in model list."
    }
  };

  if (!installed) {
    return fallback;
  }

  if (provider.id === "google-gemini-cli") {
    return getGeminiModelInfo(provider);
  }

  return fallback;
}

function getGeminiModelInfo(provider) {
  const cached = providerModelCache.get(provider.id);
  const now = Date.now();

  if (cached && now - cached.checkedAt < 5 * 60 * 1000) {
    return cached.value;
  }

  const help = runCommand(provider.command, ["--help"], { timeout: 8000 });
  const output = compact(`${help.stdout || ""}\n${help.stderr || ""}`);
  const cliCanRun = !help.error && help.status === 0;
  const hasModelFlag = /\b-m,\s*--model\b|--model\b/i.test(output);
  const discovery = {
    status: cliCanRun ? "default_only" : "unavailable",
    message: cliCanRun && hasModelFlag
      ? "Gemini CLI supports choosing a model, but does not expose an account-specific model list through a stable command. Use default unless you know this account can access a specific model."
      : "Gemini CLI model discovery is unavailable, so Browser Companion will use the provider default model."
  };

  const value = {
    models: provider.models,
    defaultModel: provider.defaultModel,
    discovery
  };
  providerModelCache.set(provider.id, { checkedAt: now, value });
  return value;
}

function summarizeProviders(providers) {
  const connected = providers.filter((provider) => provider.connected).map((provider) => provider.label);
  const exhausted = providers.filter((provider) => provider.quotaState === "exhausted").map((provider) => provider.label);
  if (exhausted.length) {
    return `Usage limit reached for: ${exhausted.join(", ")}.`;
  }
  if (connected.length) {
    return `Connected providers: ${connected.join(", ")}.`;
  }

  return "No connected provider is ready yet.";
}

function applyProviderRuntimeState(status) {
  const alert = providerRuntimeAlerts.get(status?.id || "");
  if (!alert) {
    return status;
  }

  return {
    ...status,
    quotaState: alert.kind,
    quotaMessage: alert.message,
    quotaDetectedAt: alert.detectedAt,
    message: alert.message
  };
}

function noteProviderSuccess(providerId) {
  if (!providerId) {
    return;
  }

  providerRuntimeAlerts.delete(providerId);
}

function noteProviderFailure(provider, result) {
  const providerId = provider?.id || "";
  if (!providerId) {
    return;
  }

  const raw = compact(`${result?.error?.message || ""} ${result?.stderr || ""} ${result?.stdout || ""} ${result?.message || ""} ${result?.text || ""}`);
  if (!isUsageLimitReachedText(raw)) {
    return;
  }

  providerRuntimeAlerts.set(providerId, {
    kind: "exhausted",
    detectedAt: new Date().toISOString(),
    message: buildUsageLimitMessage(provider, raw),
    raw: raw.slice(0, 1200)
  });
}

function isUsageLimitReachedText(text) {
  const raw = String(text || "");
  return [
    /\blimit reached\b/i,
    /insufficient[_\s-]?quota/i,
    /\bout of credits?\b/i,
    /\bcredit balance\b.*\b(low|empty|insufficient)\b/i,
    /\bbilling hard limit\b/i,
    /\bresource has been exhausted\b/i,
    /\byou have exhausted your capacity on this model\b/i,
    /\bquota exceeded\b/i
  ].some((pattern) => pattern.test(raw));
}

function buildUsageLimitMessage(provider, text) {
  const label = provider?.label || "Provider";
  if (/insufficient[_\s-]?quota|billing hard limit|out of credits?|credit balance/i.test(text)) {
    return `${label} has no remaining credits or has reached its billing limit. Add credits, wait for reset, or switch provider.`;
  }

  if (/exhausted your capacity on this model|resource has been exhausted|limit reached|quota exceeded/i.test(text)) {
    return `${label} has reached its current usage limit. Wait for quota reset or switch provider.`;
  }

  return `${label} cannot continue because its current usage limit has been reached.`;
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
      command: resolveProviderCliBin("claude"),
      installCommand: "npm install -g @anthropic-ai/claude-code",
      models: ["default", "opus", "sonnet", "haiku"],
      defaultModel: "default"
    },
    "google-gemini-cli": {
      id: "google-gemini-cli",
      label: "Gemini CLI",
      command: resolveProviderCliBin("gemini"),
      installCommand: "npm install -g @google/gemini-cli",
      models: ["default"],
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

function commandExists(command) {
  if (!command) {
    return false;
  }

  if (fs.existsSync(command)) {
    return true;
  }

  if (process.platform === "win32") {
    const result = spawnSync("where.exe", [command], {
      encoding: "utf8",
      shell: false,
      windowsHide: true
    });
    return !result.error && result.status === 0;
  }

  const result = spawnSync("command", ["-v", command], {
    encoding: "utf8",
    shell: true
  });
  return !result.error && result.status === 0;
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
  const codexStatus = health.providers.find((item) => item.id === "openai-codex");

  if (codexStatus?.connected) {
    return {
      ...health,
      connected: true,
      status: codexStatus.status || "ready",
      selectedProvider: "openai-codex",
      message: codexStatus.message || "Codex CLI is installed and signed in."
    };
  }

  if (codexStatus?.status === "missing") {
    return createCodexUnavailableResponse(health, codexStatus);
  }

  const child = spawnLoginProcess();
  child.unref();

  return {
    ...getHealth(),
    connected: false,
    status: "login_started",
    selectedProvider: "openai-codex",
    message: "Codex login was started. Complete the ChatGPT sign-in flow, then check the connector again."
  };
}

function logoutProvider(payload = {}) {
  const provider = getProviderDefinition(payload.provider || payload.providerId || "openai-codex");
  const status = getProviderStatus(provider);

  if (!status.installed) {
    return status;
  }

  if (provider.id === "openai-codex") {
    const result = runCodex(["logout"], { timeout: 15000 });
    if (result.error || result.status !== 0) {
      return {
        ...getHealth(),
        status: "logout_failed",
        message: summarizeLogoutFailure(provider.label, result)
      };
    }

    return {
      ...getHealth(),
      status: "logged_out",
      message: "Codex credentials were removed. Use Connect to sign in with another account."
    };
  }

  if (provider.id === "anthropic-claude-code") {
    const result = runCommand(provider.command, ["auth", "logout"], { timeout: 15000 });
    if (result.error || result.status !== 0) {
      return {
        ...getHealth(),
        status: "logout_failed",
        message: summarizeLogoutFailure(provider.label, result)
      };
    }

    return {
      ...getHealth(),
      status: "logged_out",
      message: "Claude Code credentials were removed. Use Connect to sign in with another account."
    };
  }

  if (provider.id === "google-gemini-cli") {
    const authState = getGeminiAuthState();
    const removed = clearGeminiCachedAuth();
    return {
      ...getHealth(),
      status: authState.hasEnvironmentAuth ? "ready" : (removed.length ? "logged_out" : "login_required"),
      message: authState.hasEnvironmentAuth
        ? "Gemini CLI still has environment-based authentication available. Clear the relevant environment variables outside Browser Companion if you need a full account reset."
        : (removed.length
            ? "Gemini CLI cached authentication was cleared. Use Connect to choose or sign in with another account."
            : "Gemini CLI did not have cached authentication files to remove. Use Connect to choose an account.")
    };
  }

  return {
    ...getHealth(),
    status: "logout_unavailable",
    message: `Logout is not configured for ${provider.label}.`
  };
}

function summarizeLogoutFailure(providerLabel, result) {
  const output = compact(`${result?.stdout || ""}\n${result?.stderr || ""}\n${result?.error?.message || ""}`);
  return output
    ? `${providerLabel} logout failed: ${output}`
    : `${providerLabel} logout failed.`;
}

function clearGeminiCachedAuth() {
  const files = [
    path.join(os.homedir(), ".gemini", "oauth_creds.json"),
    path.join(os.homedir(), ".gemini", "google_accounts.json"),
    path.join(os.homedir(), ".gemini", "state.json")
  ];
  const removed = [];

  for (const filePath of files) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removed.push(filePath);
      }
    } catch {
      // Best effort only; remaining auth state will be visible on the next health check.
    }
  }

  return removed;
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
      npmPath: npmBin,
      npmCliPath,
      nodePath: process.execPath,
      message: `Node/npm was not usable by the native host. Checked npm at "${npmBin}" and npm CLI at "${npmCliPath || "not found"}" from Node "${process.execPath}". Install Node.js from https://nodejs.org/en/download, restart Chrome, then click Install again or run the displayed npm command manually.`
    };
  }

  const runnableCommand = makeRunnableNpmCommand(command);
  const child = spawnVisibleShell(runnableCommand);
  child?.unref?.();

  return {
    ...getHealth(),
    status: "install_started",
    provider: provider.id,
    installCommand: command,
    logPath: providerInstallLogPath,
    message: `Started opt-in installation for ${provider.label}. A visible terminal should open; if it does not, check ${providerInstallLogPath}.`
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
    const command = "winget install --id OpenJS.NodeJS.LTS -e --source winget";
    const child = spawnVisibleShell(command);
    child?.unref?.();

    return {
      ...getHealth(),
      status: "nodejs_install_started",
      logPath: providerInstallLogPath,
      message: `Started Node.js/npm installation. A visible terminal should open; if it does not, check ${providerInstallLogPath}. Approve any Windows prompts, then restart Chrome.`
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
  if (npmCliPath && fs.existsSync(npmCliPath)) {
    const cliResult = runCommand(process.execPath, [npmCliPath, "--version"], { timeout: 10000 });
    return !cliResult.error && cliResult.status === 0;
  }

  const result = runCommand(npmBin, ["--version"], { timeout: 10000 });
  if (!result.error && result.status === 0) {
    return true;
  }

  if (process.platform === "win32" && fs.existsSync(npmBin)) {
    const cmdResult = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${npmBin}" --version`], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 10000
    });
    return !cmdResult.error && cmdResult.status === 0;
  }

  return false;
}

function makeRunnableNpmCommand(command) {
  if (!/^npm\s+/i.test(command)) {
    return command;
  }

  if (process.platform === "win32" && npmBin && fs.existsSync(npmBin)) {
    return `call ${quoteShellPath(npmBin)} ${command.replace(/^npm\s+/i, "")}`;
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
  if (provider.id === "anthropic-claude-code") {
    return spawnVisibleShell(`${quoteShellPath(provider.command)} auth login`);
  }

  if (provider.id === "google-gemini-cli") {
    if (process.platform === "win32") {
      return spawnVisibleShell([
        `Write-Host ${toPowerShellString("Browser Companion will open Gemini CLI so you can sign in or switch account.")}`,
        `Write-Host ${toPowerShellString("If Gemini opens without asking, run /auth inside Gemini to change authentication method or account.")}`,
        `& ${toPowerShellString(provider.command)}`
      ].join("\n"));
    }

    return spawnVisibleShell(`printf '%s\n%s\n\n' "Browser Companion will open Gemini CLI so you can sign in or switch account." "If Gemini opens without asking, run /auth inside Gemini to change authentication method or account."; ${quoteShellPath(provider.command)}`);
  }

  return spawnVisibleShell(provider.command);
}

function spawnVisibleShell(command) {
  if (process.platform === "win32") {
    const scriptPath = writeVisiblePowerShellScript(command);
    const launcherPath = writeVisiblePowerShellLauncher(scriptPath);
    return spawn("cmd.exe", ["/k", launcherPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      cwd: bridgeDir
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

function writeVisiblePowerShellScript(command) {
  const scriptPath = path.join(os.tmpdir(), `browser-companion-${crypto.randomUUID()}.ps1`);
  const commandLines = String(command || "").split(/\r?\n/).filter(Boolean);
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    "$browserCompanionTranscriptStarted = $false",
    `try { Start-Transcript -LiteralPath ${toPowerShellString(providerInstallLogPath)} -Force | Out-Null; $browserCompanionTranscriptStarted = $true } catch { Write-Host ('Transcript unavailable: ' + $_.Exception.Message) }`,
    "Write-Host 'Browser Companion provider setup'",
    "Write-Host ''",
    `Set-Location -LiteralPath ${toPowerShellString(bridgeDir)}`,
    "Write-Host ('Working directory: ' + (Get-Location).Path)",
    `Write-Host ${toPowerShellString(`Node: ${process.execPath}`)}`,
    `Write-Host ${toPowerShellString(`npm: ${npmBin}`)}`,
    `Write-Host ${toPowerShellString(`npm CLI: ${npmCliPath || "not found"}`)}`,
    "Write-Host ''",
    "Write-Host 'Running:'",
    ...commandLines.map((line) => `Write-Host ${toPowerShellString(`  ${line}`)}`),
    "Write-Host ''",
    ...commandLines.map((line) => convertCmdLineToPowerShell(line)),
    "$status = $LASTEXITCODE",
    "if ($null -eq $status) { $status = 0 }",
    "Write-Host ''",
    "Write-Host ('Command finished with exit code ' + $status + '.')",
    "Write-Host 'Return to Browser Companion and click Check.'",
    "if ($browserCompanionTranscriptStarted) { Stop-Transcript | Out-Null }"
  ];
  fs.writeFileSync(scriptPath, lines.join("\r\n"), "utf8");
  return scriptPath;
}

function writeVisiblePowerShellLauncher(scriptPath) {
  const launcherPath = path.join(os.tmpdir(), `browser-companion-launch-${crypto.randomUUID()}.cmd`);
  const lines = [
    "@echo off",
    "echo Browser Companion provider setup launcher",
    `echo Log: ${providerInstallLogPath}`,
    "echo.",
    `powershell.exe -NoExit -ExecutionPolicy Bypass -File "${scriptPath}"`,
    "echo.",
    "echo PowerShell exited or could not start. Check the log path above.",
    "pause"
  ];
  fs.writeFileSync(launcherPath, lines.join("\r\n"), "utf8");
  return launcherPath;
}

function writeVisibleCommandScript(command) {
  const scriptPath = path.join(os.tmpdir(), `browser-companion-${crypto.randomUUID()}.cmd`);
  const lines = [
    "@echo off",
    "echo Browser Companion provider setup",
    "echo.",
    `cd /d "${bridgeDir}"`,
    "echo Working directory: %CD%",
    `echo Node: "${process.execPath}"`,
    `echo npm: "${npmBin}"`,
    npmCliPath ? `echo npm CLI: "${npmCliPath}"` : "echo npm CLI: not found",
    "echo.",
    "echo Running:",
    ...String(command || "").split(/\r?\n/).map((line) => `echo   ${line}`),
    "echo.",
    ...String(command || "").split(/\r?\n/),
    "set COMMAND_STATUS=%ERRORLEVEL%",
    "echo.",
    "echo Command finished with exit code %COMMAND_STATUS%.",
    "echo You can close this window after checking the output.",
    "exit /b %COMMAND_STATUS%"
  ];
  fs.writeFileSync(scriptPath, lines.join("\r\n"), "utf8");
  return scriptPath;
}

function convertCmdLineToPowerShell(line) {
  const echoMatch = String(line || "").match(/^echo(?:\s+(.+)|\.)?$/i);
  if (echoMatch) {
    return `Write-Host ${toPowerShellString(echoMatch[1] || "")}`;
  }

  const npmMatch = String(line || "").match(/^call\s+"([^"]+)"\s+(.+)$/i);
  if (npmMatch) {
    return `& ${toPowerShellString(npmMatch[1])} ${npmMatch[2]}`;
  }

  const quotedExeMatch = String(line || "").match(/^"([^"]+)"\s+(.+)$/);
  if (quotedExeMatch) {
    return `& ${toPowerShellString(quotedExeMatch[1])} ${quotedExeMatch[2]}`;
  }

  return line;
}

function toPowerShellString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
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

function runAgentRequest(payload = {}, options = {}) {
  if (payload.httpProvider) {
    return runHttpProviderAgentRequest(payload.httpProvider, payload, options);
  }

  const provider = getProviderDefinition(payload.provider || payload.providerId || "openai-codex");
  if (provider.id !== "openai-codex") {
    return runCliAgentRequest(provider, payload, options);
  }

  const health = getHealth();
  const codexStatus = health.providers.find((item) => item.id === "openai-codex");

  if (!codexStatus?.connected) {
    return createCodexUnavailableResponse(health, codexStatus, "agent_unavailable");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-companion-"));
  const outputPath = path.join(tempDir, "codex-response.txt");
  const prompt = buildCodexAgentPrompt(payload);
  const schemaPath = path.join(projectRoot, "codex", "tool-schema-codex.json");

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
    noteProviderFailure(providerDefinitions["openai-codex"], result);
    return {
      type: "agent_error",
      message: summarizeCodexFailure(result)
    };
  }

  try {
    const responseText = fs.readFileSync(outputPath, "utf8").trim();
    noteProviderSuccess("openai-codex");
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

function runSynthesisRequest(payload = {}, options = {}) {
  if (payload.httpProvider) {
    return runHttpProviderSynthesisRequest(payload.httpProvider, payload, options);
  }

  const provider = getProviderDefinition(payload.provider || payload.providerId || "openai-codex");
  if (provider.id !== "openai-codex") {
    return runCliSynthesisRequest(provider, payload, options);
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
    noteProviderFailure(providerDefinitions["openai-codex"], result);
    return {
      type: "natural_response",
      text: summarizeCodexFailure(result)
    };
  }

  try {
    noteProviderSuccess("openai-codex");
    return {
      type: "natural_response",
      text: fs.readFileSync(outputPath, "utf8").trim()
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runDeepSearchPlanRequest(payload = {}, options = {}) {
  const stage = payload.stage === "refine" ? "refine" : "initial";
  const prompt = stage === "refine"
    ? buildDeepSearchRefinementPrompt(payload)
    : buildDeepSearchPlanningPrompt(payload);
  const parsed = await runStructuredProviderJsonRequest(payload, prompt, options);

  if (!parsed.ok) {
    return {
      type: "deep_search_plan_result",
      status: "error",
      stage,
      message: parsed.message
    };
  }

  if (stage === "refine") {
    return {
      type: "deep_search_plan_result",
      status: "ok",
      stage,
      refinement: normalizeDeepSearchRefinementResponse(parsed.value)
    };
  }

  return {
    type: "deep_search_plan_result",
    status: "ok",
    stage,
    plan: normalizeDeepSearchPlanningResponse(parsed.value)
  };
}

async function runDeepSearchDigestRequest(payload = {}, options = {}) {
  const prompt = buildDeepSearchDigestPrompt(payload);
  const parsed = await runStructuredProviderJsonRequest(payload, prompt, options);

  if (!parsed.ok) {
    return {
      type: "deep_search_digest_result",
      status: "error",
      message: parsed.message
    };
  }

  return {
    type: "deep_search_digest_result",
    status: "ok",
    digests: normalizeDeepSearchDigestResponse(parsed.value)
  };
}

async function runDeepSearchBatchSynthesisRequest(payload = {}, options = {}) {
  const prompt = buildDeepSearchBatchSynthesisPrompt(payload);
  const parsed = await runStructuredProviderJsonRequest(payload, prompt, options);

  if (!parsed.ok) {
    return {
      type: "deep_search_batch_synthesis_result",
      status: "error",
      message: parsed.message
    };
  }

  return {
    type: "deep_search_batch_synthesis_result",
    status: "ok",
    summary: normalizeDeepSearchBatchSynthesisResponse(parsed.value)
  };
}

async function runDeepSearchReportRequest(payload = {}, options = {}) {
  const prompt = buildDeepSearchReportPrompt(payload);
  const parsed = await runStructuredProviderJsonRequest(payload, prompt, options);

  if (!parsed.ok) {
    return {
      type: "deep_search_report_result",
      status: "error",
      message: parsed.message
    };
  }

  return {
    type: "deep_search_report_result",
    status: "ok",
    report: normalizeDeepSearchReportResponse(parsed.value)
  };
}

async function runDeepSearchChatRequest(payload = {}, options = {}) {
  const prompt = buildDeepSearchChatPrompt(payload);

  if (payload.httpProvider) {
    try {
      const { text } = await runHttpProviderCompletion(payload.httpProvider, prompt, false, options);
      return {
        type: "deep_search_chat_result",
        status: "ok",
        text: compactProviderOutput(text)
      };
    } catch (error) {
      return {
        type: "deep_search_chat_result",
        status: "error",
        message: error.message || "HTTP provider Deep Search chat failed."
      };
    }
  }

  const provider = getProviderDefinition(payload.provider || payload.providerId || "openai-codex");
  if (provider.id !== "openai-codex") {
    const status = getProviderStatus(provider);
    if (!status.installed) {
      return {
        type: "deep_search_chat_result",
        status: "error",
        message: `${provider.label} is not installed.`
      };
    }

    const result = await runProviderPromptWithModelFallback(provider, prompt, payload.model, false, options);
    if (result.error || result.status !== 0) {
      noteProviderFailure(provider, result);
      return {
        type: "deep_search_chat_result",
        status: "error",
        message: summarizeProviderFailure(provider, result)
      };
    }

    noteProviderSuccess(provider.id);
    return {
      type: "deep_search_chat_result",
      status: "ok",
      text: compactProviderOutput(result.stdout || result.stderr || "")
    };
  }

  const health = getHealth();
  const codexStatus = health.providers.find((item) => item.id === "openai-codex");
  if (!codexStatus?.connected) {
    return {
      type: "deep_search_chat_result",
      status: "error",
      message: codexStatus?.message || "Codex is not connected."
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-companion-deep-search-chat-"));
  const outputPath = path.join(tempDir, "deep-search-chat.txt");
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
    noteProviderFailure(providerDefinitions["openai-codex"], result);
    fs.rmSync(tempDir, { recursive: true, force: true });
    return {
      type: "deep_search_chat_result",
      status: "error",
      message: summarizeCodexFailure(result)
    };
  }

  try {
    noteProviderSuccess("openai-codex");
    return {
      type: "deep_search_chat_result",
      status: "ok",
      text: compact(fs.readFileSync(outputPath, "utf8").trim())
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runStructuredProviderJsonRequest(payload = {}, prompt, options = {}) {
  if (payload.httpProvider) {
    try {
      const { text } = await runHttpProviderCompletion(payload.httpProvider, prompt, true, options);
      return {
        ok: true,
        value: JSON.parse(extractJsonObject(compactProviderOutput(text)))
      };
    } catch (error) {
      return {
        ok: false,
        message: error.message || "HTTP provider Deep Search request failed."
      };
    }
  }

  const provider = getProviderDefinition(payload.provider || payload.providerId || "openai-codex");
  if (provider.id !== "openai-codex") {
    const status = getProviderStatus(provider);
    if (!status.installed) {
      return {
        ok: false,
        message: `${provider.label} is not installed.`
      };
    }

    const result = await runProviderPromptWithModelFallback(provider, prompt, payload.model, true, options);
    if (result.error || result.status !== 0) {
      noteProviderFailure(provider, result);
      return {
        ok: false,
        message: summarizeProviderFailure(provider, result)
      };
    }

    noteProviderSuccess(provider.id);
    try {
      return {
        ok: true,
        value: JSON.parse(extractJsonObject(compactProviderOutput(result.stdout || result.stderr || "")))
      };
    } catch (error) {
      return {
        ok: false,
        message: error.message || `${provider.label} did not return valid Deep Search JSON.`
      };
    }
  }

  const health = getHealth();
  const codexStatus = health.providers.find((item) => item.id === "openai-codex");
  if (!codexStatus?.connected) {
    return {
      ok: false,
      message: codexStatus?.message || "Codex is not connected."
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-companion-deep-search-"));
  const outputPath = path.join(tempDir, "deep-search.json");
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
    noteProviderFailure(providerDefinitions["openai-codex"], result);
    fs.rmSync(tempDir, { recursive: true, force: true });
    return {
      ok: false,
      message: summarizeCodexFailure(result)
    };
  }

  try {
    noteProviderSuccess("openai-codex");
    return {
      ok: true,
      value: JSON.parse(extractJsonObject(fs.readFileSync(outputPath, "utf8").trim()))
    };
  } catch (error) {
    return {
      ok: false,
      message: error.message || "Codex returned invalid Deep Search JSON."
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runCliAgentRequest(provider, payload = {}, options = {}) {
  const status = getProviderStatus(provider);
  if (!status.installed) {
    return {
      type: "agent_unavailable",
      ...status
    };
  }

  const prompt = buildAgentPrompt(payload, { includeSchema: true, compactContext: true });
  const result = await runProviderPromptWithModelFallback(provider, prompt, payload.model, true, options);
  if (result.error || result.status !== 0) {
    noteProviderFailure(provider, result);
    return {
      type: "agent_error",
      message: summarizeProviderFailure(provider, result)
    };
  }

  noteProviderSuccess(provider.id);
  const output = compactProviderOutput(result.stdout || result.stderr || "");
  return parseAgentJsonOrNaturalResponse(output);
}

async function runProviderPromptWithModelFallback(provider, prompt, model, needsJson, options = {}) {
  const result = await runProviderPrompt(provider, prompt, model, needsJson, options);
  if (!shouldRetryWithDefaultModel(provider, model, result)) {
    return result;
  }

  const retry = await runProviderPrompt(provider, prompt, provider.defaultModel, needsJson, options);
  if (!retry.error && retry.status === 0) {
    retry.stderr = compact(`${retry.stderr || ""}\nRetried with ${provider.label} default model after the selected model was unavailable.`);
  }
  return retry;
}

function shouldRetryWithDefaultModel(provider, model, result) {
  if (provider.id !== "google-gemini-cli") return false;
  if (!model || model === provider.defaultModel) return false;
  if (!result?.error && result?.status === 0) return false;

  const combined = compact(`${result?.error?.message || ""} ${result?.stderr || ""} ${result?.stdout || ""}`);
  return /Requested entity was not found|code:\s*404|"\s*code\s*"\s*:\s*404|model.*not found|not found.*model/i.test(combined);
}

async function runCliSynthesisRequest(provider, payload = {}, options = {}) {
  const status = getProviderStatus(provider);
  if (!status.installed) {
    return {
      type: "natural_response",
      text: `${provider.label} is not installed.`
    };
  }

  const prompt = buildSynthesisPrompt(payload);
  const result = await runProviderPromptWithModelFallback(provider, prompt, payload.model, false, options);
  if (result.error || result.status !== 0) {
    noteProviderFailure(provider, result);
    return {
      type: "natural_response",
      text: summarizeProviderFailure(provider, result)
    };
  }

  noteProviderSuccess(provider.id);
  return {
    type: "natural_response",
    text: compactProviderOutput(result.stdout || result.stderr || "")
  };
}

async function testHttpProvider(provider = {}) {
  if (isCloudflareWorkersAiProvider(provider)) {
    return testCloudflareWorkersAiProvider(provider);
  }

  const baseUrl = normalizeHttpProviderBaseUrl(provider.baseUrl);

  try {
    const response = await fetch(buildHttpProviderApiUrl(baseUrl, "/v1/models"), {
      method: "GET",
      headers: getHttpProviderHeaders(provider)
    });
    const text = await response.text();

    if (!response.ok) {
      return createHttpProviderTestError({
        baseUrl,
        statusCode: response.status,
        body: text
      });
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return createHttpProviderTestError({
        baseUrl,
        kind: "invalid_json",
        statusCode: response.status,
        body: text
      });
    }

    const models = Array.isArray(json.data)
      ? json.data.map((item) => item.id).filter(Boolean)
      : [];
    const loadedModels = extractLoadedModels(json);

    return {
      type: "http_provider_test",
      status: "ready",
      models,
      loadedModels,
      message: models.length
        ? `HTTP provider is reachable. Found ${models.length} model${models.length === 1 ? "" : "s"}.`
        : "HTTP provider is reachable, but no models were returned."
    };
  } catch (error) {
    return createHttpProviderTestError({
      baseUrl,
      kind: "offline",
      error
    });
  }
}

async function testCloudflareWorkersAiProvider(provider = {}) {
  const accountId = String(provider.accountId || extractCloudflareAccountIdFromBaseUrl(provider.baseUrl) || "").trim();
  if (!accountId) {
    throw new Error("Cloudflare Account ID is required.");
  }

  const modelsUrl = new URL(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search`);
  modelsUrl.searchParams.set("per_page", "1000");
  modelsUrl.searchParams.set("hide_experimental", "true");
  modelsUrl.searchParams.set("format", "openrouter");

  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: getHttpProviderHeaders({
        ...provider,
        authType: "bearer"
      })
    });
    const text = await response.text();

    if (!response.ok) {
      return createHttpProviderTestError({
        baseUrl: modelsUrl.origin,
        statusCode: response.status,
        body: text,
        resourceLabel: "Cloudflare model search"
      });
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return createHttpProviderTestError({
        baseUrl: modelsUrl.origin,
        kind: "invalid_json",
        statusCode: response.status,
        body: text,
        resourceLabel: "Cloudflare model search"
      });
    }

    const models = extractCloudflareModelIds(json);

    return {
      type: "http_provider_test",
      status: "ready",
      models,
      loadedModels: [],
      message: models.length
        ? `Cloudflare Workers AI is reachable. Found ${models.length} model${models.length === 1 ? "" : "s"}.`
        : "Cloudflare Workers AI is reachable, but no models were returned."
    };
  } catch (error) {
    return createHttpProviderTestError({
      baseUrl: modelsUrl.origin,
      kind: "offline",
      error,
      resourceLabel: "Cloudflare model search"
    });
  }
}

function createHttpProviderTestError({ baseUrl, kind = "", statusCode = 0, body = "", error = null, resourceLabel = "/v1/models" } = {}) {
  const rawBody = String(body || "").trim();
  const bodyPreview = rawBody.slice(0, 200);
  const htmlLike = /^\s*<!doctype html>|^\s*<html\b/i.test(rawBody);
  const normalizedKind = kind
    || (statusCode && htmlLike ? "upstream_html" : "")
    || "http_error";

  if (normalizedKind === "offline") {
    return {
      type: "http_provider_test",
      status: "error",
      errorKind: "offline",
      models: [],
      loadedModels: [],
      message: `HTTP provider is offline or unreachable at ${baseUrl}. Browser Companion could not read ${resourceLabel}.`,
      detail: compact(error?.message || "")
    };
  }

  if (normalizedKind === "invalid_json") {
    return {
      type: "http_provider_test",
      status: "error",
      errorKind: "invalid_json",
      statusCode,
      models: [],
      loadedModels: [],
      message: `HTTP provider responded at ${baseUrl}, but ${resourceLabel} did not return valid JSON.`,
      detail: bodyPreview || "The endpoint answered, but not with an OpenAI-compatible JSON models payload."
    };
  }

  if (normalizedKind === "upstream_html") {
    return {
      type: "http_provider_test",
      status: "error",
      errorKind: "upstream_html",
      statusCode,
      models: [],
      loadedModels: [],
      message: `HTTP provider returned an HTML error page${statusCode ? ` (${statusCode})` : ""} while reading ${resourceLabel}.`,
      detail: "A reverse proxy or web server answered instead of the OpenAI-compatible API."
    };
  }

  return {
    type: "http_provider_test",
    status: "error",
    errorKind: "http_error",
    statusCode,
    models: [],
    loadedModels: [],
    message: `HTTP provider returned HTTP ${statusCode || "error"} while reading ${resourceLabel}.`,
    detail: bodyPreview || "The provider endpoint did not return a usable OpenAI-compatible models response."
  };
}

async function unloadHttpProviderModel(payload = {}) {
  const provider = payload.provider || {};
  const model = String(payload.model || provider.model || "").trim();
  if (!model) {
    throw new Error("HTTP provider model is required for unload.");
  }

  const baseUrl = normalizeHttpProviderBaseUrl(provider.baseUrl);
  const response = await fetch(buildHttpProviderApiUrl(baseUrl, "/models/unload"), {
    method: "POST",
    headers: {
      ...getHttpProviderHeaders(provider),
      "content-type": "application/json"
    },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(60000)
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP provider unload returned ${response.status}: ${text.slice(0, 300)}`);
  }

  return {
    type: "http_provider_unload",
    status: "ok",
    model,
    message: `Requested unload for ${model}.`
  };
}

function extractLoadedModels(json) {
  if (!Array.isArray(json?.data)) return [];

  return json.data
    .filter((item) => /loaded|loading/i.test(String(item?.status || item?.state || "")))
    .map((item) => item.id)
    .filter(Boolean);
}

function runHttpProviderAgentRequest(provider, payload = {}, options = {}) {
  const prompt = buildAgentPrompt(payload, { includeSchema: true, compactContext: true });
  return runHttpProviderCompletion(provider, prompt, true, options)
    .then(({ text, thinking }) => {
      const output = compactProviderOutput(text);
      const parsed = parseAgentJsonOrNaturalResponse(output);
      if (thinking && parsed && typeof parsed === "object" && !parsed.thinking) {
        parsed.thinking = thinking;
      }
      return parsed;
    })
    .catch((error) => {
      saveHttpProviderDebugError(createHttpProviderErrorArtifact({
        requestId: options.requestId || "",
        baseUrl: normalizeHttpProviderBaseUrl(provider.baseUrl),
        provider,
        requestBody: error?.httpProviderRequestBody || {},
        error
      }));
      return {
        type: "agent_error",
        message: error.message || "HTTP provider request failed.",
        thinking: error?.partialThinking || "",
        diagnostics: extractHttpProviderErrorDiagnostics(error)
      };
    });
}

function runHttpProviderSynthesisRequest(provider, payload = {}, options = {}) {
  const prompt = buildSynthesisPrompt({
    ...payload,
    observation: compactObservationForPrompt(payload.observation)
  });
  return runHttpProviderCompletion(provider, prompt, false, options)
    .then(({ text, thinking }) => ({
      type: "natural_response",
      text: compactProviderOutput(text),
      thinking
    }))
    .catch((error) => {
      saveHttpProviderDebugError(createHttpProviderErrorArtifact({
        requestId: options.requestId || "",
        baseUrl: normalizeHttpProviderBaseUrl(provider.baseUrl),
        provider,
        requestBody: error?.httpProviderRequestBody || {},
        error
      }));
      return {
        type: "natural_response",
        text: error.message || "HTTP provider synthesis failed.",
        thinking: error?.partialThinking || ""
      };
    });
}

async function runHttpProviderCompletion(provider, prompt, wantsJson, options = {}) {
  const baseUrl = normalizeHttpProviderBaseUrl(provider.baseUrl);
  const useStreaming = Boolean(provider.useStreaming);
  const initialMaxTokens = getHttpProviderPositiveInt(provider.maxTokens, 24576, 1);
  const retryMaxTokens = getHttpProviderPositiveInt(provider.retryMaxTokens, 49152, 1);
  const requestBody = {
    model: provider.model,
    messages: [
      {
        role: "user",
        content: wantsJson
          ? `${prompt}\n\nReturn only valid JSON in the final assistant content. If you use hidden reasoning, continue until the final content contains only the JSON object.`
          : `${prompt}\n\nIf you use hidden reasoning, continue until you emit the final user-facing answer in assistant content.`
      }
    ],
    temperature: 0.2,
    max_tokens: initialMaxTokens,
    stream: useStreaming
  };

  if (wantsJson) {
    requestBody.response_format = { type: "json_object" };
  }

  saveHttpProviderDebugRequest({
    savedAt: new Date().toISOString(),
    baseUrl,
    wantsJson,
    useStreaming,
    model: provider.model,
    timeoutMs: getHttpProviderTimeoutMs(provider.timeoutMs, HTTP_PROVIDER_DEFAULT_TIMEOUT_MS),
    maxTokens: initialMaxTokens,
    retryMaxTokens,
    requestBody
  });

  try {
    let json = await postHttpProviderCompletion(baseUrl, provider, requestBody, wantsJson, options);
    let extracted = extractChatCompletionText(json);

    if (!extracted.ok && extracted.retryable) {
      requestBody.max_tokens = retryMaxTokens;
      requestBody.messages[0].content += "\n\nPrevious attempt ended before final assistant content. Continue through hidden reasoning if needed, but emit the final answer in assistant content before stopping.";
      json = await postHttpProviderCompletion(baseUrl, provider, requestBody, false, options);
      extracted = extractChatCompletionText(json);
    }

    if (extracted.ok) {
      return {
        text: extracted.text,
        thinking: extracted.thinking || ""
      };
    }

    throw new Error(extracted.message);
  } catch (error) {
    if (error && typeof error === "object" && !error.httpProviderRequestBody) {
      error.httpProviderRequestBody = JSON.parse(JSON.stringify(requestBody));
    }
    throw error;
  }
}

function saveHttpProviderDebugRequest(payload) {
  try {
    fs.writeFileSync(httpProviderDebugRequestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort debug artifact only.
  }
}

function saveHttpProviderDebugError(payload) {
  try {
    fs.writeFileSync(httpProviderDebugErrorPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort debug artifact only.
  }
}

async function postHttpProviderCompletion(baseUrl, provider, requestBody, canRetryWithoutResponseFormat, options = {}) {
  const timeoutMs = getHttpProviderTimeoutMs(provider.timeoutMs, HTTP_PROVIDER_DEFAULT_TIMEOUT_MS);
  const activityTimeout = createActivityTimeoutController(timeoutMs, options.abortSignal);
  activityTimeout.onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const completionsUrl = buildHttpProviderApiUrl(baseUrl, "/v1/chat/completions");

  try {
    let response = await fetch(completionsUrl, {
      method: "POST",
      headers: {
        ...getHttpProviderHeaders(provider),
        "content-type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: activityTimeout.signal
    });
    let text = requestBody.stream
      ? await readStreamingChatCompletion(response, activityTimeout)
      : await response.text();

    if (!response.ok && canRetryWithoutResponseFormat && /response_format|json_object|unsupported/i.test(text)) {
      delete requestBody.response_format;
      response = await fetch(completionsUrl, {
        method: "POST",
        headers: {
          ...getHttpProviderHeaders(provider),
          "content-type": "application/json"
        },
        body: JSON.stringify(requestBody),
        signal: activityTimeout.signal
      });
      text = requestBody.stream
        ? await readStreamingChatCompletion(response, activityTimeout)
        : await response.text();
    }

    if (!response.ok) {
      throw new Error(`HTTP provider returned ${response.status}: ${text.slice(0, 500)}`);
    }

    return JSON.parse(text);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw makeProviderAbortError(
        error?.abortKind || activityTimeout.getAbortKind(),
        error?.partialThinking || "",
        error?.partialContent || "",
        error?.finishReason || ""
      );
    }
    throw error;
  } finally {
    activityTimeout.dispose();
  }
}

function getHttpProviderPositiveInt(value, fallback, min = 1) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

function getHttpProviderTimeoutMs(value, fallback = HTTP_PROVIDER_DEFAULT_TIMEOUT_MS) {
  const raw = String(value ?? fallback).trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function createActivityTimeoutController(timeoutMs, externalSignal) {
  const controller = new AbortController();
  let abortKind = "timeout";
  let timer = null;
  let disposed = false;
  let externalAbortHandler = null;

  const markActivity = () => {
    if (disposed || timeoutMs <= 0) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (disposed || controller.signal.aborted) {
        return;
      }
      abortKind = "timeout";
      controller.abort();
    }, timeoutMs);
  };

  if (externalSignal) {
    externalAbortHandler = () => {
      if (disposed || controller.signal.aborted) {
        return;
      }
      abortKind = "user";
      controller.abort();
    };

    if (externalSignal.aborted) {
      externalAbortHandler();
    } else {
      externalSignal.addEventListener("abort", externalAbortHandler, { once: true });
    }
  }

  markActivity();

  return {
    signal: controller.signal,
    markActivity,
    getAbortKind: () => abortKind,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      if (externalSignal && externalAbortHandler) {
        externalSignal.removeEventListener("abort", externalAbortHandler);
      }
    }
  };
}

function makeProviderAbortError(kind, partialThinking = "", partialContent = "", finishReason = "") {
  const isUserStop = kind === "user";
  const message = isUserStop
    ? "The request was stopped by the user."
    : (partialThinking
      ? "The operation was aborted due to the inactivity timeout after streamed thinking arrived but before the final assistant answer was completed."
      : "The operation was aborted due to the inactivity timeout before the final assistant answer was completed.");
  const error = new Error(message);
  error.name = "AbortError";
  error.partialThinking = partialThinking;
  error.partialContent = partialContent;
  error.finishReason = finishReason;
  error.abortKind = kind;
  return error;
}

function makeHttpProviderStreamError(error, diagnostics = {}) {
  const transportError = serializeErrorForDiagnostics(error);
  const transportLabel = compact([
    transportError.name,
    transportError.message
  ].filter(Boolean).join(": "));
  const message = [
    "HTTP provider stream terminated unexpectedly while waiting for the final assistant content.",
    transportLabel ? `Transport error: ${transportLabel}.` : "",
    `Response status: ${diagnostics.responseStatus ?? "unknown"}.`,
    `Content-Type: ${diagnostics.contentType || "unknown"}.`,
    `Reasoning chars: ${diagnostics.partialThinkingLength || 0}.`,
    `Content chars: ${diagnostics.partialContentLength || 0}.`,
    `Finish reason: ${diagnostics.finishReason || "none"}.`,
    `Chunks: ${diagnostics.chunksReceived || 0}.`,
    `SSE events: ${diagnostics.sseEvents || 0}.`,
    `Bytes: ${diagnostics.bytesReceived || 0}.`
  ].filter(Boolean).join(" ");
  const wrapped = new Error(message);
  wrapped.name = "HttpProviderStreamError";
  wrapped.partialThinking = diagnostics.partialThinking || "";
  wrapped.partialContent = diagnostics.partialContent || "";
  wrapped.finishReason = diagnostics.finishReason || "";
  wrapped.httpProviderDiagnostics = {
    ...diagnostics,
    transportError
  };
  return wrapped;
}

function serializeErrorForDiagnostics(error, depth = 0) {
  if (!error || typeof error !== "object") {
    return {
      message: String(error || "")
    };
  }

  if (depth > 2) {
    return {
      name: String(error.name || ""),
      message: String(error.message || "")
    };
  }

  const serialized = {
    name: String(error.name || ""),
    message: String(error.message || "")
  };

  if (typeof error.code === "string" || typeof error.code === "number") {
    serialized.code = error.code;
  }
  if (typeof error.type === "string") {
    serialized.type = error.type;
  }
  if (typeof error.errno === "string" || typeof error.errno === "number") {
    serialized.errno = error.errno;
  }
  if (typeof error.stack === "string") {
    serialized.stack = error.stack.slice(0, 4000);
  }
  if (error.cause && error.cause !== error) {
    serialized.cause = serializeErrorForDiagnostics(error.cause, depth + 1);
  }

  return serialized;
}

function extractHttpProviderErrorDiagnostics(error) {
  if (!error || typeof error !== "object") {
    return null;
  }

  const diagnostics = error.httpProviderDiagnostics && typeof error.httpProviderDiagnostics === "object"
    ? { ...error.httpProviderDiagnostics }
    : {};

  if (!diagnostics.transportError) {
    diagnostics.transportError = serializeErrorForDiagnostics(error);
  }
  if (typeof error.abortKind === "string" && !diagnostics.abortKind) {
    diagnostics.abortKind = error.abortKind;
  }
  if (typeof error.finishReason === "string" && !diagnostics.finishReason) {
    diagnostics.finishReason = error.finishReason;
  }
  if (typeof error.partialThinking === "string" && !diagnostics.partialThinkingLength) {
    diagnostics.partialThinkingLength = error.partialThinking.length;
  }
  if (typeof error.partialContent === "string" && !diagnostics.partialContentLength) {
    diagnostics.partialContentLength = error.partialContent.length;
  }

  return Object.keys(diagnostics).length ? diagnostics : null;
}

function createHttpProviderErrorArtifact({
  requestId = "",
  baseUrl = "",
  provider = {},
  requestBody = {},
  error = null
} = {}) {
  return {
    savedAt: new Date().toISOString(),
    requestId,
    baseUrl,
    model: provider.model || "",
    useStreaming: Boolean(requestBody.stream),
    wantsJson: requestBody.response_format?.type === "json_object",
    timeoutMs: getHttpProviderTimeoutMs(provider.timeoutMs, HTTP_PROVIDER_DEFAULT_TIMEOUT_MS),
    maxTokens: requestBody.max_tokens || 0,
    diagnostics: extractHttpProviderErrorDiagnostics(error),
    error: serializeErrorForDiagnostics(error)
  };
}

async function readStreamingChatCompletion(response, activityTimeout = null) {
  if (!response.body) {
    return response.text();
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let aggregatedContent = "";
  let aggregatedReasoning = "";
  let finishReason = "";
  let usage = null;
  let lastProgressEmitAt = 0;
  let lastProgressThinkingLength = 0;
  let lastFinishReason = "";
  let chunksReceived = 0;
  let bytesReceived = 0;
  let sseEvents = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunksReceived += 1;
      bytesReceived += value?.byteLength || 0;
      activityTimeout?.markActivity?.();
      buffer += decoder.decode(value, { stream: true });

      let eventBoundary = findSseEventBoundary(buffer);
      while (eventBoundary) {
        const rawEvent = buffer.slice(0, eventBoundary.index);
        buffer = buffer.slice(eventBoundary.index + eventBoundary.length);
        consumeStreamingEvent(rawEvent);
        eventBoundary = findSseEventBoundary(buffer);
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw makeProviderAbortError(
        activityTimeout?.getAbortKind?.() || "timeout",
        aggregatedReasoning,
        aggregatedContent,
        finishReason
      );
    }
    throw makeHttpProviderStreamError(error, {
      responseStatus: response.status,
      contentType,
      partialThinking: aggregatedReasoning,
      partialContent: aggregatedContent,
      partialThinkingLength: aggregatedReasoning.length,
      partialContentLength: aggregatedContent.length,
      finishReason,
      chunksReceived,
      bytesReceived,
      sseEvents
    });
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    consumeStreamingEvent(buffer);
  }

  return JSON.stringify({
    choices: [
      {
        index: 0,
        finish_reason: finishReason || "stop",
        message: {
          role: "assistant",
          content: aggregatedContent,
          ...(aggregatedReasoning ? { reasoning_content: aggregatedReasoning } : {})
        }
      }
    ],
    ...(usage ? { usage } : {})
  });

  function consumeStreamingEvent(rawEvent) {
    const lines = String(rawEvent || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      sseEvents += 1;

      const choice = parsed?.choices?.[0];
      const delta = choice?.delta || {};
      const message = choice?.message || {};
      const deltaContent = normalizeStreamText(delta.content) || normalizeStreamText(choice?.text) || normalizeStreamText(message.content);
      const deltaReasoning = normalizeStreamText(delta.reasoning_content) || normalizeStreamText(message.reasoning_content);
      const previousContentLength = aggregatedContent.length;
      const previousReasoningLength = aggregatedReasoning.length;

      if (deltaContent) aggregatedContent += deltaContent;
      if (deltaReasoning) aggregatedReasoning += deltaReasoning;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (parsed?.usage) usage = parsed.usage;

      const contentGrew = aggregatedContent.length > previousContentLength;
      const reasoningGrew = aggregatedReasoning.length > previousReasoningLength;
      const finishReasonChanged = finishReason !== lastFinishReason;
      const hadMeaningfulProgress = contentGrew || reasoningGrew || finishReasonChanged;

      if (hadMeaningfulProgress) {
        lastFinishReason = finishReason;
      }

      const now = Date.now();
      if (
        typeof activityTimeout?.onProgress === "function"
        && aggregatedReasoning
        && hadMeaningfulProgress
        && (
          now - lastProgressEmitAt >= 700
          || aggregatedReasoning.length - lastProgressThinkingLength >= 120
          || finishReasonChanged
        )
      ) {
        lastProgressEmitAt = now;
        lastProgressThinkingLength = aggregatedReasoning.length;
        activityTimeout.onProgress({
          thinking: aggregatedReasoning,
          content: aggregatedContent,
          finishReason
        });
      }
    }
  }
}

function findSseEventBoundary(buffer) {
  const value = String(buffer || "");
  if (!value) return null;

  const crlfBoundary = value.indexOf("\r\n\r\n");
  const lfBoundary = value.indexOf("\n\n");

  if (crlfBoundary >= 0 && (lfBoundary < 0 || crlfBoundary <= lfBoundary)) {
    return { index: crlfBoundary, length: 4 };
  }

  if (lfBoundary >= 0) {
    return { index: lfBoundary, length: 2 };
  }

  return null;
}

function normalizeStreamText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      return "";
    }).join("");
  }
  return "";
}

function extractChatCompletionText(json) {
  const choice = json?.choices?.[0];
  const content = choice?.message?.content || choice?.text || "";
  const reasoning = choice?.message?.reasoning_content || "";

  if (content) {
    return {
      ok: true,
      text: content,
      thinking: reasoning
    };
  }

  const finishReason = choice?.finish_reason || "";

  if (reasoning && finishReason === "length") {
    return {
      ok: false,
      retryable: true,
      message: "HTTP provider produced only hidden reasoning and hit the token limit before returning a usable answer. Browser Companion retried with more tokens, but the model still did not emit final assistant content."
    };
  }

  if (reasoning) {
    return {
      ok: false,
      retryable: false,
      message: "HTTP provider produced hidden reasoning but no user-facing answer. The model must emit final assistant content after thinking."
    };
  }

  return {
    ok: false,
    retryable: finishReason === "length",
    message: `HTTP provider returned no assistant content. Finish reason: ${finishReason || "unknown"}.`
  };
}

function normalizeHttpProviderBaseUrl(baseUrl) {
  const value = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) {
    throw new Error("HTTP provider Base URL must start with http:// or https://.");
  }
  return value;
}

function buildHttpProviderApiUrl(baseUrl, routePath) {
  const normalizedBaseUrl = normalizeHttpProviderBaseUrl(baseUrl);
  const normalizedRoutePath = `/${String(routePath || "").trim().replace(/^\/+/, "")}`;

  if (/\/v1$/i.test(normalizedBaseUrl) && /^\/v1(\/|$)/i.test(normalizedRoutePath)) {
    return `${normalizedBaseUrl}${normalizedRoutePath.replace(/^\/v1/i, "") || ""}`;
  }

  return `${normalizedBaseUrl}${normalizedRoutePath}`;
}

function isCloudflareWorkersAiProvider(provider = {}) {
  return String(provider.providerKind || "").trim().toLowerCase() === "cloudflare-workers-ai";
}

function extractCloudflareAccountIdFromBaseUrl(baseUrl) {
  const value = String(baseUrl || "").trim();
  const match = value.match(/\/accounts\/([^/]+)\/ai\/v1\/?$/i);
  return match?.[1] || "";
}

function extractCloudflareModelIds(json) {
  if (Array.isArray(json?.data)) {
    return json.data.map((item) => item?.id).filter(Boolean);
  }

  if (!Array.isArray(json?.result)) {
    return [];
  }

  return json.result
    .map((item) => item?.id || item?.name || item?.slug || item?.model)
    .filter(Boolean);
}

function getHttpProviderHeaders(provider = {}) {
  const headers = {};
  if (provider.authType === "basic" && (provider.username || provider.password)) {
    headers.authorization = `Basic ${Buffer.from(`${provider.username || ""}:${provider.password || ""}`).toString("base64")}`;
  }
  if (provider.authType === "bearer" && provider.token) {
    headers.authorization = `Bearer ${provider.token}`;
  }
  return headers;
}

function runProviderPrompt(provider, prompt, model, needsJson, options = {}) {
  if (provider.id === "anthropic-claude-code") {
    const args = ["-p", "-"];
    const normalized = normalizeProviderModel(provider, model);
    if (normalized !== "default") args.unshift("--model", normalized);
    return runCommandWithActivityTimeout(provider.command, args, {
      input: prompt,
      idleTimeout: CLI_PROVIDER_INACTIVITY_TIMEOUT_MS,
      abortSignal: options.abortSignal
    });
  }

  if (provider.id === "google-gemini-cli") {
    const args = [];
    const normalized = normalizeProviderModel(provider, model);
    if (normalized !== "default") args.push("-m", normalized);
    if (needsJson) args.push("--output-format", "json");
    return runCommandWithActivityTimeout(provider.command, args, {
      input: prompt,
      idleTimeout: CLI_PROVIDER_INACTIVITY_TIMEOUT_MS,
      abortSignal: options.abortSignal
    });
  }

  return Promise.resolve(runCodex(["exec", "--model", normalizeModel(model), "-"], { input: prompt, timeout: 120000 }));
}

function normalizeProviderModel(provider, model) {
  return provider.models.includes(model) ? model : provider.defaultModel;
}

function compactProviderOutput(output) {
  const text = stripProviderNoise(String(output || "")).trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed?.type || Array.isArray(parsed?.actions)) {
      return text;
    }
    return pickResponseText(parsed) || text;
  } catch {
    return text;
  }
}

function stripProviderNoise(output) {
  return String(output || "")
    .replace(/\bAttempt\s+\d+\s+failed:\s+You have exhausted your capacity on this model\..*?Retrying after \d+ms\.\.\./gi, "")
    .replace(/\bYou have exhausted your capacity on this model\..*?Retrying after \d+ms\.\.\./gi, "")
    .split(/\r?\n/)
    .filter((line) => !isProviderNoiseLine(line))
    .join("\n")
    .trim();
}

function isProviderNoiseLine(line) {
  return [
    /\[DEP0190\]\s+DeprecationWarning/i,
    /Use `node --trace-deprecation/i,
    /^Attempt\s+\d+\s+failed:/i,
    /Retrying after \d+ms/i,
    /You have exhausted your capacity on this model/i,
    /^Error executing tool /i,
    /^austed your capacity on this model/i,
    /^\(node:\d+\)/,
    /^Warning:\s+Windows 10 detected/i,
    /^Warning:\s+256-color support not detected/i,
    /^Ripgrep is not available\.\s+Falling back to GrepTool\./i
  ].some((pattern) => pattern.test(String(line || "")));
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (raw.startsWith("{") && raw.endsWith("}")) return raw;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found.");
  return match[0];
}

function parseAgentJsonOrNaturalResponse(output) {
  const text = compactProviderOutput(output);

  try {
    return normalizeAgentResponse(JSON.parse(extractJsonObject(text)));
  } catch (error) {
    if (text && !/^No JSON object found\.?$/i.test(text)) {
      return makeNaturalAgentResponse(text);
    }

    return {
      type: "agent_error",
      message: error.message || "HTTP provider response was not valid Browser Companion JSON."
    };
  }
}

function normalizeAgentResponse(response) {
  if (!response || typeof response !== "object") {
    return makeNaturalAgentResponse(String(response || ""));
  }

  if (!response.type) {
    const text = pickResponseText(response);
    const thinking = pickResponseThinking(response);
    return text
      ? makeNaturalAgentResponse(text, thinking)
      : {
          type: "agent_error",
          message: "Provider returned JSON, but it did not contain Browser Companion fields or user-facing text."
        };
  }

  if (response.type === "natural_response") {
    return {
      ...response,
      text: pickResponseText(response),
      thinking: pickResponseThinking(response)
    };
  }

  if (response.type === "ask_user") {
    return {
      ...response,
      question: response.question || pickResponseText(response)
    };
  }

  if (response.type === "stop_for_human") {
    return {
      ...response,
      reason: response.reason || pickResponseText(response)
    };
  }

  return response;
}

function pickResponseText(response) {
  if (typeof response === "string") {
    return compact(response);
  }

  const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
  const candidate = Array.isArray(response?.candidates) ? response.candidates[0] : null;
  const geminiParts = Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts.map((part) => part?.text || "").filter(Boolean).join("\n")
    : "";
  const values = [
    response?.text,
    response?.answer,
    response?.response,
    response?.content,
    response?.message?.content,
    response?.message,
    choice?.message?.content,
    choice?.text,
    geminiParts,
    response?.result,
    response?.output,
    response?.summary,
    response?.summary_for_user,
    response?.question,
    response?.reason
  ];

  return compact(values.find((value) => typeof value === "string" && value.trim()) || "");
}

function pickResponseThinking(response) {
  if (typeof response === "string") {
    return "";
  }

  const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
  const values = [
    response?.thinking,
    response?.reasoning_content,
    response?.message?.reasoning_content,
    choice?.message?.reasoning_content
  ];

  return compact(values.find((value) => typeof value === "string" && value.trim()) || "");
}

function makeNaturalAgentResponse(text, thinking = "") {
  return {
    type: "natural_response",
    text,
    thinking,
    question: "",
    reason: "",
    goal: "",
    risk_level: "low",
    summary_for_user: "",
    needs_clarification: false,
    requires_confirmation: false,
    will_submit: false,
    actions: [],
    uncertain_fields: []
  };
}

function summarizeProviderFailure(provider, result) {
  const combined = compact(stripProviderNoise(`${result.error?.message || ""} ${result.stderr || ""} ${result.stdout || ""}`));
  const raw = compact(`${result.error?.message || ""} ${result.stderr || ""} ${result.stdout || ""}`);
  const parsedError = parseProviderErrorMessage(combined);
  const message = parsedError || combined;

  if (/Requested entity was not found|code:\s*404|"\s*code\s*"\s*:\s*404|model.*not found|not found.*model/i.test(message)) {
    return `${provider.label} could not find the requested model. Open Connector, choose a model this account can use, or select the provider default model and try again.`;
  }

  if (/auth|login|sign in|unauthorized|permission/i.test(combined)) {
    return `${provider.label} appears to need sign-in. Open Connector and click Connect for this provider.`;
  }
  if (result?.error?.code === "ABORT_ERR" || /stopped by the user/i.test(message)) {
    return "The provider request was stopped by the user.";
  }
  if (result?.error?.code === "ETIMEDOUT" || /inactivity timeout|stopped producing output|etimedout/i.test(raw)) {
    return `${provider.label} stopped producing output before it completed the response and hit the inactivity timeout. Try again, reduce the request context, or switch provider.`;
  }
  if (isUsageLimitReachedText(raw)) {
    return buildUsageLimitMessage(provider, raw);
  }
  return message.slice(-800) || `${provider.label} request failed.`;
}

function parseProviderErrorMessage(text) {
  const raw = String(text || "");
  const jsonMatches = raw.match(/\{[\s\S]*?\}/g) || [];

  for (const candidate of jsonMatches.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      const message = parsed.error?.message || parsed.message || parsed.error?.type || "";
      if (message) return compact(message);
    } catch {
      // Continue scanning smaller embedded JSON snippets.
    }
  }

  const requestedEntity = raw.match(/Requested entity was not found\.?/i)?.[0];
  if (requestedEntity) return requestedEntity;

  return "";
}

function buildAgentPrompt(payload, options = {}) {
  const systemPrompt = fs.readFileSync(path.join(projectRoot, "codex", "system-prompt.md"), "utf8");
  const includeSchema = Boolean(options.includeSchema);
  const compactContext = Boolean(options.compactContext);
  const toolSchema = includeSchema ? fs.readFileSync(path.join(projectRoot, "codex", "tool-schema.json"), "utf8") : "";
  const hasObservation = Boolean(payload.observation);
  const observation = hasObservation
    ? (compactContext ? compactObservationForPrompt(payload.observation) : payload.observation)
    : null;
  const attachments = compactContext ? compactAttachmentsForPrompt(payload.attachments) : payload.attachments || [];

  return [
    systemPrompt,
    "",
    includeSchema ? "Browser Companion strict response JSON schema:" : "",
    includeSchema ? toolSchema : "",
    includeSchema ? "" : "",
    includeSchema ? "Important for non-Codex providers: if any browser action is needed, return only one JSON object conforming to the schema above. Do not wrap it in Markdown. Do not explain outside JSON." : "",
    includeSchema ? "For memory saves, return a top-level memory_proposal JSON object with memory_title and memory_content, not an agent_plan action." : "",
    includeSchema ? "Do not ask for approval or confirmation in prose such as 'Does this approach work?' or 'If so, I will proceed.' Browser Companion handles confirmation itself when required." : "",
    includeSchema ? "Do not output narrative sections such as 'Strategy Summary', 'Proposed Plan', or fenced Markdown plans when browser actions are needed. If you have enough information to act, return an agent_plan JSON object immediately. Use ask_user only when a specific missing detail genuinely blocks the next safe step." : "",
    includeSchema ? "" : "",
    "User goal:",
    payload.goal || "",
    "",
    "Response language:",
    payload.responseLanguage || "same language as the user",
    "",
    "Runtime continuation note:",
    payload.runtimeContext || "",
    "",
    "Recent conversation context JSON:",
    JSON.stringify(payload.conversationContext || [], null, 2),
    "",
    "Recent structured references JSON:",
    JSON.stringify(payload.recentReferences || {}, null, 2),
    "",
    "Accessible tabs JSON:",
    JSON.stringify(payload.accessibleTabs || [], null, 2),
    "",
    "Recent browser action results JSON:",
    JSON.stringify(payload.recentActions || [], null, 2),
    "",
    "Task memory JSON:",
    JSON.stringify(payload.taskMemory || null, null, 2),
    "",
    "Current page observation available:",
    hasObservation ? "yes" : "no",
    "",
    "Current page observation JSON:",
    JSON.stringify(observation, null, 2),
    "",
    "Local user memory JSON:",
    JSON.stringify(payload.userMemory || [], null, 2),
    "",
    "Local attachment context JSON:",
    JSON.stringify(attachments, null, 2),
    "",
    "When structured_items or focused_context include destination_url values observed on the page, treat those URLs as authoritative candidates for open_url_new_tab. Prefer those URLs over guessing. If no trustworthy destination URL is present, do not invent one.",
    "When the user's request is primarily operational (for example opening tabs, application pages, job posts, result pages, or the correct destination links), prefer taking the concrete browser action as soon as you already have a trustworthy URL or target. Favor completing the operational objective over continuing passive research once enough evidence is available to act.",
    "If a trustworthy destination URL is already supported by recent observation, structured items, focused context, recent successful action results, or task memory, prefer opening it directly rather than re-observing related tabs merely to reconfirm the same destination.",
    "For page-bound actions on a non-current tab, prefer using the normal action type with a `tab` object copied from Accessible tabs JSON. Use read-only observation on that target tab before stronger actions only when the tab has not been observed recently, the context is uncertain, or the destination URL is still ambiguous or missing.",
    "If a useful page may already be open in another accessible tab and you only need to inspect it first, you may use observe_page with a `tab` object or observe_known_tab with its tabId. Do not use those read-only inspections as the default next step when the user's main request is to open or navigate and the correct destination is already trustworthy.",
    "When the user refers to links, tabs, or pages opened earlier, treat the recent browser action results as the authoritative record of what was actually opened. Prefer those recorded URLs over guessed internal routes or slugs.",
    "If structured_items or elements include multiple link_candidates, use their visible link text, aria-label, and title to prefer the true details/apply destination over share, bookmark, organization/profile, menu, or decorative icon links.",
    "If an observed element is expandable or includes a controlled_region summary, treat that as evidence that more page content exists behind a closed menu, listbox, combobox, accordion, or popup. Use controlled_region titles and actions as a partial catalog of what that control can reveal or trigger. Do not assume the hidden content is already visible; if needed, propose opening one or more specific controls first.",
    "If the user refers to previously mentioned items and the exact destination still cannot be resolved safely, you may return ask_user. Prefer narrow clarification such as exact title, ordinal position, organization/company, section, visible metadata, or whether opening in the current tab is acceptable.",
    "",
    "Return only a JSON object that matches the Browser Companion tool schema when actions or memory proposals are needed."
  ].filter((line) => line !== "").join("\n");
}

function buildCodexAgentPrompt(payload) {
  return [
    buildAgentPrompt(payload),
    "",
    "Codex output-schema compatibility note:",
    "The attached output schema requires every declared property to be present.",
    "For unused memory_title and memory_content, use empty strings.",
    "Every action must include a tab object. If the action does not target a known tab, use {\"tabId\":null,\"url\":\"\",\"title\":\"\"}.",
    "Use source.confidence as a number; 0 means no specific source confidence."
  ].join("\n");
}

function buildDeepSearchPlanningPrompt(payload = {}) {
  const systemPrompt = fs.readFileSync(path.join(projectRoot, "codex", "system-prompt.md"), "utf8");
  const seedPage = payload.seedPageContext || payload.observation || null;

  return [
    systemPrompt,
    "",
    "Task: Plan a web-first Deep Search run for Browser Companion.",
    "Return only one JSON object. Do not wrap it in Markdown.",
    "Do not return browser actions. Do not ask the user for confirmation. Do not write a prose strategy summary.",
    'JSON shape: {"title":"report title","objective":"concise research objective","search_queries":["up to 32 focused web queries"],"desired_sections":["section title"],"evaluation_focus":["what to judge or compare"],"constraints":["important limits"],"stop_early_if_sufficient":true}',
    "",
    "Planning rules:",
    "- Web-first research only.",
    "- Favor public sources that can be read with normal HTTP fetches.",
    "- Be ambitious about source coverage. Use multiple query angles, not just a single phrasing.",
    "- Prefer official company pages, direct job pages, public documentation, reputable org pages, strong directories, and transparent public writeups over vague aggregator fluff when possible.",
    "- Plan enough query diversity to support a detailed final report, not just a quick answer.",
    "- Anticipate whether the final answer will work best as a report, a list of records, a hybrid report plus list, or a map-backed result, and plan source coverage accordingly.",
    "- Use the current page only as optional seed context, not as a browsing target.",
    "- Keep queries diverse but concrete.",
    "- Respect the user's explicit constraints and language.",
    "",
    "User goal:",
    payload.goal || "",
    "",
    "Response language:",
    payload.responseLanguage || "same language as the user",
    "",
    "Fixed Deep Search caps:",
    "- Initial queries max: 32",
    "- Search results retained per query max: 20",
    "- Total fetched pages max: 80",
    "- Optional refinement queries per round max: 16",
    "- Optional refinement rounds max: 4",
    "",
    "Seed page context JSON:",
    JSON.stringify(seedPage || null, null, 2),
    "",
    "Follow-up refinement instruction:",
    payload.followUpInstruction || "",
    "",
    "Review notes JSON:",
    JSON.stringify(payload.reviewNotes || [], null, 2),
    "",
    "Prior report JSON:",
    JSON.stringify(payload.priorReport || null, null, 2),
    "",
    "Prior search trail JSON:",
    JSON.stringify(payload.priorSearchArtifacts || [], null, 2),
    "",
    "Prior fetched sources JSON:",
    JSON.stringify(payload.priorFetchedSources || [], null, 2),
    "",
    "Local user memory JSON:",
    JSON.stringify(payload.userMemory || [], null, 2),
    "",
    "Return only valid JSON."
  ].join("\n");
}

function buildDeepSearchRefinementPrompt(payload = {}) {
  return [
    "Task: Review the first-wave Deep Search evidence and decide whether a second wave is necessary.",
    "Return only one JSON object. Do not wrap it in Markdown.",
    'JSON shape: {"additional_queries":["up to 16 queries"],"rationale":"short reason","stop_early":false}',
    "",
    "User goal:",
    payload.goal || "",
    "",
    "Response language:",
    payload.responseLanguage || "same language as the user",
    "",
    "Initial Deep Search plan JSON:",
    JSON.stringify(payload.plan || null, null, 2),
    "",
    "Collected source summary JSON:",
    JSON.stringify(payload.sources || payload.fetchedSources || [], null, 2),
    "",
    "Search trail JSON:",
    JSON.stringify(payload.searchArtifacts || [], null, 2),
    "",
    "Rules:",
    "- Use stop_early=true when the current evidence is already sufficient for a strong final report.",
    "- If more research is needed, propose the highest-value follow-up queries that expand source coverage, quality, specificity, and domain diversity.",
    "- Prefer follow-up queries that add new organizations, new domains, new evidence classes, or tighter constraints.",
    "- Do not repeat the same query phrasing unless a genuinely tighter variant is needed.",
    "",
    "Return only valid JSON."
  ].join("\n");
}

function buildDeepSearchDigestPrompt(payload = {}) {
  return [
    "Task: Compress fetched Deep Search source pages into structured source digests.",
    "Return only one JSON object. Do not wrap it in Markdown.",
    'JSON shape: {"digests":[{"url":"https://...","title":"source title","domain":"example.com","source_type":"official|directory|article|listing|job|event|general","relevance_score":0,"confidence":0,"summary":"2-3 sentence compression","key_facts":["fact"],"entities":["entity"],"dates":["date"],"locations":["location"],"important_links":[{"label":"Apply","type":"application","url":"https://..."}],"matches_user_goal":"why it matters","risks_or_gaps":["what is missing or uncertain"],"query":"source query","siteName":"site"}]}',
    "",
    "Digest rules:",
    "- Keep only information that is useful for the user's research goal.",
    "- Remove prose fluff, navigation noise, and duplicated framing language.",
    "- Preserve concrete facts, dates, requirements, prices, locations, organizations, and direct links when present.",
    "- Score each source for relevance to the user's goal from 0 to 100.",
    "- Confidence should reflect how directly the page supports the extracted claims.",
    "- If a source is weak, say why in risks_or_gaps rather than inventing certainty.",
    "",
    "User goal:",
    payload.goal || "",
    "",
    "Response language:",
    payload.responseLanguage || "same language as the user",
    "",
    "Deep Search plan JSON:",
    JSON.stringify(payload.plan || null, null, 2),
    "",
    "Batch index:",
    `${payload.batchIndex || 1}/${payload.batchCount || 1}`,
    "",
    "Fetched source batch JSON:",
    JSON.stringify(payload.sources || [], null, 2),
    "",
    "Return only valid JSON."
  ].join("\n");
}

function buildDeepSearchBatchSynthesisPrompt(payload = {}) {
  return [
    "Task: Synthesize a batch of Deep Search source digests into a compact batch summary for later meta-synthesis.",
    "Return only one JSON object. Do not wrap it in Markdown.",
    'JSON shape: {"title":"batch title","summary":"compressed synthesis","key_points":["point"],"top_source_urls":["https://..."]}',
    "",
    "Batch synthesis rules:",
    "- Combine overlapping digests and surface only the strongest takeaways.",
    "- Prefer high-relevance, high-confidence evidence when there is conflict.",
    "- Keep this batch summary compact and factual so it can be merged later.",
    "- Mention uncertainty only when it materially affects interpretation.",
    "",
    "User goal:",
    payload.goal || "",
    "",
    "Response language:",
    payload.responseLanguage || "same language as the user",
    "",
    "Deep Search plan JSON:",
    JSON.stringify(payload.plan || null, null, 2),
    "",
    "Batch index:",
    `${payload.batchIndex || 1}/${payload.batchCount || 1}`,
    "",
    "Source digests batch JSON:",
    JSON.stringify(payload.digests || [], null, 2),
    "",
    "Return only valid JSON."
  ].join("\n");
}

function buildDeepSearchReportPrompt(payload = {}) {
  return [
    "Task: Write the final Deep Search report for Browser Companion from collected public web evidence.",
    "Return only one JSON object. Do not wrap it in Markdown.",
    'JSON shape: {"title":"report title","objective":"research objective","executive_summary":"short synthesis","key_findings":[{"title":"finding","summary":"why it matters","source_urls":["https://..."]}],"sections":[{"heading":"section title","body":"source-backed narrative","source_urls":["https://..."]}],"methodology":["step"],"open_questions":["remaining unknown"],"sources":[{"url":"https://...","title":"source title","snippet":"short note","statusCode":200,"siteName":"optional","heroImageUrl":"https://..."}],"presentation":{"primary_view":"report|list|hybrid|map","available_views":["report","list","map","print"],"print_ready":true},"collections":[{"id":"collection-id","title":"collection title","description":"what the list contains","record_type":"job|hotel|event|listing|result","columns":[{"key":"organization","label":"Organization","kind":"text|link|tag"}],"items":[{"id":"item-id","label":"short label","title":"display title","description":"short summary","primary_url":"https://...","evidence_note":"why it qualifies","tags":["tag"],"source_urls":["https://..."],"fields":{"organization":"Acme","location":"Remote Europe"},"links":[{"label":"Apply","type":"application","url":"https://..."}],"location":{"label":"Milan","address":"Milan, Italy","query":"Milan Italy"}}],"source_urls":["https://..."]}],"document":{"title":"print title","subtitle":"print subtitle","toc":[{"id":"chapter-1","label":"Chapter 1"}],"chapters":[{"id":"chapter-1","heading":"Chapter 1","summary":"short summary","body":"print-friendly narrative","source_urls":["https://..."],"image_urls":["https://..."]}],"appendix":[{"id":"appendix-1","heading":"Appendix","body":"extra notes"}],"selected_images":[{"url":"https://...","alt":"alt text","caption":"caption","source_url":"https://..."}]},"map_data":[{"id":"map-1","title":"map title","description":"why the map helps","points":[{"id":"point-1","label":"point label","note":"why it matters","source_url":"https://...","primary_url":"https://...","lat":45.4,"lng":11.9,"location":{"label":"Padua","address":"Padua, Italy","query":"Padua Italy"}}],"source_urls":["https://..."]}],"media":[{"url":"https://...","alt":"alt text","caption":"caption","source_url":"https://..."}]}',
    "",
    "Report rules:",
    "- Be source-backed, concrete, and concise.",
    "- Prefer synthesis over dumping raw search output.",
    "- Produce a detailed report with multiple distinct findings and rich sections when evidence allows.",
    "- Use a broad share of the collected evidence instead of relying on only one or two sources.",
    "- Pull out concrete comparisons, tradeoffs, patterns, and caveats where the evidence supports them.",
    "- Mention uncertainty when evidence is thin or conflicting.",
    "- Cite relevant URLs for findings and sections.",
    "- Use collections when the user would benefit from scanning or comparing many concrete results.",
    "- Use map_data only when location meaningfully helps interpretation, comparison, or planning.",
    "- Build a document when the result would benefit from a print-friendly report with chapters and a table of contents.",
    "- Include media only when it genuinely improves comprehension; prefer public page images such as hero or og:image assets tied to cited sources.",
    "- Keep the report aligned with the user's language.",
    "",
    "User goal:",
    payload.goal || "",
    "",
    "Response language:",
    payload.responseLanguage || "same language as the user",
    "",
    "Deep Search plan JSON:",
    JSON.stringify(payload.plan || null, null, 2),
    "",
    "Search artifacts JSON:",
    JSON.stringify(payload.searchArtifacts || [], null, 2),
    "",
    "Compressed source digests JSON:",
    JSON.stringify(payload.sourceDigests || [], null, 2),
    "",
    "Batch synthesis summaries JSON:",
    JSON.stringify(payload.batchSummaries || [], null, 2),
    "",
    "Representative top fetched sources JSON:",
    JSON.stringify(payload.fetchedSources || [], null, 2),
    "",
    "Local user memory JSON:",
    JSON.stringify(payload.userMemory || [], null, 2),
    "",
    "Return only valid JSON."
  ].join("\n");
}

function buildDeepSearchChatPrompt(payload = {}) {
  return [
    "Task: Answer a follow-up user message about an existing Browser Companion Deep Search run.",
    "Do not return JSON.",
    "Answer directly, using the collected report, sources, search trail, and thread context.",
    "If the user is criticizing mistakes or gaps, acknowledge them plainly and use the evidence you have.",
    "If the user asks for a narrower slice of the existing results, reorganize the current material instead of pretending you ran new research.",
    "If the user asks for something the current evidence cannot support, say what is missing and suggest a refinement.",
    "",
    "Original Deep Search goal:",
    payload.originalGoal || "",
    "",
    "Current follow-up user message:",
    payload.goal || "",
    "",
    "Response language:",
    payload.responseLanguage || "same language as the user",
    "",
    "Deep Search status:",
    payload.runStatus || "",
    "",
    "Deep Search report JSON:",
    JSON.stringify(payload.report || null, null, 2),
    "",
    "Deep Search fetched sources JSON:",
    JSON.stringify(payload.fetchedSources || [], null, 2),
    "",
    "Deep Search source digests JSON:",
    JSON.stringify(payload.sourceDigests || [], null, 2),
    "",
    "Deep Search batch summaries JSON:",
    JSON.stringify(payload.batchSummaries || [], null, 2),
    "",
    "Deep Search search trail JSON:",
    JSON.stringify(payload.searchArtifacts || [], null, 2),
    "",
    "Deep Search thread messages JSON:",
    JSON.stringify(payload.threadMessages || [], null, 2)
  ].join("\n");
}

function normalizeDeepSearchPlanningResponse(value = {}) {
  return {
    title: compact(value?.title || ""),
    objective: compact(value?.objective || ""),
    search_queries: normalizeStructuredStringList(value?.search_queries || [], 32),
    desired_sections: normalizeStructuredStringList(value?.desired_sections || [], 18),
    evaluation_focus: normalizeStructuredStringList(value?.evaluation_focus || [], 18),
    constraints: normalizeStructuredStringList(value?.constraints || [], 20),
    stop_early_if_sufficient: Boolean(value?.stop_early_if_sufficient)
  };
}

function normalizeDeepSearchDigestResponse(value = {}) {
  const rawDigests = Array.isArray(value?.digests)
    ? value.digests
    : (Array.isArray(value) ? value : []);

  return rawDigests.slice(0, 40).map((digest, index) => ({
    id: compact(digest?.id || `digest-${index + 1}`),
    url: normalizeStructuredUrl(digest?.url || ""),
    title: compact(digest?.title || ""),
    domain: compact(digest?.domain || ""),
    sourceType: compact(digest?.source_type || digest?.sourceType || "general"),
    relevanceScore: normalizeScore(digest?.relevance_score ?? digest?.relevanceScore),
    confidence: normalizeScore(digest?.confidence),
    summary: compact(digest?.summary || ""),
    keyFacts: normalizeStructuredStringList(digest?.key_facts || digest?.keyFacts || [], 10),
    entities: normalizeStructuredStringList(digest?.entities || [], 12),
    dates: normalizeStructuredStringList(digest?.dates || [], 10),
    locations: normalizeStructuredStringList(digest?.locations || [], 10),
    importantLinks: Array.isArray(digest?.important_links || digest?.importantLinks)
      ? (digest.important_links || digest.importantLinks).slice(0, 10).map((link, linkIndex) => ({
          id: compact(link?.id || `link-${linkIndex + 1}`),
          label: compact(link?.label || link?.type || link?.url || ""),
          type: compact(link?.type || "source"),
          url: normalizeStructuredUrl(link?.url || ""),
          note: compact(link?.note || "")
        })).filter((link) => link.label && link.url)
      : [],
    matchesUserGoal: compact(digest?.matches_user_goal || digest?.matchesUserGoal || ""),
    risksOrGaps: normalizeStructuredStringList(digest?.risks_or_gaps || digest?.risksOrGaps || [], 8),
    extractedAt: new Date().toISOString(),
    query: compact(digest?.query || ""),
    siteName: compact(digest?.siteName || digest?.site_name || "")
  })).filter((digest) => digest.url || digest.title);
}

function normalizeDeepSearchBatchSynthesisResponse(value = {}) {
  return {
    id: compact(value?.id || ""),
    title: compact(value?.title || ""),
    summary: compact(value?.summary || ""),
    keyPoints: normalizeStructuredStringList(value?.key_points || value?.keyPoints || [], 8),
    topSourceUrls: normalizeStructuredUrlList(value?.top_source_urls || value?.topSourceUrls || [], 12)
  };
}

function normalizeDeepSearchRefinementResponse(value = {}) {
  return {
    additional_queries: normalizeStructuredStringList(value?.additional_queries || [], 16),
    rationale: compact(value?.rationale || ""),
    stop_early: Boolean(value?.stop_early)
  };
}

function normalizeScore(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function normalizeDeepSearchReportResponse(value = {}) {
  return {
    title: compact(value?.title || ""),
    objective: compact(value?.objective || ""),
    executive_summary: compact(value?.executive_summary || ""),
    key_findings: Array.isArray(value?.key_findings)
      ? value.key_findings.slice(0, 16).map((item) => ({
          title: compact(item?.title || ""),
          summary: compact(item?.summary || ""),
          source_urls: normalizeStructuredUrlList(item?.source_urls || [], 10)
        }))
      : [],
    sections: Array.isArray(value?.sections)
      ? value.sections.slice(0, 18).map((item) => ({
          heading: compact(item?.heading || ""),
          body: compact(item?.body || ""),
          source_urls: normalizeStructuredUrlList(item?.source_urls || [], 16)
        }))
      : [],
    methodology: normalizeStructuredStringList(value?.methodology || [], 24),
    open_questions: normalizeStructuredStringList(value?.open_questions || [], 20),
    sources: Array.isArray(value?.sources)
      ? value.sources.slice(0, 40).map((item) => ({
          url: normalizeStructuredUrl(item?.url || ""),
          title: compact(item?.title || ""),
          snippet: compact(item?.snippet || ""),
          statusCode: Number.isFinite(Number(item?.statusCode)) ? Number(item.statusCode) : null,
          siteName: compact(item?.siteName || ""),
          heroImageUrl: normalizeStructuredUrl(item?.heroImageUrl || "")
        })).filter((item) => item.url)
      : [],
    presentation: normalizeDeepSearchPresentationResponse(value?.presentation || null),
    collections: normalizeDeepSearchCollectionsResponse(value?.collections || []),
    document: normalizeDeepSearchDocumentResponse(value?.document || null),
    map_data: normalizeDeepSearchMapDataResponse(value?.map_data || []),
    media: normalizeDeepSearchMediaResponse(value?.media || [])
  };
}

function normalizeDeepSearchPresentationResponse(value = null) {
  if (!value || typeof value !== "object") {
    return {
      primary_view: "report",
      available_views: ["report"],
      print_ready: false
    };
  }

  const availableViews = Array.isArray(value?.available_views)
    ? value.available_views.map((item) => compact(item)).filter((item) => ["report", "list", "hybrid", "map", "print"].includes(item))
    : [];

  return {
    primary_view: ["report", "list", "hybrid", "map", "print"].includes(compact(value?.primary_view || ""))
      ? compact(value.primary_view)
      : "report",
    available_views: availableViews.length ? [...new Set(availableViews)] : ["report"],
    print_ready: Boolean(value?.print_ready)
  };
}

function normalizeDeepSearchCollectionsResponse(collections = []) {
  if (!Array.isArray(collections)) {
    return [];
  }

  return collections.slice(0, 8).map((collection, index) => ({
    id: compact(collection?.id || `collection-${index + 1}`),
    title: compact(collection?.title || ""),
    description: compact(collection?.description || ""),
    record_type: compact(collection?.record_type || "result"),
    columns: Array.isArray(collection?.columns)
      ? collection.columns.slice(0, 12).map((column, columnIndex) => ({
          key: compact(column?.key || `column_${columnIndex + 1}`),
          label: compact(column?.label || column?.key || `Column ${columnIndex + 1}`),
          kind: compact(column?.kind || "text")
        })).filter((column) => column.key)
      : [],
    items: Array.isArray(collection?.items)
      ? collection.items.slice(0, 120).map((item, itemIndex) => ({
          id: compact(item?.id || `item-${itemIndex + 1}`),
          label: compact(item?.label || item?.title || ""),
          title: compact(item?.title || item?.label || ""),
          description: compact(item?.description || ""),
          primary_url: normalizeStructuredUrl(item?.primary_url || item?.url || ""),
          evidence_note: compact(item?.evidence_note || item?.note || ""),
          tags: normalizeStructuredStringList(item?.tags || [], 10),
          source_urls: normalizeStructuredUrlList(item?.source_urls || [], 12),
          fields: normalizeDeepSearchObjectFieldMap(item?.fields || {}),
          links: Array.isArray(item?.links)
            ? item.links.slice(0, 12).map((link, linkIndex) => ({
                id: compact(link?.id || `link-${linkIndex + 1}`),
                label: compact(link?.label || link?.type || link?.url || ""),
                type: compact(link?.type || "source"),
                url: normalizeStructuredUrl(link?.url || ""),
                note: compact(link?.note || "")
              })).filter((link) => link.label && link.url)
            : [],
          location: normalizeDeepSearchLocationResponse(item?.location || null)
        })).filter((item) => item.label || item.primary_url || Object.keys(item.fields).length)
      : [],
    source_urls: normalizeStructuredUrlList(collection?.source_urls || [], 20)
  })).filter((collection) => collection.items.length || collection.title);
}

function normalizeDeepSearchDocumentResponse(document = null) {
  if (!document || typeof document !== "object") {
    return null;
  }

  return {
    title: compact(document?.title || ""),
    subtitle: compact(document?.subtitle || ""),
    toc: Array.isArray(document?.toc)
      ? document.toc.slice(0, 24).map((item, index) => ({
          id: compact(item?.id || `toc-${index + 1}`),
          label: compact(item?.label || item?.title || "")
        })).filter((item) => item.label)
      : [],
    chapters: Array.isArray(document?.chapters)
      ? document.chapters.slice(0, 20).map((chapter, index) => ({
          id: compact(chapter?.id || `chapter-${index + 1}`),
          heading: compact(chapter?.heading || chapter?.title || ""),
          summary: compact(chapter?.summary || ""),
          body: compact(chapter?.body || ""),
          source_urls: normalizeStructuredUrlList(chapter?.source_urls || [], 16),
          image_urls: normalizeStructuredUrlList(chapter?.image_urls || [], 6)
        })).filter((chapter) => chapter.heading || chapter.body)
      : [],
    appendix: Array.isArray(document?.appendix)
      ? document.appendix.slice(0, 20).map((item, index) => ({
          id: compact(item?.id || `appendix-${index + 1}`),
          heading: compact(item?.heading || item?.title || ""),
          body: compact(item?.body || "")
        })).filter((item) => item.heading || item.body)
      : [],
    selected_images: normalizeDeepSearchMediaResponse(document?.selected_images || [], 8)
  };
}

function normalizeDeepSearchMapDataResponse(mapData = []) {
  if (!Array.isArray(mapData)) {
    return [];
  }

  return mapData.slice(0, 4).map((entry, index) => ({
    id: compact(entry?.id || `map-${index + 1}`),
    title: compact(entry?.title || ""),
    description: compact(entry?.description || ""),
    points: Array.isArray(entry?.points)
      ? entry.points.slice(0, 20).map((point, pointIndex) => ({
          id: compact(point?.id || `point-${pointIndex + 1}`),
          label: compact(point?.label || point?.title || ""),
          note: compact(point?.note || point?.description || ""),
          source_url: normalizeStructuredUrl(point?.source_url || ""),
          primary_url: normalizeStructuredUrl(point?.primary_url || point?.url || ""),
          lat: Number.isFinite(Number(point?.lat)) ? Number(point.lat) : null,
          lng: Number.isFinite(Number(point?.lng)) ? Number(point.lng) : null,
          location: normalizeDeepSearchLocationResponse(point?.location || point)
        })).filter((point) => point.label || point.location?.label || Number.isFinite(point.lat))
      : [],
    bounds: normalizeDeepSearchBoundsResponse(entry?.bounds || null),
    source_urls: normalizeStructuredUrlList(entry?.source_urls || [], 20)
  })).filter((entry) => entry.points.length || entry.title);
}

function normalizeDeepSearchMediaResponse(media = [], limit = 12) {
  if (!Array.isArray(media)) {
    return [];
  }

  return media.slice(0, limit).map((item, index) => ({
    id: compact(item?.id || `media-${index + 1}`),
    kind: compact(item?.kind || "image"),
    url: normalizeStructuredUrl(item?.url || item?.src || ""),
    alt: compact(item?.alt || ""),
    caption: compact(item?.caption || ""),
    source_url: normalizeStructuredUrl(item?.source_url || "")
  })).filter((item) => item.url);
}

function normalizeDeepSearchBoundsResponse(bounds = null) {
  if (!bounds || typeof bounds !== "object") {
    return null;
  }

  const north = Number(bounds?.north);
  const south = Number(bounds?.south);
  const east = Number(bounds?.east);
  const west = Number(bounds?.west);

  if (![north, south, east, west].every((value) => Number.isFinite(value))) {
    return null;
  }

  return { north, south, east, west };
}

function normalizeDeepSearchLocationResponse(location = null) {
  if (!location || typeof location !== "object") {
    return {
      label: "",
      address: "",
      query: ""
    };
  }

  return {
    label: compact(location?.label || location?.name || location?.place || ""),
    address: compact(location?.address || ""),
    query: compact(location?.query || location?.location_text || "")
  };
}

function normalizeDeepSearchObjectFieldMap(fields = {}) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(fields)
      .slice(0, 20)
      .map(([key, fieldValue]) => [compact(key), compact(fieldValue)])
      .filter(([key, fieldValue]) => key && fieldValue)
  );
}

function compactObservationForPrompt(observation = {}) {
  const safeObservation = observation && typeof observation === "object" ? observation : {};
  return {
    type: safeObservation.type || "page_observation",
    tab: safeObservation.tab || {},
    viewport: safeObservation.viewport || {},
    visible_text: String(safeObservation.visible_text || "").slice(0, 6000),
    headings: (safeObservation.headings || []).slice(0, 20),
    links: (safeObservation.links || []).slice(0, 80).map(compactElementForPrompt),
    buttons: (safeObservation.buttons || []).slice(0, 80).map(compactElementForPrompt),
    forms: (safeObservation.forms || []).slice(0, 10),
    interactive_elements: (safeObservation.interactive_elements || []).slice(0, 120).map(compactElementForPrompt),
    counts: safeObservation.counts || null,
    page_outline: compactPageOutlineForPrompt(safeObservation.page_outline || null),
    structured_items: (safeObservation.structured_items || []).slice(0, 24).map(compactStructuredItemForPrompt),
    focused_context: (safeObservation.focused_context || []).slice(0, 12).map(compactFocusedContextForPrompt),
    content_blocks: (safeObservation.content_blocks || []).slice(0, 16).map(compactFocusedContextForPrompt),
    note: safeObservation.note || "",
    capturedAt: safeObservation.capturedAt || ""
  };
}

function compactElementForPrompt(element = {}) {
  return {
    agent_id: element.agent_id || "",
    role: element.role || "",
    name: element.name || "",
    href: element.href || "",
    destination_url: element.destination_url || "",
    expandable: Boolean(element.expandable),
    expanded: typeof element.expanded === "boolean" ? element.expanded : null,
    popup_role: element.popup_role || "",
    controlled_region: element.controlled_region
      ? {
          id: element.controlled_region.id || "",
          role: element.controlled_region.role || "",
          label: String(element.controlled_region.label || "").slice(0, 120),
          hidden: Boolean(element.controlled_region.hidden),
          item_count: Number(element.controlled_region.item_count || 0),
          titles: Array.isArray(element.controlled_region.titles)
            ? element.controlled_region.titles.slice(0, 6).map((title) => String(title || "").slice(0, 120))
            : [],
          actions: Array.isArray(element.controlled_region.actions)
            ? element.controlled_region.actions.slice(0, 8).map((action) => ({
                role: action.role || "",
                label: String(action.label || "").slice(0, 120),
                href: action.href || "",
                value: String(action.value || "").slice(0, 120)
              }))
            : []
        }
      : null,
    link_candidates: (element.link_candidates || []).slice(0, 4).map((candidate) => ({
      href: candidate.href || "",
      text: String(candidate.text || "").slice(0, 180),
      aria_label: String(candidate.aria_label || "").slice(0, 120),
      title: String(candidate.title || "").slice(0, 120)
    })),
    nearest_heading: element.nearest_heading || null,
    type: element.type || "",
    selector_candidates: (element.selector_candidates || []).slice(0, 3)
  };
}

function compactPageOutlineForPrompt(pageOutline = null) {
  if (!pageOutline) {
    return null;
  }

  return {
    page_type: pageOutline.page_type || "general",
    repeated_item_summary: String(pageOutline.repeated_item_summary || "").slice(0, 300),
    counts: pageOutline.counts || null,
    sections: (pageOutline.sections || []).slice(0, 10).map((section) => ({
      section_id: section.section_id || "",
      title: section.title || "",
      preview: String(section.preview || "").slice(0, 220),
      item_count: Number(section.item_count || 0),
      level: section.level || ""
    }))
  };
}

function compactStructuredItemForPrompt(item = {}) {
  return {
    item_id: item.item_id || "",
    agent_id: item.agent_id || "",
    role: item.role || "",
    title: String(item.title || "").slice(0, 220),
    label: String(item.label || "").slice(0, 220),
    metadata: String(item.metadata || "").slice(0, 260),
    text_preview: String(item.text_preview || "").slice(0, 320),
    destination_url: item.destination_url || item.href || "",
    link_candidates: (item.link_candidates || []).slice(0, 6).map((candidate) => ({
      href: candidate.href || "",
      text: String(candidate.text || "").slice(0, 180),
      aria_label: String(candidate.aria_label || "").slice(0, 120),
      title: String(candidate.title || "").slice(0, 120)
    })),
    href: item.href || "",
    section_id: item.section_id || "",
    section_title: item.section_title || "",
    selector_candidates: (item.selector_candidates || []).slice(0, 3),
    source_agent_ids: (item.source_agent_ids || []).slice(0, 4)
  };
}

function compactFocusedContextForPrompt(block = {}) {
  return {
    block_id: block.block_id || "",
    kind: block.kind || "section",
    section_id: block.section_id || "",
    section_title: block.section_title || "",
    item_id: block.item_id || "",
    title: String(block.title || "").slice(0, 200),
    text: String(block.text || "").slice(0, 360),
    destination_url: block.destination_url || ""
  };
}

function compactAttachmentsForPrompt(attachments = []) {
  return attachments.slice(0, 8).map((attachment) => ({
    id: attachment.id || "",
    name: attachment.name || "",
    type: attachment.type || "",
    status: attachment.status || "",
    text: String(attachment.text || "").slice(0, 8000)
  }));
}

function normalizeStructuredStringList(values, limit) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => compact(value))
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeStructuredUrlList(values, limit) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeStructuredUrl(value))
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeStructuredUrl(value) {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) {
    return "";
  }
  try {
    return new URL(text).toString();
  } catch {
    return "";
  }
}

function buildSynthesisPrompt(payload) {
  const systemPrompt = fs.readFileSync(path.join(projectRoot, "codex", "system-prompt.md"), "utf8");

  if (payload.task === "user_memory") {
    return [
      systemPrompt,
      "",
      "Task: Create a local user-memory entry from the user's explicit save request and recent conversation context.",
      "Return only one JSON object. Do not wrap it in Markdown.",
      "JSON shape: {\"title\":\"short stable title\",\"content\":\"clean memory body\"}",
      "",
      "Memory rules:",
      "- Save a curated synthesis, not the raw user command.",
      "- Keep only stable, future-useful facts and context.",
      "- Use English for the saved title and content, even if the conversation is in another language.",
      "- Distinguish source-backed facts from self-reported claims when relevant.",
      "- Do not invent names, dates, organizations, titles, or achievements that are not present in the context.",
      "- Keep the content concise but detailed enough to help future job-fit, writing, research, or browser tasks.",
      "",
      "User save request:",
      payload.memoryRequest || payload.goal || "",
      "",
      "Requested memory scope:",
      payload.requestedScope || "",
      "",
      "Recent conversation context JSON:",
      JSON.stringify(payload.conversationContext || [], null, 2),
      "",
      "Existing local user memory JSON:",
      JSON.stringify(payload.userMemory || [], null, 2),
      "",
      "Local attachment summaries JSON:",
      JSON.stringify(payload.attachments || [], null, 2)
    ].join("\n");
  }

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
    "Recent conversation context JSON:",
    JSON.stringify(payload.conversationContext || [], null, 2),
    "",
    "Recent structured references JSON:",
    JSON.stringify(payload.recentReferences || {}, null, 2),
    "",
    "Accessible tabs JSON:",
    JSON.stringify(payload.accessibleTabs || [], null, 2),
    "",
    "Recent browser action results JSON:",
    JSON.stringify(payload.recentActions || [], null, 2),
    "",
    "Task memory JSON:",
    JSON.stringify(payload.taskMemory || null, null, 2),
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
  if (process.platform === "win32" && /\.cmd$/i.test(command) && fs.existsSync(command)) {
    return runWindowsCommandFile(command, args, options);
  }

  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: 1024 * 1024 * 12,
    ...options
  });

  if (result.error && process.platform === "win32" && fs.existsSync(command)) {
    return runWindowsCommandFile(command, args, options);
  }

  return result;
}

function runCommandWithActivityTimeout(command, args, options = {}) {
  const {
    input = "",
    idleTimeout = 0,
    abortSignal = null,
    maxBuffer = COMMAND_MAX_BUFFER_BYTES,
    env = {}
  } = options;

  return new Promise((resolve) => {
    let settled = false;
    let exitCode = null;
    let exitSignal = null;
    let timeoutHandle = null;
    let forceKillHandle = null;
    let terminationReason = "";
    let spawned = false;
    let spawnError = null;
    let timeoutError = null;
    let abortedError = null;
    let bufferError = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];

    const child = spawnCommand(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ...env
      }
    });

    const clearTimers = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (forceKillHandle) {
        clearTimeout(forceKillHandle);
        forceKillHandle = null;
      }
    };

    const killChild = () => {
      if (child.exitCode !== null || child.signalCode) {
        return;
      }

      try {
        child.kill();
      } catch {
        // Ignore kill errors while shutting down the child.
      }

      forceKillHandle = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode) {
          return;
        }

        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore SIGKILL fallback failures.
        }
      }, COMMAND_FORCE_KILL_GRACE_MS);
    };

    const resetTimeout = () => {
      if (idleTimeout <= 0 || terminationReason) {
        return;
      }

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      timeoutHandle = setTimeout(() => {
        terminationReason = "timeout";
        timeoutError = Object.assign(
          new Error(`The provider process hit the inactivity timeout after ${idleTimeout}ms without stdout or stderr activity.`),
          { code: "ETIMEDOUT" }
        );
        killChild();
      }, idleTimeout);
    };

    const pushChunk = (targetChunks, text, kind) => {
      const buffer = Buffer.from(text, "utf8");
      if (kind === "stdout") {
        stdoutBytes += buffer.length;
      } else {
        stderrBytes += buffer.length;
      }

      if (stdoutBytes + stderrBytes > maxBuffer) {
        terminationReason = terminationReason || "maxBuffer";
        bufferError = Object.assign(
          new Error(`The provider process exceeded the output buffer limit of ${maxBuffer} bytes.`),
          { code: "ENOBUFS" }
        );
        killChild();
        return;
      }

      targetChunks.push(text);
      resetTimeout();
    };

    const finalize = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();

      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }

      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      const error = bufferError || abortedError || timeoutError || spawnError;

      resolve({
        stdout,
        stderr,
        status: typeof exitCode === "number" ? exitCode : (error ? 1 : 0),
        signal: exitSignal || null,
        error
      });
    };

    const onAbort = () => {
      if (terminationReason) {
        return;
      }

      terminationReason = "aborted";
      abortedError = Object.assign(
        new Error("The provider request was stopped by the user."),
        { code: "ABORT_ERR" }
      );
      killChild();
    };

    child.once("spawn", () => {
      spawned = true;
      resetTimeout();
    });

    child.once("error", (error) => {
      spawnError = error;
      finalize();
    });

    child.stdout?.on("data", (chunk) => {
      pushChunk(stdoutChunks, chunk.toString("utf8"), "stdout");
    });

    child.stderr?.on("data", (chunk) => {
      pushChunk(stderrChunks, chunk.toString("utf8"), "stderr");
    });

    child.once("close", (code, signal) => {
      exitCode = typeof code === "number" ? code : null;
      exitSignal = signal || null;
      finalize();
    });

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    if (!spawned) {
      resetTimeout();
    }

    if (input) {
      child.stdin?.write(input, "utf8");
    }
    child.stdin?.end();
  });
}

function runWindowsCommandFile(command, args, options = {}) {
  const line = ["call", quoteCmdArg(command), ...args.map((arg) => quoteCmdArg(arg))].join(" ");
  return spawnSync("cmd.exe", ["/d", "/c", line], {
    encoding: "utf8",
    shell: false,
    maxBuffer: 1024 * 1024 * 12,
    ...options
  });
}

function spawnCommand(command, args, options = {}) {
  if (process.platform === "win32" && /\.cmd$/i.test(command) && fs.existsSync(command)) {
    const line = ["call", quoteCmdArg(command), ...args.map((arg) => quoteCmdArg(arg))].join(" ");
    return spawn("cmd.exe", ["/d", "/c", line], options);
  }

  return spawn(command, args, options);
}

function quoteShellArg(value) {
  return quoteCmdArg(value);
}

function quoteCmdArg(value) {
  const raw = String(value ?? "");
  if (!/[\s"&|<>^]/.test(raw)) {
    return raw;
  }
  return `"${raw.replace(/"/g, '\\"')}"`;
}

function resolveCodexBin() {
  const explicit = String(process.env.CODEX_BIN || "").trim();
  if (explicit) {
    if (fs.existsSync(explicit)) {
      return explicit;
    }

    if (process.platform !== "win32") {
      return explicit;
    }
  }

  if (process.platform === "win32") {
    const homeDir = process.env.USERPROFILE || os.homedir() || "";
    const directCandidates = [
      path.join(process.env.APPDATA || "", "npm", "codex.cmd"),
      path.join(process.env.APPDATA || "", "npm", "codex.exe"),
      path.join(process.env.LOCALAPPDATA || "", "npm", "codex.cmd"),
      path.join(process.env.LOCALAPPDATA || "", "npm", "codex.exe"),
      path.join(homeDir, "AppData", "Roaming", "npm", "codex.cmd"),
      path.join(homeDir, "AppData", "Roaming", "npm", "codex.exe"),
      path.join(path.dirname(process.execPath || ""), "codex.cmd"),
      path.join(path.dirname(process.execPath || ""), "codex.exe")
    ];

    for (const candidate of directCandidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const searchRoots = [
      path.join(homeDir, ".vscode", "extensions"),
      path.join(homeDir, ".vscode-insiders", "extensions")
    ];

    for (const root of searchRoots) {
      const found = findCodexInVsCodeExtensions(root);
      if (found) return found;
    }

    if (explicit && !/[\\/]/.test(explicit)) {
      const explicitFromPath = resolveWindowsCommandFromPath(explicit);
      if (explicitFromPath) {
        return explicitFromPath;
      }
    }

    const foundOnPath = resolveWindowsCommandFromPath("codex");
    if (foundOnPath) {
      return foundOnPath;
    }

    if (explicit && /[\\/]/.test(explicit)) {
      return explicit;
    }

    return "codex.cmd";
  }

  return "codex";
}

function findCodexInVsCodeExtensions(root) {
  if (!root || !fs.existsSync(root)) {
    return null;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const likelyExtensions = entries
    .filter((entry) => entry.isDirectory() && /openai|chatgpt|codex/i.test(entry.name))
    .map((entry) => path.join(root, entry.name));

  const knownRelativePaths = [
    path.join("bin", "windows-x86_64", "codex.exe"),
    path.join("bin", "windows-x64", "codex.exe"),
    path.join("bin", "win32-x64", "codex.exe"),
    path.join("bin", "codex.exe"),
    "codex.exe",
    "codex.cmd"
  ];

  for (const extensionPath of likelyExtensions) {
    for (const relativePath of knownRelativePaths) {
      const candidate = path.join(extensionPath, relativePath);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  for (const extensionPath of likelyExtensions) {
    for (const fileName of ["codex.exe", "codex.cmd"]) {
      const found = findFile(extensionPath, fileName, 4);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function resolveWindowsCommandFromPath(command) {
  if (process.platform !== "win32" || !command) {
    return "";
  }

  const result = spawnSync("where.exe", [command], {
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  return String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function resolveNpmBin() {
  const executableDir = path.dirname(process.execPath || "");

  if (process.platform !== "win32") {
    const localNpm = path.join(executableDir, "npm");
    return fs.existsSync(localNpm) ? localNpm : "npm";
  }

  const candidates = [
    path.join(executableDir, "npm.cmd"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "npm.cmd"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "npm.cmd"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "npm.cmd"),
    path.join(process.env.APPDATA || "", "npm", "npm.cmd")
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const whereResult = spawnSync("where.exe", ["npm.cmd"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  const found = String(whereResult.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);

  return found || "npm.cmd";
}

function resolveNpmCliPath() {
  const npmDir = path.dirname(npmBin || "");
  const candidates = [
    path.join(npmDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath || ""), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node_modules", "npm", "bin", "npm-cli.js")
  ];

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

function resolveProviderCliBin(commandName) {
  if (process.platform !== "win32") {
    return commandName;
  }

  const fileName = `${commandName}.cmd`;
  const candidates = [
    path.join(process.env.APPDATA || "", "npm", fileName),
    path.join(process.env.LOCALAPPDATA || "", "npm", fileName),
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming", "npm", fileName),
    path.join(path.dirname(process.execPath || ""), fileName),
    fileName
  ];

  for (const candidate of candidates) {
    if (candidate && candidate !== fileName && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const whereResult = spawnSync("where.exe", [fileName], {
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  const found = String(whereResult.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);

  return found || fileName;
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

function getDevWatchStatus() {
  const entries = [];
  const roots = [
    "manifest.json",
    "package.json",
    "src",
    "codex"
  ];

  roots.forEach((relativePath) => {
    const fullPath = path.join(projectRoot, relativePath);
    collectDevWatchEntries(fullPath, relativePath, entries);
  });

  const fingerprintSource = entries
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((entry) => `${entry.relativePath}|${entry.size}|${entry.mtimeMs}`)
    .join("\n");
  const fingerprint = crypto.createHash("sha1").update(fingerprintSource).digest("hex");
  const changedAt = entries.reduce((latest, entry) => Math.max(latest, entry.mtimeMs), 0);

  return {
    type: "dev_watch_status",
    enabled: true,
    fingerprint,
    changedAt: changedAt ? new Date(changedAt).toISOString() : "",
    message: "Dev watch fingerprint ready."
  };
}

function collectDevWatchEntries(fullPath, relativePath, entries) {
  if (!fs.existsSync(fullPath)) {
    return;
  }

  let stats;
  try {
    stats = fs.statSync(fullPath);
  } catch {
    return;
  }

  if (stats.isDirectory()) {
    let children = [];
    try {
      children = fs.readdirSync(fullPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const child of children) {
      if (shouldSkipDevWatchPath(child.name)) {
        continue;
      }

      collectDevWatchEntries(
        path.join(fullPath, child.name),
        `${relativePath}/${child.name}`,
        entries
      );
    }
    return;
  }

  entries.push({
    relativePath: relativePath.replace(/\\/g, "/"),
    size: stats.size || 0,
    mtimeMs: Math.round(stats.mtimeMs || 0)
  });
}

function shouldSkipDevWatchPath(name) {
  return [
    ".git",
    "node_modules",
    ".DS_Store"
  ].includes(String(name || ""));
}

function writeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([length, payload]));
}

function writeResponse(requestId, message) {
  if (!requestId) {
    writeMessage(message);
    return;
  }

  writeMessage({
    requestId,
    ...message
  });
}

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tryParseJson(text) {
  const source = String(text || "").trim();
  if (!source) {
    return null;
  }

  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function summarizeCodexFailure(result) {
  const combined = compact(`${result.error?.message || ""} ${result.stderr || ""} ${result.stdout || ""}`);
  const schemaMessage = combined.match(/Invalid schema[^"]*|invalid_json_schema[^"]*/i)?.[0];

  if (schemaMessage) {
    return `Codex rejected the response schema: ${schemaMessage}`;
  }

  if (isUsageLimitReachedText(combined)) {
    return buildUsageLimitMessage({ label: "Codex" }, combined);
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
