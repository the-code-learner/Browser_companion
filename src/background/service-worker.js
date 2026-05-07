import { MESSAGE_TYPES, NATIVE_HOST_NAME, makeEnvelope } from "../shared/messages.js";
import { createObservation } from "../shared/schemas.js";
import { validateActionPlan } from "../shared/policy.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

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

  if (message?.type === MESSAGE_TYPES.INSTALL_PROVIDER) {
    return installProvider(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.INSTALL_NODEJS) {
    return installNodejs();
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

  if (message?.type === MESSAGE_TYPES.VALIDATE_ACTION_PLAN) {
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.POLICY_RESULT, validateActionPlan(message.payload?.plan))
    };
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

async function requestAgent(payload) {
  try {
    const response = await sendNativeMessage({
      type: "agent_request",
      payload
    });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.AGENT_RESPONSE, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Provider agent request failed."
    };
  }
}

async function requestSynthesis(payload) {
  try {
    const response = await sendNativeMessage({
      type: "synthesis_request",
      payload
    });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.AGENT_RESPONSE, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Provider synthesis request failed."
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

  assertSupportedTab(tab);

  const results = [];
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];

  for (const action of actions) {
    if (needsTabScript(action)) {
      const permission = await ensureTabOriginPermission(tab);
      if (!permission.ok) {
        return {
          ok: false,
          error: permission.error
        };
      }
      await ensureActionScripts(tab.id);
    }

    const browserLevelResult = await executeBrowserLevelAction(tab, action);
    if (browserLevelResult) {
      results.push(browserLevelResult);
      continue;
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (browserAction) => window.__browserCompanionActions.execute(browserAction),
      args: [action]
    });
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

function needsTabScript(action) {
  return ![
    "open_url",
    "http_request",
    "web_search",
    "go_back",
    "wait_for_page_change"
  ].includes(action?.type);
}

async function ensureTabOriginPermission(tab) {
  if (!tab?.url) {
    return {
      ok: false,
      error: "No active tab URL is available."
    };
  }

  let originPattern;
  try {
    const url = new URL(tab.url);
    if (!["http:", "https:"].includes(url.protocol)) {
      return { ok: true };
    }
    originPattern = `${url.origin}/*`;
  } catch {
    return {
      ok: false,
      error: "The current page URL cannot be accessed."
    };
  }

  const hasPermission = await chrome.permissions.contains({
    origins: [originPattern]
  });

  if (hasPermission) {
    return { ok: true };
  }

  const granted = await chrome.permissions.request({
    origins: [originPattern]
  });

  return granted
    ? { ok: true }
    : {
        ok: false,
        error: `Site access was not granted for ${originPattern}.`
      };
}

async function executeBrowserLevelAction(tab, action) {
  if (action?.type === "observe_page" || action?.type === "get_visible_text" || action?.type === "get_links" || action?.type === "get_buttons" || action?.type === "get_forms" || action?.type === "get_dom_snapshot") {
    return tryObserveTabForAction(tab, action);
  }

  if (action?.type === "capture_viewport") {
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
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__browserCompanionActions.showNumberedOverlay()
    });
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const [{ result: overlayMap }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__browserCompanionActions.getOverlayMap()
    });
    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: "success",
      target_verified: true,
      page_changed: false,
      artifact: {
        kind: "numbered_overlay",
        dataUrl,
        overlayMap
      },
      validation_messages: [],
      log_message: "Captured a numbered overlay of visible controls."
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

async function tryObserveTabForAction(tab, action) {
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
        ? `Observed the active tab and fetched Google Docs text from ${googleDocText.source}.`
        : "Observed the active tab."
    };
  } catch (error) {
    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: "error",
      target_verified: false,
      page_changed: false,
      validation_messages: [],
      log_message: error.message || "Could not observe the active tab."
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

function waitForTabSettled(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(done, timeoutMs);

    function done() {
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
