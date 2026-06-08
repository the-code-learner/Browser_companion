export const EXTERNAL_DEBUG_LOGS_KEY = "browserCompanionExternalDebugLogs";
export const DEBUG_LOG_LIMIT = 200;

export function normalizeDebugLogs(entries = []) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.slice(0, DEBUG_LOG_LIMIT).map((entry, index) => ({
    id: String(entry?.id || `debug-${index + 1}`),
    time: normalizeIsoString(entry?.time),
    event: String(entry?.event || "event"),
    summary: String(entry?.summary || "").trim(),
    data: sanitizeDebugData(entry?.data || {})
  }));
}

export function mergeDebugLogs(...groups) {
  const seen = new Set();
  const merged = groups
    .flatMap((group) => normalizeDebugLogs(group))
    .filter((entry) => {
      const key = `${entry.id}|${entry.time}|${entry.event}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => new Date(right.time || 0).getTime() - new Date(left.time || 0).getTime());

  return merged.slice(0, DEBUG_LOG_LIMIT * 2);
}

export async function appendExternalDebugLog(event, data = {}, summary = "") {
  if (!chrome?.storage?.local) {
    return [];
  }

  const stored = await chrome.storage.local.get([EXTERNAL_DEBUG_LOGS_KEY]);
  const logs = normalizeDebugLogs(stored[EXTERNAL_DEBUG_LOGS_KEY] || []);
  logs.unshift(createDebugLogEntry(event, data, summary));
  const nextLogs = logs.slice(0, DEBUG_LOG_LIMIT);
  await chrome.storage.local.set({
    [EXTERNAL_DEBUG_LOGS_KEY]: nextLogs
  });
  return nextLogs;
}

export async function clearExternalDebugLogs() {
  if (!chrome?.storage?.local) {
    return;
  }
  await chrome.storage.local.set({
    [EXTERNAL_DEBUG_LOGS_KEY]: []
  });
}

function createDebugLogEntry(event, data = {}, summary = "") {
  return {
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    event: String(event || "event"),
    summary: String(summary || "").trim(),
    data: sanitizeDebugData(data)
  };
}

function normalizeIsoString(value) {
  const parsed = new Date(value || "");
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function sanitizeDebugData(value, depth = 0) {
  if (depth > 6) return "[depth limit]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactSensitiveText(value).slice(0, 8000);
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => sanitizeDebugData(item, depth + 1));
  if (typeof value !== "object") return String(value);

  const objectKeys = Object.keys(value);
  const looksLikeAttachment = objectKeys.includes("status")
    && objectKeys.includes("type")
    && (objectKeys.includes("text") || objectKeys.includes("textPreview") || objectKeys.includes("name"));

  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/password|authorization|token|secret|cookie|credential|username/i.test(key)) {
      return [key, "[redacted]"];
    }

    if (/reasoning/i.test(key)) {
      return [key, "[omitted provider reasoning]"];
    }

    if (looksLikeAttachment && key === "name") {
      return [key, "[attachment name redacted]"];
    }

    if (/baseUrl|codexPath|command|path/i.test(key) && typeof item === "string") {
      return [key, redactLocalAndPrivateUrls(item)];
    }

    if (/goal|memoryRequest|requestedScope|summary_for_user|question|reason|value/i.test(key) && typeof item === "string") {
      const redacted = redactSensitiveText(item);
      return [key, redacted.length > 240 ? `[omitted ${item.length} chars]` : redacted];
    }

    if (/text|content|body|visible_text|bodyPreview|textPreview|prompt|raw/i.test(key) && typeof item === "string") {
      return [key, `[omitted ${item.length} chars]`];
    }

    return [key, sanitizeDebugData(item, depth + 1)];
  }));
}

function redactSensitiveText(text) {
  return String(text || "")
    .replace(/[A-Za-z]:\\(?:Users\\[^\\\s]+|Desktop|Documents|Downloads|Desktop\\Projects)[^\n\r"]*/gi, "[local path]")
    .replace(/https?:\/\/(?:llm\.)?[^/\s"]+/gi, "[url]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:\+?\d[\d .()-]{7,}\d)\b/g, "[phone]");
}

function redactLocalAndPrivateUrls(text) {
  return redactSensitiveText(text)
    .replace(/\\[^\\\s"]+/g, "\\...")
    .slice(0, 240);
}
