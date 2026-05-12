import { MESSAGE_TYPES, makeEnvelope } from "../shared/messages.js";

const HTTP_PROVIDER_DEFAULT_MAX_TOKENS = 24576;
const HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS = 49152;
const HTTP_PROVIDER_DEFAULT_TIMEOUT_MS = 360000;

const state = {
  view: "chat",
  settingsSection: "memory",
  theme: "system",
  connector: {
    status: "unknown",
    message: "Connector status has not been checked.",
    providers: [
      {
        id: "openai-codex",
        label: "Codex",
        status: "missing",
        statusLabel: "Missing",
        installed: false,
        connected: false,
        command: "codex",
        installCommand: "npm install -g @openai/codex",
        models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"],
        defaultModel: "gpt-5.5",
        message: "Codex CLI has not been detected."
      },
      {
        id: "anthropic-claude-code",
        label: "Claude Code",
        status: "missing",
        statusLabel: "Missing",
        installed: false,
        connected: false,
        command: "claude.cmd",
        installCommand: "npm install -g @anthropic-ai/claude-code",
        models: ["default", "opus", "sonnet", "haiku"],
        defaultModel: "default",
        message: "Claude Code CLI has not been detected."
      },
      {
        id: "google-gemini-cli",
        label: "Gemini CLI",
        status: "missing",
        statusLabel: "Missing",
        installed: false,
        connected: false,
        command: "gemini",
        installCommand: "npm install -g @google/gemini-cli",
        models: ["default"],
        defaultModel: "default",
        message: "Gemini CLI has not been detected."
      }
    ]
  },
  page: {
    status: "idle",
    title: "No page observed yet",
    url: "",
    summary: "Open a page and observe it before asking the agent to work with page context.",
    observation: null
  },
  attachments: [],
  messages: [
    {
      role: "assistant",
      text: "Tell me what you want to accomplish on the current page. I can observe the page first, then propose safe next steps.",
      createdAt: Date.now()
    }
  ],
  actionNotes: [],
  accessibleTabs: {},
  pendingPlan: null,
  pendingPlanContext: null,
  pendingPolicy: null,
  confirmationText: "",
  sessionApprovals: [],
  privacy: {
    persistSession: true,
    sendAttachmentsToCodex: true
  },
  codex: {
    provider: "openai-codex",
    model: "gpt-5.5"
  },
  httpProviders: [],
  httpProviderDraft: {
    id: "",
    name: "",
    baseUrl: "",
    username: "",
    password: "",
    model: "",
    useStreaming: false,
    maxTokens: HTTP_PROVIDER_DEFAULT_MAX_TOKENS,
    retryMaxTokens: HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS,
    timeoutMs: HTTP_PROVIDER_DEFAULT_TIMEOUT_MS
  },
  userMemory: {
    status: "unknown",
    message: "User memory has not been loaded.",
    path: "",
    items: [],
    draftTitle: "",
    draftContent: ""
  },
  pendingMemoryIntent: null,
  pendingMemoryProposal: null,
  composerDraft: "",
  outboundQueue: [],
  isProcessingQueue: false,
  stopProcessingRequested: false,
  stopRequestInFlight: false,
  currentProcessingMessageId: null,
  pendingSteeredMessageId: null,
  liveThinking: null,
  chatAtBottom: true,
  activity: [],
  debugLogs: []
};

const app = document.getElementById("app");
let connectorCheckInFlight = false;
let devWatchPollTimer = null;
let devWatchPollInFlight = false;
let devWatchFingerprint = "";
let devWatchInitialized = false;

const PROVIDER_VISIBLE_TEXT_LIMIT = 5000;
const PROVIDER_ELEMENT_LIMIT = 24;
const PROVIDER_FORM_LIMIT = 8;
const PROVIDER_FIELD_LIMIT = 12;
const PROVIDER_SELECTOR_LIMIT = 3;
const PROVIDER_VISIBLE_TEXT_HEAD_RATIO = 0.65;

initialize();

async function initialize() {
  await restoreProviderSettings();
  await restoreSession();
  applyTheme();
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  render();
  checkConnector();
  loadUserMemory();
  startDevAutoReloadPolling();
  window.addEventListener("beforeunload", stopDevAutoReloadPolling, { once: true });
}

function render() {
  app.innerHTML = `
    <section class="topbar">
      <button id="theme-toggle" class="theme-toggle" type="button" title="${escapeHtml(getThemeTitle())}">${escapeHtml(getThemeIcon())}</button>
      <div>
        <h1>Browser Companion</h1>
        <span class="title-line" aria-hidden="true"></span>
      </div>
      <div class="top-actions">
        <button id="open-settings-view" class="top-action icon-action" type="button" title="Settings" aria-label="Settings">&#9881;</button>
        <span class="status ${getConnectorClass()}">${escapeHtml(getConnectorStatusLabel())}</span>
      </div>
    </section>

    <section id="settings-view" class="settings-view" aria-label="Settings" ${state.view === "settings" ? "" : "hidden"}>
      <div class="settings-view-header">
        <button id="close-settings-view" class="top-action" type="button">Back</button>
        <div>
          <h2>Settings</h2>
          <p>${escapeHtml(getSettingsSubtitle())}</p>
        </div>
      </div>
      <nav class="settings-menu" aria-label="Settings sections">
        ${renderSettingsButton("memory", `Memory ${state.userMemory.items.length}`)}
        ${renderSettingsButton("attachments", `Attachments ${state.attachments.length}`)}
        ${renderSettingsButton("currentPage", "Current Page")}
        ${renderSettingsButton("connector", "Connector")}
        ${renderSettingsButton("privacy", "Privacy")}
        ${renderSettingsButton("activity", `Activity ${state.activity.length}`)}
        ${renderSettingsButton("logs", `Logs ${state.debugLogs.length}`)}
      </nav>
      <section class="settings-panel">
        ${renderSettingsPanel()}
      </section>
    </section>

    <details class="page-strip" aria-label="Current page">
      <summary>
        <span class="eyebrow">Current page</span>
        <strong>${escapeHtml(state.page.title)}</strong>
        <button id="observe-page" type="button">${escapeHtml(getObserveButtonText())}</button>
      </summary>
      <p>${escapeHtml(state.page.summary)}</p>
      ${state.page.url ? `<p class="memory-path">${escapeHtml(state.page.url)}</p>` : ""}
    </details>

    ${state.pendingPlan ? renderActionPreview() : ""}

    <section class="chat-log" aria-label="Chat messages">
      ${renderChatTimeline()}
    </section>
    <button id="jump-to-latest" class="jump-to-latest" type="button" title="Jump to latest message" aria-label="Jump to latest message" ${state.chatAtBottom ? "hidden" : ""}>&#8595;</button>

    ${renderLiveThinkingPanel()}
    ${renderComposer()}
  `;

  document.getElementById("observe-page").addEventListener("click", observePage);
  const observePageSettings = document.getElementById("observe-page-settings");
  if (observePageSettings) observePageSettings.addEventListener("click", observePage);
  document.getElementById("theme-toggle").addEventListener("click", cycleTheme);
  document.getElementById("open-settings-view").addEventListener("click", () => {
    openSettingsSection(state.settingsSection);
  });
  document.getElementById("close-settings-view").addEventListener("click", () => {
    state.view = "chat";
    render();
  });
  document.querySelectorAll("[data-settings-section]").forEach((button) => {
    button.addEventListener("click", () => {
      openSettingsSection(button.dataset.settingsSection);
    });
  });
  setupChatScrollControls();
  const checkConnectorButton = document.getElementById("check-connector");
  if (checkConnectorButton) checkConnectorButton.addEventListener("click", checkConnector);
  const connectCodexButton = document.getElementById("connect-codex");
  if (connectCodexButton) connectCodexButton.addEventListener("click", () => connectProvider(state.codex.provider));
  document.querySelectorAll("[data-connect-provider]").forEach((button) => {
    button.addEventListener("click", () => connectProvider(button.dataset.connectProvider));
  });
  document.querySelectorAll("[data-install-provider]").forEach((button) => {
    button.addEventListener("click", () => installProvider(button.dataset.installProvider));
  });
  document.querySelectorAll("[data-copy-provider-command]").forEach((button) => {
    button.addEventListener("click", () => copyProviderInstallCommand(button.dataset.copyProviderCommand));
  });
  const installNodejsButton = document.getElementById("install-nodejs");
  if (installNodejsButton) installNodejsButton.addEventListener("click", installNodejs);
  const httpProviderForm = document.getElementById("http-provider-form");
  if (httpProviderForm) httpProviderForm.addEventListener("submit", saveHttpProviderFromForm);
  const testHttpProviderButton = document.getElementById("test-http-provider");
  if (testHttpProviderButton) testHttpProviderButton.addEventListener("click", testHttpProviderFromForm);
  const cancelHttpProviderEditButton = document.getElementById("cancel-http-provider-edit");
  if (cancelHttpProviderEditButton) cancelHttpProviderEditButton.addEventListener("click", cancelHttpProviderEdit);
  document.querySelectorAll("[data-http-provider-edit]").forEach((button) => {
    button.addEventListener("click", () => editHttpProvider(button.dataset.httpProviderEdit));
  });
  document.querySelectorAll("[data-http-provider-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteHttpProvider(button.dataset.httpProviderDelete));
  });
  const copyInstallCommand = document.getElementById("copy-install-command");
  if (copyInstallCommand) {
    copyInstallCommand.addEventListener("click", copyConnectorInstallCommand);
  }
  const openExtensions = document.getElementById("open-extensions");
  if (openExtensions) {
    openExtensions.addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions" }));
  }
  const codexModel = document.getElementById("codex-model");
  if (codexModel) codexModel.addEventListener("change", async (event) => {
    const previousModel = state.codex.model;
    state.codex.model = event.target.value;
    state.activity.unshift(`Model set to ${state.codex.model}.`);
    persistConnectorSelection();
    render();
    await maybeOfferHttpModelUnload(previousModel, state.codex.model);
  });
  const providerSelect = document.getElementById("provider-select");
  if (providerSelect) providerSelect.addEventListener("change", (event) => {
    state.codex.provider = event.target.value;
    const provider = getSelectedProviderStatus();
    state.codex.model = provider?.defaultModel || provider?.models?.[0] || "default";
    state.activity.unshift(`Provider set to ${provider?.label || state.codex.provider}.`);
    persistConnectorSelection();
    render();
  });
  const clearActivityButton = document.getElementById("clear-activity");
  if (clearActivityButton) clearActivityButton.addEventListener("click", () => {
    state.activity = [];
    persistSession();
    render();
  });
  const clearLogsButton = document.getElementById("clear-logs");
  if (clearLogsButton) clearLogsButton.addEventListener("click", clearDebugLogs);
  const copyLogsButton = document.getElementById("copy-logs");
  if (copyLogsButton) copyLogsButton.addEventListener("click", copyDebugLogs);
  const clearAttachmentsButton = document.getElementById("clear-attachments");
  if (clearAttachmentsButton) clearAttachmentsButton.addEventListener("click", clearAttachments);
  document.querySelectorAll("[data-remove-attachment]").forEach((button) => {
    button.addEventListener("click", () => removeAttachment(button.dataset.removeAttachment));
  });
  document.querySelectorAll("[data-memory-edit]").forEach((button) => {
    button.addEventListener("click", () => startMemoryEdit(button.dataset.memoryEdit));
  });
  document.querySelectorAll("[data-memory-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteMemoryItem(button.dataset.memoryDelete));
  });
  const memoryViewForm = document.getElementById("memory-view-form");
  if (memoryViewForm) memoryViewForm.addEventListener("submit", saveMemoryFromViewForm);
  const memoryViewTitle = document.getElementById("memory-view-title");
  if (memoryViewTitle) memoryViewTitle.addEventListener("input", (event) => {
    state.userMemory.draftTitle = event.target.value;
  });
  const memoryViewContent = document.getElementById("memory-view-content");
  if (memoryViewContent) memoryViewContent.addEventListener("input", (event) => {
    state.userMemory.draftContent = event.target.value;
  });
  const clearSessionButton = document.getElementById("clear-session");
  if (clearSessionButton) clearSessionButton.addEventListener("click", clearSession);
  const persistSessionInput = document.getElementById("persist-session");
  if (persistSessionInput) persistSessionInput.addEventListener("change", (event) => {
    state.privacy.persistSession = event.target.checked;
    persistSession();
    render();
  });
  const sendAttachmentsInput = document.getElementById("send-attachments");
  if (sendAttachmentsInput) sendAttachmentsInput.addEventListener("change", (event) => {
    state.privacy.sendAttachmentsToCodex = event.target.checked;
    persistSession();
  });
  document.getElementById("attachment-input").addEventListener("change", handleAttachments);
  document.getElementById("chat-form").addEventListener("submit", handleChatSubmit);
  document.getElementById("chat-input").addEventListener("input", handleComposerInput);
  document.getElementById("chat-input").addEventListener("keydown", handleComposerKeydown);
  const stopProcessingButton = document.getElementById("stop-processing");
  if (stopProcessingButton) stopProcessingButton.addEventListener("click", stopCurrentProcessing);
  document.querySelectorAll("[data-steer-message]").forEach((button) => {
    button.addEventListener("click", () => steerQueuedMessage(button.dataset.steerMessage));
  });

  if (state.pendingPlan) {
    document.getElementById("confirm-plan").addEventListener("click", confirmPendingPlan);
    document.getElementById("cancel-plan").addEventListener("click", cancelPendingPlan);
    const sessionApprovalButton = document.getElementById("approve-plan-session");
    if (sessionApprovalButton) {
      sessionApprovalButton.addEventListener("click", () => confirmPendingPlan({ approvalScope: "session" }));
    }
    const confirmationInput = document.getElementById("confirmation-text");
    if (confirmationInput) {
      confirmationInput.addEventListener("input", (event) => {
        state.confirmationText = event.target.value.trim();
        updateConfirmButtonState();
      });
    }
  }
}

function cycleTheme() {
  const order = ["system", "light", "dark"];
  const currentIndex = order.indexOf(state.theme);
  state.theme = order[(currentIndex + 1) % order.length];
  applyTheme();
  chrome.storage.local.set({ browserCompanionTheme: state.theme });
  render();
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
}

function getThemeIcon() {
  if (state.theme === "dark") return "D";
  if (state.theme === "light") return "L";
  return "S";
}

function getThemeTitle() {
  if (state.theme === "dark") return "Theme: dark";
  if (state.theme === "light") return "Theme: light";
  return "Theme: system";
}

function getSettingsSubtitle() {
  const labels = {
    memory: "Saved user context",
    attachments: "Local files",
    currentPage: "Observed page",
    connector: "Local provider connector",
    privacy: "Session controls",
    activity: "Recent events",
    logs: "Detailed diagnostics"
  };

  return labels[state.settingsSection] || "Settings";
}

function openSettingsSection(section) {
  state.settingsSection = section || state.settingsSection || "memory";
  state.view = "settings";
  render();

  if (state.settingsSection === "connector") {
    queueConnectorRefresh();
  }
}

function queueConnectorRefresh() {
  if (connectorCheckInFlight) {
    return;
  }

  setTimeout(() => {
    checkConnector();
  }, 0);
}

function startDevAutoReloadPolling() {
  if (devWatchPollTimer) {
    return;
  }

  void checkDevAutoReloadStatus();
  devWatchPollTimer = window.setInterval(() => {
    void checkDevAutoReloadStatus();
  }, 2500);
}

function stopDevAutoReloadPolling() {
  if (!devWatchPollTimer) {
    return;
  }

  window.clearInterval(devWatchPollTimer);
  devWatchPollTimer = null;
}

async function checkDevAutoReloadStatus() {
  if (devWatchPollInFlight) {
    return;
  }

  devWatchPollInFlight = true;

  try {
    const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.DEV_WATCH_STATUS));
    if (!response.ok) {
      return;
    }

    const payload = response.envelope?.payload || {};
    if (!payload.enabled || !payload.fingerprint) {
      return;
    }

    if (!devWatchInitialized) {
      devWatchFingerprint = payload.fingerprint;
      devWatchInitialized = true;
      return;
    }

    if (payload.fingerprint === devWatchFingerprint) {
      return;
    }

    devWatchFingerprint = payload.fingerprint;
    persistSession();
    chrome.runtime.reload();
  } finally {
    devWatchPollInFlight = false;
  }
}

function renderSettingsButton(section, label) {
  const selected = state.settingsSection === section ? "selected" : "";
  return `<button type="button" data-settings-section="${escapeHtml(section)}" class="${selected}">${escapeHtml(label)}</button>`;
}

function renderSettingsPanel() {
  if (state.settingsSection === "attachments") return renderAttachmentsSettings();
  if (state.settingsSection === "currentPage") return renderCurrentPageSettings();
  if (state.settingsSection === "connector") return renderConnectorSettings();
  if (state.settingsSection === "privacy") return renderPrivacySettings();
  if (state.settingsSection === "activity") return renderActivitySettings();
  if (state.settingsSection === "logs") return renderLogsSettings();
  return renderMemorySettings();
}

function renderMemorySettings() {
  return `
    <p>${escapeHtml(state.userMemory.message)}</p>
    ${state.userMemory.path ? `<p class="memory-path">${escapeHtml(state.userMemory.path)}</p>` : ""}
    <form id="memory-view-form" class="memory-form">
      <input id="memory-view-title" type="text" placeholder="Title" value="${escapeHtml(state.userMemory.draftTitle)}">
      <textarea id="memory-view-content" rows="7" placeholder="Only save information the user explicitly asked to remember">${escapeHtml(state.userMemory.draftContent)}</textarea>
      <button type="submit">Save Memory</button>
    </form>
    <ul class="memory-list full">
      ${state.userMemory.items.length ? state.userMemory.items.map(renderMemoryItem).join("") : "<li>No saved user memory.</li>"}
    </ul>
  `;
}

function renderAttachmentsSettings() {
  return `
    <ul class="compact-list">
      ${state.attachments.length ? state.attachments.map(renderAttachment).join("") : "<li>No files attached.</li>"}
    </ul>
    ${state.attachments.length ? `<button id="clear-attachments" type="button" class="wide-button">Clear Attachments</button>` : ""}
  `;
}

function renderCurrentPageSettings() {
  return `
    <div class="settings-card">
      <span class="eyebrow">Current page</span>
      <strong>${escapeHtml(state.page.title)}</strong>
      <p>${escapeHtml(state.page.summary)}</p>
      ${state.page.url ? `<p class="memory-path">${escapeHtml(state.page.url)}</p>` : ""}
    </div>
    <button id="observe-page-settings" type="button">${escapeHtml(getObserveButtonText())}</button>
  `;
}

function getObserveButtonText() {
  const summary = String(state.page.summary || "");
  if (state.page.status === "error" && /site access|Chrome could not show|not granted/i.test(summary)) {
    return "Grant Site Access";
  }

  if (state.page.status === "observing") {
    return "Observing...";
  }

  return "Observe";
}

function renderConnectorSettings() {
  return `
    <div class="button-row">
      <button id="check-connector" type="button">Check</button>
      <button id="connect-codex" type="button">Connect Selected</button>
    </div>
    <p>${escapeHtml(state.connector.message)}</p>
    <label class="field-stack">
      <span>Provider</span>
      <select id="provider-select">
        ${renderProviderOptions()}
      </select>
    </label>
    <label class="field-stack">
      <span>Model</span>
      <select id="codex-model">
        ${renderModelOptions()}
      </select>
    </label>
    ${["missing", "error", "unknown"].includes(state.connector.status) ? "" : `
      <div class="provider-list">
        ${renderProviderCards()}
      </div>
    `}
    ${renderHttpProviderSettings()}
    ${renderProviderPrerequisites()}
    ${renderConnectorSetup()}
  `;
}

function renderHttpProviderSettings() {
  return `
    <div class="connector-help">
      <strong>OpenAI-compatible HTTP provider</strong>
      <p>Use this for a local or private server such as llama.cpp, LocalAI, LiteLLM, vLLM, or a custom OpenAI-compatible proxy. Observed page content can be sent to this URL when selected.</p>
      <form id="http-provider-form" class="memory-form">
        <input id="http-provider-name" type="text" placeholder="Name" value="${escapeHtml(state.httpProviderDraft.name)}">
        <input id="http-provider-base-url" type="url" placeholder="Base URL, e.g. http://192.168.0.10:8080" value="${escapeHtml(state.httpProviderDraft.baseUrl)}">
        <input id="http-provider-username" type="text" placeholder="Basic auth username" value="${escapeHtml(state.httpProviderDraft.username)}">
        <input id="http-provider-password" type="password" placeholder="Basic auth password" value="${escapeHtml(state.httpProviderDraft.password)}">
        ${renderHttpProviderModelControl()}
        <div class="button-row">
          <label class="field-stack compact-field">
            <span>Max tokens</span>
            <input id="http-provider-max-tokens" type="number" min="1" step="1" value="${escapeHtml(String(state.httpProviderDraft.maxTokens ?? HTTP_PROVIDER_DEFAULT_MAX_TOKENS))}">
          </label>
          <label class="field-stack compact-field">
            <span>Retry max tokens</span>
            <input id="http-provider-retry-max-tokens" type="number" min="1" step="1" value="${escapeHtml(String(state.httpProviderDraft.retryMaxTokens ?? HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS))}">
          </label>
          <label class="field-stack compact-field">
            <span>Request timeout (ms)</span>
            <input id="http-provider-timeout-ms" type="number" min="1000" step="1000" value="${escapeHtml(String(state.httpProviderDraft.timeoutMs ?? HTTP_PROVIDER_DEFAULT_TIMEOUT_MS))}">
          </label>
        </div>
        <label class="toggle-row">
          <input id="http-provider-use-streaming" type="checkbox" ${state.httpProviderDraft.useStreaming ? "checked" : ""}>
          <span>Use streaming responses when the server supports them</span>
        </label>
        <div class="button-row">
          <button id="test-http-provider" type="button">Refresh Models</button>
          <button type="submit">${state.httpProviderDraft.id ? "Save Changes" : "Save HTTP Provider"}</button>
          ${state.httpProviderDraft.id ? `<button id="cancel-http-provider-edit" type="button">Cancel Edit</button>` : ""}
        </div>
      </form>
      <ul class="compact-list">
        ${state.httpProviders.length ? state.httpProviders.map(renderHttpProviderItem).join("") : "<li>No HTTP providers saved.</li>"}
      </ul>
    </div>
  `;
}

function renderHttpProviderModelControl() {
  const models = state.httpProviderDraft.models || [];
  if (!models.length) {
    return `<input id="http-provider-model" type="text" placeholder="Model, filled by Test if available" value="${escapeHtml(state.httpProviderDraft.model)}">`;
  }

  const options = models.map((model) => {
    const selected = model === state.httpProviderDraft.model ? "selected" : "";
    return `<option value="${escapeHtml(model)}" ${selected}>${escapeHtml(model)}</option>`;
  }).join("");

  return `
    <label class="field-stack compact-field">
      <span>HTTP model</span>
      <select id="http-provider-model">${options}</select>
    </label>
  `;
}

function renderHttpProviderItem(provider) {
  const extras = [
    provider.useStreaming ? "streaming on" : "",
    provider.maxTokens ? `max ${provider.maxTokens}` : "",
    provider.retryMaxTokens ? `retry ${provider.retryMaxTokens}` : "",
    provider.timeoutMs ? `${provider.timeoutMs} ms timeout` : ""
  ].filter(Boolean).join(" - ");

  return `
    <li>
      <strong>${escapeHtml(provider.name)}</strong>
      <span>${escapeHtml(provider.baseUrl)} - ${escapeHtml(provider.model || "No model selected")}${extras ? ` - ${escapeHtml(extras)}` : ""}</span>
      <div class="button-row">
        <button type="button" data-http-provider-edit="${escapeHtml(provider.id)}">Edit</button>
        <button type="button" data-http-provider-delete="${escapeHtml(provider.id)}">Delete</button>
      </div>
    </li>
  `;
}

function makeDefaultHttpProviderDraft() {
  return {
    id: "",
    name: "",
    baseUrl: "",
    username: "",
    password: "",
    model: "",
    useStreaming: false,
    maxTokens: HTTP_PROVIDER_DEFAULT_MAX_TOKENS,
    retryMaxTokens: HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS,
    timeoutMs: HTTP_PROVIDER_DEFAULT_TIMEOUT_MS
  };
}

function sanitizePositiveInteger(value, fallback, defaultValue, min = 1) {
  const parsed = Number.parseInt(String(value ?? fallback ?? defaultValue), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return defaultValue;
  }
  return parsed;
}

function renderPrivacySettings() {
  return `
    <button id="clear-session" type="button">Clear Session</button>
    <label class="toggle-row">
      <input id="persist-session" type="checkbox" ${state.privacy.persistSession ? "checked" : ""}>
      <span>Persist this local session in Chrome storage</span>
    </label>
    <label class="toggle-row">
      <input id="send-attachments" type="checkbox" ${state.privacy.sendAttachmentsToCodex ? "checked" : ""}>
      <span>Allow extracted attachment text in provider requests</span>
    </label>
  `;
}

function renderActivitySettings() {
  return `
    <button id="clear-activity" type="button">Clear</button>
    <ol class="activity-list">
      ${state.activity.length ? state.activity.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : "<li>No actions yet.</li>"}
    </ol>
  `;
}

function renderLogsSettings() {
  return `
    <div class="button-row">
      <button id="copy-logs" type="button">Copy Logs</button>
      <button id="clear-logs" type="button">Clear Logs</button>
    </div>
    <ol class="debug-log-list">
      ${state.debugLogs.length ? state.debugLogs.map(renderDebugLog).join("") : "<li>No diagnostic logs yet.</li>"}
    </ol>
  `;
}

function renderDebugLog(entry) {
  return `
    <li>
      <details>
        <summary>
          <span>${escapeHtml(entry.time || "")}</span>
          <strong>${escapeHtml(entry.event || "event")}</strong>
          ${entry.summary ? `<em>${escapeHtml(entry.summary)}</em>` : ""}
        </summary>
        <pre>${escapeHtml(JSON.stringify(entry.data || {}, null, 2))}</pre>
      </details>
    </li>
  `;
}

function summarizeObservationForLog(observation = {}) {
  return {
    url: observation.tab?.url || "",
    title: observation.tab?.title || "",
    viewport: observation.viewport || {},
    visibleTextLength: String(observation.visible_text || "").length,
    links: observation.links?.length || 0,
    buttons: observation.buttons?.length || 0,
    forms: observation.forms?.length || 0
  };
}

function renderComposer() {
  const queueLabel = state.isProcessingQueue
    ? (state.outboundQueue.length ? `Working, ${state.outboundQueue.length} queued` : "Working")
    : (state.outboundQueue.length ? `${state.outboundQueue.length} queued` : "");
  const submitLabel = state.isProcessingQueue ? "Queue" : "Send";
  const stopButton = state.isProcessingQueue
    ? `<button id="stop-processing" type="button" class="composer-stop" ${state.stopRequestInFlight ? "disabled" : ""}>${escapeHtml(state.stopRequestInFlight ? "Stopping..." : "Stop")}</button>`
    : "";

  return `
    <div class="composer-wrap">
      <form id="chat-form" class="composer">
        <label class="file-input">
          <input id="attachment-input" type="file" multiple>
          <span>Attach</span>
        </label>
        <textarea id="chat-input" rows="3" placeholder="Describe your goal on this page">${escapeHtml(state.composerDraft)}</textarea>
        ${stopButton}
        <button type="submit">${escapeHtml(submitLabel)}</button>
      </form>
      ${queueLabel ? `<p class="composer-meta">${escapeHtml(queueLabel)}</p>` : ""}
    </div>
  `;
}

function renderLiveThinkingPanel() {
  if (!state.liveThinking?.text) {
    return "";
  }

  return `
    <div class="live-thinking-wrap">
      <details class="action-note action-thinking" open>
        <summary>Thinking</summary>
        <ul><li>${escapeHtml(state.liveThinking.text)}</li></ul>
      </details>
    </div>
  `;
}

function setupChatScrollControls() {
  const chatLog = document.querySelector(".chat-log");
  const jumpButton = document.getElementById("jump-to-latest");

  if (!chatLog || !jumpButton) {
    return;
  }

  const update = () => {
    const distanceFromBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight;
    const atBottom = distanceFromBottom < 48;
    state.chatAtBottom = atBottom;
    jumpButton.hidden = atBottom;
  };

  chatLog.addEventListener("scroll", update);
  jumpButton.addEventListener("click", () => {
    chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: "smooth" });
    state.chatAtBottom = true;
    jumpButton.hidden = true;
  });

  requestAnimationFrame(() => {
    if (state.chatAtBottom) {
      chatLog.scrollTop = chatLog.scrollHeight;
    }
    update();
  });
}

function handleComposerKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey) {
    return;
  }

  event.preventDefault();
  document.getElementById("chat-form").requestSubmit();
}

function handleComposerInput(event) {
  state.composerDraft = event.target.value;
}

function updateConfirmButtonState() {
  const button = document.getElementById("confirm-plan");
  const sessionButton = document.getElementById("approve-plan-session");
  if (!button || !state.pendingPlan) {
    return;
  }

  const highestRisk = getHighestRisk(state.pendingPolicy);
  const needsTypedConfirmation = highestRisk === "sensitive";
  const requiredPhrase = getRequiredConfirmationPhrase(highestRisk, state.pendingPlan);
  const disabled = !state.pendingPolicy?.allowed || (needsTypedConfirmation && state.confirmationText !== requiredPhrase);
  button.disabled = disabled;
  if (sessionButton) {
    sessionButton.disabled = disabled;
  }
}

function renderMessage(message) {
  if (message.role === "assistant" && message.variant === "error") {
    return renderErrorNote(message);
  }

  const status = getQueuedMessageStatusLabel(message);
  const steerState = getQueuedMessageSteerState(message);
  return `
    <article class="message ${message.role}">
      <div class="message-head">
        <span>${message.role === "user" ? "You" : "Companion"}</span>
        <div class="message-tools">
          ${status ? `<em class="message-status">${escapeHtml(status)}</em>` : ""}
          ${renderSteerButton(message, steerState)}
        </div>
      </div>
      ${renderMessageThinking(message)}
      ${renderMessageContent(message)}
    </article>
  `;
}

function renderErrorNote(message) {
  const details = buildErrorNoteDetails(message);
  const items = details.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  return `
    <div class="message-error-stack">
      <details class="action-note action-error">
        <summary>${escapeHtml(getErrorNoteSummary(message))}</summary>
        <ul>${items}</ul>
      </details>
      ${renderMessageThinking(message)}
    </div>
  `;
}

function getErrorNoteSummary(message) {
  const raw = String(message?.text || "").trim();

  if (/timeout|timed out|aborted due to timeout/i.test(raw)) {
    return "Provider request timed out";
  }

  return "Provider error";
}

function buildErrorNoteDetails(message) {
  const details = [];
  const text = compact(String(message?.text || "").trim());
  if (text) {
    details.push(text);
  }

  if (String(message?.thinking || "").trim()) {
    details.push("The model had started reasoning before the request stopped.");
  }

  return details.length ? details : ["The provider request failed before a usable response was returned."];
}

function renderMessageContent(message) {
  return `<div class="message-body">${renderRichText(message.text)}</div>`;
}

function renderMessageThinking(message) {
  if (message.role !== "assistant" || !String(message.thinking || "").trim()) {
    return "";
  }

  return `
    <details class="action-note message-thinking">
      <summary>Thinking</summary>
      <div class="message-thinking-body">${renderRichText(message.thinking)}</div>
    </details>
  `;
}

function renderSteerButton(message, steerState) {
  if (message.role !== "user" || steerState === "hidden") {
    return "";
  }

  const disabled = steerState === "next" ? "disabled" : "";
  const title = steerState === "next" ? "This queued message is already next." : "Move this queued message to the front.";
  return `<button type="button" class="message-steer" data-steer-message="${escapeHtml(message.id)}" title="${escapeHtml(title)}" ${disabled}>Steer</button>`;
}

function renderChatTimeline() {
  const items = [
    ...state.messages.map((item) => ({ kind: "message", createdAt: item.createdAt || 0, item })),
    ...getQueuedMessageTimelineEntries().map((item) => ({ kind: "message", createdAt: item.createdAt || 0, item })),
    ...(state.liveThinking?.text ? [{
      kind: "note",
      createdAt: state.liveThinking.createdAt || Date.now(),
      item: {
        summary: "Thinking",
        details: [state.liveThinking.text],
        variant: "thinking",
        open: true
      }
    }] : []),
    ...state.actionNotes.map((item) => ({ kind: "note", createdAt: item.createdAt || 0, item }))
  ].sort((a, b) => a.createdAt - b.createdAt);

  return items.map((entry) => entry.kind === "message" ? renderMessage(entry.item) : renderActionNote(entry.item)).join("");
}

function getQueuedMessageTimelineEntries() {
  return state.outboundQueue
    .filter((item) => !isQueuedMessageMaterialized(item.messageId))
    .map((item) => ({
      id: item.messageId,
      role: "user",
      text: item.text,
      createdAt: item.createdAt,
      queueStatus: item.queueStatus || "queued"
    }));
}

function renderActionNote(note) {
  const details = note.details.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  const variantClass = note.variant === "thinking" ? " action-thinking" : "";
  const openAttr = note.open ? " open" : "";
  return `
    <details class="action-note${variantClass}"${openAttr}>
      <summary>${escapeHtml(note.summary)}</summary>
      <ul>${details}</ul>
    </details>
  `;
}

function renderRichText(text) {
  const raw = String(text || "");
  const parts = raw.split(/```mermaid\s*([\s\S]*?)```/i);
  let html = "";

  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2 === 1) {
      html += renderMermaidBlock(parts[index]);
    } else {
      html += renderMarkdown(parts[index]);
    }
  }

  return html || "<p></p>";
}

function renderMarkdown(text) {
  const blocks = String(text || "").split(/\n{2,}/);

  return blocks.map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return "";

    if (/^```/.test(trimmed)) {
      return `<pre><code>${escapeHtml(trimmed.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, ""))}</code></pre>`;
    }

    if (/^#{1,3}\s+/.test(trimmed)) {
      const level = Math.min(trimmed.match(/^#+/)?.[0].length || 2, 3);
      return `<h${level + 2}>${renderInlineMarkdown(trimmed.replace(/^#{1,3}\s+/, ""))}</h${level + 2}>`;
    }

    if (/^[-*]\s+/m.test(trimmed)) {
      const items = trimmed.split(/\n/).filter(Boolean).map((line) => `<li>${renderInlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`).join("");
      return `<ul>${items}</ul>`;
    }

    if (/^\d+\.\s+/m.test(trimmed)) {
      const items = trimmed.split(/\n/).filter(Boolean).map((line) => `<li>${renderInlineMarkdown(line.replace(/^\d+\.\s+/, ""))}</li>`).join("");
      return `<ol>${items}</ol>`;
    }

    return `<p>${renderInlineMarkdown(trimmed).replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function renderMermaidBlock(source) {
  const diagram = encodeURIComponent(source.trim());
  return `
    <figure class="mermaid-block">
      <img alt="Mermaid diagram" src="https://mermaid.ink/svg/${diagram}">
      <figcaption>Mermaid diagram</figcaption>
    </figure>
  `;
}

function renderActionPreview() {
  const policy = state.pendingPolicy;
  const blocked = policy && !policy.allowed;
  const highestRisk = getHighestRisk(policy);
  const confirmation = getConfirmationLabel(highestRisk, policy);
  const needsTypedConfirmation = highestRisk === "sensitive";
  const canApproveSession = canOfferSessionApproval(state.pendingPlan, policy, state.pendingPlanContext);
  const requiredPhrase = getRequiredConfirmationPhrase(highestRisk, state.pendingPlan);
  const confirmDisabled = blocked || (needsTypedConfirmation && state.confirmationText !== requiredPhrase);

  return `
    <section class="action-preview" aria-label="Action preview">
      <div class="section-title">
        <div>
          <h2>Action Preview</h2>
          <p>${escapeHtml(confirmation)}</p>
        </div>
        <span class="risk ${escapeHtml(state.pendingPlan.risk_level)}">${escapeHtml(state.pendingPlan.risk_level)}</span>
      </div>
      <p>${escapeHtml(state.pendingPlan.summary_for_user)}</p>
      <ul class="compact-list">
        ${state.pendingPlan.actions.map(renderAction).join("")}
      </ul>
      ${renderPolicyDetails(policy)}
      ${needsTypedConfirmation ? `
        <label class="confirmation-box">
          <span>Type ${escapeHtml(requiredPhrase)} to continue</span>
          <input id="confirmation-text" type="text" value="${escapeHtml(state.confirmationText)}" autocomplete="off">
        </label>
      ` : ""}
      ${canApproveSession ? `
        <p class="approval-scope-note">You can approve these similar actions for this site for the rest of the current local session.</p>
      ` : ""}
      <div class="preview-actions">
        <button id="cancel-plan" type="button">Cancel</button>
        ${canApproveSession ? `<button id="approve-plan-session" type="button" ${confirmDisabled ? "disabled" : ""}>Approve Similar for Session</button>` : ""}
        <button id="confirm-plan" type="button" ${confirmDisabled ? "disabled" : ""}>${escapeHtml(getConfirmButtonText(highestRisk, state.pendingPlan))}</button>
      </div>
    </section>
  `;
}

function renderPolicyDetails(policy) {
  if (!policy?.results?.length) {
    return "";
  }

  return `
    <ul class="policy-list">
      ${policy.results.map((result) => `<li><strong>${escapeHtml(result.risk)}</strong><span>${escapeHtml(result.reason)}</span></li>`).join("")}
    </ul>
  `;
}

function renderAction(action) {
  const target = action.target?.name ? ` on ${action.target.name}` : "";
  return `<li><strong>${escapeHtml(action.type)}${escapeHtml(target)}</strong><span>${escapeHtml(action.reason || "")}</span></li>`;
}

function renderAttachment(file) {
  const detail = file.message
    || (file.warnings || [])[0]
    || (file.status === "error" ? "Attachment extraction failed. Reattach the file to retry with the current extractor." : "");

  return `
    <li class="attachment-item">
      <div>
        <strong>${escapeHtml(file.name)}</strong>
        <span>${escapeHtml(file.status)} - ${formatBytes(file.size)}</span>
        ${detail ? `<small class="attachment-detail">${escapeHtml(detail)}</small>` : ""}
      </div>
      <button type="button" class="remove-item-button" data-remove-attachment="${escapeHtml(file.id)}">Remove</button>
    </li>
  `;
}

function renderMemoryItem(item) {
  return `
    <li>
      <strong>${escapeHtml(item.title || "User note")}</strong>
      <p>${escapeHtml(item.content || "")}</p>
      <div class="button-row">
        <button type="button" data-memory-edit="${escapeHtml(item.id)}">Edit</button>
        <button type="button" data-memory-delete="${escapeHtml(item.id)}">Delete</button>
      </div>
    </li>
  `;
}

function renderModelOptions() {
  const provider = getSelectedProviderStatus();
  const models = provider?.models?.length ? provider.models : getDefaultProviderStatus("openai-codex").models;

  return models.map((model) => {
    const selected = model === state.codex.model ? "selected" : "";
    return `<option value="${escapeHtml(model)}" ${selected}>${escapeHtml(model)}</option>`;
  }).join("");
}

function renderProviderOptions() {
  const connected = state.connector.providers.filter((provider) => provider.connected);
  const providers = connected.length ? connected : state.connector.providers;

  return providers.map((provider) => {
    const selected = provider.id === state.codex.provider ? "selected" : "";
    const disabled = provider.connected ? "" : "disabled";
    const suffix = provider.connected ? "" : ` (${provider.statusLabel || "unavailable"})`;
    return `<option value="${escapeHtml(provider.id)}" ${selected} ${disabled}>${escapeHtml(provider.label + suffix)}</option>`;
  }).join("");
}

function renderProviderCards() {
  return state.connector.providers.map((provider) => {
    const status = provider.statusLabel || provider.status || "unknown";
    const canConnect = provider.installed && !provider.connected;
    const selected = provider.id === state.codex.provider ? " selected" : "";

    return `
      <article class="provider-card${selected}">
        <div>
          <strong>${escapeHtml(provider.label)}</strong>
          <span class="provider-status">${escapeHtml(status)}</span>
          <p>${escapeHtml(provider.message || "")}</p>
          ${provider.modelDiscovery?.message ? `<p class="memory-path">${escapeHtml(provider.modelDiscovery.message)}</p>` : ""}
          ${provider.models?.length ? `<p class="memory-path">Models: ${escapeHtml(provider.models.join(", "))}</p>` : ""}
          ${provider.installed ? "" : `<code>${escapeHtml(provider.installCommand || "")}</code>`}
        </div>
        <div class="provider-actions">
          ${provider.installed ? `<button type="button" data-connect-provider="${escapeHtml(provider.id)}">${canConnect ? "Connect" : "Reconnect"}</button>` : ""}
          ${provider.installed ? "" : `<button type="button" data-copy-provider-command="${escapeHtml(provider.id)}">Copy Command</button>`}
          ${provider.installed ? "" : `<button type="button" data-install-provider="${escapeHtml(provider.id)}">Install ${escapeHtml(provider.label)}</button>`}
        </div>
      </article>
    `;
  }).join("");
}

function renderProviderPrerequisites() {
  const missingProviders = state.connector.providers.filter((provider) => !provider.installed);
  if (!missingProviders.length) {
    return "";
  }

  return `
    <div class="connector-help">
      <strong>CLI install requirements</strong>
      <p>Provider installs require Node.js with npm available on PATH. If npm is missing, install Node.js, restart Chrome, then click Install again or run the command shown above.</p>
      <div class="button-row">
        <button id="install-nodejs" type="button">Install Node.js/npm</button>
        <a href="https://nodejs.org/en/download" target="_blank" rel="noreferrer">Download Node.js</a>
      </div>
    </div>
  `;
}

function normalizeProviderStatuses(providers = []) {
  const byId = new Map((Array.isArray(providers) ? providers : []).map((provider) => [provider.id, provider]));

  const cliProviders = getDefaultProviderStatuses().map((fallback) => {
    const provider = {
      ...fallback,
      ...(byId.get(fallback.id) || {})
    };
    const installed = provider.installed || provider.status === "ready" || provider.status === "login_required" || provider.connected;
    const connected = Boolean(provider.connected);

    return {
      ...provider,
      installed,
      connected,
      statusLabel: getProviderStatusLabel({ ...provider, installed, connected })
    };
  });

  return [
    ...cliProviders,
    ...getHttpProviderStatusSources().map(httpProviderToStatus)
  ];
}

function getHttpProviderStatusSources() {
  const providers = [...state.httpProviders];
  const draft = state.httpProviderDraft;
  const hasTestedDraft = draft?.id && draft.baseUrl && (draft.models?.length || draft.lastStatus);

  if (!hasTestedDraft) {
    return providers;
  }

  const existingIndex = providers.findIndex((provider) => provider.id === draft.id);
  const testedDraft = {
    ...draft,
    temporary: existingIndex < 0
  };

  if (existingIndex >= 0) {
    providers[existingIndex] = {
      ...providers[existingIndex],
      ...testedDraft
    };
  } else {
    providers.push(testedDraft);
  }

  return providers;
}

function httpProviderToStatus(provider) {
  const label = provider.name || "HTTP Provider";
  return {
    id: `http:${provider.id}`,
    label: provider.temporary ? `${label} (unsaved)` : label,
    status: provider.lastStatus || "ready",
    statusLabel: provider.lastStatus === "error" ? "Error" : "Connected",
    installed: true,
    connected: provider.lastStatus !== "error",
    command: provider.baseUrl,
    installCommand: "",
    models: provider.models?.length ? provider.models : [provider.model || "default"],
    defaultModel: provider.model || provider.models?.[0] || "default",
    message: provider.lastMessage || "OpenAI-compatible HTTP provider is configured."
  };
}

function getDefaultProviderStatuses() {
  return [
    getDefaultProviderStatus("openai-codex"),
    getDefaultProviderStatus("anthropic-claude-code"),
    getDefaultProviderStatus("google-gemini-cli")
  ];
}

function getDefaultProviderStatus(id) {
  const defaults = {
    "openai-codex": {
      id: "openai-codex",
      label: "Codex",
      command: "codex",
      installCommand: "npm install -g @openai/codex",
      models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"],
      defaultModel: "gpt-5.5"
    },
    "anthropic-claude-code": {
      id: "anthropic-claude-code",
      label: "Claude Code",
      command: "claude.cmd",
      installCommand: "npm install -g @anthropic-ai/claude-code",
      models: ["default", "opus", "sonnet", "haiku"],
      defaultModel: "default"
    },
    "google-gemini-cli": {
      id: "google-gemini-cli",
      label: "Gemini CLI",
      command: "gemini.cmd",
      installCommand: "npm install -g @google/gemini-cli",
      models: ["default"],
      defaultModel: "default"
    }
  };

  return {
    status: "missing",
    installed: false,
    connected: false,
    message: `${defaults[id]?.label || id} CLI has not been detected.`,
    ...(defaults[id] || defaults["openai-codex"])
  };
}

function getProviderStatusLabel(provider) {
  if (provider.connected) return "Connected";
  if (!provider.installed || provider.status === "missing") return "Missing";
  if (provider.status === "login_required") return "Login required";
  if (provider.status === "install_started") return "Installing";
  if (provider.status === "login_started") return "Login started";
  return "Installed";
}

function getSelectedProviderStatus() {
  return state.connector.providers.find((provider) => provider.id === state.codex.provider)
    || getDefaultProviderStatus(state.codex.provider)
    || getDefaultProviderStatus("openai-codex");
}

function ensureSelectedProviderAvailable() {
  if (!state.connector.providers.length) {
    state.connector.providers = getDefaultProviderStatuses();
  }

  const selected = getSelectedProviderStatus();
  const connectedProviders = state.connector.providers.filter((provider) => provider.connected);

  if (!selected.connected && connectedProviders.length) {
    const codex = connectedProviders.find((provider) => provider.id === "openai-codex");
    state.codex.provider = (codex || connectedProviders[0]).id;
  }

  const provider = getSelectedProviderStatus();
  const models = provider.models?.length ? provider.models : ["default"];
  if (!models.includes(state.codex.model)) {
    state.codex.model = provider.defaultModel || models[0];
  }
}

function renderConnectorSetup() {
  if (!["missing", "error", "unknown"].includes(state.connector.status)) {
    return "";
  }

  const command = getConnectorInstallCommand();

  return `
    <div class="connector-setup">
      <span class="eyebrow">Local setup</span>
      <code>${escapeHtml(command)}</code>
      <div class="button-row">
        <button id="copy-install-command" type="button">Copy Command</button>
        <button id="open-extensions" type="button">Open Extensions</button>
      </div>
    </div>
  `;
}

async function copyConnectorInstallCommand() {
  const command = getConnectorInstallCommand();
  await navigator.clipboard.writeText(command);
  state.activity.unshift("Connector install command copied.");
  render();
}

async function copyProviderInstallCommand(providerId) {
  const provider = state.connector.providers.find((item) => item.id === providerId) || getDefaultProviderStatus(providerId);
  const command = provider.installCommand || "";
  if (!command) {
    return;
  }

  await navigator.clipboard.writeText(command);
  state.activity.unshift(`${provider.label} install command copied.`);
  render();
}

function getConnectorInstallCommand() {
  return `powershell -ExecutionPolicy Bypass -File native-host/install-windows.ps1 -ExtensionId ${chrome.runtime.id}`;
}

async function observePage(options = {}) {
  const silent = Boolean(options.silent);
  const reason = options.reason || "read the current page";

  if (!silent && !options.skipWaitingMessage) {
    state.page.status = "observing";
    state.page.summary = `Requesting site access to ${reason}...`;
    render();
  }

  const permission = await ensureCurrentSitePermission();

  if (!permission.ok) {
    addDebugLog("observe.permission_blocked", { reason, permission }, permission.error);
    if (!silent) {
      state.page.status = "error";
      state.page.summary = permission.error;
      state.messages.push({
        role: "assistant",
        text: permission.error,
        variant: "error",
        createdAt: Date.now()
      });
    }
    state.activity.unshift(`Observation blocked: ${permission.error}`);
    render();
    return null;
  }

  if (!silent) {
    state.page.status = "observing";
    state.page.summary = "Observing the active tab...";
    render();
  }

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.OBSERVE_ACTIVE_TAB));
  addDebugLog("observe.response", {
    ok: response.ok,
    error: response.error || "",
    observation: response.envelope?.payload ? summarizeObservationForLog(response.envelope.payload) : null
  }, response.ok ? "Observed active tab." : response.error);

  if (!response.ok) {
    if (!silent) {
      state.page.status = "error";
      state.page.summary = response.error;
    }
    state.activity.unshift(`Observation failed: ${response.error}`);
    render();
    return null;
  }

  const observation = response.envelope.payload;
  rememberObservedTab(observation, "observe");
  state.page = {
    status: "ready",
    title: observation.tab.title || "Untitled page",
    url: observation.tab.url || "",
    summary: summarizeObservation(observation),
    observation
  };
  await enrichGoogleDocObservation();
  rememberObservedTab(state.page.observation, "observe");
  state.activity.unshift(`Observed ${state.page.title}.`);
  render();
  return observation;
}

async function enrichGoogleDocObservation() {
  const observation = state.page.observation;
  const docId = extractGoogleDocId(observation?.tab?.url || state.page.url);

  if (!docId || String(observation?.visible_text || "").length > 1200) {
    return;
  }

  const exported = await fetchGoogleDocText(docId);

  if (!exported || exported.text.length <= String(observation.visible_text || "").length + 200) {
    return;
  }

  state.page.observation = {
    ...observation,
    visible_text: exported.text,
    external_text_source: exported.source,
    external_text_status: exported.status
  };
  state.page.summary = summarizeObservation(state.page.observation);
  state.activity.unshift(`Fetched Google Docs text from ${exported.source}.`);
}

async function fetchGoogleDocText(docId) {
  const candidates = [
    `https://docs.google.com/document/d/${docId}/export?format=txt`,
    `https://docs.google.com/document/d/${docId}/mobilebasic`
  ];

  for (const url of candidates) {
    const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.HTTP_REQUEST, {
      url,
      method: "GET"
    }));

    const payload = response.ok ? response.envelope.payload : null;
    const text = cleanFetchedText(payload?.bodyPreview || "", payload?.contentType || "");

    if (payload?.ok && text.length > 200) {
      return {
        source: payload.finalUrl || url,
        status: payload.statusCode,
        text
      };
    }
  }

  return null;
}

async function ensureCurrentSitePermission() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

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
      return {
        ok: false,
        error: "Browser Companion can observe normal http and https pages only."
      };
    }

    originPattern = `${url.origin}/*`;
  } catch (error) {
    return {
      ok: false,
      error: "The current page URL cannot be observed."
    };
  }

  const hasPermission = await chrome.permissions.contains({
    origins: [originPattern]
  });

  if (hasPermission) {
    return { ok: true, requested: false };
  }

  let granted = false;

  try {
    granted = await chrome.permissions.request({
      origins: [originPattern]
    });
  } catch (error) {
    return {
      ok: false,
      error: `Chrome could not show the site access prompt for ${originPattern}. Click Observe or retry from the side panel, then approve site access when Chrome shows the prompt.`
    };
  }

  return granted
    ? { ok: true, requested: true }
    : {
        ok: false,
        error: `Site access was not granted for ${originPattern}. Click Observe or retry the request, then approve site access if Chrome shows the prompt.`
      };
}

async function checkConnector() {
  if (connectorCheckInFlight) {
    return;
  }

  connectorCheckInFlight = true;

  try {
    addDebugLog("connector.health.start", { selectedProvider: state.codex.provider, selectedModel: state.codex.model }, "Checking connector.");
    const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.NATIVE_HEALTH));
    addDebugLog("connector.health.end", {
      ok: response.ok,
      error: response.error || "",
      status: response.envelope?.payload || null
    }, response.ok ? response.envelope?.payload?.message || "Connector status received." : response.error);

    if (!response.ok) {
      state.connector = {
        status: "error",
        message: response.error,
        providers: state.connector.providers
      };
      render();
      return;
    }

    const status = response.envelope.payload;
    const providers = normalizeProviderStatuses(status.providers || []);
    const connected = Boolean(status.connected) || providers.some((provider) => provider.connected);
    state.connector = {
      status: connected ? "connected" : status.status,
      message: status.message || "Local connector status received.",
      providers
    };
    ensureSelectedProviderAvailable();
    render();
  } finally {
    connectorCheckInFlight = false;
  }
}

async function loadUserMemory() {
  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.USER_MEMORY_GET));

  if (!response.ok) {
    state.userMemory.status = "error";
    state.userMemory.message = response.error || "User memory is unavailable.";
    render();
    return;
  }

  applyUserMemoryPayload(response.envelope.payload);
  render();
}

async function saveMemoryFromForm(event) {
  event.preventDefault();
  const title = document.getElementById("memory-title").value.trim() || "User note";
  const content = document.getElementById("memory-content").value.trim();

  if (!content) {
    state.userMemory.message = "Memory content is empty.";
    render();
    return;
  }

  await saveUserMemory({
    id: state.userMemory.editingId || "",
    title,
    content
  });
}

async function saveMemoryFromViewForm(event) {
  event.preventDefault();
  const title = document.getElementById("memory-view-title").value.trim() || "User note";
  const content = document.getElementById("memory-view-content").value.trim();

  if (!content) {
    state.userMemory.message = "Memory content is empty.";
    render();
    return;
  }

  await saveUserMemory({
    id: state.userMemory.editingId || "",
    title,
    content
  });
}

async function saveUserMemory(item) {
  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.USER_MEMORY_SAVE, item));

  if (!response.ok) {
    state.userMemory.status = "error";
    state.userMemory.message = response.error || "User memory could not be saved.";
    render();
    return false;
  }

  if (response.envelope.payload?.status === "error") {
    applyUserMemoryPayload(response.envelope.payload);
    render();
    return false;
  }

  applyUserMemoryPayload(response.envelope.payload);
  state.userMemory.draftTitle = "";
  state.userMemory.draftContent = "";
  state.userMemory.editingId = "";
  state.activity.unshift(response.envelope.payload.message || "User memory saved.");
  render();
  return true;
}

function startMemoryEdit(id) {
  const item = state.userMemory.items.find((memoryItem) => memoryItem.id === id);
  if (!item) {
    return;
  }

  state.userMemory.editingId = item.id;
  state.userMemory.draftTitle = item.title || "User note";
  state.userMemory.draftContent = item.content || "";
  state.userMemory.message = `Editing "${state.userMemory.draftTitle}".`;
  render();
}

async function deleteMemoryItem(id) {
  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.USER_MEMORY_DELETE, { id }));

  if (!response.ok) {
    state.userMemory.status = "error";
    state.userMemory.message = response.error || "User memory could not be deleted.";
    render();
    return;
  }

  if (response.envelope.payload?.status === "error") {
    applyUserMemoryPayload(response.envelope.payload);
    render();
    return;
  }

  applyUserMemoryPayload(response.envelope.payload);
  state.activity.unshift(response.envelope.payload.message || "User memory deleted.");
  render();
}

function applyUserMemoryPayload(payload = {}) {
  state.userMemory.status = payload.status || "ready";
  state.userMemory.message = payload.message || "User memory loaded.";
  state.userMemory.path = payload.path || state.userMemory.path;
  state.userMemory.items = Array.isArray(payload.items) ? payload.items : [];
}

async function connectProvider(providerId = state.codex.provider) {
  const provider = state.connector.providers.find((item) => item.id === providerId) || getDefaultProviderStatus(providerId);
  state.codex.provider = provider.id;
  state.connector = {
    ...state.connector,
    status: "connecting",
    message: `Starting the local ${provider.label} sign-in flow...`
  };
  render();

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.CONNECT_CODEX, {
    provider: provider.id
  }));

  if (!response.ok) {
    state.connector = {
      ...state.connector,
      status: "missing",
      message: response.error
    };
    render();
    return;
  }

  const status = response.envelope.payload;
  const providers = normalizeProviderStatuses(status.providers || []);
  const connected = Boolean(status.connected) || providers.some((provider) => provider.connected);
  state.connector = {
    status: connected ? "connected" : status.status,
    message: status.message || "Connector response received.",
    providers
  };
  ensureSelectedProviderAvailable();
  persistConnectorSelection();
  render();
}

async function installProvider(providerId) {
  const provider = state.connector.providers.find((item) => item.id === providerId) || getDefaultProviderStatus(providerId);
  state.activity.unshift(`Requested opt-in install for ${provider.label}.`);
  state.connector = {
    ...state.connector,
    status: "installing",
    message: `Opening visible installer for ${provider.label}.`
  };
  render();

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.INSTALL_PROVIDER, {
    provider: provider.id
  }));

  if (!response.ok) {
    state.connector = {
      ...state.connector,
      status: "error",
      message: response.error
    };
    state.activity.unshift(`Install request failed for ${provider.label}: ${response.error}`);
    render();
    return;
  }

  const payload = response.envelope.payload;
  if (payload?.providers) {
    state.connector.providers = normalizeProviderStatuses(payload.providers);
    ensureSelectedProviderAvailable();
  }
  state.connector.status = payload?.connected || state.connector.providers.some((provider) => provider.connected)
    ? "connected"
    : (payload?.status || state.connector.status);
  state.connector.message = payload?.message || `Install request sent for ${provider.label}.`;
  if (payload?.logPath) {
    state.connector.message = `${state.connector.message} Log: ${payload.logPath}`;
  }
  state.activity.unshift(`${state.connector.message} Wait for the terminal to finish, then click Check.`);
  persistSession();
  render();
}

async function installNodejs() {
  state.connector = {
    ...state.connector,
    status: "installing",
    message: "Starting opt-in Node.js/npm installation."
  };
  state.activity.unshift("Requested opt-in Node.js/npm installation.");
  render();

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.INSTALL_NODEJS));

  if (!response.ok) {
    state.connector = {
      ...state.connector,
      status: "error",
      message: response.error
    };
    state.activity.unshift(`Node.js/npm install request failed: ${response.error}`);
    render();
    return;
  }

  const payload = response.envelope.payload;
  if (payload?.providers) {
    state.connector.providers = normalizeProviderStatuses(payload.providers);
    ensureSelectedProviderAvailable();
  }
  state.connector.status = payload?.connected || state.connector.providers.some((provider) => provider.connected)
    ? "connected"
    : (payload?.status || state.connector.status);
  state.connector.message = payload?.message || "Node.js/npm install request sent.";
  if (payload?.logPath) {
    state.connector.message = `${state.connector.message} Log: ${payload.logPath}`;
  }
  state.activity.unshift(state.connector.message);
  persistSession();
  render();
}

async function testHttpProviderFromForm() {
  const provider = readHttpProviderDraft();
  if (!provider.baseUrl) {
    state.connector.message = "HTTP provider Base URL is required.";
    render();
    return;
  }

  state.connector.message = `Testing ${provider.name || provider.baseUrl}...`;
  render();

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.HTTP_PROVIDER_TEST, provider));
  if (!response.ok) {
    state.connector.message = response.error;
    render();
    return;
  }

  const payload = response.envelope.payload;
  const models = payload.models || [];
  const loadedModels = payload.loadedModels || [];
  const selectedModel = models.includes(provider.model) ? provider.model : (models[0] || provider.model || "");
  state.httpProviderDraft = {
    ...provider,
    model: selectedModel,
    models,
    loadedModels,
    lastStatus: payload.status || "ready",
    lastMessage: payload.message || "HTTP provider test completed."
  };
  state.connector.providers = normalizeProviderStatuses(state.connector.providers);
  state.codex.provider = `http:${state.httpProviderDraft.id}`;
  state.codex.model = selectedModel || "default";
  const loadedMessage = loadedModels.length ? ` Loaded: ${loadedModels.join(", ")}.` : "";
  state.connector.message = `${state.httpProviderDraft.lastMessage}${loadedMessage} Select a model above, then Save HTTP Provider to keep it.`;
  state.activity.unshift(`HTTP provider ${state.httpProviderDraft.name} found ${models.length} model${models.length === 1 ? "" : "s"}.`);
  persistConnectorSelection();
  render();
}

async function saveHttpProviderFromForm(event) {
  event.preventDefault();
  const provider = readHttpProviderDraft();
  if (!provider.baseUrl) {
    state.connector.message = "HTTP provider Base URL is required.";
    render();
    return;
  }

  const existingIndex = state.httpProviders.findIndex((item) => item.id === provider.id);
  const previousModel = existingIndex >= 0 ? state.httpProviders[existingIndex].model : "";
  if (existingIndex >= 0) {
    state.httpProviders[existingIndex] = provider;
  } else {
    state.httpProviders.push(provider);
  }
  state.httpProviderDraft = makeDefaultHttpProviderDraft();
  state.connector.providers = normalizeProviderStatuses(state.connector.providers);
  if (state.codex.provider === `http:${provider.id}` || existingIndex < 0) {
    state.codex.provider = `http:${provider.id}`;
    state.codex.model = provider.model || provider.models?.[0] || "default";
  }
  ensureSelectedProviderAvailable();
  await persistProviderSettings();
  persistSession();
  state.connector.message = `Saved HTTP provider ${provider.name}.`;
  render();
  await maybeOfferHttpModelUnload(previousModel, provider.model, provider);
}

function readHttpProviderDraft() {
  const existingId = state.httpProviderDraft.id || "";
  const name = document.getElementById("http-provider-name")?.value.trim() || "Local LLM";
  const baseUrl = document.getElementById("http-provider-base-url")?.value.trim().replace(/\/+$/, "") || "";
  const username = document.getElementById("http-provider-username")?.value.trim() || "";
  const password = document.getElementById("http-provider-password")?.value || "";
  const model = document.getElementById("http-provider-model")?.value.trim() || state.httpProviderDraft.model || "";
  const useStreaming = Boolean(document.getElementById("http-provider-use-streaming")?.checked);
  const maxTokens = sanitizePositiveInteger(
    document.getElementById("http-provider-max-tokens")?.value,
    state.httpProviderDraft.maxTokens,
    HTTP_PROVIDER_DEFAULT_MAX_TOKENS
  );
  const retryMaxTokens = sanitizePositiveInteger(
    document.getElementById("http-provider-retry-max-tokens")?.value,
    state.httpProviderDraft.retryMaxTokens,
    HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS
  );
  const timeoutMs = sanitizePositiveInteger(
    document.getElementById("http-provider-timeout-ms")?.value,
    state.httpProviderDraft.timeoutMs,
    HTTP_PROVIDER_DEFAULT_TIMEOUT_MS,
    1000
  );
  return {
    ...state.httpProviderDraft,
    id: existingId || crypto.randomUUID(),
    name,
    baseUrl,
    username,
    password,
    authType: username || password ? "basic" : "none",
    model,
    useStreaming,
    maxTokens,
    retryMaxTokens,
    timeoutMs,
    models: state.httpProviderDraft.models?.length
      ? Array.from(new Set([...state.httpProviderDraft.models, ...(model ? [model] : [])]))
      : (model ? [model] : []),
    loadedModels: state.httpProviderDraft.loadedModels || [],
    lastStatus: state.httpProviderDraft.lastStatus || "ready",
    lastMessage: state.httpProviderDraft.lastMessage || "OpenAI-compatible HTTP provider is configured."
  };
}

function editHttpProvider(id) {
  const provider = state.httpProviders.find((item) => item.id === id);
  if (!provider) return;
  state.httpProviderDraft = {
    ...provider,
    maxTokens: sanitizePositiveInteger(provider.maxTokens, HTTP_PROVIDER_DEFAULT_MAX_TOKENS, HTTP_PROVIDER_DEFAULT_MAX_TOKENS),
    retryMaxTokens: sanitizePositiveInteger(provider.retryMaxTokens, HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS, HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS),
    timeoutMs: sanitizePositiveInteger(provider.timeoutMs, HTTP_PROVIDER_DEFAULT_TIMEOUT_MS, HTTP_PROVIDER_DEFAULT_TIMEOUT_MS, 1000)
  };
  render();
}

function cancelHttpProviderEdit() {
  state.httpProviderDraft = makeDefaultHttpProviderDraft();
  render();
}

async function deleteHttpProvider(id) {
  state.httpProviders = state.httpProviders.filter((provider) => provider.id !== id);
  if (state.codex.provider === `http:${id}`) {
    state.codex.provider = "openai-codex";
    state.codex.model = "gpt-5.5";
  }
  state.connector.providers = normalizeProviderStatuses(state.connector.providers);
  ensureSelectedProviderAvailable();
  await persistProviderSettings();
  persistSession();
  render();
}

function getSelectedHttpProvider() {
  if (!state.codex.provider.startsWith("http:")) {
    return null;
  }

  const id = state.codex.provider.slice("http:".length);
  const provider = state.httpProviders.find((item) => item.id === id)
    || (state.httpProviderDraft.id === id ? state.httpProviderDraft : null);
  if (!provider) return null;
  return {
    ...provider,
    model: state.codex.model || provider.model
  };
}

async function maybeOfferHttpModelUnload(previousModel, nextModel, providerOverride = null) {
  if (!previousModel || !nextModel || previousModel === nextModel) {
    return;
  }

  const provider = providerOverride || getSelectedHttpProvider();
  if (!provider?.baseUrl) {
    return;
  }

  const loadedModels = provider.loadedModels || [];
  if (loadedModels.length && !loadedModels.includes(previousModel)) {
    return;
  }

  const shouldUnload = window.confirm(
    `Unload the previous LLM model "${previousModel}" from ${provider.name || provider.baseUrl}?`
  );
  if (!shouldUnload) {
    return;
  }

  addDebugLog("provider.http_unload.start", {
    provider: provider.name || provider.baseUrl,
    model: previousModel
  }, `Unloading ${previousModel}`);

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.HTTP_PROVIDER_UNLOAD, {
    provider: {
      ...provider,
      model: previousModel
    },
    model: previousModel
  }));
  const payload = response.envelope?.payload || null;
  const unloadOk = response.ok && payload?.status !== "error";
  addDebugLog("provider.http_unload.end", {
    ok: unloadOk,
    error: response.error || "",
    result: payload
  }, unloadOk ? payload?.message || "HTTP unload request completed." : response.error || payload?.message);

  const message = unloadOk
    ? payload?.message || `Requested unload for ${previousModel}.`
    : response.error || payload?.message || `Could not unload ${previousModel}.`;
  state.activity.unshift(message);
  state.connector.message = message;
  persistSession();
  render();
}

async function handleAttachments(event) {
  const files = Array.from(event.target.files || []);
  const loaded = await Promise.all(files.map(readAttachment));
  state.attachments.unshift(...loaded);
  state.activity.unshift(`Attached ${files.length} file${files.length === 1 ? "" : "s"}.`);
  persistSession();
  render();
}

async function readAttachment(file) {
  const textLike = /^text\/|json|csv|xml|markdown|javascript|typescript/i.test(file.type) || /\.(txt|md|csv|json|xml|html|css|js|ts)$/i.test(file.name);
  const base = {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    type: file.type || "unknown",
    status: "registered",
    text: "",
    message: "",
    warnings: []
  };

  if (file.size > 15 * 1024 * 1024) {
    return {
      ...base,
      status: "too large",
      message: "Files larger than 15 MB are not extracted in the side panel.",
      warnings: ["Files larger than 15 MB are not extracted in the side panel."]
    };
  }

  const extracted = await extractAttachmentViaBridge(file, base.id);

  if (extracted) {
    return {
      ...base,
      status: extracted.status || "text ready",
      text: extracted.text || "",
      message: extracted.message || "",
      warnings: extracted.warnings || []
    };
  }

  if (!textLike) {
    return base;
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        ...base,
        status: "text ready",
        text: String(reader.result || "").slice(0, 30000)
      });
    };
    reader.onerror = () => {
      resolve({
        ...base,
        status: "read failed",
        message: "The browser could not read this attachment as text.",
        text: ""
      });
    };
    reader.readAsText(file);
  });
}

async function extractAttachmentViaBridge(file, id) {
  const base64 = await readFileAsBase64(file);
  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.EXTRACT_ATTACHMENT, {
    id,
    name: file.name,
    size: file.size,
    type: file.type || "unknown",
    base64
  }));

  if (!response.ok) {
    state.activity.unshift(`Local extraction unavailable for ${file.name}: ${response.error}`);
    return null;
  }

  return response.envelope.payload;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      resolve(dataUrl.includes(",") ? dataUrl.split(",").pop() : dataUrl);
    };
    reader.onerror = () => reject(new Error("Could not read attachment bytes."));
    reader.readAsDataURL(file);
  });
}

async function handleChatSubmit(event) {
  event.preventDefault();
  const text = state.composerDraft.trim();

  if (!text) {
    return;
  }

  const questionTab = await getCurrentActiveTab();
  const questionContext = tabToPageContext(questionTab);
  rememberActiveTab(questionTab);
  const messageId = crypto.randomUUID();
  const createdAt = Date.now();

  state.composerDraft = "";
  state.outboundQueue.push({
    id: crypto.randomUUID(),
    messageId,
    text,
    createdAt,
    planContext: questionContext,
    queueStatus: state.isProcessingQueue ? "queued" : "pending"
  });
  render();

  processOutboundQueue();
}

async function processOutboundQueue() {
  if (state.isProcessingQueue) {
    return;
  }

  state.isProcessingQueue = true;
  state.stopProcessingRequested = false;
  state.stopRequestInFlight = false;
  state.liveThinking = null;
  render();

  try {
    while (state.outboundQueue.length) {
      if (state.stopProcessingRequested) {
        break;
      }
      const item = state.outboundQueue.shift();
      state.currentProcessingMessageId = item?.messageId || null;
      materializeQueuedMessage(item, "processing");
      render();

      try {
        const outcome = await processQueuedMessage(item);
        setMessageQueueStatus(item?.messageId, outcome?.stopped ? "stopped" : "sent");
        if (outcome?.stopped || state.stopProcessingRequested) {
          break;
        }
      } catch (error) {
        setMessageQueueStatus(item?.messageId, "failed");
        state.messages.push({
          role: "assistant",
          text: error.message || "The queued request could not be completed.",
          variant: "error",
          createdAt: Date.now()
        });
        state.activity.unshift(`Queued request failed: ${error.message || "Unexpected error."}`);
        render();
      }
    }
  } finally {
    if (state.stopProcessingRequested) {
      state.activity.unshift(
        state.outboundQueue.length
          ? `Stopped processing. ${state.outboundQueue.length} queued request(s) remain.`
          : "Stopped processing."
      );
    }
    state.isProcessingQueue = false;
    state.stopProcessingRequested = false;
    state.stopRequestInFlight = false;
    state.liveThinking = null;
    state.currentProcessingMessageId = null;
    state.pendingSteeredMessageId = null;
    render();
  }
}

async function processQueuedMessage(item) {
  const text = item?.text || "";
  if (state.pendingMemoryProposal) {
    const handled = await handlePendingMemoryProposalReply(text);
    if (handled) {
      return;
    }
  }

  const memoryRequest = state.connector.status === "connected" ? null : parseDirectMemoryRequest(text);
  if (memoryRequest) {
    const memoryItem = memoryRequest.synthesize
      ? await synthesizeMemoryRequest(memoryRequest)
      : memoryRequest;
    proposeMemorySave(memoryItem, detectUserLanguage(text), memoryRequest.goal);
    return;
  }
  state.pendingMemoryIntent = parseDeferredMemoryIntent(text);

  const planContext = item?.planContext || tabToPageContext(await getCurrentActiveTab());
  state.liveThinking = null;
  const agentResult = await getAgentResult(text, { planContext });
  await handleAgentResult(agentResult, { planContext });
  return {
    stopped: isUserStoppedResult(agentResult)
  };
}

function handleRuntimeMessage(message) {
  if (message?.type !== MESSAGE_TYPES.PROVIDER_PROGRESS) {
    return false;
  }

  const payload = message.payload || {};
  const thinking = String(payload.thinking || "").trim();
  if (!thinking) {
    return false;
  }

  state.liveThinking = {
    requestId: payload.requestId || "",
    text: thinking,
    createdAt: state.liveThinking?.createdAt || Date.now(),
    updatedAt: Date.now()
  };
  addDebugLog("provider.progress", {
    requestId: payload.requestId || "",
    thinkingLength: thinking.length
  }, "Received provider thinking progress.");
  render();
  return false;
}

async function stopCurrentProcessing() {
  if (!state.isProcessingQueue || state.stopRequestInFlight) {
    return;
  }

  state.stopProcessingRequested = true;
  state.stopRequestInFlight = true;
  state.activity.unshift("Stopping current request...");
  render();

  try {
    const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.STOP_ACTIVE_REQUEST, {}));
    addDebugLog("provider.request_stop", {
      ok: response.ok,
      error: response.error || "",
      result: response.envelope?.payload || null
    }, response.ok ? (response.envelope?.payload?.message || "Stop requested") : response.error);

    if (response.ok) {
      state.activity.unshift(response.envelope?.payload?.message || "Stop requested.");
    } else {
      state.activity.unshift(`Stop request failed: ${response.error || "Unexpected error."}`);
    }
  } finally {
    state.stopRequestInFlight = false;
    render();
  }
}

function steerQueuedMessage(messageId) {
  const targetId = String(messageId || "");
  if (!targetId) {
    return;
  }

  const index = state.outboundQueue.findIndex((item) => item.messageId === targetId);
  if (index < 0) {
    return;
  }

  if (index === 0) {
    state.activity.unshift(state.isProcessingQueue
      ? "Queued message is already next."
      : "Queued message is already at the front.");
    render();
    return;
  }

  const [item] = state.outboundQueue.splice(index, 1);
  item.queueStatus = "steered";
  state.outboundQueue.unshift(item);
  setMessageQueueStatus(targetId, "steered");
  if (state.isProcessingQueue) {
    state.pendingSteeredMessageId = targetId;
  }
  state.activity.unshift("Queued message moved to the front.");
  render();
}

function setMessageQueueStatus(messageId, status) {
  if (!messageId) {
    return;
  }

  const message = state.messages.find((entry) => entry.id === messageId);
  if (message) {
    message.queueStatus = status;
  }

  const queuedItem = state.outboundQueue.find((entry) => entry.messageId === messageId);
  if (queuedItem) {
    queuedItem.queueStatus = status;
  }
}

function isQueuedMessageSteerable(messageId) {
  return state.outboundQueue.some((item, index) => item.messageId === messageId && index > 0);
}

function getQueuedMessageSteerState(message) {
  if (message?.role !== "user" || !message?.id) {
    return "hidden";
  }

  const index = state.outboundQueue.findIndex((item) => item.messageId === message.id);
  if (index < 0) {
    return "hidden";
  }

  if (index === 0) {
    return state.isProcessingQueue ? "next" : "hidden";
  }

  return "enabled";
}

function getQueuedMessageStatusLabel(message) {
  const queuedItem = state.outboundQueue.find((entry) => entry.messageId === message?.id);
  const status = queuedItem?.queueStatus || message?.queueStatus;

  if (!status || status === "sent") {
    return "";
  }

  if (status === "queued") {
    return "queued";
  }

  if (status === "processing") {
    return "processing";
  }

  if (status === "steered") {
    return "steered";
  }

  if (status === "failed") {
    return "failed";
  }

  if (status === "stopped") {
    return "stopped";
  }

  if (status === "pending" && state.isProcessingQueue) {
    return "queued";
  }

  return "";
}

function materializeQueuedMessage(item, status = "queued") {
  if (!item?.messageId) {
    return;
  }

  const existing = state.messages.find((entry) => entry.id === item.messageId);
  if (existing) {
    existing.queueStatus = status;
    return;
  }

  state.messages.push({
    role: "user",
    id: item.messageId,
    text: item.text,
    createdAt: item.createdAt,
    queueStatus: status
  });
}

function isQueuedMessageMaterialized(messageId) {
  return state.messages.some((entry) => entry.id === messageId);
}

function consumePendingSteeredQueueItem() {
  if (!state.pendingSteeredMessageId) {
    return null;
  }

  const index = state.outboundQueue.findIndex((item) => item.messageId === state.pendingSteeredMessageId);
  if (index < 0) {
    state.pendingSteeredMessageId = null;
    return null;
  }

  const [queuedItem] = state.outboundQueue.splice(index, 1);
  state.pendingSteeredMessageId = null;
  return queuedItem;
}

function buildSteeredContinuationGoal(baseGoal, steeredQueueItem) {
  const goal = compact(baseGoal || "");
  const steerText = compact(steeredQueueItem?.text || "");
  if (!steerText) {
    return goal;
  }

  if (!goal) {
    return steerText;
  }

  return compact(
    `Original user request:\n${goal}\n\nAdditional user message received while the request was still in progress:\n${steerText}`
  );
}

function appendSteeredContinuationReason(reason, steeredQueueItem) {
  const baseReason = compact(reason || "");
  const steerText = compact(steeredQueueItem?.text || "");
  if (!steerText) {
    return baseReason;
  }

  return compact(
    `${baseReason}\nA new user message arrived while you were still working. Treat it as an addition or refinement to the same task. Continue from the current progress instead of restarting from scratch. New user message: ${steerText}`
  );
}

function injectSteeredMessageIntoCurrentFlow(steeredQueueItem) {
  if (!steeredQueueItem) {
    return;
  }

  materializeQueuedMessage(steeredQueueItem, "steered");
  state.activity.unshift("Steered message injected into the current flow.");
  addDebugLog("agent.steer.injected", {
    messageId: steeredQueueItem.messageId,
    text: steeredQueueItem.text
  }, "Injected the steered queued message into the current flow.");
}

async function getAgentResult(goal, options = {}) {
  const responseLanguage = detectUserLanguage(goal);
  const navigationPlan = buildNavigationPlan(goal, responseLanguage);

  if (navigationPlan) {
    addDebugLog("agent.local_navigation_plan", { goal, plan: navigationPlan }, navigationPlan.summary_for_user);
    return navigationPlan;
  }

  if (state.connector.status === "connected") {
    const selectedHttpProvider = getSelectedHttpProvider();
    const runtimeContext = await buildRuntimeContext(goal, options);
    const observationForRequest = compactObservationForProvider(getObservationForContext(options.planContext));
    const payload = {
      goal,
      responseLanguage,
      provider: state.codex.provider,
      model: state.codex.model,
      httpProvider: selectedHttpProvider,
      runtimeContext,
      observation: observationForRequest,
      userMemory: state.userMemory.items.map((item) => ({
        id: item.id,
        title: item.title,
        content: item.content,
        updatedAt: item.updatedAt
      })),
      attachments: (options.omitAttachmentsForProvider ? [] : state.attachments).map((file) => ({
        id: file.id,
        name: file.name,
        type: file.type,
        status: file.status,
        text: state.privacy.sendAttachmentsToCodex ? file.text : ""
      }))
    };
    addDebugLog("provider.agent_request.start", payload, `${state.codex.provider} / ${state.codex.model}`);
    const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.AGENT_REQUEST, payload));
    addDebugLog("provider.agent_request.end", {
      ok: response.ok,
      error: response.error || "",
      result: response.envelope?.payload || null
    }, response.ok ? response.envelope?.payload?.type || "provider response" : response.error);

    if (
      response.ok
      && isProviderTimeoutResult(response.envelope?.payload)
      && !options.omitAttachmentsForProvider
      && state.attachments.length
    ) {
      state.activity.unshift("HTTP provider timed out; retrying once without attachments.");
      addDebugLog("provider.agent_request.retry", {
        reason: "timeout_524",
        omitAttachmentsForProvider: true
      }, "Retrying provider request without attachments after timeout.");
      return getAgentResult(goal, {
        ...options,
        omitAttachmentsForProvider: true,
        continuationReason: compact(`${options.continuationReason || ""}\nThe previous provider attempt timed out. Retry with lighter context and no attachments. If the answer still depends on missing material, ask for the rest explicitly.`)
      });
    }

    if (response.ok) {
      return response.envelope.payload;
    }

    state.activity.unshift(`Provider request failed: ${response.error}`);
  }

  if (isSimpleConversationalMessage(goal)) {
    return buildSimpleConversationalResponse(goal, responseLanguage);
  }

  if (!getObservationForContext(options.planContext)) {
    if (options.planContext) {
      await restoreExpectedTab(options.planContext);
    }
    const observed = await observePage({ reason: "read this page for your request" });
    if (!observed) {
      return {
        type: "ask_user",
        question: responseLanguage === "it"
          ? "Ho bisogno del permesso di accesso al sito per leggere questa pagina. Clicca Observe o riprova la richiesta; se Chrome mostra il prompt, approva l'accesso al sito."
          : "I need site access permission to read this page. Click Observe or retry the request; if Chrome shows the prompt, approve site access."
      };
    }
  }

  const deterministicPlan = buildDeterministicActionPlan(goal, responseLanguage);

  if (deterministicPlan) {
    return deterministicPlan;
  }

  return buildLocalAgentResult(goal, responseLanguage);
}

async function buildRuntimeContext(goal, options = {}) {
  const lines = [];
  const continuationReason = compact(options.continuationReason || "");
  const currentTab = await getCurrentActiveTab();
  const questionContext = options.planContext || getObservedPageContext();
  const observation = getObservationForContext(options.planContext);

  if (continuationReason) {
    lines.push(continuationReason);
  }

  if (questionContext?.url || questionContext?.title || questionContext?.tabId) {
    lines.push(`Question context tab: ${formatTabContextForPrompt(questionContext)}.`);
  }

  if (currentTab?.url || currentTab?.title || currentTab?.id) {
    lines.push(`Current active tab now: ${formatTabContextForPrompt({
      tabId: currentTab.id,
      url: currentTab.url,
      title: currentTab.title
    })}.`);
    rememberActiveTab(currentTab);
  }

  const recentTabs = getRecentAccessibleTabs(currentTab?.id);
  if (recentTabs.length) {
    lines.push(`Recently known tabs (observed tabs have page access; active-only tabs may need permission): ${recentTabs.map(formatTabContextForPrompt).join(" | ")}.`);
  }

  if (String(observation?.visible_text || "").length > PROVIDER_VISIBLE_TEXT_LIMIT) {
    lines.push("Observed page text is excerpted to fit the provider context window. Treat missing sections as unknown. If the excerpt is not enough, ask for the rest or return a read-only plan to inspect more page context before answering.");
  }

  lines.push("Tab rule: bind page-specific questions and actions to the question context tab. If the user changes tabs while you are thinking, do not reinterpret the request as referring to the new active tab unless the user explicitly says so. If a page-bound action would target a different tab, ask for clarification or use the original tab context.");

  return lines.filter(Boolean).join("\n");
}

function formatTabContextForPrompt(tab) {
  const parts = [];
  if (tab.tabId || tab.id) parts.push(`id=${tab.tabId || tab.id}`);
  if (tab.isCurrent) parts.push("current=true");
  if (tab.title) parts.push(`title="${String(tab.title).slice(0, 120)}"`);
  if (tab.url) parts.push(`url=${String(tab.url).slice(0, 220)}`);
  if (tab.source) parts.push(`source=${tab.source}`);
  if (tab.lastObservedAt) parts.push(`lastObservedAt=${tab.lastObservedAt}`);
  if (tab.lastActiveAt) parts.push(`lastActiveAt=${tab.lastActiveAt}`);
  return parts.join(", ");
}

function getObservationForContext(context) {
  const observation = state.page.observation || null;
  if (!observation || !context) {
    return observation;
  }

  const observedTab = observation.tab || {};
  const sameTab = context.tabId && observedTab.id && context.tabId === observedTab.id;
  const sameUrl = normalizeUrlForContext(context.url) === normalizeUrlForContext(observedTab.url || state.page.url);

  return sameTab || sameUrl ? observation : null;
}

function compactObservationForProvider(observation) {
  if (!observation) return null;

  const visibleText = String(observation.visible_text || "");
  const visibleTextExcerpt = smartExcerptForProvider(visibleText, PROVIDER_VISIBLE_TEXT_LIMIT);

  return {
    type: observation.type || "page_observation",
    tab: compactTabForProvider(observation.tab || {}),
    viewport: observation.viewport || null,
    capturedAt: observation.capturedAt || "",
    visible_text: visibleTextExcerpt.text,
    visibleTextLength: visibleText.length,
    visibleTextTruncated: visibleTextExcerpt.truncated,
    visibleTextExcerptStrategy: visibleTextExcerpt.strategy,
    headings: compactElementsForProvider(observation.headings, PROVIDER_ELEMENT_LIMIT),
    links: compactElementsForProvider(observation.links, PROVIDER_ELEMENT_LIMIT),
    buttons: compactElementsForProvider(observation.buttons, PROVIDER_ELEMENT_LIMIT),
    forms: compactFormsForProvider(observation.forms),
    counts: {
      headings: observation.headings?.length || 0,
      links: observation.links?.length || 0,
      buttons: observation.buttons?.length || 0,
      forms: observation.forms?.length || 0,
      interactive_elements: observation.interactive_elements?.length || 0
    },
    note: "Observation compacted before provider request to fit local model context."
  };
}

function compactTabForProvider(tab) {
  return {
    id: tab.id || null,
    url: tab.url || "",
    title: tab.title || ""
  };
}

function compactElementsForProvider(elements, limit) {
  return (Array.isArray(elements) ? elements : []).slice(0, limit).map((element) => ({
    agent_id: element.agent_id || "",
    role: element.role || "",
    name: element.name || element.text || "",
    text: element.text || "",
    href: element.href || "",
    level: element.level || "",
    selector_candidates: compactSelectorsForProvider(element.selector_candidates)
  }));
}

function compactFormsForProvider(forms) {
  return (Array.isArray(forms) ? forms : []).slice(0, PROVIDER_FORM_LIMIT).map((form) => ({
    agent_id: form.agent_id || "",
    title: form.title || "",
    fields: (Array.isArray(form.fields) ? form.fields : []).slice(0, PROVIDER_FIELD_LIMIT).map((field) => ({
      agent_id: field.agent_id || "",
      role: field.role || "",
      tag: field.tag || "",
      type: field.type || "",
      name: field.name || "",
      value: field.value || "",
      disabled: Boolean(field.disabled),
      required: Boolean(field.required),
      selector_candidates: compactSelectorsForProvider(field.selector_candidates),
      options: Array.isArray(field.options) ? field.options.slice(0, 12) : []
    }))
  }));
}

function compactSelectorsForProvider(selectors) {
  return (Array.isArray(selectors) ? selectors : [])
    .slice(0, PROVIDER_SELECTOR_LIMIT)
    .map((selector) => String(selector || "").slice(0, 220));
}

function smartExcerptForProvider(text, limit) {
  const raw = String(text || "");
  if (raw.length <= limit) {
    return {
      text: raw,
      truncated: false,
      strategy: "full"
    };
  }

  const normalized = raw.replace(/\r\n/g, "\n");
  const headTarget = Math.max(1200, Math.floor(limit * PROVIDER_VISIBLE_TEXT_HEAD_RATIO));
  const tailTarget = Math.max(800, limit - headTarget);
  const head = trimExcerptBoundary(normalized.slice(0, headTarget), "end");
  const tail = trimExcerptBoundary(normalized.slice(-tailTarget), "start");
  const omittedChars = Math.max(0, normalized.length - head.length - tail.length);
  const divider = `\n\n[... omitted ${omittedChars} chars from the middle of the page text ...]\n\n`;

  return {
    text: `${head}${divider}${tail}`.slice(0, limit + divider.length),
    truncated: true,
    strategy: "head_tail_with_middle_gap"
  };
}

function trimExcerptBoundary(text, side) {
  const raw = String(text || "");
  if (!raw) return "";

  if (side === "end") {
    const lastBreak = Math.max(raw.lastIndexOf("\n"), raw.lastIndexOf(". "), raw.lastIndexOf(" "));
    return lastBreak > raw.length * 0.7 ? raw.slice(0, lastBreak).trim() : raw.trim();
  }

  const firstNewline = raw.indexOf("\n");
  if (firstNewline >= 0 && firstNewline < raw.length * 0.3) {
    return raw.slice(firstNewline + 1).trim();
  }

  const firstSentence = raw.indexOf(". ");
  if (firstSentence >= 0 && firstSentence < raw.length * 0.3) {
    return raw.slice(firstSentence + 2).trim();
  }

  const firstSpace = raw.indexOf(" ");
  return firstSpace >= 0 && firstSpace < raw.length * 0.2 ? raw.slice(firstSpace + 1).trim() : raw.trim();
}

function isSimpleConversationalMessage(goal) {
  const text = normalizeKey(goal);
  return /^(ciao|salve|hey|hello|hi|buongiorno|buonasera)$/.test(text)
    || /^(funzioni|mi leggi|ci sei|are you there)$/.test(text)
    || /^(chi sei|who are you)$/.test(text)
    || /^(ciao|salve|hey|hello|hi|buongiorno|buonasera) (chi sei|who are you|funzioni|mi leggi|ci sei|are you there)$/.test(text);
}

function buildSimpleConversationalResponse(goal, responseLanguage) {
  const text = normalizeKey(goal);

  if (/\b(chi sei|who are you)\b/i.test(text)) {
    return {
      type: "natural_response",
      text: responseLanguage === "it"
        ? "Sono Browser Companion, un assistente locale per il browser. Posso leggere la pagina osservata, cercare online e proporre azioni sicure da confermare prima dell'esecuzione."
        : "I am Browser Companion, a local browser assistant. I can read the observed page, search online, and propose safe browser actions for confirmation before execution."
    };
  }

  if (/\b(funzioni|mi leggi|ci sei|are you there)\b/i.test(text)) {
    return {
      type: "natural_response",
      text: responseLanguage === "it"
        ? "Si, ti leggo. Dimmi cosa vuoi fare nella pagina corrente."
        : "Yes, I can read you. Tell me what you want to do on the current page."
    };
  }

  return {
    type: "natural_response",
    text: responseLanguage === "it"
      ? "Ciao. Dimmi cosa vuoi fare nella pagina corrente."
      : "Hi. Tell me what you want to do on the current page."
  };
}

function buildDeterministicActionPlan(goal, responseLanguage) {
  if (!state.page.observation) {
    return null;
  }

  return buildNavigationPlan(goal, responseLanguage)
    || buildRequestedOpenLinksPlan(goal, state.page.observation, responseLanguage)
    || buildRequestedClickPlan(goal, state.page.observation, responseLanguage);
}

async function handleAgentResult(result, options = {}) {
  result = normalizeAgentControlFlow(result);
  addDebugLog("agent.result", { result }, result?.type || "unknown result");

  if (result?.type === "agent_plan") {
    const hasPageBoundActions = (result.actions || []).some(isPageBoundAction);
    const planContext = hasPageBoundActions ? (options.planContext || createPlanPageContext(result)) : null;
    const policyResponse = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.VALIDATE_ACTION_PLAN, { plan: result }));
    addDebugLog("policy.validation", {
      plan: result,
      ok: policyResponse.ok,
      policy: policyResponse.envelope?.payload || null,
      error: policyResponse.error || ""
    }, policyResponse.ok ? "Policy validated" : policyResponse.error);
    state.confirmationText = "";
    state.messages.push({
      role: "assistant",
      text: result.summary_for_user,
      thinking: getAgentDisplayThinking(result),
      createdAt: Date.now()
    });

    const policy = policyResponse.envelope.payload;

    if (policy.allowed && !policy.requiresConfirmation) {
      state.activity.unshift("Executing low-risk action plan.");
      addActionNote("Executed low-risk action plan", result.actions.map(formatActionDetail));
      render();
      await executeActionPlan(result, { ...options, planContext });
      return;
    }

    if (policy.allowed && hasSessionApprovalForPlan(result, policy, planContext)) {
      state.confirmationText = "";
      state.activity.unshift("Executing session-approved action plan.");
      addActionNote("Executed session-approved action plan", [
        "A matching session approval rule was found for this action plan.",
        ...result.actions.map(formatActionDetail)
      ]);
      render();
      await executeActionPlan(result, { ...options, planContext });
      return;
    }

    state.pendingPlan = result;
    state.pendingPlanContext = planContext;
    state.pendingPolicy = policy;
    state.activity.unshift("Action plan prepared for confirmation.");
    addActionNote("Asked for action approval", [
      result.summary_for_user,
      ...result.actions.map(formatActionDetail),
      ...policy.results.map((item) => `${item.risk}: ${item.reason}`)
    ]);
    render();
    return;
  }

  if (result?.type === "ask_user") {
    state.messages.push({ role: "assistant", text: result.question, thinking: getAgentDisplayThinking(result), createdAt: Date.now() });
    render();
    return;
  }

  if (result?.type === "stop_for_human") {
    state.messages.push({ role: "assistant", text: result.reason, thinking: getAgentDisplayThinking(result), createdAt: Date.now() });
    state.activity.unshift("Automation stopped for human action.");
    render();
    return;
  }

  if (result?.type === "memory_proposal") {
    proposeMemorySave({
      title: result.memory_title || result.title || result.heading || inferResearchMemoryTitle(result.goal || result.text || ""),
      content: result.memory_content || result.content || result.text || result.summary_for_user || ""
    }, detectUserLanguage(result.goal || result.text || ""), result.goal || "");
    return;
  }

  if (isUserStoppedResult(result)) {
    state.messages.push({
      role: "assistant",
      text: "Stopped the current provider request.",
      thinking: getAgentDisplayThinking(result),
      createdAt: Date.now()
    });
    state.activity.unshift("Current provider request stopped.");
    render();
    return;
  }

  if (result?.type === "agent_unavailable" || result?.type === "agent_error") {
    const provider = getSelectedProviderStatus();
    state.messages.push({
      role: "assistant",
      text: formatProviderAgentErrorMessage(result),
      thinking: getAgentDisplayThinking(result),
      variant: "error",
      createdAt: Date.now()
    });
    state.activity.unshift(`${provider?.label || "Selected provider"} was unavailable.`);
    render();
    return;
  }

  const responseText = getAgentDisplayText(result) || "I could not produce a safe browser action from that request yet.";
  const memoryProposal = await maybeSaveDeferredMemory(responseText);
  state.messages.push({
    role: "assistant",
    text: memoryProposal ? appendMemorySavedNote(responseText) : responseText,
    thinking: getAgentDisplayThinking(result),
    createdAt: Date.now()
  });
  if (memoryProposal) {
    proposeMemorySave(memoryProposal.item, memoryProposal.responseLanguage, memoryProposal.goal);
    return;
  }
  render();
}

function normalizeAgentControlFlow(result) {
  if (result?.type !== "agent_plan" || !Array.isArray(result.actions)) {
    return result;
  }

  const controlAction = result.actions.find((action) => ["ask_user", "stop_for_human"].includes(action?.type));

  if (!controlAction) {
    return result;
  }

  if (controlAction.type === "ask_user" && isMemoryProposalLike(result, controlAction)) {
    const proposal = extractMemoryProposalFromText(controlAction.value || result.summary_for_user || controlAction.reason || "");
    return {
      type: "memory_proposal",
      text: proposal.content,
      question: "",
      reason: "",
      goal: result.goal || "",
      risk_level: "low",
      summary_for_user: result.summary_for_user || "",
      needs_clarification: false,
      requires_confirmation: false,
      will_submit: false,
      actions: [],
      uncertain_fields: [],
      memory_title: proposal.title,
      memory_content: proposal.content
    };
  }

  const text = compact(
    controlAction.value
    || result.question
    || result.reason
    || result.summary_for_user
    || controlAction.reason
    || ""
  );

  if (controlAction.type === "stop_for_human") {
    return {
      type: "stop_for_human",
      reason: text || "This needs to be handled by the user directly."
    };
  }

  return {
    type: "ask_user",
    question: text || "I need one more confirmation before continuing."
  };
}

function isProviderTimeoutResult(result) {
  const text = `${result?.message || ""} ${result?.error || ""}`;
  return result?.type === "agent_error" && (/\b524\b/.test(text) || /timeout occurred|timed out|aborted due to timeout/i.test(text));
}

function isUserStoppedResult(result) {
  const text = `${result?.message || ""} ${result?.error || ""}`;
  return result?.type === "agent_error" && /stopped by the user/i.test(text);
}

function formatProviderAgentErrorMessage(result) {
  const raw = String(result?.message || "").trim();

  if (/\b524\b/.test(raw) || /timeout occurred|timed out|aborted due to timeout/i.test(raw)) {
    return "The HTTP provider timed out before the model completed its response. If this happens often, the model is too slow for this page or the local bridge timeout needs to be increased.";
  }

  if (/exceeds the available context size|exceed_context_size_error/i.test(raw)) {
    return "The HTTP provider rejected the request because the supplied context exceeds the model's available context window.";
  }

  return raw || "The selected local provider is not ready, so I used only local page context.";
}

function isMemoryProposalLike(result, action) {
  const combined = `${result?.goal || ""} ${result?.summary_for_user || ""} ${action?.reason || ""} ${action?.value || ""}`;
  return /\b(memory|memoria|remember|save|store|salva|salvare|memorizza|local memory|user memory)\b/i.test(combined);
}

function extractMemoryProposalFromText(text) {
  const raw = String(text || "").trim();
  const withoutQuestion = raw
    .replace(/\n*Would you like me to save[\s\S]*$/i, "")
    .replace(/\n*Vuoi che (?:lo|la|le)?\s*salvi[\s\S]*$/i, "")
    .trim();
  const lines = withoutQuestion.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = compact(lines[0] || "User memory")
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "")
    .slice(0, 90);

  return sanitizeMemoryItem({
    title,
    content: withoutQuestion || raw
  }, { goal: raw });
}

function getAgentDisplayText(result) {
  const text = compact(
    result?.text
    || result?.answer
    || result?.response
    || result?.message
    || result?.result
    || result?.output
    || result?.summary
    || result?.summary_for_user
    || result?.question
    || result?.reason
    || ""
  );

  return extractNestedNaturalText(text);
}

function getAgentDisplayThinking(result) {
  const text = compact(
    result?.thinking
    || result?.reasoning_content
    || result?.message?.reasoning_content
    || ""
  );

  return extractNestedReasoningText(text);
}

function extractNestedNaturalText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const parsed = parseLooseJsonObject(raw);
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
  const candidate = Array.isArray(parsed?.candidates) ? parsed.candidates[0] : null;
  const geminiParts = Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts.map((part) => part?.text || "").filter(Boolean).join("\n")
    : "";
  const nested = parsed?.text
    || parsed?.answer
    || parsed?.response
    || parsed?.content
    || parsed?.message?.content
    || parsed?.message
    || choice?.message?.content
    || choice?.text
    || geminiParts
    || parsed?.result
    || parsed?.output
    || parsed?.summary
    || "";

  if (nested && typeof nested === "string") {
    addDebugLog("agent.nested_json_text_unwrapped", { raw, parsed }, "Unwrapped JSON text returned as natural_response.");
    return compact(nested);
  }

  return raw;
}

function extractNestedReasoningText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const parsed = parseLooseJsonObject(raw);
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
  const nested = parsed?.thinking
    || parsed?.reasoning_content
    || parsed?.message?.reasoning_content
    || choice?.message?.reasoning_content
    || "";

  if (nested && typeof nested === "string") {
    return compact(nested);
  }

  return raw;
}

async function confirmPendingPlan(options = {}) {
  const plan = normalizePlan(state.pendingPlan);

  if (!plan) {
    return;
  }

  const planContext = state.pendingPlanContext;
  const pendingPolicy = state.pendingPolicy;
  if (options.approvalScope === "session") {
    addSessionApprovalForPlan(plan, pendingPolicy, planContext);
  }

  state.pendingPlan = null;
  state.pendingPlanContext = null;
  state.pendingPolicy = null;
  state.confirmationText = "";

  try {
    await executeActionPlan(plan, { planContext });
  } catch (error) {
    state.messages.push({
      role: "assistant",
      text: error.message || "The confirmed action could not be executed.",
      variant: "error",
      createdAt: Date.now()
    });
    state.activity.unshift(`Execution failed: ${error.message || "Unexpected error."}`);
    render();
  }
}

async function executeActionPlan(plan, options = {}) {
  const normalizedPlan = normalizePlan(plan);
  const actions = normalizedPlan?.actions || [];
  const pageMatch = await verifyActionPlanPageContext(actions, options.planContext);

  if (!pageMatch.ok) {
    state.messages.push({
      role: "assistant",
      text: pageMatch.error,
      variant: "error",
      createdAt: Date.now()
    });
    state.activity.unshift(`Execution blocked: ${pageMatch.error}`);
    addDebugLog("action.stale_page_blocked", {
      expected: options.planContext || null,
      current: pageMatch.current || null,
      actions
    }, "Blocked stale page-bound action plan.");
    render();
    return;
  }

  const permission = await ensurePermissionForActionPlan(actions);

  if (!permission.ok) {
    state.messages.push({
      role: "assistant",
      text: permission.error,
      variant: "error",
      createdAt: Date.now()
    });
    state.activity.unshift(`Execution blocked: ${permission.error}`);
    render();
    return;
  }

  state.activity.unshift("Executing browser action plan...");
  addActionNote("Executing browser actions", actions.map(formatActionDetail));
  addDebugLog("action.execute.start", { plan: normalizedPlan }, `${actions.length} action(s).`);
  render();

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.EXECUTE_ACTION_PLAN, { plan: normalizedPlan }));
  addDebugLog("action.execute.end", {
    ok: response.ok,
    error: response.error || "",
    result: response.envelope?.payload || null
  }, response.ok ? "Action execution response received." : response.error);

  if (!response.ok) {
    state.messages.push({ role: "assistant", text: response.error, variant: "error", createdAt: Date.now() });
    state.activity.unshift(`Execution failed: ${response.error}`);
    render();
    return;
  }

  const results = response.envelope.payload.results || [];
  rememberActionResultTabs(results);
  results.forEach((result) => state.activity.unshift(result.log_message));
  addActionNote("Browser action result", results.map((result) => `${result.status}: ${result.log_message}`));
  const httpArtifacts = results
    .map((result) => result.artifact)
    .filter((artifact) => artifact?.kind === "http_response");
  const searchArtifacts = results
    .map((result) => result.artifact)
    .filter((artifact) => artifact?.kind === "web_search");

  [...httpArtifacts, ...searchArtifacts].forEach((artifact) => {
    addActionNote(getArtifactSummary(artifact), getArtifactDetails(artifact));
  });

  const completionResults = shouldCapturePostActionObservation(normalizedPlan, results)
    ? await capturePostActionObservation(results)
    : results;

  const steeredQueueItem = consumePendingSteeredQueueItem();
  if (steeredQueueItem) {
    injectSteeredMessageIntoCurrentFlow(steeredQueueItem);
    render();
  }

  if (shouldAutoContinueAfterReadOnlyAction(normalizedPlan, results, options)) {
    await refreshPageAfterAction();
    const goal = buildSteeredContinuationGoal(normalizedPlan.goal || getLastUserMessageText() || "", steeredQueueItem);
    const continuationDepth = (options.continuationDepth || 0) + 1;
    state.activity.unshift("Continuing with updated page context.");
    addDebugLog("agent.auto_continue", {
      goal,
      continuationDepth,
      actions,
      results
    }, "Continuing after read-only context action.");
    render();
    const followUpResult = await getAgentResult(goal, {
      continuationDepth,
      continuationReason: appendSteeredContinuationReason(
        "A read-only browser action was just executed to gather context. Use the updated page observation to answer the user's original request now if possible. Only request another read-only action if essential.",
        steeredQueueItem
      ),
      planContext: options.planContext || getObservedPageContext()
    });
    await handleAgentResult(followUpResult, {
      continuationDepth,
      planContext: options.planContext || getObservedPageContext()
    });
    return;
  }

  if (isSuccessfulReadOnlyContextRun(normalizedPlan, results)) {
    const finalized = await finalizeReadOnlyRequest(normalizedPlan, results, { ...options, steeredQueueItem });
    if (finalized) {
      return;
    }
  }

  const synthesized = await maybeSynthesizeResults(plan, completionResults);
  if (steeredQueueItem || shouldContinueAfterActionPlan(normalizedPlan, completionResults, synthesized, options)) {
    const goal = buildSteeredContinuationGoal(normalizedPlan.goal || getLastUserMessageText() || "", steeredQueueItem);
    const continuationDepth = (options.continuationDepth || 0) + 1;
    const planContext = options.planContext || getObservedPageContext();
    state.activity.unshift("Continuing with the latest action results.");
    addDebugLog("agent.auto_continue_after_actions", {
      goal,
      continuationDepth,
      actions,
      results: completionResults,
      synthesized
    }, "Continuing after browser actions because the current context is not sufficient yet.");
    render();
    const followUpResult = await getAgentResult(goal, {
      continuationDepth,
      continuationReason: appendSteeredContinuationReason(
        buildPostActionContinuationReason(normalizedPlan, completionResults, synthesized),
        steeredQueueItem
      ),
      planContext
    });
    await handleAgentResult(followUpResult, {
      continuationDepth,
      planContext
    });
    return;
  }
  const answerText = synthesized || getExecutionSummary(completionResults);
  const memoryProposal = await maybeSaveResearchMemory(plan, completionResults, answerText);
  state.messages.push({
    role: "assistant",
    text: memoryProposal ? appendMemorySavedNote(answerText) : answerText,
    createdAt: Date.now()
  });
  if (memoryProposal) {
    proposeMemorySave(memoryProposal.item, memoryProposal.responseLanguage, memoryProposal.goal);
  }
  await refreshPageAfterAction();
}

async function capturePostActionObservation(results) {
  await refreshPageAfterAction();
  return appendCurrentObservationArtifact(results);
}

function shouldCapturePostActionObservation(plan, results) {
  const actions = plan?.actions || [];

  if (!actions.length || !results.length) {
    return false;
  }

  if (results.some((result) => result.page_changed)) {
    return true;
  }

  if (results.some((result) => result.status !== "success")) {
    return false;
  }

  return actions.some((action) => POST_ACTION_OBSERVATION_ACTION_TYPES.has(action?.type));
}

function shouldAutoContinueAfterReadOnlyAction(plan, results, options = {}) {
  if ((options.continuationDepth || 0) >= MAX_READ_ONLY_CONTINUATIONS) {
    return false;
  }

  return isSuccessfulReadOnlyContextRun(plan, results);
}

function isSuccessfulReadOnlyContextRun(plan, results) {
  const actions = plan?.actions || [];

  if (!actions.length || !results.length || results.some((result) => result.status !== "success")) {
    return false;
  }

  const hasExternalArtifact = results.some((result) => ["web_search", "http_response"].includes(result.artifact?.kind));
  return !hasExternalArtifact && actions.every((action) => READ_ONLY_CONTEXT_ACTION_TYPES.has(action?.type));
}

async function finalizeReadOnlyRequest(plan, results, options = {}) {
  await refreshPageAfterAction();

  const goal = buildSteeredContinuationGoal(plan.goal || getLastUserMessageText() || "", options.steeredQueueItem);
  const responseLanguage = detectUserLanguage(goal);
  const planContext = options.planContext || getObservedPageContext();
  const completionResults = appendCurrentObservationArtifact(results);

  state.activity.unshift("Finishing the request with the gathered page context.");
  addDebugLog("agent.read_only_finalize.start", {
    goal,
    continuationDepth: options.continuationDepth || 0,
    planContext,
    results: completionResults
  }, "Requesting a final answer after read-only context gathering.");
  render();

  const synthesized = await maybeSynthesizeResults({ ...plan, goal }, completionResults);
  if (synthesized && !isActionOnlyCompletionText(synthesized)) {
    const memoryProposal = await maybeSaveResearchMemory(plan, completionResults, synthesized);
    state.messages.push({
      role: "assistant",
      text: memoryProposal ? appendMemorySavedNote(synthesized) : synthesized,
      createdAt: Date.now()
    });
    if (memoryProposal) {
      proposeMemorySave(memoryProposal.item, memoryProposal.responseLanguage, memoryProposal.goal);
    } else {
      render();
    }
    return true;
  }

  const followUpResult = await getAgentResult(goal, {
    continuationDepth: options.continuationDepth || 0,
    continuationReason: appendSteeredContinuationReason(
      "Context gathering is complete. Answer the user's original request directly now using the latest page observation. Do not return another read-only action plan. If something is still missing, explain exactly what is missing.",
      options.steeredQueueItem
    ),
    planContext
  });

  if (followUpResult?.type === "agent_plan" && isReadOnlyContextPlan(followUpResult)) {
    const fallbackText = responseLanguage === "it"
      ? "Ho raccolto il contesto disponibile dalla pagina, ma l'agente continua a chiedere altre azioni di sola lettura invece di rispondere. Mi fermo qui per evitare un loop. Se torni nella sezione giusta o fai un nuovo Observe, posso riprendere da li'."
      : "I gathered the available page context, but the agent kept asking for more read-only actions instead of answering. I stopped here to avoid a loop. If you return to the right section or run Observe again, I can continue from there.";
    state.messages.push({
      role: "assistant",
      text: fallbackText,
      createdAt: Date.now()
    });
    addDebugLog("agent.read_only_finalize.loop_blocked", {
      goal,
      result: followUpResult,
      planContext
    }, "Stopped a repeated read-only continuation loop.");
    render();
    return true;
  }

  await handleAgentResult(followUpResult, {
    continuationDepth: options.continuationDepth || 0,
    planContext
  });
  return true;
}

function appendCurrentObservationArtifact(results) {
  const items = Array.isArray(results) ? [...results] : [];
  const hasPageObservation = items.some((result) => result?.artifact?.kind === "page_observation");

  if (!hasPageObservation && state.page.observation) {
    items.push({
      action_id: "current_page_observation",
      status: "success",
      target_verified: true,
      page_changed: false,
      type: "execution_result",
      validation_messages: [],
      log_message: "Captured the latest page observation for answer synthesis.",
      artifact: {
        kind: "page_observation",
        observation: state.page.observation
      }
    });
  }

  return items;
}

function shouldContinueAfterActionPlan(plan, results, synthesized, options = {}) {
  if ((options.continuationDepth || 0) >= MAX_ACTION_CONTINUATIONS) {
    return false;
  }

  const actions = plan?.actions || [];
  if (!actions.length || !results.length || results.some((result) => result.status !== "success")) {
    return false;
  }

  if (isSuccessfulReadOnlyContextRun(plan, results)) {
    return false;
  }

  if (synthesized && !isActionOnlyCompletionText(synthesized)) {
    return false;
  }

  return results.some((result) => ACTION_CONTINUATION_ARTIFACT_KINDS.has(result.artifact?.kind))
    || actions.some((action) => POST_ACTION_OBSERVATION_ACTION_TYPES.has(action?.type));
}

function buildPostActionContinuationReason(plan, results, synthesized) {
  const latestObservation = compactObservationForProvider(getLatestObservationFromResults(results));
  const actionSummary = results
    .slice(0, 6)
    .map((result) => {
      const detail = compact(result?.log_message || "");
      return `${result.action_id || "action"}: ${result.status}${detail ? ` - ${detail}` : ""}`;
    })
    .join(" | ");
  const fallbackNote = synthesized
    ? `The intermediate answer was not sufficient yet: "${compact(synthesized).slice(0, 240)}".`
    : "No final answer is available yet from the last action batch.";

  return [
    "A browser action batch has just completed. Use the newest context to either answer directly or choose the next necessary action plan.",
    latestObservation ? `Latest observed page after the actions: ${formatObservationForContinuation(latestObservation)}.` : "",
    actionSummary ? `Recent action results: ${actionSummary}.` : "",
    fallbackNote,
    "Do not stop only because the previous action batch finished. If the user's goal still needs more context, return the next best action plan."
  ].filter(Boolean).join("\n");
}

function getLatestObservationFromResults(results) {
  const pageObservationResult = [...(Array.isArray(results) ? results : [])]
    .reverse()
    .find((result) => result?.artifact?.kind === "page_observation");

  return pageObservationResult?.artifact?.observation || state.page.observation || null;
}

function formatObservationForContinuation(observation) {
  const tab = observation?.tab || {};
  const parts = [];
  if (tab.title) parts.push(`title="${String(tab.title).slice(0, 120)}"`);
  if (tab.url) parts.push(`url=${String(tab.url).slice(0, 220)}`);
  if (observation?.capturedAt) parts.push(`capturedAt=${observation.capturedAt}`);
  return parts.join(", ");
}

function isReadOnlyContextPlan(plan) {
  const actions = plan?.actions || [];
  return Boolean(actions.length) && actions.every((action) => READ_ONLY_CONTEXT_ACTION_TYPES.has(action?.type));
}

function isActionOnlyCompletionText(text) {
  const compactText = compact(text).toLowerCase();
  return compactText === "the browser actions were completed."
    || compactText === "no browser actions were returned."
    || compactText === "scrolled the page."
    || compactText === "observed the active tab."
    || compactText === "action completed."
    || compactText.length < 40;
}

function getLastUserMessageText() {
  return [...state.messages].reverse().find((message) => message.role === "user")?.text || "";
}

async function getCurrentActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

function createPlanPageContext(plan) {
  const actions = plan?.actions || [];

  if (!actions.some(isPageBoundAction)) {
    return null;
  }

  return getObservedPageContext();
}

function getObservedPageContext() {
  const tab = state.page.observation?.tab || {};
  if (!tab.id && !tab.url && !tab.title && !state.page.url && !state.page.title) {
    return null;
  }

  return {
    tabId: tab.id || null,
    url: tab.url || state.page.url || "",
    title: tab.title || state.page.title || "",
    capturedAt: state.page.observation?.capturedAt || ""
  };
}

function tabToPageContext(tab) {
  if (!tab?.id && !tab?.url && !tab?.title) {
    return null;
  }

  return {
    tabId: tab?.id || null,
    url: tab?.url || "",
    title: tab?.title || "",
    capturedAt: new Date().toISOString()
  };
}

async function verifyActionPlanPageContext(actions, expectedContext) {
  if (!actions.some(isPageBoundAction) || !expectedContext) {
    return { ok: true };
  }

  const tab = await getCurrentActiveTab();
  const current = {
    tabId: tab?.id || null,
    url: tab?.url || "",
    title: tab?.title || ""
  };
  const sameTab = !expectedContext.tabId || !current.tabId || expectedContext.tabId === current.tabId;
  const sameUrl = normalizeUrlForContext(expectedContext.url) === normalizeUrlForContext(current.url);

  if (sameTab && sameUrl) {
    return { ok: true, current };
  }

  const restored = await restoreExpectedTab(expectedContext);

  if (restored.ok) {
    addDebugLog("action.plan_tab_restored", {
      expected: expectedContext,
      previous: current,
      restored: restored.current
    }, "Restored the tab bound to the action plan.");
    return restored;
  }

  return {
    ok: false,
    current: restored.current || current,
    error: getStalePageContextMessage(detectUserLanguage(getLastUserMessageText()))
  };
}

async function restoreExpectedTab(expectedContext) {
  if (!expectedContext?.tabId) {
    return { ok: false };
  }

  try {
    const tab = await chrome.tabs.get(expectedContext.tabId);
    const sameUrl = normalizeUrlForContext(expectedContext.url) === normalizeUrlForContext(tab?.url);

    if (!sameUrl) {
      return {
        ok: false,
        current: {
          tabId: tab?.id || null,
          url: tab?.url || "",
          title: tab?.title || ""
        }
      };
    }

    await chrome.tabs.update(expectedContext.tabId, { active: true });
    rememberActiveTab(tab);
    return {
      ok: true,
      current: {
        tabId: tab.id || null,
        url: tab.url || "",
        title: tab.title || ""
      }
    };
  } catch {
    return { ok: false };
  }
}

function getStalePageContextMessage(language) {
  if (language === "it") {
    return "La pagina di riferimento della richiesta non e' piu' disponibile o e' cambiata. Non eseguo l'azione per evitare di usare la scheda sbagliata. Torna alla pagina corretta, clicca Observe e riprova.";
  }

  return "The page for that request is no longer available or has changed. I stopped instead of acting in the wrong tab. Return to the correct page, click Observe, and retry.";
}

function normalizeUrlForContext(url) {
  try {
    const parsed = new URL(url || "");
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(url || "");
  }
}

function rememberObservedTab(observation, source = "observation") {
  const tab = observation?.tab;
  if (!tab?.id && !tab?.url) {
    return;
  }

  const id = String(tab.id || normalizeUrlForContext(tab.url));
  const previous = state.accessibleTabs[id] || {};
  const now = new Date().toISOString();
  state.accessibleTabs[id] = {
    id,
    tabId: tab.id || previous.tabId || null,
    url: tab.url || previous.url || "",
    title: tab.title || previous.title || "",
    source,
    lastObservedAt: observation.capturedAt || now,
    lastActiveAt: previous.lastActiveAt || "",
    visibleTextLength: String(observation.visible_text || "").length,
    links: Array.isArray(observation.links) ? observation.links.length : 0,
    buttons: Array.isArray(observation.buttons) ? observation.buttons.length : 0
  };
  pruneAccessibleTabs();
}

function rememberActiveTab(tab) {
  if (!tab?.id && !tab?.url) {
    return;
  }

  const id = String(tab.id || normalizeUrlForContext(tab.url));
  const previous = state.accessibleTabs[id] || {};
  state.accessibleTabs[id] = {
    id,
    tabId: tab.id || previous.tabId || null,
    url: tab.url || previous.url || "",
    title: tab.title || previous.title || "",
    source: previous.source || "active-tab",
    lastObservedAt: previous.lastObservedAt || "",
    lastActiveAt: new Date().toISOString(),
    visibleTextLength: previous.visibleTextLength || 0,
    links: previous.links || 0,
    buttons: previous.buttons || 0
  };
  pruneAccessibleTabs();
}

function rememberActionResultTabs(results) {
  results.forEach((result) => {
    const observation = result?.artifact?.kind === "page_observation"
      ? result.artifact.observation
      : result?.artifact?.observation;
    rememberObservedTab(observation, "action-artifact");
  });
}

function getRecentAccessibleTabs(currentTabId) {
  return Object.values(state.accessibleTabs || {})
    .sort((a, b) => String(b.lastActiveAt || b.lastObservedAt || "").localeCompare(String(a.lastActiveAt || a.lastObservedAt || "")))
    .slice(0, 6)
    .map((tab) => ({
      ...tab,
      isCurrent: Boolean(currentTabId && tab.tabId === currentTabId)
    }));
}

function pruneAccessibleTabs() {
  const entries = Object.entries(state.accessibleTabs || {})
    .sort(([, a], [, b]) => String(b.lastActiveAt || b.lastObservedAt || "").localeCompare(String(a.lastActiveAt || a.lastObservedAt || "")))
    .slice(0, 12);
  state.accessibleTabs = Object.fromEntries(entries);
}

function isPageBoundAction(action) {
  return [
    "observe_page",
    "get_visible_text",
    "get_dom_snapshot",
    "get_forms",
    "get_links",
    "get_buttons",
    "scroll_to_element",
    "scroll_by",
    "wait_for_page_change",
    "focus_element",
    "highlight_element",
    "fill_field",
    "select_option",
    "toggle_checkbox",
    "set_radio",
    "upload_file_to_field",
    "click_element",
    "click_overlay_number",
    "capture_viewport",
    "capture_numbered_overlay"
  ].includes(action?.type);
}

async function ensurePermissionForActionPlan(actions) {
  if (!actions.some(needsActiveTabReadPermission)) {
    return { ok: true };
  }

  const observed = await observePage({
    reason: "read the current page for this browser action",
    skipWaitingMessage: false
  });

  if (observed) {
    return { ok: true };
  }

  return {
    ok: false,
    error: "I need site access permission before I can read or act on this page. Click Observe or retry the request; if Chrome shows the prompt, approve site access."
  };
}

function needsActiveTabReadPermission(action) {
  return [
    "observe_page",
    "get_visible_text",
    "get_links",
    "get_buttons",
    "get_forms",
    "get_dom_snapshot",
    "capture_viewport",
    "capture_numbered_overlay",
    "click_element",
    "focus_element",
    "highlight_element",
    "fill_field",
    "select_option",
    "toggle_checkbox",
    "set_radio",
    "upload_file_to_field",
    "click_overlay_number"
  ].includes(action?.type);
}

async function refreshPageAfterAction() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url) {
    return;
  }

  let originPattern;
  try {
    const url = new URL(tab.url);
    if (!["http:", "https:"].includes(url.protocol)) return;
    originPattern = `${url.origin}/*`;
  } catch {
    return;
  }

  const hasPermission = await chrome.permissions.contains({
    origins: [originPattern]
  });

  if (!hasPermission) {
    state.activity.unshift(`Skipped post-action observation because site access is not granted for ${originPattern}.`);
    render();
    return;
  }

  await observePage({ silent: true });
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== "object") {
    return null;
  }

  return {
    ...plan,
    actions: Array.isArray(plan.actions) ? plan.actions : [],
    uncertain_fields: Array.isArray(plan.uncertain_fields) ? plan.uncertain_fields : []
  };
}

function cancelPendingPlan() {
  state.pendingPlan = null;
  state.pendingPolicy = null;
  state.confirmationText = "";
  state.activity.unshift("Action plan canceled.");
  addActionNote("Canceled action approval", ["The pending browser action plan was canceled."]);
  persistSession();
  render();
}

function canOfferSessionApproval(plan, policy, planContext) {
  if (!policy?.allowed || !policy?.requiresConfirmation) {
    return false;
  }

  const highestRisk = getHighestRisk(policy);
  if (highestRisk === "blocked" || highestRisk === "sensitive") {
    return false;
  }

  return buildSessionApprovalEntries(plan, policy, planContext).length > 0;
}

function hasSessionApprovalForPlan(plan, policy, planContext) {
  const entries = buildSessionApprovalEntries(plan, policy, planContext);
  if (!entries.length) {
    return false;
  }

  return entries.every((entry) => state.sessionApprovals.some((stored) => stored.key === entry.key));
}

function addSessionApprovalForPlan(plan, policy, planContext) {
  const entries = buildSessionApprovalEntries(plan, policy, planContext);
  if (!entries.length) {
    return;
  }

  const next = [...state.sessionApprovals];
  for (const entry of entries) {
    if (!next.some((stored) => stored.key === entry.key)) {
      next.push(entry);
    }
  }

  state.sessionApprovals = next.slice(-60);
  state.activity.unshift(`Saved ${entries.length} session approval rule${entries.length === 1 ? "" : "s"} for similar actions.`);
  addActionNote("Saved session approval", entries.map((entry) => entry.label));
  persistSession();
}

function buildSessionApprovalEntries(plan, policy, planContext) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const results = Array.isArray(policy?.results) ? policy.results : [];
  if (!actions.length || !results.length) {
    return [];
  }

  const origin = getApprovalOrigin(planContext?.url || state.page.observation?.tab?.url || "");
  const entries = [];

  if (!origin) {
    return [];
  }

  for (const policyResult of results) {
    if (!policyResult?.requiresConfirmation) {
      continue;
    }

    const action = actions[policyResult.index];
    if (!isSessionApprovableAction(action, policyResult)) {
      return [];
    }

    const key = JSON.stringify({
      origin,
      risk: policyResult.risk,
      actionType: action.type || "",
      targetRole: action?.target?.role || "",
      targetKey: getActionApprovalTargetKey(action)
    });

    entries.push({
      key,
      label: `${policyResult.risk} ${action.type}${origin ? ` on ${origin}` : ""}${action?.target?.name ? ` -> ${action.target.name}` : ""}`,
      createdAt: new Date().toISOString()
    });
  }

  return entries;
}

function isSessionApprovableAction(action, policyResult) {
  if (!action || !policyResult?.requiresConfirmation) {
    return false;
  }

  if (policyResult.risk === "blocked" || policyResult.risk === "sensitive") {
    return false;
  }

  return [
    "focus_element",
    "fill_field",
    "select_option",
    "toggle_checkbox",
    "set_radio",
    "click_element",
    "click_overlay_number"
  ].includes(action.type);
}

function getApprovalOrigin(url) {
  try {
    return new URL(url || "").origin;
  } catch {
    return "";
  }
}

function getActionApprovalTargetKey(action) {
  const target = action?.target || {};
  const selectorKey = Array.isArray(target.selector_candidates)
    ? target.selector_candidates.filter(Boolean).slice(0, 3).join("||")
    : "";
  return normalizeApprovalText(
    target.agent_id
    || selectorKey
    || target.name
    || target.role
    || ""
  );
}

function normalizeApprovalText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function addActionNote(summary, details = []) {
  state.actionNotes.push({
    id: crypto.randomUUID(),
    createdAt: Date.now() + state.actionNotes.length / 1000,
    summary,
    details: details.filter(Boolean).slice(0, 20)
  });
}

function formatActionDetail(action) {
  const target = action.target?.name ? ` on ${action.target.name}` : "";
  const value = action.value ? ` -> ${action.value}` : "";
  return `${action.type}${target}${value}${action.reason ? `: ${action.reason}` : ""}`;
}

function addDebugLog(event, data = {}, summary = "") {
  state.debugLogs.unshift({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    event,
    summary,
    data: sanitizeDebugData(data)
  });
  state.debugLogs = state.debugLogs.slice(0, 200);
  persistSession();
}

function sanitizeDebugData(value, depth = 0) {
  if (depth > 6) return "[depth limit]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactSensitiveText(value).slice(0, 8000);
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => sanitizeDebugData(item, depth + 1));
  if (typeof value !== "object") return String(value);

  const objectKeys = Object.keys(value);
  const looksLikeAttachment = objectKeys.includes("status")
    && objectKeys.includes("type")
    && (objectKeys.includes("text") || objectKeys.includes("textPreview") || objectKeys.includes("name"));

  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/password|authorization|token|secret|cookie|credential|username/i.test(key)) {
      return [key, "[redacted]"];
    }

    if (/reasoning/i.test(key)) {
      return [key, "[omitted provider reasoning]"];
    }

    if (looksLikeAttachment && key === "name") {
      return [key, "[attachment name redacted]"];
    }

    if (/baseUrl|codexPath|command|path/i.test(key) && typeof item === "string") {
      return [key, redactLocalAndPrivateUrls(item)];
    }

    if (/goal|memoryRequest|requestedScope|summary_for_user|question|reason|value/i.test(key) && typeof item === "string") {
      const redacted = redactSensitiveText(item);
      return [key, redacted.length > 240 ? `[omitted ${item.length} chars]` : redacted];
    }

    if (/text|content|body|visible_text|bodyPreview|textPreview|prompt/i.test(key) && typeof item === "string") {
      return [key, `[omitted ${item.length} chars]`];
    }

    return [key, sanitizeDebugData(item, depth + 1)];
  }));
}

function redactSensitiveText(text) {
  return String(text || "")
    .replace(/[A-Za-z]:\\(?:Users\\[^\\\s]+|Desktop|Documents|Downloads|Desktop\\Projects)[^\n\r"]*/gi, "[local path]")
    .replace(/https?:\/\/(?:llm\.)?[^/\s"]+/gi, "[url]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:\+?\d[\d .()-]{7,}\d)\b/g, "[phone]");
}

function redactLocalAndPrivateUrls(text) {
  return redactSensitiveText(text)
    .replace(/\\[^\\\s"]+/g, "\\...")
    .slice(0, 240);
}

async function copyDebugLogs() {
  await navigator.clipboard.writeText(JSON.stringify(state.debugLogs, null, 2));
  state.activity.unshift("Diagnostic logs copied.");
  render();
}

function clearDebugLogs() {
  state.debugLogs = [];
  state.activity.unshift("Diagnostic logs cleared.");
  persistSession();
  render();
}

function parseDirectMemoryRequest(text) {
  const raw = String(text || "").trim();
  if (isResearchIntent(raw)) {
    return null;
  }

  const match = raw.match(/^(?:remember|save|store|ricordati|salva|salvalo|salvare|memorizza|aggiungi)\b(?:\s+(?:that|che|questo|this|in memoria|to memory))?\s*[:,-]?\s+([\s\S]{6,})/i);

  const looseMemorySave = !match
    && /\b(remember|save|store|ricordati|salva|salvalo|salvare|memorizza|aggiungi)\b/i.test(raw)
    && /\b(memory|memoria|informazioni|information|profilo|profile|sintesi|summary)\b/i.test(raw);

  if (!match && !looseMemorySave) {
    return null;
  }

  const content = (match?.[1] || raw).trim();
  if (!content || /\?$/.test(content)) {
    return null;
  }

  return {
    synthesize: true,
    goal: raw,
    requestedScope: content
  };
}

async function synthesizeMemoryRequest(intent) {
  const fallback = buildFallbackMemorySynthesis(intent);

  if (state.connector.status !== "connected") {
    return fallback;
  }

  const payload = {
    task: "user_memory",
    goal: intent.goal,
    memoryRequest: intent.goal,
    requestedScope: intent.requestedScope,
    responseLanguage: detectUserLanguage(intent.goal),
    provider: state.codex.provider,
    model: state.codex.model,
    httpProvider: getSelectedHttpProvider(),
    conversationContext: getRecentConversationForMemory(intent.goal),
    userMemory: state.userMemory.items.map((item) => ({
      id: item.id,
      title: item.title,
      content: item.content,
      updatedAt: item.updatedAt
    })),
    attachments: state.attachments.map((file) => ({
      id: file.id,
      name: file.name,
      type: file.type,
      status: file.status,
      textPreview: state.privacy.sendAttachmentsToCodex ? String(file.text || "").slice(0, 2000) : ""
    }))
  };
  addDebugLog("provider.memory_synthesis.start", payload, `${state.codex.provider} / ${state.codex.model}`);
  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.SYNTHESIS_REQUEST, payload));
  addDebugLog("provider.memory_synthesis.end", {
    ok: response.ok,
    error: response.error || "",
    result: response.envelope?.payload || null
  }, response.ok ? "Memory synthesis response received." : response.error);

  if (!response.ok) {
    state.activity.unshift(`Memory synthesis failed: ${response.error}`);
    return fallback;
  }

  return parseMemorySynthesisResponse(response.envelope.payload?.text || "", intent, fallback);
}

function getRecentConversationForMemory(currentText) {
  return state.messages
    .filter((message) => message.text !== currentText)
    .slice(-10)
    .map((message) => ({
      role: message.role,
      text: String(message.text || "").slice(0, 4000),
      createdAt: message.createdAt || 0
    }));
}

function parseMemorySynthesisResponse(text, intent, fallback) {
  const parsed = parseLooseJsonObject(text);
  const title = parsed?.title || parsed?.name || parsed?.heading || "";
  const content = parsed?.content || parsed?.body || parsed?.memory || parsed?.summary || parsed?.text || "";

  if (title && content) {
    return sanitizeMemoryItem({ title, content }, intent);
  }

  const plain = stripMarkdownJsonFence(text).trim();
  if (plain.length > 20) {
    const lines = plain.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return sanitizeMemoryItem({
      title: title || lines[0] || fallback.title,
      content: content || lines.slice(1).join("\n") || plain
    }, intent);
  }

  return fallback;
}

function parseLooseJsonObject(text) {
  const candidates = [
    stripMarkdownJsonFence(text),
    extractJsonObjectLiteral(text)
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function extractJsonObjectLiteral(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return "";
  return raw.slice(start, end + 1);
}

function stripMarkdownJsonFence(text) {
  return String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function sanitizeMemoryItem(item, intent) {
  const title = compact(item.title || inferResearchMemoryTitle(intent.goal)).slice(0, 90) || "User memory";
  const content = String(item.content || "")
    .replace(/^content\s*:\s*/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 5000);

  return {
    title,
    content: content || buildFallbackMemorySynthesis(intent).content
  };
}

function buildFallbackMemorySynthesis(intent) {
  const context = getRecentConversationForMemory(intent.goal)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n\n")
    .slice(-6000);

  return {
    title: inferResearchMemoryTitle(`${intent.goal}\n${context}`),
    content: [
      "Memory request to synthesize later:",
      compact(intent.requestedScope || intent.goal),
      "",
      "Recent context available when this was saved:",
      context || "No recent conversation context was available.",
      "",
      "Reliability note: this fallback was saved because provider-based memory synthesis was unavailable or malformed."
    ].join("\n").slice(0, 5000)
  };
}

function isResearchIntent(text) {
  return /\b(cerca|search|look up|find|internet|online|web|google|fonti|sources|dettagli|details|informazioni|information)\b/i.test(text);
}

function isDeferredMemoryIntent(text) {
  return /\b(ricordati|remember|save|store|memorizza|salva|aggiungi|add)\b/i.test(text);
}

function parseDeferredMemoryIntent(text) {
  if (!isDeferredMemoryIntent(text)) {
    return null;
  }

  return {
    goal: text,
    title: inferResearchMemoryTitle(text),
    createdAt: Date.now()
  };
}

function shouldRememberAfterResearch(text) {
  return isResearchIntent(text) && /\b(ricordati|remember|save|store|memorizza|salva|aggiungi|add)\b/i.test(text);
}

async function maybeSaveResearchMemory(plan, results, answerText) {
  const goal = state.pendingMemoryIntent?.goal || plan?.goal || [...state.messages].reverse().find((message) => message.role === "user")?.text || "";
  const hasResearchArtifact = results.some((result) => ["web_search", "http_response", "page_observation", "screenshot"].includes(result.artifact?.kind));

  if (!shouldRememberAfterResearch(goal) || !hasResearchArtifact || !answerText || /^No browser actions/.test(answerText)) {
    return false;
  }

  const title = state.pendingMemoryIntent?.title || inferResearchMemoryTitle(goal);
  state.pendingMemoryIntent = null;

  return {
    item: {
      title,
      content: curateMemoryContent(answerText)
    },
    responseLanguage: detectUserLanguage(goal),
    goal
  };
}

async function maybeSaveDeferredMemory(answerText) {
  const intent = state.pendingMemoryIntent;

  if (!intent || !answerText || /^I could not produce/.test(answerText)) {
    return false;
  }

  state.pendingMemoryIntent = null;

  return {
    item: {
      title: intent.title || inferResearchMemoryTitle(intent.goal),
      content: curateMemoryContent(answerText)
    },
    responseLanguage: detectUserLanguage(intent.goal),
    goal: intent.goal
  };
}

function curateMemoryContent(text) {
  return String(text || "")
    .replace(/^Add this CV summary:\s*/i, "")
    .replace(/^CV Summary\s*/i, "CV Summary\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 5000);
}

function appendMemorySavedNote(text) {
  return `${text}\n\n_Memory preview prepared._`;
}

const READ_ONLY_CONTEXT_ACTION_TYPES = new Set([
  "observe_page",
  "get_visible_text",
  "get_dom_snapshot",
  "get_forms",
  "get_links",
  "get_buttons",
  "capture_viewport",
  "capture_numbered_overlay",
  "scroll_to_element",
  "scroll_by",
  "wait_for_page_change"
]);

const POST_ACTION_OBSERVATION_ACTION_TYPES = new Set([
  "click_element",
  "click_overlay_number",
  "fill_field",
  "select_option",
  "toggle_checkbox",
  "set_radio",
  "go_back",
  "wait_for_page_change"
]);

const ACTION_CONTINUATION_ARTIFACT_KINDS = new Set([
  "page_observation",
  "web_search",
  "http_response",
  "screenshot"
]);

const MAX_READ_ONLY_CONTINUATIONS = 4;
const MAX_ACTION_CONTINUATIONS = 4;

function proposeMemorySave(item, responseLanguage = "en", sourceGoal = "") {
  const memoryItem = sanitizeMemoryItem(item, { goal: sourceGoal || item?.title || "" });
  state.pendingMemoryProposal = {
    id: crypto.randomUUID(),
    title: memoryItem.title,
    content: memoryItem.content,
    sourceGoal,
    responseLanguage,
    createdAt: Date.now()
  };
  state.activity.unshift(`Prepared memory preview: ${memoryItem.title}.`);
  addDebugLog("memory.proposal.created", {
    title: memoryItem.title,
    content: memoryItem.content,
    sourceGoal
  }, "Memory preview prepared.");
  state.messages.push({
    role: "assistant",
    text: formatMemoryPreview(memoryItem, responseLanguage),
    createdAt: Date.now()
  });
  persistSession();
  render();
}

async function handlePendingMemoryProposalReply(text) {
  const responseLanguage = state.pendingMemoryProposal.responseLanguage || detectUserLanguage(text);

  if (isMemoryProposalRejection(text)) {
    const title = state.pendingMemoryProposal.title;
    state.pendingMemoryProposal = null;
    state.activity.unshift(`Memory preview discarded: ${title}.`);
    state.messages.push({
      role: "assistant",
      text: "Ok, I will not save this memory.",
      createdAt: Date.now()
    });
    persistSession();
    render();
    return true;
  }

  if (!isMemoryProposalConfirmation(text)) {
    return false;
  }

  const proposal = state.pendingMemoryProposal;
  const saved = await saveUserMemory({
    title: proposal.title,
    content: proposal.content
  });
  state.pendingMemoryProposal = null;
  state.messages.push({
    role: "assistant",
    text: saved
      ? localText(responseLanguage, "memorySaved")
      : localText(responseLanguage, "memorySaveFailed"),
    createdAt: Date.now()
  });
  persistSession();
  render();
  return true;
}

function isMemoryProposalConfirmation(text) {
  return /^(si|sì|ok|okay|yes|yep|salva|salvalo|confermo|conferma|procedi|va bene|save|confirm|go ahead)$/i.test(String(text || "").trim());
}

function isMemoryProposalRejection(text) {
  return /^(no|nope|annulla|cancella|non salvare|lascia stare|cancel|discard|don't save|do not save)$/i.test(String(text || "").trim());
}

function formatMemoryPreview(item, responseLanguage = "en") {
  const title = item.title || "User memory";
  const content = item.content || "";

  return [
    "I prepared this local memory preview:",
    "",
    `**${title}**`,
    "",
    content,
    "",
    "Save it? Reply `yes` to save or `no` to cancel."
  ].join("\n");
}

function inferResearchMemoryTitle(goal) {
  const words = String(goal || "")
    .replace(/\b(remember|save|store|ricordati|salva|memorizza|aggiungi|add)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ");
  return words ? `User memory: ${words}`.slice(0, 90) : "User memory";
}

function createMemoryTitle(content) {
  const words = String(content || "").replace(/\s+/g, " ").trim().split(/\s+/).slice(0, 8).join(" ");
  return words.length > 64 ? `${words.slice(0, 61)}...` : words || "User note";
}

function buildLocalAgentResult(goal, responseLanguage) {
  const observation = state.page.observation;
  const lowerGoal = goal.toLowerCase();

  if (!observation) {
    return {
      type: "ask_user",
      question: localText(responseLanguage, "needObservation")
    };
  }

  if (/\b(captcha|password|payment|card|delete account|sign contract)\b/i.test(goal)) {
    return {
      type: "stop_for_human",
      reason: localText(responseLanguage, "humanOnly")
    };
  }

  const navigationPlan = buildNavigationPlan(goal, responseLanguage);
  if (navigationPlan) {
    return navigationPlan;
  }

  const openLinksPlan = buildRequestedOpenLinksPlan(goal, observation, responseLanguage);
  if (openLinksPlan) {
    return openLinksPlan;
  }

  const clickPlan = buildRequestedClickPlan(goal, observation, responseLanguage);
  if (clickPlan) {
    return clickPlan;
  }

  if (/\b(submit|send|accept|agree|invia|accetta|conferma|procedi)\b/i.test(lowerGoal)) {
    const finalPlan = buildFinalClickPlan(goal, observation, responseLanguage);
    if (finalPlan.actions.length > 0) {
      return finalPlan;
    }
  }

  if (/\b(fill|complete|register|apply|form|profile)\b/i.test(lowerGoal)) {
    const plan = buildFormFillPlan(goal, observation, responseLanguage);
    if (plan.actions.length > 0) {
      return plan;
    }

    return {
      type: "ask_user",
      question: localText(responseLanguage, "attachClearProfile")
    };
  }

  return {
    type: "natural_response",
    text: summarizePageForUser(observation, responseLanguage)
  };
}

function buildNavigationPlan(goal, responseLanguage) {
  const preferNewTab = shouldPreferNewTabNavigation(goal);
  const searchMatch = goal.match(/\b(?:open|apri)\s+((?:https?:\/\/)?(?:www\.)?(?:google|bing|duckduckgo|brave|yahoo)(?:\.[a-z]{2,})?)\b.*\b(?:search|cerca)\b.*["“”']([^"“”']+)["“”']/i)
    || goal.match(/\b(?:search|cerca)\b.*["“”']([^"“”']+)["“”'].*\b(?:on|su)\s+((?:https?:\/\/)?(?:www\.)?(?:google|bing|duckduckgo|brave|yahoo)(?:\.[a-z]{2,})?)/i);

  if (searchMatch) {
    const first = searchMatch[1];
    const second = searchMatch[2];
    const engine = /google|bing|duckduckgo|brave|yahoo/i.test(first) ? first : second;
    const query = engine === first ? second : first;
    const url = buildSearchUrl(engine, query.trim());
    return {
      type: "agent_plan",
      goal,
      risk_level: "low",
      summary_for_user: preferNewTab
        ? localText(responseLanguage, "openUrlInNewTab", url)
        : localText(responseLanguage, "openSearch", query.trim()),
      needs_clarification: false,
      requires_confirmation: false,
      will_submit: false,
      actions: [
        {
          id: "act_open_url_001",
          type: preferNewTab ? "open_url_new_tab" : "open_url",
          target: {
            agent_id: "",
            role: "",
            name: "",
            selector_candidates: []
          },
          value: url,
          source: {
            file_id: "",
            confidence: 1
          },
          reason: "Open the requested Google search URL."
        }
      ],
      uncertain_fields: []
    };
  }

  const explicitUrls = extractExplicitUrls(goal);
  if (/\b(open|apri|go to|vai su|naviga a)\b/i.test(goal) && explicitUrls.length > 1) {
    return buildOpenUrlsInNewTabsPlan(goal, explicitUrls, responseLanguage);
  }

  const openMatch = goal.match(/\b(?:open|apri|go to|vai su|naviga a)\s+((?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?)/i)
    || goal.match(/\b((?:https?:\/\/)[^\s]+)\b/i);
  if (!openMatch) {
    return null;
  }

  return {
    type: "agent_plan",
    goal,
    risk_level: "low",
    summary_for_user: preferNewTab
      ? localText(responseLanguage, "openUrlInNewTab", openMatch[1])
      : localText(responseLanguage, "openUrl", openMatch[1]),
    needs_clarification: false,
    requires_confirmation: false,
    will_submit: false,
    actions: [
      {
        id: "act_open_url_001",
        type: preferNewTab ? "open_url_new_tab" : "open_url",
        target: {
          agent_id: "",
          role: "",
          name: "",
          selector_candidates: []
        },
        value: openMatch[1],
        source: {
          file_id: "",
          confidence: 1
        },
        reason: "Open the requested URL."
      }
    ],
    uncertain_fields: []
  };
}

function buildSearchUrl(engine, query) {
  const host = normalizeUrlValue(engine).hostname.replace(/^www\./, "");
  const encoded = encodeURIComponent(query);

  if (host.startsWith("duckduckgo.")) return `https://duckduckgo.com/?q=${encoded}`;
  if (host.startsWith("bing.")) return `https://www.bing.com/search?q=${encoded}`;
  if (host.startsWith("brave.")) return `https://search.brave.com/search?q=${encoded}`;
  if (host.startsWith("yahoo.")) return `https://search.yahoo.com/search?p=${encoded}`;
  return `https://www.google.com/search?q=${encoded}`;
}

function normalizeUrlValue(value) {
  const raw = String(value || "").trim();
  return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
}

function shouldPreferNewTabNavigation(goal) {
  const text = String(goal || "");

  if (/\b(new tab|background tab|keep this page|keep current page|without leaving this page|don'?t leave this page|open in tab)\b/i.test(text)) {
    return true;
  }

  if (/\b(nuova tab|nuova scheda|in scheda separata|senza lasciare questa pagina|mantieni questa pagina|lascia aperta questa pagina)\b/i.test(text)) {
    return true;
  }

  if (/\b(compare|comparison|reference|references|research|look up|documentation|docs|read later)\b/i.test(text)) {
    return true;
  }

  if (/\b(confronta|confrontare|riferimento|riferimenti|ricerca|documentazione|documentazione ufficiale|leggi dopo)\b/i.test(text)) {
    return true;
  }

  return false;
}

function extractExplicitUrls(goal) {
  const matches = String(goal || "").match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s,;)]*)?/gi) || [];
  const seen = new Set();
  const urls = [];

  matches.forEach((match) => {
    const value = String(match || "").trim().replace(/[.)]+$/, "");
    if (!value || value.includes("@")) {
      return;
    }

    try {
      const normalized = normalizeUrlValue(value).href;
      if (seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      urls.push(normalized);
    } catch {
      // Ignore invalid URL-like fragments.
    }
  });

  return urls;
}

function buildOpenUrlsInNewTabsPlan(goal, urls, responseLanguage) {
  return {
    type: "agent_plan",
    goal,
    risk_level: "low",
    summary_for_user: localText(responseLanguage, "openUrlsInNewTabs", urls.length),
    needs_clarification: false,
    requires_confirmation: false,
    will_submit: false,
    actions: urls.map((url, index) => ({
      id: `act_open_new_tab_${String(index + 1).padStart(3, "0")}`,
      type: "open_url_new_tab",
      target: {
        agent_id: "",
        role: "",
        name: "",
        selector_candidates: []
      },
      value: url,
      source: {
        file_id: "",
        confidence: 1
      },
      reason: responseLanguage === "it"
        ? "L'utente ha chiesto di aprire piu' link, quindi li apro in schede separate."
        : "The user asked to open multiple links, so I am opening them in separate tabs."
    })),
    uncertain_fields: []
  };
}

function buildRequestedOpenLinksPlan(goal, observation, responseLanguage) {
  if (!/\b(open|apri)\b/i.test(goal)) {
    return null;
  }

  const requestedNames = extractQuotedElementNames(goal);
  if (requestedNames.length < 2) {
    return null;
  }

  const candidates = (observation.links || []).filter((item) => item.agent_id && item.name && item.href);
  const used = new Set();
  const matches = [];

  for (const name of requestedNames) {
    const target = findNamedElement(candidates.filter((item) => !used.has(item.agent_id)), name);
    if (!target?.href) {
      return null;
    }
    used.add(target.agent_id);
    matches.push(target);
  }

  return {
    type: "agent_plan",
    goal,
    risk_level: "low",
    summary_for_user: localText(responseLanguage, "openUrlsInNewTabs", matches.length),
    needs_clarification: false,
    requires_confirmation: false,
    will_submit: false,
    actions: matches.map((target, index) => ({
      id: `act_open_named_link_tab_${String(index + 1).padStart(3, "0")}`,
      type: "open_url_new_tab",
      target: {
        agent_id: target.agent_id,
        role: target.role || "link",
        name: target.name || "",
        selector_candidates: target.selector_candidates || []
      },
      value: target.href,
      source: {
        file_id: "current_page_observation",
        confidence: 0.9
      },
      reason: responseLanguage === "it"
        ? "L'utente ha chiesto di aprire piu' link osservati, quindi li apro in nuove schede."
        : "The user asked to open multiple observed links, so I am opening them in new tabs."
    })),
    uncertain_fields: []
  };
}

function buildRequestedClickPlan(goal, observation, responseLanguage) {
  if (!/\b(click|clicca|press|premi|open|apri)\b/i.test(goal)) {
    return null;
  }

  const wanted = extractRequestedElementName(goal);
  if (!wanted) {
    return null;
  }

  const preferNewTab = shouldPreferNewTabNavigation(goal);
  const linkCandidates = (observation.links || []).filter((item) => item.agent_id && item.name && item.href);
  const linkTarget = findNamedElement(linkCandidates, wanted);

  if (preferNewTab && linkTarget?.href) {
    return {
      type: "agent_plan",
      goal,
      risk_level: "low",
      summary_for_user: localText(responseLanguage, "openUrlInNewTab", linkTarget.href),
      needs_clarification: false,
      requires_confirmation: false,
      will_submit: false,
      actions: [
        {
          id: "act_open_named_link_new_tab_001",
          type: "open_url_new_tab",
          target: {
            agent_id: linkTarget.agent_id,
            role: linkTarget.role || "link",
            name: linkTarget.name || "",
            selector_candidates: linkTarget.selector_candidates || []
          },
          value: linkTarget.href,
          source: {
            file_id: "current_page_observation",
            confidence: 0.9
          },
          reason: responseLanguage === "it"
            ? "Apro il link richiesto in una nuova scheda per preservare la pagina corrente."
            : "Open the requested link in a new tab to preserve the current page."
        }
      ],
      uncertain_fields: []
    };
  }

  const candidates = [
    ...(observation.links || []),
    ...(observation.buttons || []),
    ...(observation.interactive_elements || []).filter((item) => ["button", "link", "textbox"].includes(item.role))
  ].filter((item) => item.agent_id && item.name);

  const target = findNamedElement(candidates, wanted);
  if (!target) {
    return null;
  }

  return {
    type: "agent_plan",
    goal,
    risk_level: "low",
    summary_for_user: responseLanguage === "it"
      ? `Apro l'elemento "${target.name}".`
      : `I will open "${target.name}".`,
    needs_clarification: false,
    requires_confirmation: false,
    will_submit: false,
    actions: [
      {
        id: "act_click_named_001",
        type: "click_element",
        target: {
          agent_id: target.agent_id,
          role: target.role || "",
          name: target.name || "",
          selector_candidates: target.selector_candidates || []
        },
        value: "",
        source: {
          file_id: "current_page_observation",
          confidence: 0.86
        },
        reason: responseLanguage === "it"
          ? "L'utente ha chiesto esplicitamente di cliccare questo elemento visibile."
          : "The user explicitly asked to click this visible element."
      }
    ],
    uncertain_fields: []
  };
}

function extractRequestedElementName(goal) {
  const text = String(goal || "").trim();
  const quoted = text.match(/["'“”](.+?)["'“”]/)?.[1];
  if (quoted) return quoted.trim();

  const patterns = [
    /\b(?:link|button|pulsante|elemento)\s+(?:di|con scritto|named|called|labeled|etichettato)\s+(.+)$/i,
    /\b(?:click|clicca|press|premi|open|apri)\s+(?:on|su|il|la|lo|l'|the)?\s*(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/\b(link|button|pulsante|elemento)$/i, "").trim();
    }
  }

  return "";
}

function extractQuotedElementNames(goal) {
  return [...String(goal || "").matchAll(/["'â€œâ€](.+?)["'â€œâ€]/g)]
    .map((match) => String(match[1] || "").trim())
    .filter(Boolean);
}

function findNamedElement(candidates, wanted) {
  const normalizedWanted = normalizeElementName(wanted);
  if (!normalizedWanted) {
    return null;
  }

  return candidates.find((item) => normalizeElementName(item.name) === normalizedWanted)
    || candidates.find((item) => normalizeElementName(item.name).includes(normalizedWanted))
    || candidates.find((item) => normalizedWanted.includes(normalizeElementName(item.name)));
}

function normalizeElementName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildFinalClickPlan(goal, observation, responseLanguage) {
  const candidates = [
    ...(observation.buttons || []),
    ...(observation.interactive_elements || []).filter((item) => item.role === "button" || item.role === "link")
  ];
  const target = candidates.find((item) => /\b(submit|send|publish|accept|agree|continue|confirm|invia|accetta|conferma|procedi)\b/i.test(item.name || ""));

  if (!target) {
    return {
      type: "agent_plan",
      goal,
      risk_level: "high",
      summary_for_user: localText(responseLanguage, "noSubmitControl"),
      needs_clarification: true,
      requires_confirmation: true,
      will_submit: true,
      actions: [],
      uncertain_fields: []
    };
  }

  return {
    type: "agent_plan",
    goal,
    risk_level: "high",
    summary_for_user: localText(responseLanguage, "submitFound", target.name),
    needs_clarification: false,
    requires_confirmation: true,
    will_submit: true,
    actions: [
      {
        id: "act_submit_001",
        type: "click_element",
        target: {
          agent_id: target.agent_id,
          role: target.role,
          name: target.name,
          selector_candidates: target.selector_candidates || []
        },
        reason: "User requested a final submit or accept action."
      }
    ],
    uncertain_fields: []
  };
}

function buildFormFillPlan(goal, observation, responseLanguage) {
  const facts = extractAttachmentFacts();
  const actions = [];
  const uncertainFields = [];
  const fields = observation.forms.flatMap((form) => form.fields.map((field) => ({ ...field, formTitle: form.title })));

  for (const field of fields) {
    if (field.disabled || isSensitiveField(field)) {
      uncertainFields.push({
        field: field.name || field.agent_id,
        reason: "Sensitive or disabled fields require human handling."
      });
      continue;
    }

    const value = findFactForField(field, facts);
    if (value == null || value === "") {
      continue;
    }

    const actionType = getFillActionType(field);
    if (!actionType) {
      continue;
    }

    actions.push({
      id: `act_${String(actions.length + 1).padStart(3, "0")}`,
      type: actionType,
      target: {
        agent_id: field.agent_id,
        role: field.role,
        name: field.name,
        selector_candidates: field.selector_candidates || []
      },
      value,
      source: {
        file_id: "local_attachments",
        confidence: 0.72
      },
      reason: `Matched "${field.name}" with local attachment context.`
    });
  }

  return {
    type: "agent_plan",
    goal,
    risk_level: "medium",
    summary_for_user: localText(responseLanguage, "fillSummary", actions.length),
    needs_clarification: false,
    requires_confirmation: true,
    will_submit: false,
    actions,
    uncertain_fields: uncertainFields
  };
}

function extractAttachmentFacts() {
  const facts = new Map();

  for (const attachment of state.attachments) {
    const text = attachment.text || "";
    const lines = text.split(/\r?\n/).slice(0, 800);

    for (const line of lines) {
      const match = line.match(/^\s*([^:,\t=]{2,80})\s*[:=\t,]\s*(.{1,500})\s*$/);
      if (match) {
        facts.set(normalizeKey(match[1]), match[2].trim());
      }
    }

    const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    if (email) facts.set("email", email);

    const website = text.match(/https?:\/\/[^\s)]+/i)?.[0];
    if (website) facts.set("website", website);

    const phone = text.match(/(?:\+?\d[\d .()-]{7,}\d)/)?.[0];
    if (phone) facts.set("phone", phone.trim());
  }

  return facts;
}

function findFactForField(field, facts) {
  const name = normalizeKey(field.name);
  const aliases = [
    name,
    name.replace("company", "organization"),
    name.replace("organization", "company"),
    name.replace("e mail", "email"),
    name.replace("phone number", "phone"),
    name.replace("telephone", "phone"),
    name.replace("web site", "website")
  ];

  for (const alias of aliases) {
    if (facts.has(alias)) return facts.get(alias);
  }

  for (const [key, value] of facts) {
    if (name.includes(key) || key.includes(name)) {
      return value;
    }
  }

  return null;
}

function getFillActionType(field) {
  if (field.role === "combobox" || field.tag === "select") return "select_option";
  if (field.role === "checkbox" || field.type === "checkbox") return "toggle_checkbox";
  if (field.role === "radio" || field.type === "radio") return "set_radio";
  if (field.role === "textbox" || ["text", "email", "tel", "url", "textarea"].includes(field.type)) return "fill_field";
  return null;
}

function isSensitiveField(field) {
  return /\b(password|card|cvv|cvc|tax|vat|passport|identity|health|medical|legal representative|ssn)\b/i.test(`${field.name} ${field.type} ${field.nearby_text}`);
}

function summarizePageForUser(observation, responseLanguage) {
  const headings = (observation.headings || []).map((heading) => heading.text).filter(Boolean).slice(0, 5);
  const fieldCount = observation.forms.reduce((total, form) => total + form.fields.length, 0);
  const headingText = headings.length ? ` Main sections: ${headings.join("; ")}.` : "";
  if (responseLanguage === "it") {
    const italianHeadingText = headings.length ? ` Sezioni principali: ${headings.join("; ")}.` : "";
    return `Ho osservato la pagina: ${observation.links.length} link, ${observation.buttons.length} pulsanti e ${fieldCount} campi modulo.${italianHeadingText}`;
  }
  return `I observed the page: ${observation.links.length} links, ${observation.buttons.length} buttons, and ${fieldCount} form fields.${headingText}`;
}

function summarizeObservation(observation) {
  const fieldCount = observation.forms.reduce((total, form) => total + form.fields.length, 0);
  return `${observation.links.length} links, ${observation.buttons.length} buttons, ${fieldCount} fields, and ${observation.visible_text.length} characters of visible text captured.`;
}

function summarizeHttpArtifact(artifact) {
  const preview = formatHttpBodyPreview(artifact);
  const headerLines = Object.entries(artifact.headers || {})
    .filter(([key]) => ["content-type", "server", "location", "cache-control", "x-robots-tag"].includes(key.toLowerCase()))
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const isError = Number(artifact.statusCode) >= 400;

  const lines = [
    `${isError ? "HTTP request failed" : "HTTP response"}: ${artifact.statusCode} ${artifact.finalUrl || artifact.url}`,
    artifact.contentType ? `Content-Type: ${artifact.contentType}` : "",
    headerLines ? `Headers:\n${headerLines}` : "",
    preview ? `Body preview:\n${preview}` : ""
  ].filter(Boolean);

  if (isError && !preview) {
    lines.push("The server returned an error response, so no useful page text was available.");
  }

  return lines.join("\n\n");
}

function formatHttpBodyPreview(artifact) {
  const body = String(artifact.bodyPreview || "").trim();
  const contentType = String(artifact.contentType || "").toLowerCase();

  if (!body) {
    return "";
  }

  if (Number(artifact.statusCode) >= 400 && /<html|<!doctype html/i.test(body)) {
    return "";
  }

  if (contentType.includes("html") || /<html|<!doctype html|<body/i.test(body)) {
    return stripHtml(body).slice(0, 1200);
  }

  return body.slice(0, 1200);
}

async function maybeSynthesizeResults(plan, results) {
  const hasResearchArtifact = results.some((result) => ["web_search", "http_response", "page_observation"].includes(result.artifact?.kind));

  if (!hasResearchArtifact || state.connector.status !== "connected") {
    addDebugLog("provider.synthesis.skipped", {
      hasResearchArtifact,
      connectorStatus: state.connector.status,
      resultKinds: results.map((result) => result.artifact?.kind || result.status)
    }, "Synthesis skipped.");
    return "";
  }

  const lastUserMessage = [...state.messages].reverse().find((message) => message.role === "user")?.text || plan.goal || "";
  const selectedHttpProvider = getSelectedHttpProvider();
  const latestObservation = compactObservationForProvider(getLatestObservationFromResults(results));
  const payload = {
    goal: lastUserMessage,
    responseLanguage: detectUserLanguage(lastUserMessage),
    provider: state.codex.provider,
    model: state.codex.model,
    httpProvider: selectedHttpProvider,
    observation: latestObservation,
    userMemory: state.userMemory.items.map((item) => ({
      id: item.id,
      title: item.title,
      content: item.content,
      updatedAt: item.updatedAt
    })),
    results: results.map(stripLargeArtifactsForSynthesis)
  };
  addDebugLog("provider.synthesis.start", payload, `${state.codex.provider} / ${state.codex.model}`);
  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.SYNTHESIS_REQUEST, payload));
  addDebugLog("provider.synthesis.end", {
    ok: response.ok,
    error: response.error || "",
    result: response.envelope?.payload || null
  }, response.ok ? "Synthesis response received." : response.error);

  if (!response.ok) {
    state.activity.unshift(`Synthesis failed: ${response.error}`);
    return "";
  }

  return response.envelope.payload?.text || "";
}

function stripLargeArtifactsForSynthesis(result) {
  if (result.artifact?.kind === "http_response") {
    return {
      ...result,
      artifact: {
        ...result.artifact,
        bodyPreview: formatHttpBodyPreview(result.artifact).slice(0, 4000)
      }
    };
  }

  if (result.artifact?.kind === "screenshot") {
    return {
      ...result,
      artifact: {
        kind: "screenshot",
        ocrText: String(result.artifact.ocrText || "").slice(0, 4000)
      }
    };
  }

  return result;
}

function getArtifactSummary(artifact) {
  if (artifact.kind === "web_search") {
    return `Search results: ${artifact.query}`;
  }

  if (artifact.kind === "http_response") {
    return `HTTP ${artifact.statusCode}: ${artifact.finalUrl || artifact.url}`;
  }

  if (artifact.kind === "page_observation") {
    return "Page observation captured";
  }

  return "Tool artifact";
}

function getArtifactDetails(artifact) {
  if (artifact.kind === "web_search") {
    return (artifact.results || []).slice(0, 8).map((result, index) => `${index + 1}. ${result.title} - ${result.url}${result.snippet ? ` - ${result.snippet}` : ""}`);
  }

  if (artifact.kind === "http_response") {
    return summarizeHttpArtifact(artifact).split("\n").filter(Boolean).slice(0, 16);
  }

  if (artifact.kind === "page_observation") {
    const observation = artifact.observation;
    return [
      observation?.tab?.title || "Untitled page",
      `${observation?.links?.length || 0} links`,
      `${observation?.buttons?.length || 0} buttons`,
      `${observation?.visible_text?.length || 0} visible text characters`
    ];
  }

  if (artifact.kind === "screenshot") {
    return [
      "Viewport screenshot captured.",
      artifact.ocrText ? `OCR text: ${artifact.ocrText.slice(0, 600)}` : "No OCR text was extracted from the viewport."
    ];
  }

  return [];
}

function extractGoogleDocId(url) {
  try {
    const parsed = new URL(url || "");
    if (parsed.hostname !== "docs.google.com") {
      return "";
    }

    return parsed.pathname.match(/\/document\/d\/([^/]+)/)?.[1] || "";
  } catch {
    return "";
  }
}

function cleanFetchedText(body, contentType) {
  const raw = String(body || "");
  if (!raw) {
    return "";
  }

  if (/html/i.test(contentType) || /^\s*</.test(raw)) {
    return stripHtml(raw);
  }

  return raw.replace(/\s+/g, " ").trim();
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function getExecutionSummary(results) {
  const total = results.length;
  const failures = results.filter((result) => result.status !== "success");

  if (total === 0) {
    return "No browser actions were returned.";
  }

  if (failures.length > 0) {
    const failedCount = failures.length;
    const firstFailure = compact(failures[0]?.log_message || "");
    const detail = firstFailure ? ` First issue: ${firstFailure}` : "";
    return `${total - failedCount} of ${total} action${total === 1 ? "" : "s"} completed. ${failedCount} need${failedCount === 1 ? "s" : ""} attention; see the expandable action details above.${detail}`;
  }

  return "The browser actions were completed.";
}

function summarizeSearchArtifact(artifact) {
  const results = artifact.results || [];
  const lines = results.slice(0, 6).map((result, index) => {
    const snippet = result.snippet ? ` - ${result.snippet}` : "";
    return `${index + 1}. ${result.title}\n${result.url}${snippet}`;
  });

  return [`Search results for "${artifact.query}"`, ...lines].join("\n\n");
}

async function restoreSession() {
  const stored = await chrome.storage.local.get(["browserCompanionSession", "browserCompanionTheme"]);
  const session = stored.browserCompanionSession;
  const selectedProvider = state.codex.provider;
  const selectedModel = state.codex.model;
  state.theme = stored.browserCompanionTheme || "system";

  if (!session?.privacy?.persistSession) {
    state.privacy.persistSession = true;
    return;
  }

  state.privacy = session.privacy;
  state.codex = {
    provider: "openai-codex",
    model: "gpt-5.5",
    ...(session.codex || {})
  };
  state.codex.provider = selectedProvider;
  state.codex.model = selectedModel;
  state.attachments = session.attachments || [];
  state.messages = session.messages || state.messages;
  state.actionNotes = session.actionNotes || [];
  state.accessibleTabs = session.accessibleTabs || {};
  state.sessionApprovals = Array.isArray(session.sessionApprovals) ? session.sessionApprovals : [];
  state.activity = session.activity || [];
  state.debugLogs = session.debugLogs || [];
  state.pendingMemoryProposal = session.pendingMemoryProposal || null;
}

async function restoreProviderSettings() {
  const stored = await chrome.storage.local.get(["browserCompanionProviderSettings"]);
  const settings = stored.browserCompanionProviderSettings || {};
  state.httpProviders = Array.isArray(settings.httpProviders)
    ? settings.httpProviders.map((provider) => ({
      ...provider,
      useStreaming: Boolean(provider.useStreaming),
      maxTokens: sanitizePositiveInteger(provider.maxTokens, HTTP_PROVIDER_DEFAULT_MAX_TOKENS, HTTP_PROVIDER_DEFAULT_MAX_TOKENS),
      retryMaxTokens: sanitizePositiveInteger(provider.retryMaxTokens, HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS, HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS),
      timeoutMs: sanitizePositiveInteger(provider.timeoutMs, HTTP_PROVIDER_DEFAULT_TIMEOUT_MS, HTTP_PROVIDER_DEFAULT_TIMEOUT_MS, 1000)
    }))
    : [];
  state.codex = {
    ...state.codex,
    ...(settings.selectedProvider ? { provider: settings.selectedProvider } : {}),
    ...(settings.selectedModel ? { model: settings.selectedModel } : {})
  };
  state.connector.providers = normalizeProviderStatuses(state.connector.providers);
}

async function persistProviderSettings() {
  await chrome.storage.local.set({
    browserCompanionProviderSettings: {
      httpProviders: state.httpProviders,
      selectedProvider: state.codex.provider,
      selectedModel: state.codex.model
    }
  });
}

function persistConnectorSelection() {
  persistSession();
  persistProviderSettings().catch((error) => {
    state.activity.unshift(`Provider selection could not be saved: ${error.message || error}`);
  });
}

function persistSession() {
  if (!state.privacy.persistSession) {
    chrome.storage.local.remove("browserCompanionSession");
    return;
  }

  chrome.storage.local.set({
    browserCompanionSession: {
      privacy: state.privacy,
      codex: state.codex,
      attachments: state.attachments,
      messages: state.messages.slice(-30),
      actionNotes: state.actionNotes.slice(-80),
      accessibleTabs: Object.fromEntries(Object.entries(state.accessibleTabs || {}).slice(0, 12)),
      sessionApprovals: state.sessionApprovals.slice(-60),
      activity: state.activity.slice(0, 80),
      debugLogs: state.debugLogs.slice(0, 200),
      pendingMemoryProposal: state.pendingMemoryProposal
    }
  });
}

function clearAttachments() {
  state.attachments = [];
  state.activity.unshift("Attachments cleared from local session memory.");
  persistSession();
  render();
}

function removeAttachment(id) {
  const file = state.attachments.find((attachment) => attachment.id === id);
  state.attachments = state.attachments.filter((attachment) => attachment.id !== id);
  state.activity.unshift(file ? `Removed attachment ${file.name}.` : "Removed attachment.");
  persistSession();
  render();
}

function clearSession() {
  state.attachments = [];
  state.messages = [
    {
      role: "assistant",
      text: "Local session cleared. Tell me what you want to accomplish on the current page.",
      createdAt: Date.now()
    }
  ];
  state.pendingPlan = null;
  state.pendingPolicy = null;
  state.pendingMemoryProposal = null;
  state.pendingMemoryIntent = null;
  state.sessionApprovals = [];
  state.confirmationText = "";
  state.actionNotes = [];
  state.debugLogs = [];
  state.activity = ["Local session cleared."];
  chrome.storage.local.remove("browserCompanionSession");
  render();
}

function sendRuntimeMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function getConnectorClass() {
  if (state.connector.status === "connected") return "ok";
  if (state.connector.status === "unknown" || state.connector.status === "connecting") return "neutral";
  return "warn";
}

function getConnectorStatusLabel() {
  if (state.connector.status !== "connected") {
    return state.connector.status;
  }

  const provider = getSelectedProviderStatus();
  const name = provider?.label || "Provider";
  return `${name} connected`;
}

function getHighestRisk(policy) {
  const order = ["low", "medium", "high", "sensitive", "blocked"];
  return (policy?.results || []).reduce((highest, result) => {
    return order.indexOf(result.risk) > order.indexOf(highest) ? result.risk : highest;
  }, "low");
}

function getConfirmationLabel(risk, policy) {
  if (!policy?.requiresConfirmation) return "Ready";
  if (risk === "high") return "Explicit final-action confirmation required";
  if (risk === "sensitive") return "Sensitive data confirmation required";
  if (risk === "blocked") return "Blocked by policy";
  return "Confirmation required";
}

function getRequiredConfirmationPhrase(risk, plan) {
  if (risk === "sensitive") return "CONFIRM SENSITIVE";
  if (plan?.will_submit || risk === "high") return "";
  return "CONFIRM";
}

function getConfirmButtonText(risk, plan) {
  if (risk === "sensitive") return "Confirm Sensitive Action";
  if (plan?.will_submit || risk === "high") return "Submit / Accept";
  return "Confirm";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function compact(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectUserLanguage(text) {
  if (/[àèéìòù]/i.test(text)
    || /\b(cosa|cos'hai|quindi|secondo|ruolo|bene|analisi|valutare|profilo|trovato|vedi|compila|invia|accetta|pagina|campo|allega|modulo|devo|devi|doevi|dovevi|puoi|voglio|questa|questo|qui|scheda|tab|candidatura|candidarmi|presentare|offerta|lavoro|adatto|adatta|continua|dunque|ricordati|salva|memorizza|ciao|chi|sei|sono|funzioni)\b/i.test(text)) {
    return "it";
  }

  return "en";
}

function localText(language, key, value) {
  const messages = {
    en: {
      needObservation: "I need to observe the current tab before I can help with that page.",
      humanOnly: "This request touches a human-only or sensitive flow, so I will stop instead of automating it.",
      attachClearProfile: "I found form context, but I could not confidently match attachment data to fields. Attach a text, CSV, JSON, Markdown, PDF, DOCX, XLSX, or image file with clear labels.",
      noSubmitControl: "I could not find a submit or accept control on the observed page.",
      submitFound: `I found "${value}". This may submit, accept, send, or finalize something on the website. Use the confirm button when you want to continue.`,
      fillSummary: `I can fill ${value} non-sensitive field${value === 1 ? "" : "s"} from local attachment context. I will not submit the form.`,
      openUrl: `I will open ${value}.`,
      openUrlInNewTab: `I will open ${value} in a new tab.`,
      openUrlsInNewTabs: `I will open ${value} link${value === 1 ? "" : "s"} in new tabs.`,
      openSearch: `I will open Google search results for "${value}".`,
      memorySaved: "Saved that to local user memory.",
      memorySaveFailed: "I could not save that to local user memory."
    }
  };

  return messages.en[key];
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
