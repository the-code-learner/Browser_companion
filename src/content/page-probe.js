(() => {
  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "[tabindex]:not([tabindex='-1'])",
    "[role='button']",
    "[role='link']",
    "[role='combobox']",
    "[role='searchbox']",
    "[role='textbox']",
    "[aria-haspopup='listbox']",
    "[contenteditable='true']"
  ].join(",");
  const FIELD_SELECTOR = [
    "input",
    "select",
    "textarea",
    "[contenteditable='true']",
    "[tabindex]:not([tabindex='-1'])",
    "[role='textbox']",
    "[role='searchbox']",
    "[role='combobox']",
    "button[aria-haspopup]",
    "button[aria-controls]",
    "[aria-controls][role='button']"
  ].join(",");
  const HEADING_SELECTOR = "h1,h2,h3,[role='heading']";
  const MAX_VISIBLE_TEXT = 30000;
  const MAX_HEADINGS = 60;
  const MAX_LINKS = 200;
  const MAX_BUTTONS = 200;
  const MAX_INTERACTIVE = 400;
  const MAX_FORMS = 20;
  const MAX_FORM_FIELDS = 120;
  const MAX_SECTIONS = 12;
  const MAX_STRUCTURED_ITEMS = 36;
  const MAX_CONTENT_BLOCKS = 48;
  const NAVIGATION_LABEL_RE = /\b(home|career guide|podcast|videos|job board|resources|faq|feedback|search jobs|recommended jobs|collections|about|meet people|new releases|all articles|subscribe|set up alerts|ranked|open menu|menu|login|sign in|sign up)\b/i;
  const assignedAgentIds = new Set();
  const elementAgentIds = new WeakMap();

  const rawVisibleText = compactText(document.body?.innerText || "");
  const headingElements = getVisibleElements(HEADING_SELECTOR);
  const linkElements = getVisibleElements("a[href]");
  const buttonElements = getVisibleElements("button,[role='button'],input[type='button'],input[type='submit']");
  const interactiveElementsRaw = getVisibleElements(INTERACTIVE_SELECTOR);
  const formElements = Array.from(document.querySelectorAll("form"));
  const formLikeFields = Array.from(document.querySelectorAll(FIELD_SELECTOR)).filter(isFormFieldElement);
  const headingEntries = collectHeadings(headingElements);
  const linkEntries = collectLinks(linkElements, headingEntries);
  const buttonEntries = collectButtons(buttonElements, headingEntries);
  const interactiveEntries = collectInteractiveElements(interactiveElementsRaw, headingEntries);
  const forms = getForms(formElements, formLikeFields);
  const visibleText = getVisibleText(rawVisibleText);
  const structuredItems = buildStructuredItems(linkEntries, buttonEntries, interactiveEntries, headingEntries);
  const pageOutline = buildPageOutline(visibleText, headingEntries, structuredItems, forms, linkEntries, buttonEntries);
  const contentBlocks = buildContentBlocks(visibleText, pageOutline, structuredItems, forms);
  const captureMeta = buildCaptureMeta({
    rawVisibleText,
    headingElements,
    linkElements,
    buttonElements,
    interactiveElementsRaw,
    formElements,
    formLikeFields
  });

  return {
    viewport: getViewport(),
    visibleText,
    capture_meta: captureMeta,
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

  function getVisibleElements(selector) {
    return Array.from(document.querySelectorAll(selector)).filter(isVisible);
  }

  function getVisibleText(rawText) {
    return String(rawText || "").slice(0, MAX_VISIBLE_TEXT);
  }

  function collectHeadings(elements) {
    return elements
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

  function collectLinks(elements, headingEntries) {
    return elements
      .slice(0, MAX_LINKS)
      .map((element, index) => buildInteractiveEntry(element, "link", index, headingEntries));
  }

  function collectButtons(elements, headingEntries) {
    return elements
      .slice(0, MAX_BUTTONS)
      .map((element, index) => buildInteractiveEntry(element, "button", index, headingEntries));
  }

  function collectInteractiveElements(elements, headingEntries) {
    return elements
      .slice(0, MAX_INTERACTIVE)
      .map((element, index) => buildInteractiveEntry(element, "el", index, headingEntries));
  }

  function buildInteractiveEntry(element, prefix, index, headingEntries) {
    const role = prefix === "link" ? "link" : (prefix === "button" ? "button" : inferRole(element));
    const box = getBox(element);
    const nearestHeading = findNearestHeading(box, headingEntries);
    const destinationUrl = extractDestinationUrl(element);
    const linkCandidates = extractLinkCandidates(element);
    const controlledRegion = summarizeControlledRegion(element);
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
      link_candidates: linkCandidates,
      expandable: isExpandableControl(element, role, controlledRegion),
      expanded: getExpandedState(element),
      popup_role: getPopupRole(element, controlledRegion),
      controlled_region: controlledRegion,
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

  function getForms(forms, formLikeFields) {
    const orphanFields = getOrphanFormLikeFields(formLikeFields);

    if (forms.length === 0 && formLikeFields.length > 0) {
      return [buildFormModel(document.body, "form_1", formLikeFields)];
    }

    const formModels = forms.slice(0, MAX_FORMS).map((form, index) => {
      const fields = Array.from(form.querySelectorAll(FIELD_SELECTOR)).filter(isFormFieldElement);
      return buildFormModel(form, `form_${index + 1}`, fields);
    });

    if (orphanFields.length > 0 && formModels.length < MAX_FORMS) {
      formModels.push(buildFormModel(getOrphanFieldContainer(orphanFields), `form_${formModels.length + 1}`, orphanFields));
    }

    return formModels;
  }

  function buildFormModel(container, agentId, fields) {
    return {
      agent_id: agentId,
      title: inferSectionTitle(container),
      bbox: getBox(container),
      fields: fields.filter(isVisible).slice(0, MAX_FORM_FIELDS).map((field, index) => ({
        agent_id: ensureAgentId(field, `${agentId}_field`, index),
        tag: field.tagName.toLowerCase(),
        type: field.getAttribute("type") || field.getAttribute("role") || field.tagName.toLowerCase(),
        role: inferRole(field),
        name: getAccessibleName(field),
        required: Boolean(field.required || field.getAttribute("aria-required") === "true"),
        disabled: Boolean(field.disabled || field.getAttribute("aria-disabled") === "true"),
        value: getFieldValue(field),
        options: getOptions(field),
        expanded: getExpandedState(field),
        popup_role: getPopupRole(field, summarizeControlledRegion(field)),
        controlled_region: summarizeControlledRegion(field),
        selector_candidates: getSelectorCandidates(field),
        bbox: getBox(field),
        nearby_text: compactText(getNearbyText(field)).slice(0, 240)
      }))
    };
  }

  function getOrphanFormLikeFields(formLikeFields) {
    return formLikeFields.filter((field) => !field.closest("form"));
  }

  function getOrphanFieldContainer(fields) {
    const firstField = fields.find(Boolean);
    if (!firstField) {
      return document.body;
    }

    return (
      firstField.closest("section,[role='region'],aside,main,article,[data-testid],[aria-label]")
      || firstField.parentElement
      || document.body
    );
  }

  function buildCaptureMeta({
    rawVisibleText,
    headingElements,
    linkElements,
    buttonElements,
    interactiveElementsRaw,
    formElements,
    formLikeFields
  }) {
    const orphanFields = getOrphanFormLikeFields(formLikeFields);
    const pseudoFormCount = formElements.length === 0
      ? (formLikeFields.length > 0 ? 1 : 0)
      : (orphanFields.length > 0 ? 1 : 0);

    return {
      limits: {
        visible_text: MAX_VISIBLE_TEXT,
        headings: MAX_HEADINGS,
        links: MAX_LINKS,
        buttons: MAX_BUTTONS,
        interactive_elements: MAX_INTERACTIVE,
        forms: MAX_FORMS,
        form_fields_per_form: MAX_FORM_FIELDS
      },
      estimated_counts: {
        headings: headingElements.length,
        links: linkElements.length,
        buttons: buttonElements.length,
        interactive_elements: interactiveElementsRaw.length,
        forms: Math.min(formElements.length + pseudoFormCount, MAX_FORMS)
      },
      truncated: {
        visible_text: rawVisibleText.length > MAX_VISIBLE_TEXT,
        headings: headingElements.length > MAX_HEADINGS,
        links: linkElements.length > MAX_LINKS,
        buttons: buttonElements.length > MAX_BUTTONS,
        interactive_elements: interactiveElementsRaw.length > MAX_INTERACTIVE,
        forms: formElements.length > MAX_FORMS
      },
      visible_text_length: rawVisibleText.length
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
    const container = findStructuredItemContainer(element);
    const linkCandidates = extractLinkCandidates(container || element);
    const preferredDestination = choosePreferredLinkCandidate(linkCandidates, {
      title,
      metadata,
      preview
    }) || model.destination_url || model.href || "";

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
      destination_url: preferredDestination,
      href: model.href || "",
      link_candidates: linkCandidates,
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

  function buildContentBlocks(visibleText, pageOutline, structuredItems, forms) {
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

    for (const form of forms || []) {
      const fieldNames = (Array.isArray(form.fields) ? form.fields : [])
        .map((field) => compactText(field.name || field.value || field.agent_id || ""))
        .filter(Boolean)
        .slice(0, 12);

      blocks.push({
        block_id: `block_${form.agent_id || `form_${blocks.length + 1}`}`,
        kind: "form",
        section_id: "section_filters",
        section_title: form.title || "Form",
        title: form.title || "Form",
        text: `Fields: ${fieldNames.join(" | ")}`,
        bbox: form.bbox || null
      });

      for (const field of (Array.isArray(form.fields) ? form.fields : []).slice(0, 16)) {
        const optionNames = Array.isArray(field.options)
          ? field.options.map((option) => compactText(option.label || option.value || "")).filter(Boolean).slice(0, 8)
          : [];
        const regionTitles = Array.isArray(field.controlled_region?.titles)
          ? field.controlled_region.titles.slice(0, 8)
          : [];
        const pieces = [
          `${field.name || field.agent_id || "Field"}`,
          field.role ? `role=${field.role}` : "",
          field.value ? `value=${field.value}` : "",
          optionNames.length ? `options=${optionNames.join(" | ")}` : "",
          regionTitles.length ? `popup=${regionTitles.join(" | ")}` : "",
          field.nearby_text || ""
        ].filter(Boolean);

        blocks.push({
          block_id: `block_field_${field.agent_id || blocks.length + 1}`,
          kind: "field",
          section_id: "section_filters",
          section_title: form.title || "Form",
          item_id: field.agent_id || "",
          title: field.name || field.agent_id || "Field",
          text: pieces.join(" | "),
          bbox: field.bbox || null
        });
      }
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

    if (element.matches("button,[role='button'],input[type='button'],input[type='submit']")) {
      return "button";
    }

    if (element.matches("select")) {
      return "combobox";
    }

    if (looksLikeCustomCombobox(element)) {
      return "combobox";
    }

    if (element.matches("textarea,[contenteditable='true']")) {
      return "textbox";
    }

    if (element.matches("input[type='search']")) {
      return "searchbox";
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

    if (looksLikeCustomCombobox(element)) {
      return compactText(getElementRawText(element) || getAccessibleName(element) || "");
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
    if (element.matches("select")) {
      return Array.from(element.options).map((option) => ({
        label: compactText(option.text),
        value: option.value,
        selected: option.selected
      }));
    }

    const controlledRegion = summarizeControlledRegion(element);
    if (!controlledRegion) {
      return undefined;
    }

    const rawOptions = controlledRegion.actions?.length
      ? controlledRegion.actions
      : controlledRegion.titles?.map((title) => ({ label: title, value: title })) || [];

    const options = rawOptions
      .map((option) => ({
        label: compactText(option.label || option.value || ""),
        value: compactText(option.value || option.label || ""),
        selected: false
      }))
      .filter((option) => option.label || option.value);

    return options.length ? options : undefined;
  }

  function getExpandedState(element) {
    const raw = element.getAttribute("aria-expanded");
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  }

  function getPopupRole(element, controlledRegion) {
    const hasPopup = compactText(element.getAttribute("aria-haspopup") || "");
    if (hasPopup && hasPopup !== "true") {
      return hasPopup;
    }

    if (controlledRegion?.role) {
      return controlledRegion.role;
    }

    if (element.matches("select")) {
      return "listbox";
    }

    return hasPopup ? "popup" : "";
  }

  function isExpandableControl(element, role, controlledRegion) {
    if (element.matches("select")) {
      return true;
    }

    if (role === "combobox") {
      return true;
    }

    if (element.hasAttribute("aria-expanded") || element.hasAttribute("aria-haspopup")) {
      return true;
    }

    return Boolean(controlledRegion);
  }

  function summarizeControlledRegion(element) {
    const controlledIds = String(element.getAttribute("aria-controls") || "")
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);

    const nodes = controlledIds
      .map((id) => document.getElementById(id))
      .filter(Boolean);

    if (!nodes.length) {
      return null;
    }

    const region = nodes[0];
    const texts = extractControlledRegionTitles(region);
    return {
      id: region.id || "",
      role: region.getAttribute("role") || region.tagName.toLowerCase(),
      label: getAccessibleName(region) || compactText(region.getAttribute("aria-label") || region.getAttribute("title") || ""),
      hidden: !isVisible(region),
      item_count: countControlledRegionItems(region),
      titles: texts.slice(0, 6),
      actions: extractControlledRegionActions(region).slice(0, 8)
    };
  }

  function countControlledRegionItems(region) {
    const selector = [
      "[role='option']",
      "[role='menuitem']",
      "[role='menuitemcheckbox']",
      "[role='menuitemradio']",
      "option",
      "li",
      "button",
      "a[href]"
    ].join(",");
    return region.querySelectorAll(selector).length;
  }

  function extractControlledRegionTitles(region) {
    const selector = [
      "[role='option']",
      "[role='menuitem']",
      "[role='menuitemcheckbox']",
      "[role='menuitemradio']",
      "option",
      "li",
      "button",
      "a[href]"
    ].join(",");
    const seen = new Set();
    const titles = [];

    for (const node of Array.from(region.querySelectorAll(selector))) {
      const text = compactText(getElementRawText(node) || getAccessibleName(node) || "").slice(0, 120);
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);
      titles.push(text);
      if (titles.length >= 8) {
        break;
      }
    }

    return titles;
  }

  function extractControlledRegionActions(region) {
    const selector = [
      "a[href]",
      "button",
      "[role='menuitem']",
      "[role='menuitemcheckbox']",
      "[role='menuitemradio']",
      "[role='option']",
      "option",
      "li"
    ].join(",");
    const actions = [];
    const seen = new Set();

    for (const node of Array.from(region.querySelectorAll(selector))) {
      const label = compactText(getElementRawText(node) || getAccessibleName(node) || "").slice(0, 120);
      const href = normalizePossibleUrl(node?.href || node?.getAttribute?.("href") || "");
      const value = compactText(node.getAttribute?.("value") || node.value || "").slice(0, 120);
      const role = node.getAttribute?.("role") || node.tagName.toLowerCase();
      const key = `${role}|${label}|${href}|${value}`;

      if (seen.has(key) || (!label && !href && !value)) {
        continue;
      }

      seen.add(key);
      actions.push({
        role,
        label,
        href,
        value
      });
    }

    return actions;
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
    const existing = elementAgentIds.get(element);
    if (existing) {
      return existing;
    }

    const preferred = element.dataset.browserCompanionId || `${prefix}_${index + 1}`;
    let candidate = preferred;
    let suffix = 2;

    while (assignedAgentIds.has(candidate)) {
      candidate = `${preferred}_${suffix}`;
      suffix += 1;
    }

    element.dataset.browserCompanionId = candidate;
    assignedAgentIds.add(candidate);
    elementAgentIds.set(element, candidate);
    return candidate;
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

  function isFormFieldElement(element) {
    if (!element || !isVisible(element)) {
      return false;
    }

    if (element.matches("input,select,textarea,[contenteditable='true'],[role='textbox'],[role='searchbox'],[role='combobox']")) {
      return true;
    }

    return looksLikeCustomCombobox(element) || looksLikeFieldButton(element);
  }

  function looksLikeCustomCombobox(element) {
    if (!element?.matches) {
      return false;
    }

    const role = String(element.getAttribute("role") || "").toLowerCase();
    const popup = String(element.getAttribute("aria-haspopup") || "").toLowerCase();
    if (role === "combobox") {
      return true;
    }

    if (!element.matches("button,[role='button'],div,input")) {
      return false;
    }

    return popup === "listbox"
      || popup === "menu"
      || element.hasAttribute("aria-controls")
      || element.hasAttribute("aria-expanded");
  }

  function looksLikeFieldButton(element) {
    if (!element?.matches) {
      return false;
    }

    if (!element.matches("button,[role='button'],div,span,[tabindex]")) {
      return false;
    }

    if (element.matches("a[href],input,select,textarea,[contenteditable='true']")) {
      return false;
    }

    const label = compactText(getAccessibleName(element) || getElementRawText(element) || "").slice(0, 120);
    if (!label || label.length < 2 || label.length > 80) {
      return false;
    }

    if (NAVIGATION_LABEL_RE.test(label)) {
      return false;
    }

    const wordCount = label.split(/\s+/).filter(Boolean).length;
    if (wordCount > 6) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width < 72 || rect.height < 28) {
      return false;
    }

    const nearby = compactText(getNearbyText(element)).slice(0, 240);
    const hasPopupHint = element.hasAttribute("aria-haspopup")
      || element.hasAttribute("aria-controls")
      || element.hasAttribute("aria-expanded");
    const hasFieldWords = /\b(keyword|keywords|area|areas|country|region|city|organisation|organization|salary|experience|education|skill|skills|role type|other filters|filter|filters)\b/i.test(`${label} ${nearby}`);
    const siblingCluster = countFieldLikeSiblings(element) >= 3;

    return hasPopupHint || hasFieldWords || siblingCluster;
  }

  function countFieldLikeSiblings(element) {
    const parent = element.parentElement;
    if (!parent) {
      return 0;
    }

    let count = 0;
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof Element) || !isVisible(sibling)) {
        continue;
      }

      const label = compactText(getAccessibleName(sibling) || getElementRawText(sibling) || "").slice(0, 120);
      if (!label || NAVIGATION_LABEL_RE.test(label)) {
        continue;
      }

      const rect = sibling.getBoundingClientRect();
      const words = label.split(/\s+/).filter(Boolean).length;
      if (rect.width >= 72 && rect.height >= 28 && words <= 6) {
        count += 1;
      }
    }

    return count;
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

    const preferredCandidate = choosePreferredLinkCandidate(extractLinkCandidates(element), {
      title: getAccessibleName(element),
      metadata: compactText(getNearbyText(element)).slice(0, 220)
    });
    if (preferredCandidate) {
      return preferredCandidate;
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

  function extractLinkCandidates(element) {
    if (!element) {
      return [];
    }

    const candidates = [];
    const seen = new Set();
    const container = findStructuredItemContainer(element) || element;
    const nodes = [];

    if (element.matches?.("a[href]")) {
      nodes.push(element);
    }
    if (container.closest?.("a[href]")) {
      nodes.push(container.closest("a[href]"));
    }
    nodes.push(...Array.from(container.querySelectorAll?.("a[href]") || []));

    for (const node of nodes) {
      const href = normalizePossibleUrl(node?.href || node?.getAttribute?.("href") || "");
      if (!href) {
        continue;
      }
      const text = compactText(getElementRawText(node) || getAccessibleName(node) || "").slice(0, 220);
      const ariaLabel = compactText(node.getAttribute?.("aria-label") || "").slice(0, 160);
      const title = compactText(node.getAttribute?.("title") || "").slice(0, 160);
      const key = `${href}|${text}|${ariaLabel}|${title}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({
        href,
        text,
        aria_label: ariaLabel,
        title,
        role: node.getAttribute?.("role") || "link"
      });
    }

    return candidates.slice(0, 8);
  }

  function findStructuredItemContainer(element) {
    if (!element) {
      return null;
    }

    return element.closest?.("article,li,[role='article'],[data-testid],section,div") || element.parentElement || element;
  }

  function choosePreferredLinkCandidate(candidates, context = {}) {
    const items = Array.isArray(candidates) ? candidates : [];
    if (!items.length) {
      return "";
    }

    const titleKey = normalizeTokenKey(context.title || "");
    const metadataKey = normalizeTokenKey(context.metadata || "");
    const previewKey = normalizeTokenKey(context.preview || "");
    const ctaPattern = /\b(view|details|detail|opportunity|apply|application|job|role|learn more|open|read more|view opportunity details|vedi|dettagli|offerta|candid|apri|scopri)\b/i;
    const weakPattern = /\b(share|copy|bookmark|save|feedback|expand|collapse|menu|organization|profile|open roles|largest funder)\b/i;

    const ranked = items
      .map((candidate) => {
        const combined = compactText([candidate.text, candidate.aria_label, candidate.title].filter(Boolean).join(" "));
        const normalized = normalizeTokenKey(combined);
        const href = String(candidate.href || "");
        let score = 0;
        if (ctaPattern.test(combined)) score += 8;
        if (weakPattern.test(combined)) score -= 4;
        if (titleKey && normalized.includes(titleKey)) score += 5;
        if (metadataKey && metadataKey.length >= 10 && normalized.includes(metadataKey)) score += 2;
        if (previewKey && previewKey.length >= 10 && previewKey.includes(normalized)) score += 1;
        if (!combined) score -= 2;
        if (/\/job\/conversation(?:\/|\?|$)/i.test(href)) score -= 12;
        if (/discuss this opportunity with ai/i.test(combined)) score -= 10;
        if (/utm_medium=job_card_manage_button/i.test(href)) score -= 8;
        if (/\/organisations?\//i.test(href)) score -= 4;
        if (/\/problem-profiles?\//i.test(href)) score -= 4;
        if (/\/career-reviews?\//i.test(href)) score -= 4;
        if (/^https?:\/\/[^/]+\/?(?:[?#].*)?$/i.test(href)) score -= 6;
        if (/\/forms\//i.test(href) && /view job details|details|apply|application|job/i.test(combined)) score += 10;
        if (/view job details|view details|job details|apply now|apply here|open role/i.test(combined)) score += 10;
        return {
          href,
          score,
          textLength: combined.length
        };
      })
      .sort((a, b) => b.score - a.score || b.textLength - a.textLength);

    if (!ranked.length) {
      return "";
    }

    if (ranked[0].score <= 0 && ranked.length > 1) {
      return "";
    }

    return ranked[0].href || "";
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
