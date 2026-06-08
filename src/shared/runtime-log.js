export function prefixUserMessageWithTimestamp(text, createdAt = Date.now(), options = {}) {
  const body = String(text || "").trim();
  if (!body) {
    return "";
  }

  const prefix = formatUserMessageTimestamp(createdAt, options);
  if (!prefix) {
    return body;
  }

  if (body.startsWith(prefix)) {
    return body;
  }

  return `${prefix} ${body}`;
}

export function formatUserMessageTimestamp(value = Date.now(), options = {}) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  const timeZone = options.timeZone
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || "UTC";
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(parsed).map((part) => [part.type, part.value]));
  const stamp = `${parts.year || "0000"}-${parts.month || "00"}-${parts.day || "00"} ${parts.hour || "00"}:${parts.minute || "00"}:${parts.second || "00"}`;
  return `[${stamp} ${timeZone}]`;
}
