(() => {
  if (window.__browserCompanionActions) {
    return;
  }

  window.__browserCompanionActions = {
    execute
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
        return success(action, false, "Cleared highlights.");
      }

      const element = resolveElement(action.target);

      if (!element) {
        throw new Error("Target element could not be resolved.");
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
        element.click();
        return success(action, true, `Clicked ${getName(element)}.`);
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
    for (const selector of target.selector_candidates || []) {
      const element = document.querySelector(selector);
      if (element) return element;
    }

    const candidates = Array.from(document.querySelectorAll("input,select,textarea,button,a[href],[role='button'],[contenteditable='true']"));
    const wantedRole = String(target.role || "").toLowerCase();
    const wantedName = normalize(target.name);

    return candidates.find((element) => {
      const role = inferRole(element);
      const name = normalize(getName(element));
      return (!wantedRole || role === wantedRole) && (!wantedName || name.includes(wantedName) || wantedName.includes(name));
    });
  }

  function verifyElement(element, target = {}) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") {
      throw new Error("Target element is not visible.");
    }

    if (element.disabled || element.getAttribute("aria-disabled") === "true") {
      throw new Error("Target element is disabled.");
    }

    const targetName = normalize(target.name);
    const actualName = normalize(getName(element));

    if (targetName && actualName && !actualName.includes(targetName) && !targetName.includes(actualName)) {
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

  function getName(element) {
    return element.getAttribute("aria-label") || element.labels?.[0]?.innerText || element.innerText || element.placeholder || element.name || element.id || element.href || element.tagName.toLowerCase();
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
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
})();
