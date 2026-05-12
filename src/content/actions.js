(() => {
  if (window.__browserCompanionActions) {
    return;
  }

  window.__browserCompanionActions = {
    execute,
    showNumberedOverlay,
    getOverlayMap
  };

  function execute(action) {
    try {
      if (!action?.type) {
        throw new Error("Action type is missing.");
      }

      if (action.type === "scroll_by") {
        window.scrollBy({
          top: Number(action.value?.y || action.y || 0),
          left: Number(action.value?.x || action.x || 0),
          behavior: "smooth"
        });
        return success(action, true, "Scrolled the page.");
      }

      if (action.type === "clear_highlights") {
        clearHighlights();
        clearNumberedOverlay();
        return success(action, false, "Cleared highlights.");
      }

      if (action.type === "click_overlay_number") {
        const item = overlayMap.find((entry) => entry.number === Number(action.value || action.overlay_number));
        if (!item) {
          throw new Error("Overlay number was not found.");
        }
        const element = resolveElement(item.target);
        if (!element) {
          throw new Error("Overlay target could not be resolved.");
        }
        return success(action, false, `${activateElement(element)} via overlay number ${item.number}.`);
      }

      const element = resolveElement(action.target);

      if (!element) {
        throw new Error("Target element could not be resolved.");
      }

      if (action.type === "click_element") {
        element.scrollIntoView({ block: "center", inline: "nearest" });
      }

      verifyElement(element, action.target);

      if (action.type === "scroll_to_element") {
        element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        return success(action, true, `Scrolled to ${getName(element)}.`);
      }

      if (action.type === "highlight_element") {
        clearHighlights();
        element.classList.add("browser-companion-highlight");
        return success(action, false, `Highlighted ${getName(element)}.`);
      }

      if (action.type === "focus_element") {
        element.focus();
        return success(action, false, `Focused ${getName(element)}.`);
      }

      if (action.type === "fill_field") {
        return fillField(action, element);
      }

      if (action.type === "select_option") {
        return selectOption(action, element);
      }

      if (action.type === "toggle_checkbox") {
        return toggleCheckbox(action, element);
      }

      if (action.type === "set_radio") {
        return setRadio(action, element);
      }

      if (action.type === "click_element") {
        element.scrollIntoView({ block: "center", inline: "nearest" });
        verifyElement(element, action.target);
        return success(action, false, activateElement(element));
      }

      if (action.type === "upload_file_to_field") {
        element.scrollIntoView({ block: "center", inline: "nearest" });
        element.focus();
        element.click();
        return {
          ...success(action, false, `Opened the file picker for ${getName(element)}. Complete the upload manually.`),
          status: "needs_user"
        };
      }

      throw new Error(`Unsupported action type: ${action.type}`);
    } catch (error) {
      return {
        type: "execution_result",
        action_id: action?.id || action?.type || "unknown",
        status: "error",
        target_verified: false,
        page_changed: false,
        validation_messages: [],
        log_message: error.message
      };
    }
  }

  let overlayMap = [];

  function showNumberedOverlay() {
    clearNumberedOverlay();
    overlayMap = Array.from(document.querySelectorAll("a[href],button,input,select,textarea,[role='button'],[role='link'],[contenteditable='true']"))
      .filter(isVisible)
      .slice(0, 60)
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        const number = index + 1;
        const marker = document.createElement("div");
        marker.className = "browser-companion-overlay-marker";
        marker.textContent = String(number);
        marker.style.left = `${Math.max(0, rect.left + window.scrollX)}px`;
        marker.style.top = `${Math.max(0, rect.top + window.scrollY)}px`;
        document.documentElement.appendChild(marker);
        return {
          number,
          target: {
            role: inferRole(element),
            name: getName(element),
            selector_candidates: getSelectorCandidates(element)
          },
          bbox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          }
        };
      });
    return overlayMap;
  }

  function getOverlayMap() {
    return overlayMap;
  }

  function fillField(action, element) {
    const before = getValue(element);
    setValue(element, action.value ?? "");
    dispatchInputEvents(element);
    return {
      ...success(action, false, `Filled ${getName(element)}.`),
      before: { value: before },
      after: { value: getValue(element) },
      validation_messages: getValidationMessages(element)
    };
  }

  function selectOption(action, element) {
    const before = getValue(element);
    const wanted = String(action.value ?? "");
    const option = Array.from(element.options || []).find((item) => item.value === wanted || item.text.trim() === wanted);

    if (!option) {
      throw new Error(`Option was not found for ${getName(element)}.`);
    }

    element.value = option.value;
    dispatchInputEvents(element);
    return {
      ...success(action, false, `Selected ${option.text.trim()} for ${getName(element)}.`),
      before: { value: before },
      after: { value: getValue(element) },
      validation_messages: getValidationMessages(element)
    };
  }

  function toggleCheckbox(action, element) {
    const before = getValue(element);
    const desired = Boolean(action.value);
    if (element.checked !== desired) {
      element.click();
    }
    return {
      ...success(action, false, `${desired ? "Checked" : "Unchecked"} ${getName(element)}.`),
      before: { value: before },
      after: { value: getValue(element) },
      validation_messages: getValidationMessages(element)
    };
  }

  function setRadio(action, element) {
    const before = getValue(element);
    if (!element.checked) {
      element.click();
    }
    return {
      ...success(action, false, `Selected ${getName(element)}.`),
      before: { value: before },
      after: { value: getValue(element) },
      validation_messages: getValidationMessages(element)
    };
  }

  function resolveElement(target = {}) {
    if (target.agent_id) {
      const element = document.querySelector(`[data-browser-companion-id='${cssEscape(target.agent_id)}']`);
      if (element) {
        return element;
      }
    }

    const selectorMatches = [];
    for (const selector of target.selector_candidates || []) {
      if (!isCssSelectorCandidate(selector)) {
        continue;
      }

      try {
        selectorMatches.push(...document.querySelectorAll(selector));
      } catch {
        // Model-proposed selector candidates can contain non-CSS hints such as
        // text=Label. Ignore them and fall back to role/name matching.
      }
    }

    const candidates = [
      ...selectorMatches,
      ...document.querySelectorAll("input,select,textarea,button,a[href],[role='button'],[role='link'],[contenteditable='true']"),
      ...findElementsByVisibleText(target.name)
    ];
    const wantedRole = String(target.role || "").toLowerCase();
    const wantedName = normalize(target.name);
    const uniqueCandidates = Array.from(new Set(candidates));

    return uniqueCandidates
      .map((element) => ({
        element,
        score: scoreElement(element, wantedRole, wantedName)
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function scoreElement(element, wantedRole, wantedName) {
    const visible = isVisible(element);
    const role = inferRole(element);
    const name = normalize(getName(element));
    const href = normalize(element.href || "");
    let score = 0;

    if (wantedRole && role !== wantedRole) {
      return 0;
    }

    if (!wantedName) {
      score += 10;
    } else if (name === wantedName) {
      score += 100;
    } else if (name.includes(wantedName)) {
      score += 70;
    } else if (wantedName.includes(name) && name.length > 2) {
      score += 45;
    } else if (href.includes(wantedName.replace(/\s+/g, "-"))) {
      score += 65;
    } else {
      return 0;
    }

    if (visible) score += 40;
    if (isInViewport(element)) score += 20;
    if (element.matches("a[href]")) score += 10;

    return score;
  }

  function isCssSelectorCandidate(selector) {
    const value = String(selector || "").trim();
    return Boolean(value) && !/^(text|xpath|aria|role)\s*=/i.test(value);
  }

  function findElementsByVisibleText(name) {
    const wanted = normalize(name);
    if (!wanted) {
      return [];
    }

    const textNodes = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const matches = [];
    let node = textNodes.nextNode();

    while (node && matches.length < 20) {
      const text = normalize(node.textContent);
      if (text && (text === wanted || text.includes(wanted) || wanted.includes(text))) {
        const element = closestClickable(node.parentElement) || node.parentElement;
        if (element) matches.push(element);
      }
      node = textNodes.nextNode();
    }

    return matches;
  }

  function closestClickable(element) {
    return element?.closest?.("a[href],button,[role='button'],[role='link'],[contenteditable='true']");
  }

  function verifyElement(element, target = {}) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    const hasVisibleText = Boolean(target.name && normalize(element.innerText || element.textContent).includes(normalize(target.name)));
    if ((rect.width <= 0 || rect.height <= 0) && !hasVisibleText) {
      throw new Error("Target element is not visible.");
    }

    if (style.visibility === "hidden" || style.display === "none") {
      throw new Error("Target element is not visible.");
    }

    if (element.disabled || element.getAttribute("aria-disabled") === "true") {
      throw new Error("Target element is disabled.");
    }

    const targetName = normalize(target.name);
    const actualName = normalize(getName(element));

    if (
      targetName &&
      actualName &&
      !actualName.includes(targetName) &&
      !targetName.includes(actualName) &&
      !matchesAnySelectorCandidate(element, target.selector_candidates || []) &&
      !matchesAgentId(element, target.agent_id)
    ) {
      throw new Error(`Target name mismatch. Expected ${target.name}, found ${getName(element)}.`);
    }
  }

  function setValue(element, value) {
    if (element.matches("[contenteditable='true']")) {
      element.innerText = String(value);
      return;
    }

    element.focus();
    element.value = String(value);
  }

  function getValue(element) {
    if (element.matches("[contenteditable='true']")) {
      return element.innerText || "";
    }

    if (element.type === "checkbox" || element.type === "radio") {
      return Boolean(element.checked);
    }

    return element.value || "";
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getValidationMessages(element) {
    if (typeof element.validationMessage === "string" && element.validationMessage) {
      return [element.validationMessage];
    }

    return [];
  }

  function clearHighlights() {
    document.querySelectorAll(".browser-companion-highlight").forEach((element) => {
      element.classList.remove("browser-companion-highlight");
    });
  }

  function clearNumberedOverlay() {
    document.querySelectorAll(".browser-companion-overlay-marker").forEach((element) => element.remove());
    overlayMap = [];
  }

  function success(action, pageChanged, message) {
    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: "success",
      target_verified: true,
      page_changed: pageChanged,
      validation_messages: [],
      log_message: message
    };
  }

  function activateElement(element) {
    if (isSubmitControl(element)) {
      const form = element.form || element.closest?.("form");
      if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit(element.matches("button,input") ? element : undefined);
      } else {
        element.click();
      }
      return `Submitted ${getName(element)}.`;
    }

    element.click();
    return `Clicked ${getName(element)}.`;
  }

  function isSubmitControl(element) {
    if (!element?.matches) {
      return false;
    }

    if (element.matches("button")) {
      const type = String(element.getAttribute("type") || "submit").toLowerCase();
      return type === "submit";
    }

    if (element.matches("input")) {
      const type = String(element.getAttribute("type") || "").toLowerCase();
      return type === "submit" || type === "image";
    }

    return false;
  }

  function getName(element) {
    const directValue = typeof element.value === "string" ? element.value.trim() : "";
    const textContent = compactText(element.innerText || element.textContent || "");
    const labelledByText = getAriaLabelledByText(element);
    return element.getAttribute("aria-label")
      || labelledByText
      || element.getAttribute("value")
      || directValue
      || compactText(element.labels?.[0]?.innerText || "")
      || textContent
      || element.placeholder
      || element.name
      || element.id
      || element.href
      || element.tagName.toLowerCase();
  }

  function getAriaLabelledByText(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (!labelledBy) {
      return "";
    }

    return labelledBy
      .split(/\s+/)
      .map((id) => compactText(document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || ""))
      .filter(Boolean)
      .join(" ");
  }

  function matchesAnySelectorCandidate(element, selectors) {
    for (const selector of selectors || []) {
      if (!isCssSelectorCandidate(selector)) {
        continue;
      }

      try {
        if (element.matches(selector)) {
          return true;
        }
      } catch {
        // Ignore invalid selectors provided by the model.
      }
    }

    return false;
  }

  function matchesAgentId(element, agentId) {
    return Boolean(agentId) && element.getAttribute("data-browser-companion-id") === agentId;
  }

  function getSelectorCandidates(element) {
    const selectors = [];
    if (element.id) selectors.push(`#${cssEscape(element.id)}`);
    if (element.name) selectors.push(`${element.tagName.toLowerCase()}[name='${cssEscape(element.name)}']`);
    if (element.getAttribute("aria-label")) {
      selectors.push(`${element.tagName.toLowerCase()}[aria-label='${cssEscape(element.getAttribute("aria-label"))}']`);
    }
    return selectors.slice(0, 3);
  }

  function inferRole(element) {
    if (element.getAttribute("role")) return element.getAttribute("role").toLowerCase();
    if (element.matches("select")) return "combobox";
    if (element.matches("textarea,[contenteditable='true']")) return "textbox";
    if (element.matches("button,a[href]")) return element.matches("a[href]") ? "link" : "button";
    if (element.type === "checkbox") return "checkbox";
    if (element.type === "radio") return "radio";
    return "textbox";
  }

  function normalize(value) {
    return compactText(value)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function compactText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value).replace(/'/g, "\\'");
  }
})();
