import { MESSAGE_TYPES, NATIVE_HOST_NAME, makeEnvelope } from "../shared/messages.js";
import { createObservation } from "../shared/schemas.js";
import { validateActionPlan } from "../shared/policy.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

let nativePort = null;
let nativePortSequence = 1;
const nativePortPending = new Map();
let activeNativeRequestId = null;
const AUTO_OBSERVE_OPENED_TAB_LIMIT = 3;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.windowId) {
    return;
  }

  await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message || "Unexpected extension error."
      });
    });

  return true;
});

async function handleMessage(message) {
  if (message?.type === MESSAGE_TYPES.OBSERVE_ACTIVE_TAB) {
    return observeActiveTab();
  }

  if (message?.type === MESSAGE_TYPES.NATIVE_HEALTH) {
    return checkNativeHealth();
  }

  if (message?.type === MESSAGE_TYPES.CONNECT_CODEX) {
    return connectCodex(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.LOGOUT_PROVIDER) {
    return logoutProvider(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.INSTALL_PROVIDER) {
    return installProvider(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.INSTALL_NODEJS) {
    return installNodejs();
  }

  if (message?.type === MESSAGE_TYPES.HTTP_PROVIDER_TEST) {
    return testHttpProvider(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.HTTP_PROVIDER_UNLOAD) {
    return unloadHttpProvider(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.EXTRACT_ATTACHMENT) {
    return extractAttachment(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.HTTP_REQUEST) {
    return runHttpRequest(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.WEB_SEARCH) {
    return runWebSearch(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.USER_MEMORY_GET) {
    return getUserMemory();
  }

  if (message?.type === MESSAGE_TYPES.USER_MEMORY_SAVE) {
    return saveUserMemory(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.USER_MEMORY_DELETE) {
    return deleteUserMemory(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.AGENT_REQUEST) {
    return requestAgent(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.SYNTHESIS_REQUEST) {
    return requestSynthesis(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.STOP_ACTIVE_REQUEST) {
    return stopActiveProviderRequest();
  }

  if (message?.type === MESSAGE_TYPES.VALIDATE_ACTION_PLAN) {
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.POLICY_RESULT, validateActionPlan(message.payload?.plan))
    };
  }

  if (message?.type === MESSAGE_TYPES.DEV_WATCH_STATUS) {
    return requestDevWatchStatus();
  }

  if (message?.type === MESSAGE_TYPES.EXECUTE_ACTION_PLAN) {
    return executeActionPlan(message.payload?.plan);
  }

  return {
    ok: false,
    error: `Unsupported message type: ${message?.type || "missing"}`
  };
}

async function observeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }

  assertSupportedTab(tab);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content/page-probe.js"]
  });

  const observation = createObservation(
    {
      id: tab.id,
      url: tab.url,
      title: tab.title
    },
    result
  );

  return {
    ok: true,
    envelope: makeEnvelope(MESSAGE_TYPES.PAGE_OBSERVATION, observation)
  };
}

function assertSupportedTab(tab) {
  const url = tab.url || "";

  if (/^(chrome|edge|about|devtools):/i.test(url)) {
    throw new Error("Browser Companion cannot observe restricted browser pages.");
  }
}

async function checkNativeHealth() {
  try {
    const response = await sendNativeMessage({ type: "health" });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.NATIVE_STATUS, response)
    };
  } catch (error) {
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.NATIVE_STATUS, {
        connected: false,
        status: "missing",
        message: "Local connector is not installed or not registered yet."
      })
    };
  }
}

async function connectCodex(payload = {}) {
  try {
    const response = await sendNativeMessage({
      type: "connect",
      payload
    });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.NATIVE_STATUS, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: "Local connector is not installed or cannot start the selected provider login yet."
    };
  }
}

async function logoutProvider(payload = {}) {
  try {
    const response = await sendNativeMessage({
      type: "provider_logout",
      payload
    });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.NATIVE_STATUS, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Provider logout could not be completed."
    };
  }
}

async function installProvider(payload) {
  try {
    const response = await sendNativeMessage({
      type: "provider_install",
      payload
    });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.NATIVE_STATUS, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Provider install could not be started."
    };
  }
}

async function installNodejs() {
  try {
    const response = await sendNativeMessage({
      type: "nodejs_install"
    });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.NATIVE_STATUS, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Node.js/npm install could not be started."
    };
  }
}

async function testHttpProvider(payload) {
  try {
    const response = await sendNativeMessage({
      type: "http_provider_test",
      payload
    });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.HTTP_PROVIDER_TEST, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "HTTP provider test failed."
    };
  }
}

async function unloadHttpProvider(payload) {
  try {
    const response = await sendNativeMessage({
      type: "http_provider_unload",
      payload
    });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.HTTP_PROVIDER_UNLOAD, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "HTTP provider model unload failed."
    };
  }
}

async function requestAgent(payload) {
  try {
    const { requestId, promise } = postNativePortRequest({
      type: "agent_request",
      payload
    });
    activeNativeRequestId = requestId;
    const response = await promise;
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.AGENT_RESPONSE, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Provider agent request failed."
    };
  } finally {
    activeNativeRequestId = null;
  }
}

async function requestSynthesis(payload) {
  try {
    const { requestId, promise } = postNativePortRequest({
      type: "synthesis_request",
      payload
    });
    activeNativeRequestId = requestId;
    const response = await promise;
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.AGENT_RESPONSE, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Provider synthesis request failed."
    };
  } finally {
    activeNativeRequestId = null;
  }
}

async function stopActiveProviderRequest() {
  if (!activeNativeRequestId) {
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.STOP_ACTIVE_REQUEST, {
        type: "stop_active_request",
        status: "idle",
        message: "No active provider request to stop."
      })
    };
  }

  try {
    const { promise } = postNativePortRequest({
      type: "stop_active_request",
      payload: {
        targetRequestId: activeNativeRequestId
      }
    });
    const response = await promise;
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.STOP_ACTIVE_REQUEST, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Provider stop request failed."
    };
  }
}

async function extractAttachment(payload) {
  try {
    const response = await sendNativeMessage({
      type: "extract_attachment",
      payload
    });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.EXTRACT_ATTACHMENT, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Attachment extraction failed."
    };
  }
}

async function runHttpRequest(payload) {
  try {
    const response = await sendNativeMessage({
      type: "http_request",
      payload
    });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.HTTP_REQUEST, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "HTTP request failed."
    };
  }
}

async function runWebSearch(payload) {
  try {
    const response = await sendNativeMessage({
      type: "web_search",
      payload
    });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.WEB_SEARCH, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Web search failed."
    };
  }
}

async function getUserMemory() {
  try {
    const response = await sendNativeMessage({ type: "user_memory_get" });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.USER_MEMORY_GET, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "User memory could not be loaded."
    };
  }
}

async function saveUserMemory(payload) {
  try {
    const response = await sendNativeMessage({
      type: "user_memory_save",
      payload
    });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.USER_MEMORY_SAVE, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "User memory could not be saved."
    };
  }
}

async function deleteUserMemory(payload) {
  try {
    const response = await sendNativeMessage({
      type: "user_memory_delete",
      payload
    });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.USER_MEMORY_DELETE, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "User memory could not be deleted."
    };
  }
}

async function requestDevWatchStatus() {
  try {
    const response = await sendNativeMessage({ type: "dev_watch_status" });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.DEV_WATCH_STATUS, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Dev watch status could not be loaded."
    };
  }
}

async function executeActionPlan(plan) {
  const policy = validateActionPlan(plan);

  if (!policy.allowed) {
    return {
      ok: false,
      error: "The action plan was blocked by Browser Companion policy.",
      policy
    };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }

  const results = [];
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const requiresCurrentTabAccess = actions.some((action) => usesCurrentActiveTabContext(action));
  const openInNewTabCount = actions.filter((action) => action?.type === "open_url_new_tab").length;

  if (requiresCurrentTabAccess) {
    assertSupportedTab(tab);
  }

  for (const action of actions) {
    const targetTab = await resolveActionExecutionTab(tab, action);
    if (!targetTab?.id) {
      return {
        ok: false,
        error: "The target tab for this action is not available."
      };
    }

    if (needsTabScript(action)) {
      const permission = await ensureTabOriginPermission(targetTab, { request: false });
      if (!permission.ok) {
        return {
          ok: false,
          error: permission.error
        };
      }
      await ensureActionScripts(targetTab.id);
    }

    const beforeTabState = actionMayChangePage(action)
      ? await chrome.tabs.get(targetTab.id).catch(() => null)
      : null;
    const browserLevelResult = await executeBrowserLevelAction(targetTab, action, {
      currentActiveTab: tab,
      openInNewTabCount
    });
    if (browserLevelResult) {
      results.push(browserLevelResult);
      continue;
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: (browserAction) => window.__browserCompanionActions.execute(browserAction),
      args: [action]
    });

    if (result?.status === "success" && beforeTabState) {
      result.page_changed = await waitForPotentialPageChange(targetTab.id, beforeTabState);
    }

    results.push(result);
  }

  return {
    ok: true,
    envelope: makeEnvelope(MESSAGE_TYPES.EXECUTION_RESULT, {
      type: "execution_batch_result",
      results
    })
  };
}

async function ensureActionScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content/actions.js"]
  });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["src/content/overlay.css"]
  });
}

function usesCurrentActiveTabContext(action) {
  if (Number.isInteger(action?.tab?.tabId)) {
    return false;
  }

  return ![
    "open_url",
    "open_url_new_tab",
    "observe_known_tab",
    "http_request",
    "web_search"
  ].includes(action?.type);
}

async function resolveActionExecutionTab(currentActiveTab, action) {
  const targetTabId = action?.tab?.tabId;
  if (Number.isInteger(targetTabId)) {
    return chrome.tabs.get(targetTabId).catch(() => null);
  }

  if (action?.type === "observe_known_tab") {
    const legacyTabId = Number.parseInt(String(action.value || action.tabId || action.target?.agent_id || ""), 10);
    if (Number.isInteger(legacyTabId)) {
      return chrome.tabs.get(legacyTabId).catch(() => null);
    }
  }

  return currentActiveTab;
}

function needsTabScript(action) {
  return ![
    "open_url",
    "open_url_new_tab",
    "observe_known_tab",
    "http_request",
    "web_search",
    "go_back",
    "wait_for_page_change"
  ].includes(action?.type);
}

function actionMayChangePage(action) {
  return [
    "click_element",
    "click_overlay_number"
  ].includes(action?.type);
}

async function ensureTabOriginPermission(tab, options = {}) {
  const originPattern = getTabOriginPattern(tab);
  if (!tab?.url || !originPattern) {
    return {
      ok: false,
      error: "The target tab URL cannot be accessed."
    };
  }

  const hasPermission = await chrome.permissions.contains({
    origins: [originPattern]
  });

  if (hasPermission) {
    return { ok: true };
  }

  if (options.request === false) {
    return {
      ok: false,
      error: `Site access is not granted for ${originPattern}. Grant access from the side panel and then continue the pending action.`
    };
  }

  let granted = false;

  try {
    granted = await chrome.permissions.request({
      origins: [originPattern]
    });
  } catch (error) {
    return {
      ok: false,
      error: `Chrome can only request site access during a direct user gesture. Use a side-panel button or Observe to trigger the prompt for ${originPattern}.`
    };
  }

  return granted
    ? { ok: true }
    : {
        ok: false,
        error: `Site access was not granted for ${originPattern}.`
      };
}

function getTabOriginPattern(tab) {
  try {
    const url = new URL(tab?.url || "");
    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }
    return `${url.origin}/*`;
  } catch {
    return "";
  }
}

function hasHttpUrl(url) {
  return /^https?:/i.test(String(url || ""));
}

async function hasTabOriginPermission(tab) {
  const originPattern = getTabOriginPattern(tab);
  if (!originPattern) {
    return false;
  }

  return chrome.permissions.contains({
    origins: [originPattern]
  }).catch(() => false);
}

async function executeBrowserLevelAction(tab, action, options = {}) {
  if (action?.type === "observe_page" || action?.type === "get_visible_text" || action?.type === "get_links" || action?.type === "get_buttons" || action?.type === "get_forms" || action?.type === "get_dom_snapshot") {
    return tryObserveTabForAction(tab, action);
  }

  if (action?.type === "observe_known_tab") {
    const tabId = Number.parseInt(String(action.value || action.tabId || action.target?.agent_id || ""), 10);
    if (!Number.isInteger(tabId)) {
      return {
        type: "execution_result",
        action_id: action.id || action.type,
        status: "error",
        target_verified: false,
        page_changed: false,
        validation_messages: [],
        log_message: "A valid tab ID is required to observe a known tab."
      };
    }

    try {
      const targetTab = await chrome.tabs.get(tabId);
      assertSupportedTab(targetTab);
      const permission = await ensureTabOriginPermission(targetTab, { request: false });
      if (!permission.ok) {
        return {
          type: "execution_result",
          action_id: action.id || action.type,
          status: "error",
          target_verified: false,
          page_changed: false,
          validation_messages: [],
          log_message: permission.error
        };
      }
      await waitForTabSettled(targetTab.id);
      return tryObserveTabForAction(targetTab, action, {
        successMessage: `Observed known tab ${targetTab.url || targetTab.title || tabId}.`,
        errorMessage: `Could not observe known tab ${tabId}.`
      });
    } catch (error) {
      return {
        type: "execution_result",
        action_id: action.id || action.type,
        status: "error",
        target_verified: false,
        page_changed: false,
        validation_messages: [],
        log_message: error.message || `Could not access known tab ${tabId}.`
      };
    }
  }

  if (action?.type === "capture_viewport") {
    if (options.currentActiveTab?.id && options.currentActiveTab.id !== tab.id) {
      await chrome.tabs.update(tab.id, { active: true });
      await waitForTabSettled(tab.id);
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const ocrText = await extractViewportText(dataUrl);
    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: "success",
      target_verified: true,
      page_changed: false,
      artifact: {
        kind: "screenshot",
        dataUrl,
        ocrText
      },
      validation_messages: [],
      log_message: ocrText
        ? `Captured the visible viewport and extracted ${ocrText.length} OCR characters.`
        : "Captured the visible viewport."
    };
  }

  if (action?.type === "open_url") {
    const url = normalizeNavigationUrl(action.value || action.url);
    await chrome.tabs.update(tab.id, { url });
    await waitForTabSettled(tab.id);
    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: "success",
      target_verified: true,
      page_changed: true,
      validation_messages: [],
      log_message: `Opened ${url}.`
    };
  }

  if (action?.type === "open_url_new_tab") {
    const url = normalizeNavigationUrl(action.value || action.url);
    const created = await chrome.tabs.create({
      windowId: tab.windowId,
      url,
      active: false,
      ...(Number.isInteger(tab.index) ? { index: tab.index + 1 } : {})
    });
    const warmed = await maybeWarmOpenedTab(created, options.openInNewTabCount || 0);
    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: "success",
      target_verified: true,
      page_changed: false,
      validation_messages: [],
      log_message: warmed?.logMessage || `Opened ${url} in a new tab.`,
      artifact: {
        kind: "tab_opened",
        tabId: created?.id || null,
        url,
        title: warmed?.title || created?.title || "",
        accessStatus: warmed?.accessStatus || "known",
        observation: warmed?.observation || null
      }
    };
  }

  if (action?.type === "http_request") {
    const response = await runHttpRequest({
      url: action.value || action.url,
      method: action.method || "GET",
      headers: action.headers || {}
    });

    if (!response.ok) {
      return {
        type: "execution_result",
        action_id: action.id || action.type,
        status: "error",
        target_verified: false,
        page_changed: false,
        validation_messages: [],
        log_message: response.error
      };
    }

    const result = response.envelope.payload;
    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: result.status === "success" ? "success" : "error",
      target_verified: true,
      page_changed: false,
      artifact: {
        kind: "http_response",
        url: result.url,
        statusCode: result.statusCode,
        finalUrl: result.finalUrl,
        contentType: result.contentType,
        bodyPreview: result.bodyPreview,
        headers: result.headers
      },
      validation_messages: [],
      log_message: result.message
    };
  }

  if (action?.type === "web_search") {
    const response = await runWebSearch({
      query: action.value || action.query,
      limit: action.limit || 8
    });

    if (!response.ok) {
      return {
        type: "execution_result",
        action_id: action.id || action.type,
        status: "error",
        target_verified: false,
        page_changed: false,
        validation_messages: [],
        log_message: response.error
      };
    }

    const result = response.envelope.payload;
    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: result.status === "success" ? "success" : "error",
      target_verified: true,
      page_changed: false,
      artifact: {
        kind: "web_search",
        query: result.query,
        results: result.results
      },
      validation_messages: [],
      log_message: result.message
    };
  }

  if (action?.type === "capture_numbered_overlay") {
    if (options.currentActiveTab?.id && options.currentActiveTab.id !== tab.id) {
      await chrome.tabs.update(tab.id, { active: true });
      await waitForTabSettled(tab.id);
    }
    let overlayMap = [];
    let dataUrl = "";
    let captureError = "";

    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.__browserCompanionActions.showNumberedOverlay()
      });
      overlayMap = Array.isArray(result) ? result : [];

      try {
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      } catch (error) {
        captureError = error?.message || "Chrome blocked the viewport capture.";
      }
    } finally {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.__browserCompanionActions.clearNumberedOverlay()
      }).catch(() => undefined);
    }

    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: overlayMap.length ? "success" : "error",
      target_verified: true,
      page_changed: false,
      artifact: {
        kind: "numbered_overlay",
        dataUrl,
        overlayMap,
        captureError
      },
      validation_messages: [],
      log_message: overlayMap.length
        ? (
          dataUrl
            ? "Captured a numbered overlay of visible controls."
            : `Collected a numbered overlay map, but Chrome blocked the screenshot: ${captureError}`
        )
        : "Could not build the numbered overlay for the current page."
    };
  }

  if (action?.type === "go_back") {
    await chrome.tabs.goBack(tab.id);
    await waitForTabSettled(tab.id);
    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: "success",
      target_verified: true,
      page_changed: true,
      validation_messages: [],
      log_message: "Went back in the active tab."
    };
  }

  if (action?.type === "wait_for_page_change") {
    await waitForTabSettled(tab.id, action.timeoutMs || 10000);
    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: "success",
      target_verified: true,
      page_changed: true,
      validation_messages: [],
      log_message: "Waited for the page to settle."
    };
  }

  return null;
}

async function maybeWarmOpenedTab(tab, openInNewTabCount = 0) {
  const label = tab?.url || "the page";

  if (!tab?.id || openInNewTabCount > AUTO_OBSERVE_OPENED_TAB_LIMIT || !hasHttpUrl(tab?.url || "")) {
    return {
      accessStatus: "known",
      logMessage: `Opened ${label} in a new tab.`
    };
  }

  const hasPermission = await hasTabOriginPermission(tab);
  if (!hasPermission) {
    return {
      accessStatus: "needs_permission",
      logMessage: `Opened ${label} in a new tab. Observation is available on demand after site access is granted.`
    };
  }

  await waitForTabSettled(tab.id).catch(() => null);
  const observed = await tryObserveTabForAction(tab, {
    id: "auto_observe_opened_tab",
    type: "observe_page"
  }, {
    successMessage: `Opened ${label} in a new tab and warmed its content.`,
    errorMessage: `Opened ${label} in a new tab, but warming its content failed.`
  });

  if (observed?.status === "success" && observed.artifact?.observation) {
    return {
      accessStatus: "observed",
      title: observed.artifact.observation?.tab?.title || tab.title || "",
      observation: observed.artifact.observation,
      logMessage: observed.log_message
    };
  }

  return {
    accessStatus: "granted",
    title: tab.title || "",
    logMessage: observed?.log_message || `Opened ${label} in a new tab.`
  };
}

async function tryObserveTabForAction(tab, action, options = {}) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/content/page-probe.js"]
    });
    const observation = createObservation(
      {
        id: tab.id,
        url: tab.url,
        title: tab.title
      },
      result
    );
    const googleDocText = await maybeFetchGoogleDocText(tab, observation);
    const enrichedObservation = googleDocText
      ? {
          ...observation,
          visible_text: googleDocText.text,
          external_text_source: googleDocText.source,
          external_text_status: googleDocText.status
        }
      : observation;

    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: "success",
      target_verified: true,
      page_changed: false,
      artifact: {
        kind: "page_observation",
        observation: enrichedObservation
      },
      validation_messages: [],
      log_message: googleDocText
        ? (options.successMessage
            ? `${options.successMessage} Fetched Google Docs text from ${googleDocText.source}.`
            : `Observed the active tab and fetched Google Docs text from ${googleDocText.source}.`)
        : (options.successMessage || "Observed the active tab.")
    };
  } catch (error) {
    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: "error",
      target_verified: false,
      page_changed: false,
      validation_messages: [],
      log_message: error.message || options.errorMessage || "Could not observe the active tab."
    };
  }
}

async function maybeFetchGoogleDocText(tab, observation) {
  const url = tab.url || observation?.tab?.url || "";
  const docId = extractGoogleDocId(url);

  if (!docId || String(observation?.visible_text || "").length > 1200) {
    return null;
  }

  const candidates = [
    `https://docs.google.com/document/d/${docId}/export?format=txt`,
    `https://docs.google.com/document/d/${docId}/mobilebasic`
  ];

  for (const candidate of candidates) {
    const response = await runHttpRequest({ url: candidate, method: "GET" });
    const payload = response.ok ? response.envelope.payload : null;
    const text = cleanGoogleDocText(payload?.bodyPreview || "", payload?.contentType || "");

    if (payload?.ok && text.length > String(observation?.visible_text || "").length + 200) {
      return {
        source: payload.finalUrl || candidate,
        status: payload.statusCode,
        text
      };
    }
  }

  return null;
}

function extractGoogleDocId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "docs.google.com") {
      return "";
    }

    return parsed.pathname.match(/\/document\/d\/([^/]+)/)?.[1] || "";
  } catch {
    return "";
  }
}

function cleanGoogleDocText(body, contentType) {
  const raw = String(body || "");
  if (!raw) {
    return "";
  }

  if (/html/i.test(contentType) || /^\s*</.test(raw)) {
    return decodeHtml(raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  return raw.replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

async function extractViewportText(dataUrl) {
  try {
    const base64 = String(dataUrl || "").split(",").pop() || "";
    if (!base64) {
      return "";
    }

    const response = await extractAttachment({
      id: "viewport",
      name: "viewport.png",
      type: "image/png",
      size: Math.round(base64.length * 0.75),
      base64
    });

    return response.ok ? String(response.envelope.payload?.text || "").slice(0, 12000) : "";
  } catch {
    return "";
  }
}

function normalizeNavigationUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    throw new Error("Navigation URL is missing.");
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https navigation is allowed.");
  }

  return url.href;
}

async function waitForPotentialPageChange(tabId, beforeTabState, timeoutMs = 2500) {
  const startedAt = Date.now();
  let changed = false;

  while (Date.now() - startedAt < timeoutMs) {
    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    if (!currentTab) {
      return changed;
    }

    changed = changed || hasTabNavigationChanged(beforeTabState, currentTab);
    if (changed && currentTab.status === "complete") {
      return true;
    }

    await delay(changed ? 140 : 90);
  }

  const finalTab = await chrome.tabs.get(tabId).catch(() => null);
  return finalTab ? hasTabNavigationChanged(beforeTabState, finalTab) : changed;
}

function hasTabNavigationChanged(beforeTab, afterTab) {
  return normalizeTabNavigationValue(beforeTab?.url) !== normalizeTabNavigationValue(afterTab?.url)
    || normalizeTabNavigationValue(beforeTab?.title) !== normalizeTabNavigationValue(afterTab?.title);
}

function normalizeTabNavigationValue(value) {
  return String(value || "").trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabSettled(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let finished = false;
    const timeout = setTimeout(done, timeoutMs);

    function done() {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        done();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId)
      .then((currentTab) => {
        if (currentTab?.status === "complete") {
          setTimeout(done, 150);
        }
      })
      .catch(() => {
        done();
      });
  });
}

function sendNativeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, payload, (response) => {
      const lastError = chrome.runtime.lastError;

      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

function ensureNativePort() {
  if (nativePort) {
    return nativePort;
  }

  nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  nativePort.onMessage.addListener(handleNativePortMessage);
  nativePort.onDisconnect.addListener(handleNativePortDisconnect);
  return nativePort;
}

function postNativePortRequest(payload) {
  const port = ensureNativePort();
  const requestId = `native_${Date.now()}_${nativePortSequence++}`;
  const promise = new Promise((resolve, reject) => {
    nativePortPending.set(requestId, { resolve, reject });
  });

  try {
    port.postMessage({
      ...payload,
      requestId
    });
  } catch (error) {
    nativePortPending.delete(requestId);
    throw error;
  }

  return { requestId, promise };
}

function handleNativePortMessage(message) {
  if (message?.type === MESSAGE_TYPES.PROVIDER_PROGRESS) {
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.PROVIDER_PROGRESS,
      payload: message
    }).catch(() => {
      // Sidepanel may be closed; best effort only.
    });
    return;
  }

  const requestId = message?.requestId;
  if (!requestId || !nativePortPending.has(requestId)) {
    return;
  }

  const pending = nativePortPending.get(requestId);
  nativePortPending.delete(requestId);
  pending.resolve(message);
}

function handleNativePortDisconnect() {
  const lastError = chrome.runtime.lastError;
  const reason = lastError?.message || "Native host disconnected.";

  for (const pending of nativePortPending.values()) {
    pending.reject(new Error(reason));
  }

  nativePortPending.clear();
  nativePort = null;
  activeNativeRequestId = null;
}
