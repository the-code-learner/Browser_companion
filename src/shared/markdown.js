export function renderRichText(text, options = {}) {
  const raw = String(text || "");

  if (options.allowMermaid) {
    const parts = raw.split(/```mermaid\s*([\s\S]*?)```/i);
    let html = "";
    for (let index = 0; index < parts.length; index += 1) {
      if (index % 2 === 1) {
        html += renderMermaidBlock(parts[index]);
      } else {
        html += renderMarkdown(parts[index], options);
      }
    }
    return html || "<p></p>";
  }

  return renderMarkdown(raw, options) || "<p></p>";
}

export function renderMarkdown(text, options = {}) {
  const normalized = normalizeMarkdownInput(text);
  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const language = trimmed.replace(/^```/, "").trim();
      const block = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        block.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      html.push(`<pre><code${language ? ` data-language="${escapeAttribute(language)}"` : ""}>${escapeHtml(block.join("\n"))}</code></pre>`);
      continue;
    }

    if (isTableStart(lines, index)) {
      const { nextIndex, html: tableHtml } = renderTable(lines, index);
      html.push(tableHtml);
      index = nextIndex;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length + Number(options.headingOffset ?? 2), 6);
      html.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoted = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoted.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${renderMarkdown(quoted.join("\n"), options)}</blockquote>`);
      continue;
    }

    if (/^(?:[-*+])\s+/.test(trimmed)) {
      const { nextIndex, html: listHtml } = renderList(lines, index, false);
      html.push(listHtml);
      index = nextIndex;
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const { nextIndex, html: listHtml } = renderList(lines, index, true);
      html.push(listHtml);
      index = nextIndex;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      html.push("<hr>");
      index += 1;
      continue;
    }

    const paragraph = [];
    while (index < lines.length) {
      const candidate = lines[index];
      const candidateTrimmed = candidate.trim();
      if (!candidateTrimmed) {
        break;
      }
      if (
        /^```/.test(candidateTrimmed)
        || /^(#{1,6})\s+/.test(candidateTrimmed)
        || /^>\s?/.test(candidateTrimmed)
        || /^(?:[-*+])\s+/.test(candidateTrimmed)
        || /^\d+\.\s+/.test(candidateTrimmed)
        || /^(?:-{3,}|\*{3,}|_{3,})$/.test(candidateTrimmed)
        || isTableStart(lines, index)
      ) {
        break;
      }
      paragraph.push(candidateTrimmed);
      index += 1;
    }

    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return html.join("");
}

export function normalizeMarkdownInput(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/([.!?])\s+(#{1,6}\s+)/g, "$1\n\n$2")
    .replace(/([.!?])\s+((?:\d{1,3}\.)\s+)/g, "$1\n\n$2")
    .replace(/([.!?])\s+((?:[-*+])\s+)/g, "$1\n$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderList(lines, startIndex, ordered) {
  const pattern = ordered ? /^\d+\.\s+/ : /^(?:[-*+])\s+/;
  const tag = ordered ? "ol" : "ul";
  const items = [];
  let index = startIndex;

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!pattern.test(trimmed)) {
      break;
    }

    const itemLines = [trimmed.replace(pattern, "")];
    index += 1;

    while (index < lines.length) {
      const continuation = lines[index];
      const continuationTrimmed = continuation.trim();
      if (!continuationTrimmed) {
        break;
      }
      if (
        pattern.test(continuationTrimmed)
        || (!ordered && /^(?:[-*+])\s+/.test(continuationTrimmed))
        || (ordered && /^\d+\.\s+/.test(continuationTrimmed))
        || /^(#{1,6})\s+/.test(continuationTrimmed)
        || /^```/.test(continuationTrimmed)
        || /^>\s?/.test(continuationTrimmed)
        || isLikelyTableLine(continuationTrimmed)
      ) {
        break;
      }
      itemLines.push(continuationTrimmed);
      index += 1;
    }

    items.push(`<li>${renderInlineMarkdown(itemLines.join(" "))}</li>`);

    while (index < lines.length && !lines[index].trim()) {
      index += 1;
      break;
    }
  }

  return {
    nextIndex: index,
    html: `<${tag}>${items.join("")}</${tag}>`
  };
}

function renderTable(lines, startIndex) {
  const headerCells = splitTableRow(lines[startIndex]);
  let index = startIndex + 2;
  const rows = [];

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed || !isLikelyTableLine(trimmed) || isTableDivider(trimmed)) {
      break;
    }
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }

  const headHtml = `<thead><tr>${headerCells.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
  const bodyHtml = rows.length
    ? `<tbody>${rows.map((row) => `<tr>${headerCells.map((_, columnIndex) => `<td>${renderInlineMarkdown(row[columnIndex] || "")}</td>`).join("")}</tr>`).join("")}</tbody>`
    : "";

  return {
    nextIndex: index,
    html: `<div class="markdown-table-wrap"><table class="markdown-table">${headHtml}${bodyHtml}</table></div>`
  };
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(String(text || ""));
  const tokens = [];
  const stash = (value) => {
    const token = `\u0000${tokens.length}\u0000`;
    tokens.push(value);
    return token;
  };

  html = html.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${code}</code>`));
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => (
    stash(`<a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">${label}</a>`)
  ));
  html = html.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(>])\*([^*\n]+?)\*(?=[$\s).,:;!?<])/g, "$1<em>$2</em>");
  html = html.replace(/(^|[\s(>])_([^_\n]+?)_(?=[$\s).,:;!?<])/g, "$1<em>$2</em>");

  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || "");
}

function isTableStart(lines, index) {
  return isLikelyTableLine(lines[index]?.trim() || "") && isTableDivider(lines[index + 1]?.trim() || "");
}

function isLikelyTableLine(line) {
  return /\|/.test(line) && !/^```/.test(line);
}

function isTableDivider(line) {
  return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line);
}

function splitTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderMermaidBlock(source) {
  const diagram = encodeURIComponent(String(source || "").trim());
  return `
    <figure class="mermaid-block">
      <img alt="Mermaid diagram" src="https://mermaid.ink/svg/${diagram}">
      <figcaption>Mermaid diagram</figcaption>
    </figure>
  `;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(text) {
  return escapeHtml(text).replace(/`/g, "&#96;");
}
