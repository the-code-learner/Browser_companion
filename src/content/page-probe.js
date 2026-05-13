(() => {
  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[contenteditable='true']"
  ].join(",");
  const HEADING_SELECTOR = "h1,h2,h3,[role='heading']";
  const MAX_VISIBLE_TEXT = 12000;
  const MAX_HEADINGS = 60;
  const MAX_LINKS = 80;
  const MAX_BUTTONS = 80;
  const MAX_INTERACTIVE = 160;
  const MAX_FORMS = 20;
  const MAX_SECTIONS = 12;
  const MAX_STRUCTURED_ITEMS = 36;
  const MAX_CONTENT_BLOCKS = 48;
  const NAVIGATION_LABEL_RE = /\b(home|career guide|podcast|videos|job board|resources|faq|feedback|search jobs|recommended jobs|collections|about|meet people|new releases|all articles|subscribe|set up alerts|ranked|open menu|menu|login|sign in|sign up)\b/i;

  const headingEntries = collectHeadings();
  const linkEntries = collectLinks(headingEntries);
  const buttonEntries = collectButtons(headingEntries);
  const interactiveEntries = collectInteractiveElements(headingEntries);
  const forms = getForms();
  const visibleText = getVisibleText();
  const structuredItems = buildStructuredItems(linkEntries, buttonEntries, interactiveEntries, headingEntries);
  const pageOutline = buildPageOutline(visibleText, headingEntries, structuredItems, forms, linkEntries, buttonEntries);
  const contentBlocks = buildContentBlocks(visibleText, pageOutline, structuredItems);

  return {
    viewport: getViewport(),
    visibleText,
    headings: headingEntries.map((entry) => entry.model),
    links: linkEntries.map((entry) => entry.model),
    buttons: buttonEntries.map((entry) => entry.model),
    forms,
    interactiveElements: interactiveEntries.map((entry) => entry.model),
    pageOutline,
    structuredItems,
    contentBlocks
  };

  function getViewport() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      devicePixelRatio: window.devicePixelRatio
    };
  }

  function getVisibleText() {
    return compactText(document.body?.innerText || "").slice(0, MAX_VISIBLE_TEXT);
  }

  function collectHeadings() {
    return Array.from(document.querySelectorAll(HEADING_SELECTOR))
      .filter(isVisible)
      .slice(0, MAX_HEADINGS)
      .map((element, index) => ({
        element,
        model: {
          agent_id: `heading_${index + 1}`,
          role: element.getAttribute("role") || "",
          level: element.getAttribute("aria-level") || element.tagName.replace(/\D/g, "") || undefined,
          name: compactText(element.innerText).slice(0, 180),
          text: compactText(element.innerText),
          href: "",
          selector_candidates: [],
          bbox: getBox(element)
        }
      }));
  }

  function collectLinks(headingEntries) {
    return Array.from(document.querySelectorAll("a[href]"))
      .filter(isVisible)
      .slice(0, MAX_LINKS)
      .map((element, index) => buildInteractiveEntry(element, "link", index, headingEntries));
  }

  function collectButtons(headingEntries) {
    return Array.from(document.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit']"))
      .filter(isVisible)
      .slice(0, MAX_BUTTONS)
      .map((element, index) => buildInteractiveEntry(element, "button", index, headingEntries));
  }

  function collectInteractiveElements(headingEntries) {
    return Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))
      .filter(isVisible)
      .slice(0, MAX_INTERACTIVE)
      .map((element, index) => buildInteractiveEntry(element, "el", index, headingEntries));
  }

  function buildInteractiveEntry(element, prefix, index, headingEntries) {
    const role = prefix === "link" ? "link" : (prefix === "button" ? "button" : inferRole(element));
    const box = getBox(element);
    const nearestHeading = findNearestHeading(box, headingEntries);
    const destinationUrl = extractDestinationUrl(element);
    const textLines = getElementTextLines(element);
    const accessibleName = getAccessibleName(element);
    const nearbyText = compactText(getNearbyText(element)).slice(0, 320);
    const model = {
      agent_id: ensureAgentId(element, prefix, index),
      role,
      tag: element.tagName.toLowerCase(),
      name: accessibleName,
      text: textLines.join(" ").slice(0, 320),
      href: role === "link" ? (destinationUrl || element.href || "") : "",
      destination_url: destinationUrl,
      selector_candidates: getSelectorCandidates(element),
      bbox: box,
      nearest_heading: nearestHeading
        ? {
            agent_id: nearestHeading.agent_id,
            name: nearestHeading.name || nearestHeading.text || "",
            level: nearestHeading.level || ""
          }
        : null,
      text_lines: textLines.slice(0, 8),
      nearby_text: nearbyText
    };

    if (prefix !== "el") {
      model.type = element.getAttribute("type") || element.tagName.toLowerCase();
    }

    return { element, model };
  }

  function getForms() {
    const forms = Array.from(document.querySelectorAll("form"));
    const formLikeFields = Array.from(document.querySelectorAll("input,select,textarea,[contenteditable='true']"));

    if (forms.length === 0 && formLikeFields.length > 0) {
      return [buildFormModel(document.body, "form_1", formLikeFields)];
    }

    return forms.slice(0, MAX_FORMS).map((form, index) => {
      const fields = Array.from(form.querySelectorAll("input,select,textarea,[contenteditable='true']"));
      return buildFormModel(form, `form_${index + 1}`, fields);
    });
  }

  function buildFormModel(container, agentId, fields) {
    return {
      agent_id: agentId,
      title: inferSectionTitle(container),
      fields: fields.filter(isVisible).slice(0, 120).map((field, index) => ({
        agent_id: ensureAgentId(field, `${agentId}_field`, index),
        tag: field.tagName.toLowerCase(),
        type: field.getAttribute("type") || field.getAttribute("role") || field.tagName.toLowerCase(),
        role: inferRole(field),
        name: getAccessibleName(field),
        required: Boolean(field.required || field.getAttribute("aria-required") === "true"),
        disabled: Boolean(field.disabled || field.getAttribute("aria-disabled") === "true"),
        value: getFieldValue(field),
        options: getOptions(field),
        selector_candidates: getSelectorCandidates(field),
        bbox: getBox(field),
        nearby_text: compactText(getNearbyText(field)).slice(0, 240)
      }))
    };
  }

  function buildStructuredItems(linkEntries, buttonEntries, interactiveEntries, headingEntries) {
    const rawCandidates = dedupeEntriesByAgentId([
      ...linkEntries,
      ...buttonEntries,
      ...interactiveEntries.filter((entry) => entry.model.role === "link" || entry.model.role === "button")
    ]);
    const seen = new Set();
    const items = [];

    for (const entry of rawCandidates) {
      if (!shouldTreatAsStructuredItem(entry.model)) {
        continue;
      }

      const item = buildStructuredItem(entry, headingEntries);
      if (!item) {
        continue;
      }

      const key = [
        normalizeTokenKey(item.title || ""),
        normalizeTokenKey(item.destination_url || ""),
        item.agent_id
      ].join("|");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push(item);
    }

    return items.slice(0, MAX_STRUCTURED_ITEMS);
  }

  function buildStructuredItem(entry, headingEntries) {
    const element = entry.element;
    const model = entry.model;
    const textLines = model.text_lines?.length ? model.text_lines : getElementTextLines(element);
    const title = inferItemTitle(textLines, model.name || "");
    const metadata = inferItemMetadata(textLines, title, model.name || "");
    const box = model.bbox || getBox(element);
    const nearestHeading = findNearestHeading(box, headingEntries);
    const preview = compactText(textLines.join(" ").trim() || model.nearby_text || model.name || "").slice(0, 400);

    if (!title || title.length < 8) {
      return null;
    }

    return {
      item_id: `item_${model.agent_id}`,
      agent_id: model.agent_id,
      role: model.role,
      title: title.slice(0, 200),
      label: model.name || title,
      metadata: metadata.slice(0, 240),
      text_preview: preview,
      destination_url: model.destination_url || model.href || "",
      href: model.href || "",
      section_id: nearestHeading ? `section_${nearestHeading.agent_id}` : "section_root",
      section_title: nearestHeading?.name || nearestHeading?.text || document.title || "Current page",
      selector_candidates: model.selector_candidates || [],
      source_agent_ids: [model.agent_id],
      bbox: box
    };
  }

  function buildPageOutline(visibleText, headingEntries, structuredItems, forms, linkEntries, buttonEntries) {
    const pageType = inferPageType(visibleText, structuredItems, forms, linkEntries, buttonEntries);
    const sections = buildSections(visibleText, headingEntries, structuredItems);
    const repeatedItemSummary = summarizeRepeatedItems(structuredItems);

    return {
      page_type: pageType,
      sections: sections.slice(0, MAX_SECTIONS),
      repeated_item_summary: repeatedItemSummary,
      counts: {
        headings: headingEntries.length,
        structured_items: structuredItems.length,
        forms: forms.length,
        links: linkEntries.length,
        buttons: buttonEntries.length
      }
    };
  }

  function buildSections(visibleText, headingEntries, structuredItems) {
    if (!headingEntries.length) {
      return [{
        section_id: "section_root",
        title: document.title || "Current page",
        preview: visibleText.slice(0, 280),
        item_count: structuredItems.length
      }];
    }

    const sections = headingEntries.map((entry) => {
      const sectionId = `section_${entry.model.agent_id}`;
      return {
        section_id: sectionId,
        title: entry.model.name || entry.model.text || "Section",
        preview: getSectionPreview(entry.element),
        item_count: structuredItems.filter((item) => item.section_id === sectionId).length,
        level: entry.model.level || ""
      };
    });

    return sections.filter((section) => section.title || section.preview);
  }

  function buildContentBlocks(visibleText, pageOutline, structuredItems) {
    const blocks = [];

    for (const section of pageOutline.sections || []) {
      if (!section.preview) continue;
      blocks.push({
        block_id: `block_${section.section_id}`,
        kind: "section",
        section_id: section.section_id,
        section_title: section.title || "",
        title: section.title || "",
        text: section.preview
      });
    }

    for (const item of structuredItems) {
      blocks.push({
        block_id: `block_${item.item_id}`,
        kind: "item",
        section_id: item.section_id,
        section_title: item.section_title || "",
        item_id: item.item_id,
        title: item.title || "",
        text: [item.title, item.metadata, item.text_preview].filter(Boolean).join(" | "),
        destination_url: item.destination_url || ""
      });
    }

    if (!blocks.length && visibleText) {
      blocks.push({
        block_id: "block_root_text",
        kind: "section",
        section_id: "section_root",
        section_title: document.title || "Current page",
        title: document.title || "Current page",
        text: visibleText.slice(0, 480)
      });
    }

    return blocks.slice(0, MAX_CONTENT_BLOCKS);
  }

  function inferPageType(visibleText, structuredItems, forms, linkEntries, buttonEntries) {
    const formFieldCount = forms.reduce((total, form) => total + (form.fields?.length || 0), 0);
    const itemCount = structuredItems.length;
    const controlCount = linkEntries.length + buttonEntries.length;

    if (itemCount >= 4) {
      return "listing";
    }
    if (formFieldCount >= 8) {
      return "form";
    }
    if (controlCount >= 70 && itemCount >= 2) {
      return "directory";
    }
    if (visibleText.length >= 2500 && (document.querySelectorAll("article,p").length >= 8)) {
      return "article";
    }
    return "general";
  }

  function summarizeRepeatedItems(structuredItems) {
    if (!structuredItems.length) {
      return "";
    }

    const sectionCounts = new Map();
    for (const item of structuredItems) {
      const key = item.section_title || "Current page";
      sectionCounts.set(key, (sectionCounts.get(key) || 0) + 1);
    }

    return [...sectionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([title, count]) => `${title}: ${count} item${count === 1 ? "" : "s"}`)
      .join("; ");
  }

  function shouldTreatAsStructuredItem(model) {
    const name = String(model?.name || "").trim();
    const text = String(model?.text || "").trim();
    const combined = `${name} ${text}`.trim();

    if (!combined || combined.length < 18) {
      return false;
    }

    if (model.role !== "button" && model.role !== "link") {
      return false;
    }

    if (NAVIGATION_LABEL_RE.test(combined)) {
      return false;
    }

    const wordCount = compactText(combined).split(" ").filter(Boolean).length;
    return wordCount >= 4;
  }

  function findNearestHeading(box, headingEntries) {
    if (!headingEntries.length) {
      return null;
    }

    const centerY = Number(box?.y || 0) + Number(box?.h || 0) / 2;
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const entry of headingEntries) {
      const headingBox = entry.model.bbox || { y: 0, h: 0 };
      const headingCenterY = Number(headingBox.y || 0) + Number(headingBox.h || 0) / 2;
      const verticalPenalty = headingCenterY > centerY ? 400 : 0;
      const distance = Math.abs(centerY - headingCenterY) + verticalPenalty;
      if (distance < bestScore) {
        bestScore = distance;
        best = entry.model;
      }
    }

    return best;
  }

  function inferRole(element) {
    if (element.getAttribute("role")) {
      return element.getAttribute("role");
    }

    if (element.matches("a[href]")) {
      return "link";
    }

    if (element.matches("select")) {
      return "combobox";
    }

    if (element.matches("textarea,[contenteditable='true']")) {
      return "textbox";
    }

    const type = element.getAttribute("type") || "text";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button") return "button";
    return "textbox";
  }

  function getAccessibleName(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || "")
        .join(" ");
      if (compactText(label)) return compactText(label);
    }

    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return compactText(ariaLabel);

    if (element.id) {
      const label = document.querySelector(`label[for='${cssEscape(element.id)}']`);
      if (label?.innerText) return compactText(label.innerText);
    }

    const wrappingLabel = element.closest("label");
    if (wrappingLabel?.innerText) return compactText(wrappingLabel.innerText);

    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return compactText(placeholder);

    const title = element.getAttribute("title");
    if (title) return compactText(title);

    return compactText(getElementRawText(element) || element.value || element.name || element.id || "").slice(0, 220);
  }

  function getElementTextLines(element) {
    const raw = getElementRawText(element);
    if (!raw) {
      return [];
    }

    return raw
      .split(/\r?\n+/)
      .map((line) => compactText(line))
      .filter(Boolean)
      .filter((line, index, array) => array.indexOf(line) === index)
      .slice(0, 10);
  }

  function getElementRawText(element) {
    if (!element) {
      return "";
    }

    const text = typeof element.innerText === "string" && element.innerText.trim()
      ? element.innerText
      : (typeof element.textContent === "string" ? element.textContent : "");
    return String(text || "");
  }

  function inferItemTitle(lines, fallbackName) {
    const firstUseful = lines.find((line) => !NAVIGATION_LABEL_RE.test(line) && line.length >= 8);
    return compactText(firstUseful || fallbackName || "");
  }

  function inferItemMetadata(lines, title, fallbackName) {
    const filtered = lines.filter((line) => compactText(line) && compactText(line) !== compactText(title));
    if (filtered.length) {
      return compactText(filtered.slice(0, 3).join(" | "));
    }

    const fallback = compactText(fallbackName || "").replace(new RegExp(`^${escapeRegExp(title)}\\s*`, "i"), "");
    return fallback.slice(0, 240);
  }

  function getFieldValue(element) {
    if (element.matches("[contenteditable='true']")) {
      return element.innerText || "";
    }

    if (element.type === "password") {
      return "";
    }

    if (element.type === "checkbox" || element.type === "radio") {
      return Boolean(element.checked);
    }

    return element.value || "";
  }

  function getOptions(element) {
    if (!element.matches("select")) {
      return undefined;
    }

    return Array.from(element.options).map((option) => ({
      label: compactText(option.text),
      value: option.value,
      selected: option.selected
    }));
  }

  function getSelectorCandidates(element) {
    const selectors = [];

    if (element.id) selectors.push(`#${cssEscape(element.id)}`);
    if (element.dataset.browserCompanionId) {
      selectors.push(`[data-browser-companion-id='${cssEscape(element.dataset.browserCompanionId)}']`);
    }
    if (element.name) selectors.push(`${element.tagName.toLowerCase()}[name='${cssEscape(element.name)}']`);
    if (element.getAttribute("aria-label")) {
      selectors.push(`${element.tagName.toLowerCase()}[aria-label='${cssEscape(element.getAttribute("aria-label"))}']`);
    }

    return selectors.slice(0, 3);
  }

  function ensureAgentId(element, prefix, index) {
    if (!element.dataset.browserCompanionId) {
      element.dataset.browserCompanionId = `${prefix}_${index + 1}`;
    }

    return element.dataset.browserCompanionId;
  }

  function getBox(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    };
  }

  function getNearbyText(element) {
    const parent = element.closest("label,fieldset,section,article,main,form,li,div") || element.parentElement;
    return parent?.innerText || "";
  }

  function getSectionPreview(element) {
    const container = element.closest("section,article,main,li,div") || element.parentElement || element;
    const raw = getElementRawText(container);
    const lines = raw
      .split(/\r?\n+/)
      .map((line) => compactText(line))
      .filter(Boolean);
    const preview = lines.slice(0, 5).join(" ").trim();
    return preview.slice(0, 280);
  }

  function inferSectionTitle(element) {
    const heading = element.querySelector?.(`${HEADING_SELECTOR},legend`);
    if (heading?.innerText) return compactText(heading.innerText).slice(0, 160);
    return document.title || "Current page form";
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== "hidden"
      && style.display !== "none";
  }

  function dedupeEntriesByAgentId(entries) {
    const seen = new Set();
    const output = [];
    for (const entry of entries) {
      const id = entry?.model?.agent_id;
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      output.push(entry);
    }
    return output;
  }

  function extractDestinationUrl(element) {
    const directLink = element.matches("a[href]") ? element : null;
    if (directLink?.href) {
      return normalizePossibleUrl(directLink.href);
    }

    const ancestorLink = element.closest("a[href]");
    if (ancestorLink?.href) {
      return normalizePossibleUrl(ancestorLink.href);
    }

    const descendantLink = element.querySelector?.("a[href]");
    if (descendantLink?.href) {
      return normalizePossibleUrl(descendantLink.href);
    }

    const attrCandidate = extractAttributeUrlCandidate(element);
    if (attrCandidate) {
      return attrCandidate;
    }

    const onclickCandidate = extractOnclickUrlCandidate(element);
    if (onclickCandidate) {
      return onclickCandidate;
    }

    return "";
  }

  function extractAttributeUrlCandidate(element) {
    const inspected = [element, element.parentElement, element.closest("[data-href],[data-url],[routerlink],[to]")].filter(Boolean);
    const attributeNames = [
      "href",
      "data-href",
      "data-url",
      "data-link",
      "data-destination",
      "data-path",
      "data-url-path",
      "routerlink",
      "to"
    ];

    for (const node of inspected) {
      for (const attributeName of attributeNames) {
        const value = node.getAttribute?.(attributeName);
        const normalized = normalizePossibleUrl(value);
        if (normalized) {
          return normalized;
        }
      }

      for (const [key, value] of Object.entries(node.dataset || {})) {
        if (!/(href|url|link|path|destination|slug)/i.test(key)) {
          continue;
        }
        const normalized = normalizePossibleUrl(value);
        if (normalized) {
          return normalized;
        }
      }
    }

    return "";
  }

  function extractOnclickUrlCandidate(element) {
    const nodes = [element, element.parentElement].filter(Boolean);
    const patterns = [
      /window\.open\(\s*['"]([^'"]+)['"]/i,
      /location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i,
      /navigate\(\s*['"]([^'"]+)['"]/i,
      /pushState\([^)]*['"]([^'"]+)['"]\s*\)/i
    ];

    for (const node of nodes) {
      const onclick = node.getAttribute?.("onclick") || "";
      for (const pattern of patterns) {
        const match = onclick.match(pattern);
        const normalized = normalizePossibleUrl(match?.[1] || "");
        if (normalized) {
          return normalized;
        }
      }
    }

    return "";
  }

  function normalizePossibleUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || raw === "#" || /^javascript:/i.test(raw)) {
      return "";
    }

    try {
      const parsed = new URL(raw, window.location.href);
      if (!/^https?:$/i.test(parsed.protocol)) {
        return "";
      }
      return parsed.href;
    } catch {
      return "";
    }
  }

  function compactText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function normalizeTokenKey(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function cssEscape(value) {
    if (window.CSS?.escape) {
      return window.CSS.escape(value);
    }

    return String(value).replace(/'/g, "\\'");
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
})();
