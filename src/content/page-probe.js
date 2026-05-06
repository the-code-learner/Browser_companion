(() => {
  const interactiveSelector = [
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

  const observation = {
    viewport: getViewport(),
    visibleText: getVisibleText(),
    headings: getHeadings(),
    links: getLinks(),
    buttons: getButtons(),
    forms: getForms(),
    interactiveElements: getInteractiveElements()
  };

  return observation;

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
    const text = document.body?.innerText || "";
    return compactText(text).slice(0, 12000);
  }

  function getLinks() {
    return Array.from(document.querySelectorAll("a[href]"))
      .filter(isVisible)
      .slice(0, 80)
      .map((element, index) => ({
        agent_id: ensureAgentId(element, "link", index),
        role: "link",
        name: getAccessibleName(element),
        href: element.href,
        selector_candidates: getSelectorCandidates(element),
        bbox: getBox(element)
      }));
  }

  function getHeadings() {
    return Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']"))
      .filter(isVisible)
      .slice(0, 60)
      .map((element, index) => ({
        agent_id: `heading_${index + 1}`,
        level: element.getAttribute("aria-level") || element.tagName.replace(/\D/g, "") || undefined,
        text: compactText(element.innerText),
        bbox: getBox(element)
      }));
  }

  function getButtons() {
    return Array.from(document.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit']"))
      .filter(isVisible)
      .slice(0, 80)
      .map((element, index) => ({
        agent_id: ensureAgentId(element, "button", index),
        role: "button",
        name: getAccessibleName(element),
        type: element.getAttribute("type") || element.tagName.toLowerCase(),
        selector_candidates: getSelectorCandidates(element),
        bbox: getBox(element)
      }));
  }

  function getForms() {
    const forms = Array.from(document.querySelectorAll("form"));
    const formLikeFields = Array.from(document.querySelectorAll("input,select,textarea,[contenteditable='true']"));

    if (forms.length === 0 && formLikeFields.length > 0) {
      return [buildFormModel(document.body, "form_1", formLikeFields)];
    }

    return forms.slice(0, 20).map((form, index) => {
      const fields = Array.from(form.querySelectorAll("input,select,textarea,[contenteditable='true']"));
      return buildFormModel(form, `form_${index + 1}`, fields);
    });
  }

  function getInteractiveElements() {
    return Array.from(document.querySelectorAll(interactiveSelector))
      .filter(isVisible)
      .slice(0, 160)
      .map((element, index) => ({
        agent_id: ensureAgentId(element, "el", index),
        tag: element.tagName.toLowerCase(),
        role: inferRole(element),
        name: getAccessibleName(element),
        selector_candidates: getSelectorCandidates(element),
        bbox: getBox(element)
      }));
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

  function inferRole(element) {
    if (element.getAttribute("role")) {
      return element.getAttribute("role");
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

    const text = element.innerText || element.value || element.name || element.id || "";
    return compactText(text).slice(0, 160);
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
    const parent = element.closest("label,fieldset,section,form,div") || element.parentElement;
    return parent?.innerText || "";
  }

  function inferSectionTitle(element) {
    const heading = element.querySelector?.("h1,h2,h3,legend,[role='heading']");
    if (heading?.innerText) return compactText(heading.innerText).slice(0, 160);
    return document.title || "Current page form";
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function compactText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function cssEscape(value) {
    if (window.CSS?.escape) {
      return window.CSS.escape(value);
    }

    return String(value).replace(/'/g, "\\'");
  }
})();
