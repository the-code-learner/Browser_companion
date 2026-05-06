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
    return connectCodex();
  }

  if (message?.type === MESSAGE_TYPES.EXTRACT_ATTACHMENT) {
    return extractAttachment(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.HTTP_REQUEST) {
    return runHttpRequest(message.payload);
  }

  if (message?.type === MESSAGE_TYPES.AGENT_REQUEST) {
    return requestAgent(message.payload);
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

async function connectCodex() {
  try {
    const response = await sendNativeMessage({ type: "connect" });
    return {
      ok: true,
      envelope: makeEnvelope(MESSAGE_TYPES.NATIVE_STATUS, response)
    };
  } catch (error) {
    return {
      ok: false,
      error: "Local connector is not installed or cannot start Codex login yet."
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
      error: error.message || "Codex agent request failed."
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

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content/actions.js"]
  });
  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ["src/content/overlay.css"]
  });

  const results = [];
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];

  for (const action of actions) {
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

async function executeBrowserLevelAction(tab, action) {
  if (action?.type === "capture_viewport") {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return {
      type: "execution_result",
      action_id: action.id || action.type,
      status: "success",
      target_verified: true,
      page_changed: false,
      artifact: {
        kind: "screenshot",
        dataUrl
      },
      validation_messages: [],
      log_message: "Captured the visible viewport."
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
