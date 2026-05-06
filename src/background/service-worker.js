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
