import { MESSAGE_TYPES, makeEnvelope } from "../shared/messages.js";
import {
  EXTERNAL_DEBUG_LOGS_KEY,
  clearExternalDebugLogs,
  mergeDebugLogs,
  normalizeDebugLogs
} from "../shared/debug-log.js";
import { renderRichText } from "../shared/markdown.js";
import { prefixUserMessageWithTimestamp } from "../shared/runtime-log.js";
import {
  DEEP_SEARCH_STORAGE_KEY,
  createDeepSearchRun,
  normalizeDeepSearchRun,
  upsertDeepSearchRunList
} from "../shared/deep-search.js";

const HTTP_PROVIDER_DEFAULT_MAX_TOKENS = 24576;
const HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS = 49152;
const HTTP_PROVIDER_DEFAULT_TIMEOUT_MS = 0;
const HTTP_PROVIDER_DEFAULT_PLANNER_ENABLED = false;
const HTTP_PROVIDER_LEGACY_TIMEOUT_MS = 360000;
const HTTP_PROVIDER_KIND_OPENAI = "openai-compatible";
const HTTP_PROVIDER_KIND_CLOUDFLARE = "cloudflare-workers-ai";
const GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const GEMINI_NANO_PROVIDER_ID = "chrome-gemini-nano";
const GEMINI_NANO_MODEL_ID = "gemini-nano";

function createEmptyTaskMemory() {
  return {
    rootGoal: "",
    currentGoal: "",
    goals: [],
    constraints: [],
    explored: [],
    findings: [],
    deadEnds: [],
    nextSteps: [],
    updatedAt: ""
  };
}

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
  sidebarContext: {
    windowId: null,
    tabId: null
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
  recentActions: [],
  accessibleTabs: {},
  taskMemory: createEmptyTaskMemory(),
  linkReferences: {
    nextId: 1,
    byUrl: {},
    byRef: {},
    updatedAt: ""
  },
  pendingPlan: null,
  pendingPlanContext: null,
  pendingPolicy: null,
  pendingActionSelection: [],
  pendingPermissionRequest: null,
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
    providerKind: HTTP_PROVIDER_KIND_OPENAI,
    baseUrl: "",
    accountId: "",
    token: "",
    authType: "none",
    username: "",
    password: "",
    model: "",
    useStreaming: false,
    plannerEnabled: HTTP_PROVIDER_DEFAULT_PLANNER_ENABLED,
    maxTokens: HTTP_PROVIDER_DEFAULT_MAX_TOKENS,
    retryMaxTokens: HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS,
    timeoutMs: HTTP_PROVIDER_DEFAULT_TIMEOUT_MS
  },
  geminiNano: {
    availability: "unknown",
    downloadProgress: null,
    message: "Chrome Gemini Nano availability has not been checked."
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
  composerMode: "chat",
  composerDraft: "",
  outboundQueue: [],
  isProcessingQueue: false,
  stopProcessingRequested: false,
  stopRequestInFlight: false,
  currentProcessingMessageId: null,
  pendingSteeredMessageId: null,
  liveThinking: null,
  liveThinkingOpen: false,
  chatAtBottom: true,
  activity: [],
  debugLogs: [],
  externalDebugLogs: []
};

const app = document.getElementById("app");
let connectorCheckInFlight = false;
let connectorRefreshTimer = null;
let connectorAutoRefreshTimer = null;
let devWatchPollTimer = null;
let devWatchPollInFlight = false;
let devWatchFingerprint = "";
let devWatchInitialized = false;

const PROVIDER_VISIBLE_TEXT_LIMIT = 5000;
const PROVIDER_FULL_OBSERVATION_TEXT_LIMIT = 7000;
const PROVIDER_ELEMENT_LIMIT = 24;
const PROVIDER_FULL_OBSERVATION_ELEMENT_TOTAL_LIMIT = 80;
const PROVIDER_FORM_LIMIT = 8;
const PROVIDER_FIELD_LIMIT = 12;
const PROVIDER_SELECTOR_LIMIT = 3;
const PROVIDER_VISIBLE_TEXT_HEAD_RATIO = 0.65;
const PROVIDER_CONVERSATION_CONTEXT_LIMIT = 8;
const PROVIDER_CONVERSATION_TEXT_LIMIT = 1200;
const PROVIDER_RECENT_ACTION_LIMIT = 8;
const PROVIDER_RECENT_TAB_LIMIT = 8;
const PROVIDER_SECTION_LIMIT = 8;
const PROVIDER_STRUCTURED_ITEM_LIMIT = 18;
const PROVIDER_FOCUSED_CONTEXT_LIMIT = 10;
const PROVIDER_FOCUSED_CONTEXT_COMPACT_LIMIT = 5;
const PROVIDER_FOCUSED_CONTEXT_TEXT_LIMIT = 2600;
const PROVIDER_FOCUSED_CONTEXT_TEXT_COMPACT_LIMIT = 1200;
const PROVIDER_RECENT_REFERENCE_LIMIT = 8;
const PROVIDER_COMPACT_VISIBLE_TEXT_LIMIT = 2200;
const PROVIDER_COMPACT_ELEMENT_LIMIT = 8;
const PROVIDER_COMPACT_FORM_LIMIT = 3;
const PROVIDER_COMPACT_FIELD_LIMIT = 4;
const PROVIDER_COMPACT_STRUCTURED_ITEM_LIMIT = 8;
const PROVIDER_COMPACT_CONTENT_BLOCK_LIMIT = 6;
const TASK_MEMORY_GOAL_LIMIT = 8;
const TASK_MEMORY_CONSTRAINT_LIMIT = 10;
const TASK_MEMORY_EXPLORED_LIMIT = 18;
const TASK_MEMORY_FINDING_LIMIT = 8;
const TASK_MEMORY_DEAD_END_LIMIT = 8;
const TASK_MEMORY_NEXT_STEP_LIMIT = 8;
const TASK_MEMORY_TEXT_LIMIT = 360;
const TASK_MEMORY_BRIEF_SECTION_LIMIT = 4;
const LINK_REFERENCE_LIMIT = 160;
const LINK_REFERENCE_PROVIDER_LIMIT = 80;
const LINK_REFERENCE_TEXT_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const systemThemeMediaQuery = typeof window?.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;

initialize();

async function initialize() {
  await restoreProviderSettings();
  await restoreSession();
  await captureSidebarContext();
  await refreshAccessibleTabsState();
  applyTheme();
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  chrome.storage.onChanged.addListener(handleStorageChange);
  chrome.tabs.onRemoved.addListener(handleTabRemoved);
  render();
  checkConnector();
  loadUserMemory();
  startConnectorAutoRefreshPolling();
  startDevAutoReloadPolling();
  window.addEventListener("visibilitychange", handleDocumentVisibilityChange);
  window.addEventListener("focus", handleWindowFocus);
  systemThemeMediaQuery?.addEventListener?.("change", handleSystemThemeChange);
  window.addEventListener("beforeunload", stopConnectorAutoRefreshPolling, { once: true });
  window.addEventListener("beforeunload", stopDevAutoReloadPolling, { once: true });
}

function render(options = {}) {
  const chatViewportState = captureChatViewportState();
  const preserveComposer = options.preserveComposer !== false;
  const transientInputState = preserveComposer
    ? captureTransientInputState()
    : {
        activeId: options.focusComposer ? "chat-input" : "",
        chatInput: {
          value: state.composerDraft,
          selectionStart: state.composerDraft.length,
          selectionEnd: state.composerDraft.length
        }
      };
  app.innerHTML = `
    <section class="topbar">
      <div class="brand-lockup">
        <img class="brand-mark" src="${escapeHtml(getBrandMarkSrc())}" alt="" aria-hidden="true">
        <h1><span>Browser</span><span>Companion</span></h1>
        <span class="title-line" aria-hidden="true"></span>
      </div>
      <div class="top-actions">
        <button id="open-settings-view" class="top-action icon-action" type="button" title="Settings" aria-label="Settings">&#9881;</button>
        <button id="theme-toggle" class="top-action icon-action theme-toggle" type="button" title="${escapeHtml(getThemeTitle())}" aria-label="${escapeHtml(getThemeTitle())}">${escapeHtml(getThemeIcon())}</button>
        ${renderSelectedProviderStatusBadge()}
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
        ${renderSettingsButton("logs", `Logs ${getAllDebugLogs().length}`)}
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
    ${state.pendingPermissionRequest ? renderPermissionRequestPreview() : ""}
    ${renderProviderQuotaNotice()}

    <section id="chat-log" class="chat-log" aria-label="Chat messages">
      ${renderChatTimeline()}
    </section>
    <button id="jump-to-latest" class="jump-to-latest" type="button" title="Jump to latest message" aria-label="Jump to latest message" ${state.chatAtBottom ? "hidden" : ""}>&#8595;</button>

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
  restoreChatViewportState(chatViewportState);
  const checkConnectorButton = document.getElementById("check-connector");
  if (checkConnectorButton) checkConnectorButton.addEventListener("click", checkConnector);
  const connectCodexButton = document.getElementById("connect-codex");
  if (connectCodexButton) connectCodexButton.addEventListener("click", () => connectProvider(state.codex.provider));
  document.querySelectorAll("[data-connect-provider]").forEach((button) => {
    button.addEventListener("click", () => connectProvider(button.dataset.connectProvider));
  });
  document.querySelectorAll("[data-logout-provider]").forEach((button) => {
    button.addEventListener("click", () => logoutProvider(button.dataset.logoutProvider));
  });
  document.querySelectorAll("[data-install-provider]").forEach((button) => {
    button.addEventListener("click", () => installProvider(button.dataset.installProvider));
  });
  document.querySelectorAll("[data-download-gemini-nano]").forEach((button) => {
    button.addEventListener("click", downloadGeminiNano);
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
  const httpProviderKind = document.getElementById("http-provider-kind");
  if (httpProviderKind) httpProviderKind.addEventListener("change", handleHttpProviderKindChange);
  const httpProviderAuthType = document.getElementById("http-provider-auth-type");
  if (httpProviderAuthType) httpProviderAuthType.addEventListener("change", handleHttpProviderAuthTypeChange);
  const cloudflareAccountId = document.getElementById("http-provider-account-id");
  if (cloudflareAccountId) cloudflareAccountId.addEventListener("change", handleCloudflareAccountIdChange);
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
  document.querySelectorAll("[data-composer-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.composerMode = button.dataset.composerMode === "deep-search" ? "deep-search" : "chat";
      render();
    });
  });
  document.getElementById("attachment-input").addEventListener("change", handleAttachments);
  document.getElementById("chat-form").addEventListener("submit", handleChatSubmit);
  document.getElementById("chat-input").addEventListener("input", handleComposerInput);
  document.getElementById("chat-input").addEventListener("keydown", handleComposerKeydown);
  const stopProcessingButton = document.getElementById("stop-processing");
  if (stopProcessingButton) stopProcessingButton.addEventListener("click", stopCurrentProcessing);
  bindChatTimelineControls();

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
    document.querySelectorAll("[data-pending-action-index]").forEach((input) => {
      input.addEventListener("change", handlePendingActionSelectionChange);
    });
  }

  if (state.pendingPermissionRequest) {
    document.getElementById("grant-permission-request").addEventListener("click", grantPendingPermissionRequest);
    document.getElementById("cancel-permission-request").addEventListener("click", cancelPendingPermissionRequest);
  }

  restoreTransientInputState(transientInputState);
}

function captureTransientInputState() {
  const activeElement = document.activeElement;
  const chatInput = document.getElementById("chat-input");

  if (chatInput) {
    state.composerDraft = chatInput.value;
  }

  return {
    activeId: activeElement?.id || "",
    chatInput: chatInput
      ? {
          value: chatInput.value,
          selectionStart: chatInput.selectionStart,
          selectionEnd: chatInput.selectionEnd
        }
      : null
  };
}

function restoreTransientInputState(snapshot) {
  const chatInput = document.getElementById("chat-input");
  if (chatInput && snapshot?.chatInput) {
    chatInput.value = snapshot.chatInput.value;
    state.composerDraft = snapshot.chatInput.value;

    if (snapshot.activeId === "chat-input") {
      chatInput.focus({ preventScroll: true });
      if (
        Number.isInteger(snapshot.chatInput.selectionStart)
        && Number.isInteger(snapshot.chatInput.selectionEnd)
      ) {
        chatInput.setSelectionRange(snapshot.chatInput.selectionStart, snapshot.chatInput.selectionEnd);
      }
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

function handleSystemThemeChange() {
  if (state.theme !== "system") {
    return;
  }

  applyTheme();
  render();
}

function getThemeIcon() {
  if (state.theme === "dark") return "☾";
  if (state.theme === "light") return "☀";
  return "◐";
}

function getThemeTitle() {
  if (state.theme === "dark") return "Theme: dark";
  if (state.theme === "light") return "Theme: light";
  return "Theme: system";
}

function getResolvedTheme() {
  if (state.theme === "dark" || state.theme === "light") {
    return state.theme;
  }

  try {
    return systemThemeMediaQuery?.matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function getBrandMarkSrc() {
  return getResolvedTheme() === "dark"
    ? "../../assets/icons/brand-dark.png"
    : "../../assets/icons/brand-light.png";
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
  if (connectorRefreshTimer) {
    clearTimeout(connectorRefreshTimer);
  }

  connectorRefreshTimer = window.setTimeout(() => {
    connectorRefreshTimer = null;
    if (connectorCheckInFlight) {
      queueConnectorRefresh();
      return;
    }
    void checkConnector();
  }, 0);
}

function startConnectorAutoRefreshPolling() {
  if (connectorAutoRefreshTimer) {
    return;
  }

  connectorAutoRefreshTimer = window.setInterval(() => {
    if (shouldAutoRefreshConnectorStatus()) {
      queueConnectorRefresh();
    }
  }, 45000);
}

function stopConnectorAutoRefreshPolling() {
  if (!connectorAutoRefreshTimer) {
    return;
  }
  clearInterval(connectorAutoRefreshTimer);
  connectorAutoRefreshTimer = null;
}

function handleDocumentVisibilityChange() {
  if (!document.hidden && shouldAutoRefreshConnectorStatus()) {
    queueConnectorRefresh();
  }
}

function handleWindowFocus() {
  if (shouldAutoRefreshConnectorStatus()) {
    queueConnectorRefresh();
  }
}

function shouldAutoRefreshConnectorStatus() {
  const provider = getSelectedProviderStatus();
  return !document.hidden
    && provider?.id === GEMINI_CLI_PROVIDER_ID
    && Boolean(provider?.connected);
}

function queueSelectedProviderUsageRefresh() {
  if (shouldAutoRefreshConnectorStatus()) {
    queueConnectorRefresh();
  }
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
    ${state.connector.providers.length ? `
      <div class="provider-list">
        ${renderProviderCards()}
      </div>
    ` : ""}
    ${renderHttpProviderSettings()}
    ${renderProviderPrerequisites()}
    ${renderConnectorSetup()}
  `;
}

function renderHttpProviderSettings() {
  const isCloudflare = isCloudflareHttpProviderDraft(state.httpProviderDraft);
  const computedBaseUrl = isCloudflare
    ? computeCloudflareWorkersAiBaseUrl(state.httpProviderDraft.accountId || "")
    : "";
  return `
    <div class="connector-help">
      <strong>OpenAI-compatible HTTP provider</strong>
      <p>Use this for a local or private server such as llama.cpp, LocalAI, LiteLLM, vLLM, a custom OpenAI-compatible proxy, or Cloudflare Workers AI. Observed page content can be sent to this URL when selected.</p>
      <form id="http-provider-form" class="memory-form">
        <div class="button-row">
          <label class="field-stack compact-field">
            <span>Provider type</span>
            <select id="http-provider-kind">
              <option value="${HTTP_PROVIDER_KIND_OPENAI}" ${state.httpProviderDraft.providerKind === HTTP_PROVIDER_KIND_OPENAI ? "selected" : ""}>Generic OpenAI-compatible</option>
              <option value="${HTTP_PROVIDER_KIND_CLOUDFLARE}" ${isCloudflare ? "selected" : ""}>Cloudflare Workers AI</option>
            </select>
          </label>
          <label class="field-stack compact-field">
            <span>Name</span>
            <input id="http-provider-name" type="text" placeholder="${isCloudflare ? "Cloudflare Workers AI" : "Name"}" value="${escapeHtml(state.httpProviderDraft.name)}">
          </label>
        </div>
        ${isCloudflare ? `
          <div class="button-row">
            <label class="field-stack compact-field">
              <span>Cloudflare Account ID</span>
              <input id="http-provider-account-id" type="text" placeholder="Account ID" value="${escapeHtml(state.httpProviderDraft.accountId || "")}">
            </label>
            <label class="field-stack compact-field">
              <span>API token</span>
              <input id="http-provider-api-token" type="password" placeholder="Workers AI API token" value="${escapeHtml(state.httpProviderDraft.token || "")}">
            </label>
          </div>
          <label class="field-stack compact-field">
            <span>Base URL</span>
            <input id="http-provider-base-url" type="url" readonly value="${escapeHtml(computedBaseUrl)}" placeholder="Generated from your Cloudflare Account ID">
          </label>
        ` : `
          <input id="http-provider-base-url" type="url" placeholder="Base URL, e.g. http://192.168.0.10:8080" value="${escapeHtml(state.httpProviderDraft.baseUrl)}">
          <label class="field-stack compact-field">
            <span>Authentication</span>
            <select id="http-provider-auth-type">
              <option value="none" ${state.httpProviderDraft.authType === "none" ? "selected" : ""}>None</option>
              <option value="basic" ${state.httpProviderDraft.authType === "basic" ? "selected" : ""}>Basic auth</option>
              <option value="bearer" ${state.httpProviderDraft.authType === "bearer" ? "selected" : ""}>Bearer token</option>
            </select>
          </label>
          ${renderHttpProviderAuthFields()}
        `}
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
            <span>Inactivity timeout (ms, 0 = disabled)</span>
            <input id="http-provider-timeout-ms" type="number" min="0" step="1000" value="${escapeHtml(String(state.httpProviderDraft.timeoutMs ?? HTTP_PROVIDER_DEFAULT_TIMEOUT_MS))}">
          </label>
        </div>
        <label class="toggle-row">
          <input id="http-provider-use-streaming" type="checkbox" ${state.httpProviderDraft.useStreaming ? "checked" : ""}>
          <span>Use streaming responses when the server supports them</span>
        </label>
        <label class="toggle-row">
          <input id="http-provider-planner-enabled" type="checkbox" ${state.httpProviderDraft.plannerEnabled ? "checked" : ""}>
          <span>Use planner mode for this provider</span>
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

function renderHttpProviderAuthFields() {
  if (state.httpProviderDraft.authType === "basic") {
    return `
      <div class="button-row">
        <input id="http-provider-username" type="text" placeholder="Basic auth username" value="${escapeHtml(state.httpProviderDraft.username || "")}">
        <input id="http-provider-password" type="password" placeholder="Basic auth password" value="${escapeHtml(state.httpProviderDraft.password || "")}">
      </div>
    `;
  }

  if (state.httpProviderDraft.authType === "bearer") {
    return `<input id="http-provider-token" type="password" placeholder="Bearer token" value="${escapeHtml(state.httpProviderDraft.token || "")}">`;
  }

  return "";
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
    provider.providerKind === HTTP_PROVIDER_KIND_CLOUDFLARE ? "Cloudflare Workers AI" : "OpenAI-compatible",
    provider.useStreaming ? "streaming on" : "",
    provider.plannerEnabled ? "planner on" : "",
    provider.maxTokens ? `max ${provider.maxTokens}` : "",
    provider.retryMaxTokens ? `retry ${provider.retryMaxTokens}` : "",
    provider.timeoutMs > 0 ? `${provider.timeoutMs} ms inactivity timeout` : "no timeout"
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
    providerKind: HTTP_PROVIDER_KIND_OPENAI,
    baseUrl: "",
    accountId: "",
    token: "",
    authType: "none",
    username: "",
    password: "",
    model: "",
    useStreaming: false,
    plannerEnabled: HTTP_PROVIDER_DEFAULT_PLANNER_ENABLED,
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

function sanitizeTimeoutMs(value, fallback, defaultValue = HTTP_PROVIDER_DEFAULT_TIMEOUT_MS) {
  const raw = String(value ?? fallback ?? defaultValue).trim();
  if (raw === "") {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultValue;
  }
  return parsed;
}

function normalizeHttpProviderKind(value) {
  return value === HTTP_PROVIDER_KIND_CLOUDFLARE ? HTTP_PROVIDER_KIND_CLOUDFLARE : HTTP_PROVIDER_KIND_OPENAI;
}

function normalizeHttpProviderAuthType(value) {
  return ["none", "basic", "bearer"].includes(value) ? value : "none";
}

function isCloudflareHttpProviderDraft(provider = {}) {
  return normalizeHttpProviderKind(provider.providerKind) === HTTP_PROVIDER_KIND_CLOUDFLARE;
}

function supportsHttpProviderUnload(provider = {}) {
  if (!provider?.baseUrl) {
    return false;
  }

  if (isCloudflareHttpProviderDraft(provider)) {
    return false;
  }

  const loadedModels = Array.isArray(provider.loadedModels) ? provider.loadedModels : [];
  return loadedModels.length > 0;
}

function computeCloudflareWorkersAiBaseUrl(accountId) {
  const normalized = String(accountId || "").trim();
  if (!normalized) {
    return "";
  }
  return `https://api.cloudflare.com/client/v4/accounts/${normalized}/ai/v1`;
}

function extractCloudflareAccountIdFromBaseUrl(baseUrl) {
  const value = String(baseUrl || "").trim();
  const match = value.match(/\/accounts\/([^/]+)\/ai\/v1\/?$/i);
  return match?.[1] || "";
}

function normalizeStoredTimeoutMs(provider = {}) {
  if (provider.timeoutConfigured === true) {
    return sanitizeTimeoutMs(provider.timeoutMs, HTTP_PROVIDER_DEFAULT_TIMEOUT_MS, HTTP_PROVIDER_DEFAULT_TIMEOUT_MS);
  }
  const parsed = Number.parseInt(String(provider.timeoutMs ?? ""), 10);
  if (parsed === HTTP_PROVIDER_LEGACY_TIMEOUT_MS) {
    return HTTP_PROVIDER_DEFAULT_TIMEOUT_MS;
  }
  return sanitizeTimeoutMs(provider.timeoutMs, HTTP_PROVIDER_DEFAULT_TIMEOUT_MS, HTTP_PROVIDER_DEFAULT_TIMEOUT_MS);
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
  const debugLogs = getAllDebugLogs();
  return `
    <div class="button-row">
      <button id="copy-logs" type="button">Copy Logs</button>
      <button id="clear-logs" type="button">Clear Logs</button>
    </div>
    <ol class="debug-log-list">
      ${debugLogs.length ? debugLogs.map(renderDebugLog).join("") : "<li>No diagnostic logs yet.</li>"}
    </ol>
  `;
}

function getAllDebugLogs() {
  return mergeDebugLogs(state.externalDebugLogs, state.debugLogs);
}

function renderDebugLog(entry) {
  const summaryText = getDebugLogSummary(entry);
  return `
    <li>
      <details>
        <summary>
          <span>${escapeHtml(entry.time || "")}</span>
          <strong>${escapeHtml(entry.event || "event")}</strong>
          ${summaryText ? `<em>${escapeHtml(summaryText)}</em>` : ""}
        </summary>
        <pre>${escapeHtml(JSON.stringify(entry.data || {}, null, 2))}</pre>
      </details>
    </li>
  `;
}

function getDebugLogSummary(entry) {
  if (entry?.event === "provider.progress") {
    const updates = Number.parseInt(String(entry?.data?.updates || 0), 10) || 0;
    if (updates > 0) {
      return `Received provider thinking progress (${updates} updates).`;
    }
  }
  return entry?.summary || "";
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
  const deepSearchMode = state.composerMode === "deep-search";
  const submitLabel = deepSearchMode
    ? "Launch"
    : (state.isProcessingQueue ? "Queue" : "Send");
  const stopButton = state.isProcessingQueue
    ? `<button id="stop-processing" type="button" class="composer-stop" title="${escapeHtml(state.stopRequestInFlight ? "Stopping" : "Stop")}" aria-label="${escapeHtml(state.stopRequestInFlight ? "Stopping" : "Stop")}" ${state.stopRequestInFlight ? "disabled" : ""}>${state.stopRequestInFlight ? "..." : "&#9632;"}</button>`
    : "";

  return `
    <div class="composer-wrap">
      <div class="composer-mode-switch" role="tablist" aria-label="Composer mode">
        <button type="button" class="composer-mode${deepSearchMode ? "" : " active"}" data-composer-mode="chat" aria-pressed="${deepSearchMode ? "false" : "true"}">Chat</button>
        <button type="button" class="composer-mode${deepSearchMode ? " active" : ""}" data-composer-mode="deep-search" aria-pressed="${deepSearchMode ? "true" : "false"}">Deep Search</button>
      </div>
      <form id="chat-form" class="composer">
        <label class="file-input file-input-icon" title="Attach file" aria-label="Attach file">
          <input id="attachment-input" type="file" multiple>
          <span aria-hidden="true">+</span>
        </label>
        <textarea id="chat-input" rows="3" placeholder="${escapeHtml(deepSearchMode ? "Describe the research goal for a report tab" : "Describe your goal on this page")}">${escapeHtml(state.composerDraft)}</textarea>
        <div class="composer-actions">
          ${stopButton}
          <button type="submit" class="composer-submit">${escapeHtml(submitLabel)}</button>
        </div>
      </form>
      ${queueLabel ? `<p class="composer-meta">${escapeHtml(queueLabel)}</p>` : ""}
    </div>
  `;
}

function setupChatScrollControls() {
  const chatLog = document.getElementById("chat-log");
  const jumpButton = document.getElementById("jump-to-latest");

  if (!chatLog || !jumpButton) {
    return;
  }

  const update = () => syncChatScrollState(chatLog, jumpButton);

  chatLog.addEventListener("scroll", update);
  jumpButton.addEventListener("click", () => {
    scrollChatLogToBottom(chatLog, "smooth");
    state.chatAtBottom = true;
    jumpButton.hidden = true;
  });

  requestAnimationFrame(() => {
    if (state.chatAtBottom) {
      scrollChatLogToBottom(chatLog);
    }
    update();
  });
}

function bindChatTimelineControls() {
  const liveThinkingDetails = document.getElementById("live-thinking-details");
  if (liveThinkingDetails) {
    liveThinkingDetails.addEventListener("toggle", () => {
      state.liveThinkingOpen = liveThinkingDetails.open;
    });
  }

  document.querySelectorAll("[data-steer-message]").forEach((button) => {
    button.addEventListener("click", () => steerQueuedMessage(button.dataset.steerMessage));
  });
}

function getActionNotePersistKey(note) {
  if (note?.id) {
    return `note:${note.id}`;
  }
  if (note?.createdAt) {
    return `note:${note.createdAt}`;
  }
  return "";
}

function getMessageThinkingPersistKey(message) {
  return `message-thinking:${message?.id || message?.createdAt || ""}`;
}

function getErrorNotePersistKey(message) {
  return `message-error:${message?.id || message?.createdAt || ""}`;
}

function getMessageTimelineKey(message) {
  return `message:${message?.id || message?.createdAt || ""}`;
}

function getActionNoteTimelineKey(note) {
  return `note:${note?.id || note?.createdAt || note?.summary || ""}`.slice(0, 240);
}

function captureOpenChatDisclosureState(chatLog) {
  if (!chatLog) {
    return new Set();
  }

  return new Set(
    Array.from(chatLog.querySelectorAll("details[data-chat-persist-key][open]"))
      .map((item) => String(item.dataset.chatPersistKey || "").trim())
      .filter(Boolean)
  );
}

function captureChatViewportState(chatLog = document.getElementById("chat-log")) {
  if (!chatLog) {
    return null;
  }

  const jumpButton = document.getElementById("jump-to-latest");
  syncChatScrollState(chatLog, jumpButton);
  const containerTop = chatLog.getBoundingClientRect().top;
  const candidates = Array.from(chatLog.querySelectorAll("[data-chat-item-key]"));
  const anchor = candidates.find((item) => item.getBoundingClientRect().bottom > containerTop + 1);

  return {
    atBottom: state.chatAtBottom,
    scrollTop: chatLog.scrollTop,
    anchorKey: String(anchor?.dataset.chatItemKey || "").trim(),
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - containerTop : 0
  };
}

function restoreChatViewportState(viewportState, chatLog = document.getElementById("chat-log"), jumpButton = document.getElementById("jump-to-latest")) {
  if (!viewportState || !chatLog) {
    return;
  }

  requestAnimationFrame(() => {
    if (viewportState.atBottom) {
      scrollChatLogToBottom(chatLog);
      state.chatAtBottom = true;
      syncChatScrollState(chatLog, jumpButton);
      return;
    }

    const anchor = viewportState.anchorKey
      ? chatLog.querySelector(`[data-chat-item-key="${escapeSelector(viewportState.anchorKey)}"]`)
      : null;

    if (anchor) {
      const containerTop = chatLog.getBoundingClientRect().top;
      const delta = anchor.getBoundingClientRect().top - containerTop - viewportState.anchorOffset;
      chatLog.scrollTop += delta;
    } else {
      chatLog.scrollTop = viewportState.scrollTop;
    }

    syncChatScrollState(chatLog, jumpButton);
  });
}

function restoreOpenChatDisclosureState(chatLog, openKeys) {
  if (!chatLog || !(openKeys instanceof Set) || !openKeys.size) {
    return;
  }

  Array.from(chatLog.querySelectorAll("details[data-chat-persist-key]")).forEach((item) => {
    const key = String(item.dataset.chatPersistKey || "").trim();
    item.open = openKeys.has(key);
  });
}

function escapeSelector(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(String(value || ""));
  }

  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function syncChatScrollState(chatLog = document.getElementById("chat-log"), jumpButton = document.getElementById("jump-to-latest")) {
  if (!chatLog || !jumpButton) {
    return;
  }

  const distanceFromBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight;
  const atBottom = distanceFromBottom < 48;
  state.chatAtBottom = atBottom;
  jumpButton.hidden = atBottom;
}

function scrollChatLogToBottom(chatLog = document.getElementById("chat-log"), behavior = "auto") {
  if (!chatLog) {
    return;
  }

  if (behavior === "smooth") {
    chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: "smooth" });
    return;
  }

  chatLog.scrollTop = chatLog.scrollHeight;
}

function refreshChatLog(options = {}) {
  const chatLog = document.getElementById("chat-log");
  if (!chatLog) {
    return false;
  }

  const jumpButton = document.getElementById("jump-to-latest");
  const preserveScroll = options.preserveScroll !== false;
  const shouldStickToBottom = options.scrollToBottom === true || state.chatAtBottom;
  const viewportState = preserveScroll
    ? captureChatViewportState(chatLog)
    : {
        atBottom: shouldStickToBottom,
        scrollTop: chatLog.scrollTop,
        anchorKey: "",
        anchorOffset: 0
      };
  const openDetails = captureOpenChatDisclosureState(chatLog);

  chatLog.innerHTML = renderChatTimeline();
  restoreOpenChatDisclosureState(chatLog, openDetails);
  bindChatTimelineControls();

  restoreChatViewportState({
    ...viewportState,
    atBottom: shouldStickToBottom
  }, chatLog, jumpButton);

  return true;
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

  const selectedPlan = getSelectedPendingPlan();
  const selectedPolicy = getSelectedPendingPolicy();
  const highestRisk = getHighestRisk(selectedPolicy);
  const needsTypedConfirmation = highestRisk === "sensitive";
  const requiredPhrase = getRequiredConfirmationPhrase(highestRisk, selectedPlan);
  const disabled = !selectedPlan?.actions?.length || !selectedPolicy?.allowed || (needsTypedConfirmation && state.confirmationText !== requiredPhrase);
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
  const itemKey = getMessageTimelineKey(message);
  const itemAttr = itemKey ? ` data-chat-item-key="${escapeHtml(itemKey)}"` : "";
  return `
    <article class="message ${message.role}"${itemAttr}>
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
  const persistKey = getErrorNotePersistKey(message);
  const persistAttr = persistKey ? ` data-chat-persist-key="${escapeHtml(persistKey)}"` : "";
  const itemKey = getMessageTimelineKey(message);
  const itemAttr = itemKey ? ` data-chat-item-key="${escapeHtml(itemKey)}"` : "";
  return `
    <div class="message-error-stack"${itemAttr}>
      <details class="action-note action-error"${persistAttr}>
        <summary>${escapeHtml(getErrorNoteSummary(message))}</summary>
        <ul>${items}</ul>
      </details>
      ${renderMessageThinking(message)}
    </div>
  `;
}

function getErrorNoteSummary(message) {
  const raw = String(message?.text || "").trim();

  if (/exceeds the available context size|exceed_context_size_error|context window|supplied context/i.test(raw)) {
    return "Provider context limit";
  }

  if (/\b524\b/.test(raw) || /timeout|timed out|aborted due to timeout/i.test(raw)) {
    return "Provider request timed out";
  }

  if (/upstream error page|HTTP provider returned \d+/i.test(raw)) {
    return "Provider upstream error";
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
  if (message.role === "assistant" && message.plannerDraft) {
    return renderPlannerDraftMessage(message);
  }
  return `<div class="message-body">${renderRichText(message.text, { allowMermaid: true })}</div>`;
}

function renderPlannerDraftMessage(message) {
  const draft = message.plannerDraft || {};
  const actionCount = Number.isFinite(draft.actionCount) ? draft.actionCount : 0;
  const actionLabel = actionCount === 1 ? "1 action" : `${actionCount} actions`;
  const actionItems = Array.isArray(draft.actionSummaries)
    ? draft.actionSummaries.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    : "";
  const raw = String(draft.raw || "").trim();
  const explanation = draft.summaryForUser
    ? `<p>${escapeHtml(draft.summaryForUser)}</p>`
    : `<p>The provider returned a planner draft outside the expected Browser Companion control-flow JSON, so Browser Companion did not execute it automatically.</p>`;
  const question = draft.question
    ? `<p class="planner-draft-question">${escapeHtml(draft.question)}</p>`
    : "";
  const draftSource = draft.draftKind === "conversational_plan"
    ? "Detected from conversational plan text."
    : (draft.detectedWrappedPlan ? "Detected in wrapped payload." : "Detected from malformed structured output.");

  return `
    <div class="message-body">
      <section class="planner-draft-card">
        <div class="planner-draft-head">
          <strong>${escapeHtml(draft.title || "Planner Draft")}</strong>
          <span class="planner-draft-badge">Not executed</span>
        </div>
        ${explanation}
        ${question}
        <p class="planner-draft-meta">${escapeHtml(`${actionLabel} detected. ${draftSource}`)}</p>
        ${actionItems ? `<ul class="planner-draft-list">${actionItems}</ul>` : ""}
        ${raw ? `<details class="planner-draft-raw"><summary>Raw planner payload</summary><pre><code>${escapeHtml(raw)}</code></pre></details>` : ""}
      </section>
    </div>
  `;
}

function renderMessageThinking(message) {
  if (message.role !== "assistant" || !String(message.thinking || "").trim()) {
    return "";
  }

  const persistKey = getMessageThinkingPersistKey(message);

  return `
    <details class="action-note message-thinking" data-chat-persist-key="${escapeHtml(persistKey)}">
      <summary>Thinking</summary>
      <div class="message-thinking-body">${renderRichText(message.thinking, { allowMermaid: true })}</div>
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
        summaryHtml: renderLiveThinkingSummary(state.liveThinking),
        details: [state.liveThinking.text],
        variant: "thinking",
        open: state.liveThinkingOpen,
        id: "live-thinking-details"
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
  const idAttr = note.id ? ` id="${escapeHtml(note.id)}"` : "";
  const persistKey = getActionNotePersistKey(note);
  const persistAttr = persistKey ? ` data-chat-persist-key="${escapeHtml(persistKey)}"` : "";
  const itemKey = getActionNoteTimelineKey(note);
  const itemAttr = itemKey ? ` data-chat-item-key="${escapeHtml(itemKey)}"` : "";
  const summary = note.summaryHtml || escapeHtml(note.summary);
  return `
    <details${idAttr}${persistAttr}${itemAttr} class="action-note${variantClass}"${openAttr}>
      <summary>${summary}</summary>
      <ul>${details}</ul>
    </details>
  `;
}

function renderLiveThinkingSummary(liveThinking) {
  const dots = liveThinking?.streaming
    ? `<span class="thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>`
    : "";
  return `Thinking${dots}`;
}

function renderActionPreview() {
  const selectedPlan = getSelectedPendingPlan();
  const policy = getSelectedPendingPolicy();
  const totalActions = Array.isArray(state.pendingPlan?.actions) ? state.pendingPlan.actions.length : 0;
  const selectedActions = Array.isArray(selectedPlan?.actions) ? selectedPlan.actions.length : 0;
  const showSelectionControls = totalActions > 1;
  const blocked = policy && !policy.allowed;
  const highestRisk = getHighestRisk(policy);
  const riskClass = getPreviewRiskClass(highestRisk, policy);
  const confirmation = getConfirmationLabel(highestRisk, policy);
  const needsTypedConfirmation = highestRisk === "sensitive";
  const canApproveSession = canOfferSessionApproval(selectedPlan, policy, state.pendingPlanContext);
  const requiredPhrase = getRequiredConfirmationPhrase(highestRisk, selectedPlan);
  const confirmDisabled = !selectedActions || blocked || (needsTypedConfirmation && state.confirmationText !== requiredPhrase);
  const approvalNote = getActionPreviewNote(highestRisk, policy, selectedPlan, totalActions);
  const disabledReason = getConfirmDisabledReason(highestRisk, policy, selectedPlan);
  const confirmTitle = confirmDisabled && disabledReason ? ` title="${escapeHtml(disabledReason)}"` : "";

  return `
    <section class="action-preview" aria-label="Action preview">
      <div class="section-title">
        <div>
          <h2>Action Preview</h2>
          <p>${escapeHtml(confirmation)}</p>
        </div>
        <span class="risk ${escapeHtml(riskClass)}">${escapeHtml(riskClass)}</span>
      </div>
      <p>${escapeHtml(state.pendingPlan.summary_for_user)}</p>
      ${showSelectionControls ? `<p class="action-selection-note">${escapeHtml(`${selectedActions} of ${totalActions} actions selected. Clear any checkbox to skip only that step.`)}</p>` : ""}
      <div class="approval-callout ${escapeHtml(approvalNote.tone)}">
        <strong>${escapeHtml(approvalNote.title)}</strong>
        <span>${escapeHtml(approvalNote.body)}</span>
      </div>
      <ul class="compact-list">
        ${state.pendingPlan.actions.map((action, index) => renderAction(action, index, showSelectionControls)).join("")}
      </ul>
      ${renderPolicyDetails(policy)}
      ${disabledReason ? `<p class="confirm-disabled-note">${escapeHtml(disabledReason)}</p>` : ""}
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
        ${canApproveSession ? `<button id="approve-plan-session" type="button" ${confirmDisabled ? "disabled" : ""}${confirmTitle}>Approve Similar for Session</button>` : ""}
        <button id="confirm-plan" class="primary-action" type="button" ${confirmDisabled ? "disabled" : ""}${confirmTitle}>${escapeHtml(getConfirmButtonText(highestRisk, state.pendingPlan))}</button>
      </div>
    </section>
  `;
}

function renderPolicyDetails(policy) {
  if (!policy?.results?.length) {
    return "";
  }

  const grouped = new Map();
  for (const result of policy.results) {
    const risk = String(result?.risk || "low");
    const reason = String(result?.reason || "").trim() || "No policy note provided.";
    const key = `${risk}::${reason}`;
    const current = grouped.get(key) || { risk, reason, count: 0 };
    current.count += 1;
    grouped.set(key, current);
  }

  return `
    <ul class="policy-list">
      ${Array.from(grouped.values()).map((entry) => `
        <li class="policy-${escapeHtml(entry.risk)}">
          <strong>${escapeHtml(entry.risk)}</strong>
          <span>${escapeHtml(entry.reason)}</span>
          ${entry.count > 1 ? `<em>${escapeHtml(`${entry.count} actions`)}</em>` : ""}
        </li>
      `).join("")}
    </ul>
  `;
}

function renderAction(action, index = -1, showSelectionControls = false) {
  const target = action.target?.name ? ` on ${action.target.name}` : "";
  const valuePreview = summarizeActionValueForPreview(action);
  const reason = String(action.reason || "").trim();
  const isSelected = !showSelectionControls || isPendingActionSelected(index);
  return `
    <li class="${!isSelected ? "action-skipped" : ""}">
      ${showSelectionControls ? `
        <label class="action-toggle">
          <input type="checkbox" data-pending-action-index="${escapeHtml(index)}" ${isSelected ? "checked" : ""}>
          <span>Run this action</span>
        </label>
      ` : ""}
      <strong>${escapeHtml(action.type)}${escapeHtml(target)}</strong>
      ${valuePreview ? `<span class="action-value-preview">${escapeHtml(valuePreview)}</span>` : ""}
      ${reason ? `<span>${escapeHtml(reason)}</span>` : ""}
    </li>
  `;
}

function summarizeActionValueForPreview(action) {
  if (!action || typeof action !== "object") {
    return "";
  }

  if (action.type === "fill_field") {
    return `Value: ${formatActionValuePreview(action.value)}`;
  }

  if (action.type === "select_option") {
    return `Select: ${formatActionValuePreview(action.value)}`;
  }

  if (action.type === "set_radio") {
    return `Choose: ${formatActionValuePreview(action.value)}`;
  }

  if (action.type === "toggle_checkbox") {
    return action.value ? "Set to: checked" : "Set to: unchecked";
  }

  if (action.type === "upload_file_to_field") {
    return "Opens the file picker for manual upload.";
  }

  if (action.type === "open_url" || action.type === "open_url_new_tab") {
    return action.value ? `URL: ${formatActionValuePreview(action.value, 180)}` : "";
  }

  return "";
}

function formatActionValuePreview(value, maxLength = 140) {
  if (value == null) {
    return "";
  }

  const text = typeof value === "string"
    ? value
    : (typeof value === "boolean" ? String(value) : JSON.stringify(value));
  const compacted = compact(String(text || ""));

  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, Math.max(24, maxLength - 3))}...`;
}

function renderPermissionRequestPreview() {
  const request = state.pendingPermissionRequest;
  const details = (request.details || []).map((line) => `<li>${escapeHtml(line)}</li>`).join("");

  return `
    <section class="action-preview" aria-label="Permission request">
      <div class="section-title">
        <div>
          <h2>Site Access Needed</h2>
          <p>${escapeHtml(request.message || "Browser Companion needs site access before continuing this action.")}</p>
        </div>
        <span class="risk medium">permission</span>
      </div>
      ${request.summary ? `<p>${escapeHtml(request.summary)}</p>` : ""}
      <ul class="compact-list">
        ${(request.origins || []).map((origin) => `<li><strong>${escapeHtml(origin)}</strong><span>Required to continue the pending browser action.</span></li>`).join("")}
      </ul>
      ${details ? `<ul class="policy-list">${details}</ul>` : ""}
      <div class="preview-actions">
        <button id="cancel-permission-request" type="button">Cancel</button>
        <button id="grant-permission-request" type="button">Grant Access and Continue</button>
      </div>
    </section>
  `;
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
    const isGeminiNano = provider.id === GEMINI_NANO_PROVIDER_ID;
    const isHttpProvider = isHttpProviderStatus(provider);
    const canDownloadGeminiNano = isGeminiNano && ["downloadable", "downloading"].includes(provider.status);
    const connectButton = isGeminiNano || isHttpProvider
      ? ""
      : (provider.installed ? `<button type="button" data-connect-provider="${escapeHtml(provider.id)}">${canConnect ? "Connect" : "Reconnect"}</button>` : "");
    const logoutButton = !isGeminiNano && !isHttpProvider && provider.installed
      ? `<button type="button" data-logout-provider="${escapeHtml(provider.id)}">Logout</button>`
      : "";
    const installButtons = provider.installed || isGeminiNano
      ? ""
      : `
          <button type="button" data-copy-provider-command="${escapeHtml(provider.id)}">Copy Command</button>
          <button type="button" data-install-provider="${escapeHtml(provider.id)}">Install ${escapeHtml(provider.label)}</button>
        `;
    const downloadButton = canDownloadGeminiNano
      ? `<button type="button" data-download-gemini-nano="${escapeHtml(provider.id)}">${provider.status === "downloading" ? "Continue Download" : "Download Model"}</button>`
      : "";

    return `
      <article class="provider-card${selected}">
        <div>
          <strong>${escapeHtml(provider.label)}</strong>
          <span class="provider-status">${escapeHtml(status)}</span>
          <p>${escapeHtml(provider.message || "")}</p>
          ${provider.modelDiscovery?.message ? `<p class="memory-path">${escapeHtml(provider.modelDiscovery.message)}</p>` : ""}
          ${provider.models?.length ? `<p class="memory-path">Models: ${escapeHtml(provider.models.join(", "))}</p>` : ""}
          ${provider.installCommand && !provider.installed ? `<code>${escapeHtml(provider.installCommand || "")}</code>` : ""}
        </div>
        <div class="provider-actions">
          ${connectButton}
          ${logoutButton}
          ${downloadButton}
          ${installButtons}
        </div>
      </article>
    `;
  }).join("");
}

function renderSelectedProviderStatusBadge() {
  const provider = getSelectedProviderStatus();
  const statusLabel = getConnectorStatusLabel();
  const tone = getConnectorClass();
  const usage = getSelectedProviderUsageSnapshot(provider);
  const usageTitle = usage
    ? [usage.meta, usage.remainingDetail, usage.resetDetail].filter(Boolean).join(" · ")
    : "";
  const title = [statusLabel, usageTitle].filter(Boolean).join(" · ");

  return `
    <div class="status-badge ${escapeHtml(tone)}${usage ? " has-usage" : ""}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
      <span class="status-badge-label">${escapeHtml(statusLabel)}</span>
      ${usage ? `<span class="status-badge-meta">${escapeHtml(usage.meta)}</span>` : ""}
      ${usage ? `
        <span class="status-badge-progress" aria-hidden="true">
          <span class="status-badge-progress-used" style="width:${usage.usedPercent}%"></span>
          <span class="status-badge-progress-remaining" style="width:${usage.remainingPercent}%"></span>
        </span>
      ` : ""}
    </div>
  `;
}

function getSelectedProviderUsageSnapshot(provider = getSelectedProviderStatus()) {
  const quota = provider?.quota;
  if (!quota) {
    return null;
  }

  const limit = Number(quota.limit);
  const remaining = Number(quota.remaining);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) {
    return null;
  }

  const usedPercent = clampPercentage(quota.usedPercent);
  const remainingPercent = clampPercentage(quota.remainingPercent ?? (100 - usedPercent));
  const resetLabel = formatProviderQuotaResetTime(quota.resetTime);
  return {
    usedPercent,
    remainingPercent,
    meta: remaining <= 0 ? "Limit reached" : `${usedPercent}% used`,
    remainingDetail: `${remaining}/${limit} remaining`,
    resetDetail: resetLabel ? `resets ${resetLabel}` : ""
  };
}

function renderProviderPrerequisites() {
  const missingProviders = state.connector.providers.filter((provider) => !provider.installed && provider.installCommand);
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
    getGeminiNanoProviderStatus(),
    ...getHttpProviderStatusSources().map(httpProviderToStatus)
  ];
}

function clampPercentage(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(number)));
}

function formatProviderQuotaResetTime(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const now = new Date();
  const sameDay = now.getFullYear() === date.getFullYear()
    && now.getMonth() === date.getMonth()
    && now.getDate() === date.getDate();
  const formatter = new Intl.DateTimeFormat("en", sameDay
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

  return sameDay
    ? `today ${formatter.format(date)}`
    : formatter.format(date);
}

function getGeminiNanoProviderStatus() {
  const availability = normalizeGeminiNanoAvailability(state.geminiNano.availability);
  const progress = state.geminiNano.downloadProgress;
  const connected = availability === "available";
  const installed = connected || availability === "downloadable" || availability === "downloading";
  const progressText = typeof progress === "number"
    ? ` Download progress: ${Math.round(progress * 100)}%.`
    : "";

  return {
    id: GEMINI_NANO_PROVIDER_ID,
    label: "Chrome Gemini Nano (experimental)",
    status: availability,
    statusLabel: getGeminiNanoStatusLabel(availability),
    installed,
    connected,
    command: "Chrome Prompt API",
    installCommand: "",
    models: [GEMINI_NANO_MODEL_ID],
    defaultModel: GEMINI_NANO_MODEL_ID,
    experimental: true,
    message: state.geminiNano.message || getGeminiNanoStatusMessage(availability, progressText)
  };
}

function normalizeGeminiNanoAvailability(value) {
  const normalized = String(value || "").toLowerCase();
  if (["available", "downloadable", "downloading", "unavailable"].includes(normalized)) {
    return normalized;
  }
  return "unknown";
}

function getGeminiNanoStatusLabel(availability) {
  if (availability === "available") return "Available";
  if (availability === "downloadable") return "Downloadable";
  if (availability === "downloading") return "Downloading";
  if (availability === "unavailable") return "Unavailable";
  return "Unknown";
}

function getGeminiNanoStatusMessage(availability, progressText = "") {
  if (availability === "available") {
    return "Gemini Nano is ready in Chrome and runs on this device through the Prompt API.";
  }
  if (availability === "downloadable") {
    return "Gemini Nano can be downloaded by Chrome for on-device use. Click Download Model to start it explicitly.";
  }
  if (availability === "downloading") {
    return `Chrome is downloading Gemini Nano for on-device use.${progressText}`;
  }
  if (availability === "unavailable") {
    return "Chrome Gemini Nano is not available on this browser or device.";
  }
  return "Chrome Gemini Nano availability has not been checked.";
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
  const status = provider.lastStatus || "unknown";
  const offline = status === "error";
  return {
    id: `http:${provider.id}`,
    label: provider.temporary ? `${label} (unsaved)` : label,
    status,
    statusLabel: getHttpProviderStatusLabel(provider),
    installed: true,
    connected: !offline && status === "ready",
    command: provider.baseUrl,
    installCommand: "",
    models: provider.models?.length ? provider.models : [provider.model || "default"],
    defaultModel: provider.model || provider.models?.[0] || "default",
    message: formatHttpProviderStatusMessage(provider)
  };
}

function isHttpProviderStatus(provider) {
  return String(provider?.id || "").startsWith("http:");
}

function getHttpProviderStatusLabel(provider) {
  const status = String(provider?.lastStatus || provider?.status || "").toLowerCase();
  const errorKind = String(provider?.errorKind || "").toLowerCase();

  if (status === "ready") return "Reachable";
  if (errorKind === "offline" || errorKind === "upstream_html") return "Offline";
  if (status === "error") return "Error";
  return "Unknown";
}

function formatHttpProviderStatusMessage(provider) {
  const message = compact(provider?.lastMessage || "");
  if (!message) {
    return provider?.providerKind === HTTP_PROVIDER_KIND_CLOUDFLARE
      ? "Cloudflare Workers AI is configured."
      : "OpenAI-compatible HTTP provider is configured.";
  }

  const detail = compact(provider?.lastDetail || "");
  if (!detail) {
    return message;
  }

  return `${message} Details: ${detail}`;
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
  if (provider?.quotaState === "exhausted") return "Limit reached";
  if (provider.id === GEMINI_NANO_PROVIDER_ID) {
    return getGeminiNanoStatusLabel(provider.status);
  }
  if (provider.connected) return "Connected";
  if (!provider.installed || provider.status === "missing") return "Missing";
  if (provider.status === "auth_unknown") return "Auth unknown";
  if (provider.status === "login_required") return "Login required";
  if (provider.status === "install_started") return "Installing";
  if (provider.status === "login_started") return "Login started";
  if (provider.status === "logged_out") return "Logged out";
  if (provider.status === "logout_failed") return "Logout failed";
  return "Installed";
}

function getSelectedProviderStatus() {
  return state.connector.providers.find((provider) => provider.id === state.codex.provider)
    || (state.codex.provider === GEMINI_NANO_PROVIDER_ID ? getGeminiNanoProviderStatus() : null)
    || getDefaultProviderStatus(state.codex.provider)
    || getDefaultProviderStatus("openai-codex");
}

function getSelectedDeepSearchProviderSnapshot() {
  const provider = getSelectedProviderStatus();
  const snapshot = {
    id: provider?.id || state.codex.provider,
    label: provider?.label || state.codex.provider,
    model: state.codex.model
  };

  if (isHttpProviderStatus(provider)) {
    const providerId = String(provider.id || "").replace(/^http:/, "");
    const httpProvider = getHttpProviderStatusSources().find((item) => item.id === providerId);
    if (httpProvider) {
      snapshot.httpProvider = {
        ...httpProvider,
        model: state.codex.model || httpProvider.model || httpProvider.models?.[0] || "default"
      };
    }
  }

  return snapshot;
}

function ensureSelectedProviderAvailable() {
  if (!state.connector.providers.length) {
    state.connector.providers = getDefaultProviderStatuses();
  }

  const selected = getSelectedProviderStatus();
  const existsInList = state.connector.providers.some((provider) => provider.id === state.codex.provider);

  if (!existsInList) {
    const connectedProviders = state.connector.providers.filter((provider) => provider.connected);
    if (connectedProviders.length) {
      const codex = connectedProviders.find((provider) => provider.id === "openai-codex");
      state.codex.provider = (codex || connectedProviders[0]).id;
    }
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
  const targetContext = options.planContext || {
    windowId: state.sidebarContext?.windowId || null
  };

  if (!silent && !options.skipWaitingMessage) {
    state.page.status = "observing";
    state.page.summary = `Requesting site access to ${reason}...`;
    render();
  }

  const permission = await ensureCurrentSitePermission(targetContext);

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

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.OBSERVE_ACTIVE_TAB, targetContext || {}));
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
  rememberSidebarContextFromTab(observation?.tab);
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

async function recoverObservationForProvider(reason, options = {}) {
  const planContext = options.planContext || null;
  const existing = getObservationForContext(planContext);
  if (existing) {
    return existing;
  }

  if (planContext) {
    await restoreExpectedTab(planContext);
  }

  addDebugLog("observe.recovery.start", {
    reason,
    planContext
  }, "Observation missing; attempting recovery before provider request.");

  const recovered = await observePage({
    reason,
    silent: true,
    skipWaitingMessage: true
  });

  addDebugLog("observe.recovery.end", {
    ok: Boolean(recovered),
    reason,
    planContext,
    observation: recovered ? summarizeObservationForLog(recovered) : null
  }, recovered
    ? "Recovered missing observation before provider request."
    : "Observation recovery failed before provider request.");

  return getObservationForContext(planContext) || recovered || null;
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

async function ensureCurrentSitePermission(context = null) {
  const tab = await getCurrentActiveTab({ context });

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
    await refreshGeminiNanoAvailability();
    addDebugLog("connector.health.start", { selectedProvider: state.codex.provider, selectedModel: state.codex.model }, "Checking connector.");
    const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.NATIVE_HEALTH));
    if (!response.ok) {
      state.connector = {
        status: "error",
        message: response.error,
        providers: state.connector.providers
      };
      addDebugLog("connector.health.end", {
        ok: response.ok,
        error: response.error || "",
        status: response.envelope?.payload || null,
        selectedProvider: summarizeProviderStatusForLog(getSelectedProviderStatus()),
        selectedConnectorState: getSelectedConnectorState()
      }, getConnectorHealthLogSummary(response));
      render();
      return;
    }

    const status = response.envelope.payload;
    let providers = normalizeProviderStatuses(status.providers || []);
    state.connector = {
      status: status.status,
      message: status.message || "Local connector status received.",
      providers
    };
    ensureSelectedProviderAvailable();
    const httpHealthRefreshed = await refreshAllHttpProviderHealth();
    if (httpHealthRefreshed) {
      providers = normalizeProviderStatuses(status.providers || []);
      state.connector.providers = providers;
    }
    state.connector.status = getSelectedConnectorState().status;
    state.connector.message = getSelectedConnectorState().message;
    ensureSelectedProviderAvailable();
    addDebugLog("connector.health.end", {
      ok: response.ok,
      error: response.error || "",
      status: response.envelope?.payload || null,
      selectedProvider: summarizeProviderStatusForLog(getSelectedProviderStatus()),
      selectedConnectorState: getSelectedConnectorState()
    }, getConnectorHealthLogSummary(response));
    render();
  } finally {
    connectorCheckInFlight = false;
  }
}

function getConnectorHealthLogSummary(response) {
  if (!response?.ok) {
    return response?.error || "Connector check failed.";
  }

  const provider = getSelectedProviderStatus();
  const connectorState = getSelectedConnectorState();
  const providerLabel = provider?.label || state.codex.provider || "Provider";
  const statusLabel = provider?.statusLabel || connectorState.status || "unknown";
  return `${providerLabel}: ${statusLabel}.`;
}

function summarizeProviderStatusForLog(provider) {
  if (!provider) {
    return null;
  }

  return {
    id: provider.id || "",
    label: provider.label || "",
    status: provider.status || "",
    statusLabel: provider.statusLabel || "",
    connected: Boolean(provider.connected),
    message: provider.message || "",
    model: state.codex.model || provider.defaultModel || ""
  };
}

async function refreshGeminiNanoAvailability() {
  const languageModel = getChromeLanguageModelApi();

  if (!languageModel?.availability) {
    state.geminiNano = {
      ...state.geminiNano,
      availability: "unavailable",
      downloadProgress: null,
      message: "Chrome Prompt API is not exposed in this extension context."
    };
    state.connector.providers = normalizeProviderStatuses(state.connector.providers);
    return getGeminiNanoProviderStatus();
  }

  try {
    const availability = normalizeGeminiNanoAvailability(await languageModel.availability(
      buildPromptApiAvailabilityOptions({ outputLanguage: "en" })
    ));
    state.geminiNano = {
      ...state.geminiNano,
      availability,
      downloadProgress: availability === "downloading" ? state.geminiNano.downloadProgress : null,
      message: getGeminiNanoStatusMessage(availability)
    };
  } catch (error) {
    state.geminiNano = {
      ...state.geminiNano,
      availability: "unavailable",
      downloadProgress: null,
      message: error.message || "Chrome Gemini Nano availability check failed."
    };
  }

  state.connector.providers = normalizeProviderStatuses(state.connector.providers);
  return getGeminiNanoProviderStatus();
}

function getChromeLanguageModelApi() {
  return globalThis.LanguageModel || globalThis.ai?.languageModel || null;
}

function normalizePromptApiLanguageCode(language) {
  const value = String(language || "").trim().toLowerCase();
  if (value === "es") return "es";
  if (value === "ja") return "ja";
  return "en";
}

function buildPromptApiCreateOptions(options = {}) {
  const outputLanguage = normalizePromptApiLanguageCode(options.outputLanguage || options.responseLanguage);
  const createOptions = {
    expectedOutputs: [
      { type: "text", languages: [outputLanguage] }
    ]
  };

  if (options.system) {
    createOptions.initialPrompts = [{ role: "system", content: options.system }];
  }

  if (typeof options.monitor === "function") {
    createOptions.monitor = options.monitor;
  }

  return createOptions;
}

function buildPromptApiAvailabilityOptions(options = {}) {
  const outputLanguage = normalizePromptApiLanguageCode(options.outputLanguage || options.responseLanguage);
  return {
    expectedOutputs: [
      { type: "text", languages: [outputLanguage] }
    ]
  };
}

async function downloadGeminiNano() {
  const languageModel = getChromeLanguageModelApi();

  if (!languageModel?.create) {
    state.geminiNano = {
      ...state.geminiNano,
      availability: "unavailable",
      message: "Chrome Prompt API is not available in this extension context."
    };
    state.connector.providers = normalizeProviderStatuses(state.connector.providers);
    render();
    return;
  }

  state.codex.provider = GEMINI_NANO_PROVIDER_ID;
  state.codex.model = GEMINI_NANO_MODEL_ID;
  state.geminiNano = {
    ...state.geminiNano,
    availability: "downloading",
    downloadProgress: 0,
    message: "Starting Chrome Gemini Nano download..."
  };
  state.connector.providers = normalizeProviderStatuses(state.connector.providers);
  persistConnectorSelection();
  render();

  let session = null;
  try {
    session = await languageModel.create(buildPromptApiCreateOptions({
      outputLanguage: "en",
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          const loaded = Number(event.loaded);
          state.geminiNano = {
            ...state.geminiNano,
            availability: "downloading",
            downloadProgress: Number.isFinite(loaded) ? loaded : state.geminiNano.downloadProgress,
            message: getGeminiNanoStatusMessage("downloading", Number.isFinite(loaded) ? ` Download progress: ${Math.round(loaded * 100)}%.` : "")
          };
          state.connector.providers = normalizeProviderStatuses(state.connector.providers);
          render({ preserveComposer: true });
        });
      }
    }));
    session?.destroy?.();
    state.geminiNano = {
      ...state.geminiNano,
      availability: "available",
      downloadProgress: null,
      message: "Chrome Gemini Nano is ready for on-device use."
    };
    state.activity.unshift("Chrome Gemini Nano is ready.");
  } catch (error) {
    state.geminiNano = {
      ...state.geminiNano,
      availability: "downloadable",
      downloadProgress: null,
      message: error.message || "Chrome Gemini Nano download could not be started."
    };
    state.activity.unshift(`Chrome Gemini Nano download failed: ${state.geminiNano.message}`);
  } finally {
    session?.destroy?.();
    await refreshGeminiNanoAvailability();
    state.codex.provider = GEMINI_NANO_PROVIDER_ID;
    state.codex.model = GEMINI_NANO_MODEL_ID;
    persistConnectorSelection();
    render();
  }
}

async function refreshSelectedHttpProviderHealth() {
  const provider = getSelectedHttpProvider();
  if (!provider?.baseUrl) {
    return false;
  }

  return refreshHttpProviderHealth(provider, {
    preserveSelectedModel: true
  });
}

async function refreshAllHttpProviderHealth() {
  const providers = [];
  const seen = new Set();
  for (const provider of state.httpProviders) {
    if (!provider?.id || !provider.baseUrl || seen.has(provider.id)) {
      continue;
    }
    providers.push(provider);
    seen.add(provider.id);
  }

  if (
    state.httpProviderDraft.id
    && state.httpProviderDraft.baseUrl
    && !seen.has(state.httpProviderDraft.id)
  ) {
    providers.push(state.httpProviderDraft);
  }

  let touched = false;
  for (const provider of providers) {
    touched = await refreshHttpProviderHealth(provider, {
      preserveSelectedModel: state.codex.provider === `http:${provider.id}`
    }) || touched;
  }

  return touched;
}

async function refreshHttpProviderHealth(provider, options = {}) {
  if (!provider?.baseUrl) {
    return false;
  }

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.HTTP_PROVIDER_TEST, provider));
  addDebugLog("connector.http_health", {
    providerId: provider.id,
    providerName: provider.name || provider.baseUrl,
    ok: response.ok,
    error: response.error || "",
    result: response.envelope?.payload || null
  }, response.ok
    ? (response.envelope?.payload?.message || "HTTP provider health checked.")
    : (response.error || "HTTP provider health check failed."));
  const payload = response.envelope?.payload || {};
  const models = Array.isArray(payload.models) ? payload.models : [];
  const loadedModels = Array.isArray(payload.loadedModels) ? payload.loadedModels : [];
  const targetId = provider.id;
  const updateProvider = (item) => (item.id === targetId ? {
    ...item,
    ...provider,
    ...(response.ok && payload.status !== "error" ? {
      model: models.includes(state.codex.model) && options.preserveSelectedModel
        ? state.codex.model
        : (models.includes(item.model || provider.model)
            ? (item.model || provider.model)
            : (models[0] || item.model || provider.model)),
      models: models.length ? models : item.models || [],
      loadedModels,
      lastStatus: payload.status || "ready",
      lastMessage: payload.message || "HTTP provider test completed.",
      errorKind: payload.errorKind || "",
      lastDetail: payload.detail || ""
    } : response.ok ? {
      models,
      loadedModels,
      lastStatus: payload.status || "error",
      lastMessage: payload.message || "HTTP provider test failed.",
      errorKind: payload.errorKind || "http_error",
      lastDetail: payload.detail || ""
    } : {
      lastStatus: "error",
      lastMessage: response.error || "HTTP provider test failed.",
      errorKind: "offline",
      lastDetail: ""
    })
  } : item);

  let touched = false;
  state.httpProviders = state.httpProviders.map((item) => {
    const next = updateProvider(item);
    if (next !== item) {
      touched = true;
    }
    return next;
  });

  if (state.httpProviderDraft.id === targetId) {
    state.httpProviderDraft = updateProvider(state.httpProviderDraft);
    touched = true;
  }

  if (touched) {
    await persistProviderSettings();
  }

  return touched;
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
  if (providerId === GEMINI_NANO_PROVIDER_ID) {
    state.codex.provider = GEMINI_NANO_PROVIDER_ID;
    state.codex.model = GEMINI_NANO_MODEL_ID;
    await refreshGeminiNanoAvailability();
    persistConnectorSelection();
    render();
    return;
  }

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

async function logoutProvider(providerId) {
  const provider = state.connector.providers.find((item) => item.id === providerId) || getDefaultProviderStatus(providerId);
  state.activity.unshift(`Requested logout for ${provider.label}.`);
  state.connector = {
    ...state.connector,
    status: "disconnecting",
    message: `Removing local authentication for ${provider.label}...`
  };
  render();

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.LOGOUT_PROVIDER, {
    provider: provider.id
  }));

  if (!response.ok) {
    state.connector = {
      ...state.connector,
      status: "error",
      message: response.error
    };
    state.activity.unshift(`Logout request failed for ${provider.label}: ${response.error}`);
    render();
    return;
  }

  const payload = response.envelope.payload;
  if (payload?.providers) {
    state.connector.providers = normalizeProviderStatuses(payload.providers);
    ensureSelectedProviderAvailable();
  }
  state.connector.status = payload?.status || getSelectedConnectorState().status;
  state.connector.message = payload?.message || `Logout completed for ${provider.label}.`;
  state.activity.unshift(state.connector.message);
  persistConnectorSelection();
  persistSession();
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
  const validationError = validateHttpProviderDraft(provider);
  if (validationError) {
    state.connector.message = validationError;
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
  if (payload.status === "error") {
    state.httpProviderDraft = {
      ...provider,
      models: [],
      loadedModels: [],
      lastStatus: "error",
      lastMessage: payload.message || "HTTP provider test failed.",
      errorKind: payload.errorKind || "",
      lastDetail: payload.detail || ""
    };
    state.connector.providers = normalizeProviderStatuses(state.connector.providers);
    state.connector.message = formatHttpProviderStatusMessage(state.httpProviderDraft);
    state.activity.unshift(`HTTP provider ${provider.name || provider.baseUrl} is offline or returned an invalid response.`);
    render();
    return;
  }

  const models = payload.models || [];
  const loadedModels = payload.loadedModels || [];
  const selectedModel = models.includes(provider.model) ? provider.model : (models[0] || provider.model || "");
  state.httpProviderDraft = {
    ...provider,
    model: selectedModel,
    models,
    loadedModels,
    lastStatus: payload.status || "ready",
    lastMessage: payload.message || "HTTP provider test completed.",
    errorKind: payload.errorKind || "",
    lastDetail: payload.detail || ""
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
  const validationError = validateHttpProviderDraft(provider);
  if (validationError) {
    state.connector.message = validationError;
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
  const providerKind = normalizeHttpProviderKind(
    document.getElementById("http-provider-kind")?.value || state.httpProviderDraft.providerKind || HTTP_PROVIDER_KIND_OPENAI
  );
  const defaultName = providerKind === HTTP_PROVIDER_KIND_CLOUDFLARE ? "Cloudflare Workers AI" : "Local LLM";
  const name = document.getElementById("http-provider-name")?.value.trim() || defaultName;
  const accountId = providerKind === HTTP_PROVIDER_KIND_CLOUDFLARE
    ? (document.getElementById("http-provider-account-id")?.value.trim() || state.httpProviderDraft.accountId || "")
    : (state.httpProviderDraft.accountId || "");
  const baseUrl = providerKind === HTTP_PROVIDER_KIND_CLOUDFLARE
    ? computeCloudflareWorkersAiBaseUrl(accountId)
    : (document.getElementById("http-provider-base-url")?.value.trim().replace(/\/+$/, "") || "");
  const requestedAuthType = document.getElementById("http-provider-auth-type")?.value || state.httpProviderDraft.authType || "none";
  const authType = providerKind === HTTP_PROVIDER_KIND_CLOUDFLARE ? "bearer" : normalizeHttpProviderAuthType(requestedAuthType);
  const username = authType === "basic"
    ? (document.getElementById("http-provider-username")?.value.trim() || "")
    : (state.httpProviderDraft.username || "");
  const password = authType === "basic"
    ? (document.getElementById("http-provider-password")?.value || "")
    : (state.httpProviderDraft.password || "");
  const token = authType === "bearer"
    ? (
      providerKind === HTTP_PROVIDER_KIND_CLOUDFLARE
        ? (document.getElementById("http-provider-api-token")?.value || state.httpProviderDraft.token || "")
        : (document.getElementById("http-provider-token")?.value || state.httpProviderDraft.token || "")
    )
    : (state.httpProviderDraft.token || "");
  const model = document.getElementById("http-provider-model")?.value.trim() || state.httpProviderDraft.model || "";
  const useStreaming = Boolean(document.getElementById("http-provider-use-streaming")?.checked);
  const plannerEnabled = Boolean(document.getElementById("http-provider-planner-enabled")?.checked);
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
  const timeoutMs = sanitizeTimeoutMs(
    document.getElementById("http-provider-timeout-ms")?.value,
    state.httpProviderDraft.timeoutMs,
    HTTP_PROVIDER_DEFAULT_TIMEOUT_MS
  );
  return {
    ...state.httpProviderDraft,
    id: existingId || crypto.randomUUID(),
    name,
    providerKind,
    baseUrl,
    accountId,
    token,
    authType,
    username,
    password,
    model,
    useStreaming,
    plannerEnabled,
    maxTokens,
    retryMaxTokens,
    timeoutMs,
    timeoutConfigured: timeoutMs > 0,
    models: state.httpProviderDraft.models?.length
      ? Array.from(new Set([...state.httpProviderDraft.models, ...(model ? [model] : [])]))
      : (model ? [model] : []),
    loadedModels: state.httpProviderDraft.loadedModels || [],
    lastStatus: state.httpProviderDraft.lastStatus || "ready",
    lastMessage: state.httpProviderDraft.lastMessage || (providerKind === HTTP_PROVIDER_KIND_CLOUDFLARE
      ? "Cloudflare Workers AI is configured."
      : "OpenAI-compatible HTTP provider is configured.")
  };
}

function validateHttpProviderDraft(provider) {
  if (provider.providerKind === HTTP_PROVIDER_KIND_CLOUDFLARE) {
    if (!provider.accountId) {
      return "Cloudflare Account ID is required.";
    }
    if (!provider.token) {
      return "Cloudflare API token is required.";
    }
  }

  if (!provider.baseUrl) {
    return "HTTP provider Base URL is required.";
  }

  if (provider.authType === "bearer" && !provider.token) {
    return "Bearer token is required.";
  }

  return "";
}

function handleHttpProviderKindChange() {
  state.httpProviderDraft = readHttpProviderDraft();
  if (state.httpProviderDraft.providerKind === HTTP_PROVIDER_KIND_CLOUDFLARE) {
    state.httpProviderDraft.authType = "bearer";
  }
  render();
}

function handleHttpProviderAuthTypeChange() {
  state.httpProviderDraft = readHttpProviderDraft();
  render();
}

function handleCloudflareAccountIdChange() {
  state.httpProviderDraft = readHttpProviderDraft();
  render();
}

function editHttpProvider(id) {
  const provider = state.httpProviders.find((item) => item.id === id);
  if (!provider) return;
  state.httpProviderDraft = {
    ...provider,
    maxTokens: sanitizePositiveInteger(provider.maxTokens, HTTP_PROVIDER_DEFAULT_MAX_TOKENS, HTTP_PROVIDER_DEFAULT_MAX_TOKENS),
    retryMaxTokens: sanitizePositiveInteger(provider.retryMaxTokens, HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS, HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS),
    plannerEnabled: Boolean(provider.plannerEnabled),
    timeoutMs: normalizeStoredTimeoutMs(provider)
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

function getHttpProviderPlannerMode(provider) {
  if (!provider?.plannerEnabled) {
    return null;
  }

  return {
    enabled: true,
    strategy: "plan_then_execute",
    loopAvoidance: true
  };
}

async function maybeOfferHttpModelUnload(previousModel, nextModel, providerOverride = null) {
  if (!previousModel || !nextModel || previousModel === nextModel) {
    return;
  }

  const provider = providerOverride || getSelectedHttpProvider();
  if (!supportsHttpProviderUnload(provider)) {
    return;
  }

  const loadedModels = provider.loadedModels || [];
  if (!loadedModels.includes(previousModel)) {
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
  rememberSidebarContextFromTab(questionTab);
  rememberActiveTab(questionTab);
  if (state.composerMode === "deep-search") {
    state.composerDraft = "";
    await launchDeepSearchRun(text, questionContext);
    render({ preserveComposer: false, focusComposer: true });
    return;
  }
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
  render({ preserveComposer: false, focusComposer: true });

  processOutboundQueue();
}

async function launchDeepSearchRun(text, planContext) {
  const selectedProvider = getSelectedProviderStatus();

  if (state.codex.provider === GEMINI_NANO_PROVIDER_ID) {
    state.messages.push({
      role: "user",
      text,
      createdAt: Date.now()
    });
    state.messages.push({
      role: "assistant",
      text: "Deep Search v1 currently runs through the native-host providers and is not available for Chrome Gemini Nano yet.",
      variant: "error",
      createdAt: Date.now()
    });
    state.activity.unshift("Deep Search launch blocked because Gemini Nano is not supported for this mode yet.");
    return;
  }

  if (!isSelectedProviderConnected()) {
    state.messages.push({
      role: "user",
      text,
      createdAt: Date.now()
    });
    state.messages.push({
      role: "assistant",
      text: `${selectedProvider?.label || "The selected provider"} is not ready yet. Connect it first, then launch Deep Search again.`,
      variant: "error",
      createdAt: Date.now()
    });
    state.activity.unshift("Deep Search launch blocked because the selected provider is not connected.");
    return;
  }

  const providerSnapshot = getSelectedDeepSearchProviderSnapshot();
  const createdAt = Date.now();
  const run = createDeepSearchRun({
    goal: text,
    provider: providerSnapshot.id,
    providerLabel: providerSnapshot.label,
    model: providerSnapshot.model,
    providerSnapshot,
    windowId: planContext?.windowId ?? state.sidebarContext.windowId,
    originTabId: planContext?.tabId ?? state.sidebarContext.tabId,
    responseLanguage: detectUserLanguage(text),
    userMessageLog: getProviderLoggedUserText(text, createdAt),
    createdAt: new Date(createdAt).toISOString(),
    observation: state.page.observation || null,
    page: planContext || null
  });

  try {
    await persistDeepSearchRun(run);

    const reportUrl = chrome.runtime.getURL(`src/deep-search/index.html?run=${encodeURIComponent(run.id)}`);
    await chrome.tabs.create({
      url: reportUrl,
      active: true,
      ...(run.windowId != null ? { windowId: run.windowId } : {})
    });
  } catch (error) {
    state.messages.push({
      role: "user",
      text,
      createdAt
    });
    state.messages.push({
      role: "assistant",
      text: error.message || "Deep Search could not open the report tab.",
      variant: "error",
      createdAt: Date.now()
    });
    state.activity.unshift(`Deep Search launch failed: ${error.message || "Unexpected error."}`);
    return;
  }

  state.messages.push({
    role: "user",
    text,
    createdAt
  });
  state.messages.push({
    role: "assistant",
    text: `Started a Deep Search report in a new tab. It will research in the background and keep the full write-up, sources, and methodology there.`,
    createdAt: Date.now()
  });
  state.activity.unshift(`Started Deep Search in window ${run.windowId == null ? "?" : run.windowId}.`);
  persistSession();
}

async function processOutboundQueue() {
  if (state.isProcessingQueue) {
    return;
  }

  state.isProcessingQueue = true;
  state.stopProcessingRequested = false;
  state.stopRequestInFlight = false;
  state.liveThinking = null;
  state.liveThinkingOpen = false;
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
    state.liveThinkingOpen = false;
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

  const memoryRequest = isSelectedProviderConnected() ? null : parseDirectMemoryRequest(text);
  if (memoryRequest) {
    const memoryItem = memoryRequest.synthesize
      ? await synthesizeMemoryRequest(memoryRequest)
      : memoryRequest;
    proposeMemorySave(memoryItem, detectUserLanguage(text), memoryRequest.goal);
    return;
  }
  state.pendingMemoryIntent = parseDeferredMemoryIntent(text);
  maybeResetTaskMemoryForNewGoal(text);
  rememberTaskMemoryGoal(text, { source: "user_message" });

  const planContext = item?.planContext || tabToPageContext(await getCurrentActiveTab());
  state.liveThinking = null;
  state.liveThinkingOpen = false;
  const agentResult = await getAgentResult(text, {
    planContext,
    createdAt: item?.createdAt || Date.now()
  });
  if (state.liveThinking) {
    state.liveThinking.streaming = false;
    if (!refreshChatLog()) {
      render();
    }
  }
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
    text: compactThinkingForDisplay(thinking),
    streaming: true,
    createdAt: state.liveThinking?.createdAt || Date.now(),
    updatedAt: Date.now()
  };
  addDebugLog("provider.progress", {
    requestId: payload.requestId || "",
    thinkingLength: thinking.length
  }, "Received provider thinking progress.");
  if (!refreshChatLog()) {
    render();
  }
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

function isGeminiNanoProviderSelected() {
  return state.codex.provider === GEMINI_NANO_PROVIDER_ID;
}

async function requestSelectedProviderAgent(payload) {
  if (isGeminiNanoProviderSelected()) {
    const result = await runGeminiNanoAgentRequest(payload).catch((error) => ({
      type: "agent_error",
      text: error.message || "Chrome Gemini Nano request failed.",
      message: error.message || "Chrome Gemini Nano request failed."
    }));
    return { ok: true, envelope: { payload: result } };
  }

  return sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.AGENT_REQUEST, payload));
}

async function requestSelectedProviderSynthesis(payload) {
  if (isGeminiNanoProviderSelected()) {
    const result = await runGeminiNanoSynthesisRequest(payload).catch((error) => ({
      type: "agent_error",
      text: error.message || "Chrome Gemini Nano synthesis failed.",
      message: error.message || "Chrome Gemini Nano synthesis failed."
    }));
    return { ok: true, envelope: { payload: result } };
  }

  return sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.SYNTHESIS_REQUEST, payload));
}

function applyLinkReferencesForProvider(value, options = {}) {
  return applyLinkReferencesDeep(value, {
    path: [],
    skipUrlFields: Boolean(options.skipUrlFields)
  });
}

function applyLinkReferencesDeep(value, context) {
  if (typeof value === "string") {
    return context.skipUrlFields ? value : replaceUrlsInProviderText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => applyLinkReferencesDeep(item, context));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...context.path, key];
    const lowerKey = key.toLowerCase();
    const skipUrlField = shouldKeepFullUrlForProviderPath(childPath, value);

    if (typeof child === "string" && isProviderUrlField(lowerKey) && isHttpUrl(child) && !skipUrlField) {
      const ref = registerLinkReference(child, inferLinkReferenceMetadata(value));
      output[key] = ref.ref;
      output[`${key}_ref`] = ref.ref;
      output[`${key}_host`] = ref.host;
      output[`${key}_hint`] = ref.hint;
      continue;
    }

    output[key] = applyLinkReferencesDeep(child, {
      path: childPath,
      skipUrlFields: skipUrlField
    });
  }

  return output;
}

function isProviderUrlField(key) {
  return [
    "url",
    "href",
    "destination_url",
    "finalurl",
    "final_url",
    "source_url",
    "primary_url"
  ].includes(String(key || "").toLowerCase());
}

function shouldKeepFullUrlForProviderPath(path, parent = {}) {
  const key = String(path[path.length - 1] || "").toLowerCase();
  if (!isProviderUrlField(key)) {
    return false;
  }

  if (parent && typeof parent === "object" && "baseUrl" in parent) {
    return true;
  }

  return false;
}

function inferLinkReferenceMetadata(source = {}) {
  if (!source || typeof source !== "object") {
    return {};
  }

  return {
    title: source.title || source.label || source.name || source.text || source.section_title || "",
    snippet: source.snippet || source.metadata || source.text_preview || source.nearby_text || "",
    source: source.item_id || source.agent_id || source.block_id || ""
  };
}

function replaceUrlsInProviderText(text) {
  const raw = String(text || "");
  if (!raw || !raw.match(LINK_REFERENCE_TEXT_URL_PATTERN)) {
    return raw;
  }

  LINK_REFERENCE_TEXT_URL_PATTERN.lastIndex = 0;
  return raw.replace(LINK_REFERENCE_TEXT_URL_PATTERN, (match) => {
    const trailing = match.match(/[),.;:!?]+$/)?.[0] || "";
    const candidate = trailing ? match.slice(0, -trailing.length) : match;
    if (!isHttpUrl(candidate)) {
      return match;
    }
    const ref = registerLinkReference(candidate);
    return `${ref.ref}${trailing}`;
  });
}

function registerLinkReference(url, metadata = {}) {
  const normalized = normalizeLinkReferenceUrl(url);
  if (!normalized) {
    return {
      ref: "",
      url: "",
      host: "",
      hint: ""
    };
  }

  state.linkReferences = normalizeLinkReferenceRegistry(state.linkReferences);
  const existingRef = state.linkReferences.byUrl[normalized];
  if (existingRef && state.linkReferences.byRef[existingRef]) {
    const existing = state.linkReferences.byRef[existingRef];
    mergeLinkReferenceMetadata(existing, metadata);
    state.linkReferences.updatedAt = new Date().toISOString();
    return existing;
  }

  pruneLinkReferenceRegistry();
  const ref = `L${state.linkReferences.nextId++}`;
  const parsed = parseUrlSafe(normalized);
  const createdAt = new Date().toISOString();
  const entry = {
    ref,
    url: normalized,
    host: parsed?.hostname || "",
    hint: formatLinkReferenceHint(parsed, normalized),
    title: compact(metadata.title || "").slice(0, 120),
    snippet: compact(metadata.snippet || "").slice(0, 180),
    source: compact(metadata.source || "").slice(0, 80),
    createdAt
  };

  state.linkReferences.byUrl[normalized] = ref;
  state.linkReferences.byRef[ref] = entry;
  state.linkReferences.updatedAt = createdAt;
  return entry;
}

function mergeLinkReferenceMetadata(entry, metadata = {}) {
  if (!entry || !metadata) {
    return;
  }

  if (!entry.title && metadata.title) {
    entry.title = compact(metadata.title).slice(0, 120);
  }
  if (!entry.snippet && metadata.snippet) {
    entry.snippet = compact(metadata.snippet).slice(0, 180);
  }
  if (!entry.source && metadata.source) {
    entry.source = compact(metadata.source).slice(0, 80);
  }
}

function normalizeLinkReferenceRegistry(registry) {
  const safe = registry && typeof registry === "object" ? registry : {};
  return {
    nextId: Math.max(1, Number.parseInt(String(safe.nextId || 1), 10) || 1),
    byUrl: safe.byUrl && typeof safe.byUrl === "object" ? safe.byUrl : {},
    byRef: safe.byRef && typeof safe.byRef === "object" ? safe.byRef : {},
    updatedAt: String(safe.updatedAt || "")
  };
}

function pruneLinkReferenceRegistry() {
  state.linkReferences = normalizeLinkReferenceRegistry(state.linkReferences);
  const entries = Object.values(state.linkReferences.byRef || {});
  if (entries.length < LINK_REFERENCE_LIMIT) {
    return;
  }

  const keep = entries
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, Math.max(20, LINK_REFERENCE_LIMIT - 20));
  state.linkReferences.byRef = {};
  state.linkReferences.byUrl = {};
  for (const entry of keep) {
    state.linkReferences.byRef[entry.ref] = entry;
    state.linkReferences.byUrl[entry.url] = entry.ref;
  }
}

function resetLinkReferenceRegistry() {
  state.linkReferences = {
    nextId: 1,
    byUrl: {},
    byRef: {},
    updatedAt: ""
  };
}

function getLinkReferencesForProvider(limit = LINK_REFERENCE_PROVIDER_LIMIT) {
  state.linkReferences = normalizeLinkReferenceRegistry(state.linkReferences);
  return Object.values(state.linkReferences.byRef || {})
    .sort((a, b) => Number.parseInt(a.ref.slice(1), 10) - Number.parseInt(b.ref.slice(1), 10))
    .slice(-limit)
    .map((entry) => ({
      ref: entry.ref,
      host: entry.host || "",
      hint: entry.hint || "",
      title: entry.title || "",
      snippet: entry.snippet || "",
      source: entry.source || ""
    }));
}

function resolveLinkReference(ref) {
  const normalized = normalizeLinkReferenceToken(ref);
  if (!normalized) {
    return null;
  }

  state.linkReferences = normalizeLinkReferenceRegistry(state.linkReferences);
  return state.linkReferences.byRef[normalized] || null;
}

function normalizeLinkReferenceToken(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(?:ref:)?(L\d+)$/i);
  return match ? match[1].toUpperCase() : "";
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function normalizeLinkReferenceUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function parseUrlSafe(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function formatLinkReferenceHint(parsed, fallbackUrl = "") {
  if (!parsed) {
    return String(fallbackUrl || "").slice(0, 120);
  }

  const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";
  const queryKeys = [...parsed.searchParams.keys()].slice(0, 3);
  const queryHint = queryKeys.length ? `?${queryKeys.join("&")}` : "";
  return `${parsed.hostname}${path}${queryHint}`.slice(0, 140);
}

async function runGeminiNanoAgentRequest(payload = {}) {
  const ready = await ensureGeminiNanoReady();
  if (!ready.ok) {
    return {
      type: "agent_unavailable",
      text: ready.message,
      message: ready.message
    };
  }

  const raw = await promptGeminiNano(buildGeminiNanoAgentPrompt(payload), {
    system: "You are Browser Companion's experimental on-device provider. Return only a single JSON object that follows the requested shape.",
    responseLanguage: detectUserLanguage(payload.goal || "")
  });
  const structured = extractStructuredAgentPayloadFromText(raw);

  if (structured) {
    return normalizeGeminiNanoAgentPayload(structured, payload);
  }

  return {
    type: "natural_response",
    text: compact(raw) || "I could not produce a response with Chrome Gemini Nano.",
    question: "",
    reason: "",
    goal: payload.goal || "",
    risk_level: "low",
    summary_for_user: "",
    needs_clarification: false,
    requires_confirmation: false,
    will_submit: false,
    actions: [],
    uncertain_fields: []
  };
}

async function runGeminiNanoSynthesisRequest(payload = {}) {
  const ready = await ensureGeminiNanoReady();
  if (!ready.ok) {
    return {
      type: "agent_error",
      text: ready.message,
      message: ready.message
    };
  }

  const raw = await promptGeminiNano(buildGeminiNanoSynthesisPrompt(payload), {
    system: "You are Browser Companion's experimental on-device synthesis provider. Return concise user-facing prose, not JSON, unless JSON is explicitly requested.",
    responseLanguage: detectUserLanguage(payload.goal || payload.text || "")
  });
  return {
    type: "natural_response",
    text: compact(raw) || "Chrome Gemini Nano did not return a usable answer."
  };
}

async function ensureGeminiNanoReady() {
  const provider = await refreshGeminiNanoAvailability();
  if (provider.connected) {
    return { ok: true };
  }

  return {
    ok: false,
    message: provider.status === "downloadable"
      ? "Chrome Gemini Nano is available to download. Open Connector and click Download Model before using it."
      : (provider.message || "Chrome Gemini Nano is not ready on this device.")
  };
}

async function promptGeminiNano(prompt, options = {}) {
  const languageModel = getChromeLanguageModelApi();
  if (!languageModel?.create) {
    throw new Error("Chrome Prompt API is not available.");
  }

  let session = null;
  try {
    try {
      session = await languageModel.create(buildPromptApiCreateOptions(options));
    } catch {
      session = await languageModel.create(buildPromptApiCreateOptions({
        responseLanguage: options.responseLanguage
      }));
    }

    if (typeof session?.prompt !== "function") {
      throw new Error("Chrome Gemini Nano session does not expose prompt().");
    }

    return String(await session.prompt(prompt) || "");
  } finally {
    session?.destroy?.();
  }
}

function buildGeminiNanoAgentPrompt(payload = {}) {
  return [
    "You are running locally in Chrome with Gemini Nano as an experimental Browser Companion provider.",
    "Return exactly one JSON object. Do not wrap it in Markdown.",
    "Allowed top-level type values: natural_response, ask_user, stop_for_human, memory_proposal, agent_plan.",
    "Always include these keys: type, text, question, reason, goal, risk_level, summary_for_user, needs_clarification, requires_confirmation, will_submit, actions, uncertain_fields.",
    "For natural_response, put the answer in text and keep actions empty.",
    "For ask_user, put the smallest needed question in question.",
    "For stop_for_human, put the stop reason in reason.",
    "For memory_proposal, include memory_title and memory_content.",
    "For agent_plan, use only Browser Companion action types and never invent arbitrary JavaScript. Prefer read-only actions before write actions.",
    "Action objects must include id, type, target, value, source, and reason. If a field does not apply, use empty strings, empty arrays, or confidence 0.",
    "If payload URLs are represented by short refs like L1, use the action field url_ref with that exact ref. Browser Companion will resolve it before policy and execution. Never invent refs.",
    "Browser Companion will validate policy and require confirmation before executing actions.",
    "Reply in the user's language.",
    "",
    "Runtime payload:",
    JSON.stringify(payload, null, 2)
  ].join("\n");
}

function buildGeminiNanoSynthesisPrompt(payload = {}) {
  if (payload.task === "user_memory") {
    return [
      "Create a compact local user-memory item from the request below.",
      "Return only JSON with keys title and content. Do not wrap it in Markdown.",
      "Keep stable self-reported facts. Preserve uncertainty when facts are not source-backed.",
      "",
      JSON.stringify(payload, null, 2)
    ].join("\n");
  }

  return [
    "Answer the user's request using the compact Browser Companion context below.",
    "Keep the answer concise, useful, and in the user's language.",
    "Do not dump raw tool results. Mention uncertainty when the context is incomplete.",
    "",
    JSON.stringify(payload, null, 2)
  ].join("\n");
}

function normalizeGeminiNanoAgentPayload(result, payload = {}) {
  const type = ["natural_response", "ask_user", "stop_for_human", "memory_proposal", "agent_plan"].includes(result?.type)
    ? result.type
    : (Array.isArray(result?.actions) && result.actions.length ? "agent_plan" : "natural_response");

  return {
    type,
    text: String(result?.text || result?.answer || result?.response || ""),
    question: String(result?.question || ""),
    reason: String(result?.reason || ""),
    goal: String(result?.goal || payload.goal || ""),
    risk_level: ["low", "medium", "high", "sensitive", "blocked"].includes(result?.risk_level) ? result.risk_level : "low",
    summary_for_user: String(result?.summary_for_user || result?.summary || result?.text || ""),
    needs_clarification: Boolean(result?.needs_clarification),
    requires_confirmation: Boolean(result?.requires_confirmation),
    will_submit: Boolean(result?.will_submit),
    actions: Array.isArray(result?.actions) ? result.actions : [],
    uncertain_fields: Array.isArray(result?.uncertain_fields) ? result.uncertain_fields : [],
    ...(result?.memory_title ? { memory_title: String(result.memory_title) } : {}),
    ...(result?.memory_content ? { memory_content: String(result.memory_content) } : {})
  };
}

async function getAgentResult(goal, options = {}) {
  goal = expandAgentGoal(goal);
  const responseLanguage = detectUserLanguage(goal);
  const providerGoal = getProviderLoggedUserText(goal, options.createdAt);
  const navigationPlan = buildNavigationPlan(goal, responseLanguage);

  if (navigationPlan) {
    addDebugLog("agent.local_navigation_plan", { goal, plan: navigationPlan }, navigationPlan.summary_for_user);
    return navigationPlan;
  }

  if (isSelectedProviderConnected()) {
    const needsPageRecovery = !isSimpleConversationalMessage(goal);
    let rawObservation = getObservationForContext(options.planContext);
    if (!rawObservation && needsPageRecovery) {
      rawObservation = await recoverObservationForProvider("read this page before sending the provider request", {
        planContext: options.planContext
      });
    }

    const selectedHttpProvider = getSelectedHttpProvider();
    const plannerMode = getHttpProviderPlannerMode(selectedHttpProvider);
    const runtimeContext = await buildRuntimeContext(goal, options);
    const accessibleTabs = await getAccessibleTabsForProvider();
    const conversationContext = getRecentConversationForProvider(goal);
    const recentReferences = getRecentReferencesForProvider(providerGoal, rawObservation, conversationContext);
    const recentActions = getRecentActionsForProvider();
    const taskMemory = getTaskMemoryForProvider(goal);
    const observationContext = {
      goal,
      conversationContext,
      userMemory: state.userMemory.items,
      recentReferences
    };
    const providerContextMode = options.compactProviderContext ? "compact" : "standard";
    const observationForRequest = compactObservationForProvider(rawObservation, observationContext, providerContextMode);
    const providerContext = applyLinkReferencesForProvider({
      runtimeContext,
      conversationContext,
      recentReferences,
      accessibleTabs,
      recentActions,
      taskMemory,
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
    });
    const payload = {
      goal: providerGoal,
      responseLanguage,
      provider: state.codex.provider,
      model: state.codex.model,
      httpProvider: selectedHttpProvider,
      ...(plannerMode ? { plannerMode } : {}),
      ...providerContext,
      linkReferences: getLinkReferencesForProvider()
    };
    addDebugLog("provider.agent_request.start", payload, `${state.codex.provider} / ${state.codex.model}`);
    const response = await requestSelectedProviderAgent(payload);
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
        createdAt: options.createdAt,
        omitAttachmentsForProvider: true,
        continuationReason: compact(`${options.continuationReason || ""}\nThe previous provider attempt timed out. Retry with lighter context and no attachments. If the answer still depends on missing material, ask for the rest explicitly.`)
      });
    }

    if (
      response.ok
      && isProviderContextLimitResult(response.envelope?.payload)
      && !options.compactProviderContext
    ) {
      state.activity.unshift("HTTP provider rejected the context size; retrying once with compact page context.");
      addDebugLog("provider.agent_request.retry", {
        reason: "context_limit_compact_retry",
        compactProviderContext: true,
        omitAttachmentsForProvider: true
      }, "Retrying provider request with compact context after context-window rejection.");
      return getAgentResult(goal, {
        ...options,
        createdAt: options.createdAt,
        compactProviderContext: true,
        omitAttachmentsForProvider: true,
        continuationReason: compact(`${options.continuationReason || ""}\nThe previous provider attempt exceeded the model context window. Retry with compact page context and use focused/structured URLs first.`)
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
    lines.push(`Accessible tabs known to Browser Companion (observed tabs are ready to inspect; other tabs may still need permission or fresh observation): ${recentTabs.map(formatTabContextForPrompt).join(" | ")}.`);
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
  if (tab.windowId) parts.push(`window=${tab.windowId}`);
  if (tab.isCurrent) parts.push("current=true");
  if (tab.title) parts.push(`title="${String(tab.title).slice(0, 120)}"`);
  if (tab.url) parts.push(`url=${String(tab.url).slice(0, 220)}`);
  if (tab.source) parts.push(`source=${tab.source}`);
  if (tab.accessStatus) parts.push(`access=${tab.accessStatus}`);
  if (tab.lastObservedAt) parts.push(`lastObservedAt=${tab.lastObservedAt}`);
  if (tab.lastActiveAt) parts.push(`lastActiveAt=${tab.lastActiveAt}`);
  return parts.join(", ");
}

function getRecentConversationForProvider(currentGoal) {
  const normalizedGoal = compact(currentGoal || "");
  const messages = state.messages
    .filter((message) => String(message?.text || "").trim())
    .map((message) => ({
      role: message.role || "assistant",
      text: String(message.text || ""),
      createdAt: message.createdAt || 0
    }));

  let skippedCurrentUserMessage = false;
  const trimmed = messages
    .slice()
    .reverse()
    .filter((message) => {
      if (
        !skippedCurrentUserMessage
        && message.role === "user"
        && compact(message.text || "") === normalizedGoal
      ) {
        skippedCurrentUserMessage = true;
        return false;
      }

      return true;
    })
    .slice(0, PROVIDER_CONVERSATION_CONTEXT_LIMIT)
    .reverse();

  return trimmed.map((message) => ({
    role: message.role,
    text: getProviderConversationMessageText(message).slice(0, PROVIDER_CONVERSATION_TEXT_LIMIT),
    createdAt: message.createdAt || 0
  }));
}

function getProviderConversationMessageText(message = {}) {
  const text = String(message?.text || "");
  if (message?.role !== "user") {
    return text;
  }
  return getProviderLoggedUserText(text, message?.createdAt || Date.now());
}

function getProviderLoggedUserText(text, createdAt = Date.now()) {
  return prefixUserMessageWithTimestamp(text, createdAt, {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  });
}

function getRecentReferencesForProvider(currentGoal, observation, conversationContext = []) {
  const items = Array.isArray(observation?.structured_items) ? observation.structured_items : [];
  const assistantMessages = (Array.isArray(conversationContext) ? conversationContext : [])
    .filter((message) => message.role === "assistant" && String(message.text || "").trim());
  const mentionedItems = [];

  for (const item of items) {
    const title = String(item.title || item.label || item.text_preview || "").trim();
    if (!title) {
      continue;
    }

    const normalizedTitle = normalizeElementName(title);
    const matchedMessage = assistantMessages.find((message) => {
      const messageText = normalizeElementName(message.text || "");
      return messageText.includes(normalizedTitle) || normalizedTitle.includes(messageText);
    });

    if (!matchedMessage) {
      continue;
    }

    mentionedItems.push({
      item_id: item.item_id || "",
      title,
      metadata: item.metadata || "",
      section_title: item.section_title || "",
      destination_url: item.destination_url || item.href || "",
      matched_message_at: matchedMessage.createdAt || 0
    });
  }

  const unresolvedReferences = [];
  const goal = String(currentGoal || "").trim();
  if (/\b(those|them|ones|mentioned|earlier|previous|those jobs|those offers|quelle|quelli|quelle offerte|hai menzionato|prima|second[oa]?|terz[oa]?|quart[oa]?)\b/i.test(goal)) {
    unresolvedReferences.push(goal.slice(0, 240));
  }

  return {
    mentioned_items: mentionedItems.slice(0, PROVIDER_RECENT_REFERENCE_LIMIT),
    unresolved_references: unresolvedReferences
  };
}

function getRecentActionsForProvider() {
  return (Array.isArray(state.recentActions) ? state.recentActions : [])
    .slice(0, PROVIDER_RECENT_ACTION_LIMIT)
    .map((entry) => ({
      action_id: entry.action_id || "",
      action_type: entry.action_type || "",
      status: entry.status || "",
      log_message: entry.log_message || "",
      target_verified: Boolean(entry.target_verified),
      page_changed: Boolean(entry.page_changed),
      createdAt: entry.createdAt || "",
      artifact: entry.artifact || null
    }));
}

function normalizeTaskMemory(memory) {
  const safe = memory && typeof memory === "object" ? memory : {};
  return {
    rootGoal: compact(safe.rootGoal || ""),
    currentGoal: compact(safe.currentGoal || ""),
    goals: Array.isArray(safe.goals) ? safe.goals.slice(0, TASK_MEMORY_GOAL_LIMIT).map(normalizeTaskMemoryGoalEntry).filter(Boolean) : [],
    constraints: Array.isArray(safe.constraints) ? safe.constraints.slice(0, TASK_MEMORY_CONSTRAINT_LIMIT).map(normalizeTaskMemoryText).filter(Boolean) : [],
    explored: Array.isArray(safe.explored) ? safe.explored.slice(0, TASK_MEMORY_EXPLORED_LIMIT).map(normalizeTaskMemoryEntry).filter(Boolean) : [],
    findings: Array.isArray(safe.findings) ? safe.findings.slice(0, TASK_MEMORY_FINDING_LIMIT).map(normalizeTaskMemoryEntry).filter(Boolean) : [],
    deadEnds: Array.isArray(safe.deadEnds) ? safe.deadEnds.slice(0, TASK_MEMORY_DEAD_END_LIMIT).map(normalizeTaskMemoryEntry).filter(Boolean) : [],
    nextSteps: Array.isArray(safe.nextSteps) ? safe.nextSteps.slice(0, TASK_MEMORY_NEXT_STEP_LIMIT).map(normalizeTaskMemoryEntry).filter(Boolean) : [],
    updatedAt: String(safe.updatedAt || "")
  };
}

function normalizeTaskMemoryText(value) {
  return compact(String(value || "")).slice(0, TASK_MEMORY_TEXT_LIMIT);
}

function normalizeTaskMemoryGoalEntry(entry) {
  const safe = entry && typeof entry === "object" ? entry : {};
  const text = normalizeTaskMemoryText(safe.text || "");
  if (!text) {
    return null;
  }

  return {
    text,
    source: normalizeTaskMemoryText(safe.source || "user"),
    at: String(safe.at || "")
  };
}

function normalizeTaskMemoryEntry(entry) {
  const safe = entry && typeof entry === "object" ? entry : {};
  const kind = normalizeTaskMemoryText(safe.kind || "");
  const label = normalizeTaskMemoryText(safe.label || safe.query || safe.url || safe.reason || "");
  if (!kind && !label) {
    return null;
  }

  return {
    kind: kind || "note",
    label,
    query: normalizeTaskMemoryText(safe.query || ""),
    url: String(safe.url || "").slice(0, 500),
    title: normalizeTaskMemoryText(safe.title || ""),
    results: compactWebSearchResultsForProvider(safe.results, 6),
    status: normalizeTaskMemoryText(safe.status || ""),
    reason: normalizeTaskMemoryText(safe.reason || ""),
    source: normalizeTaskMemoryText(safe.source || ""),
    at: String(safe.at || "")
  };
}

function mergeTaskMemoryEntries(existing, incoming, limit, buildKey) {
  const merged = [];
  const seen = new Set();

  for (const entry of [...incoming, ...existing]) {
    if (!entry) {
      continue;
    }

    const key = buildKey(entry);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(entry);
    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

function touchTaskMemory() {
  state.taskMemory.updatedAt = new Date().toISOString();
}

function maybeResetTaskMemoryForNewGoal(goal) {
  const text = normalizeTaskMemoryText(goal);
  if (!text || isRetryLikeGoal(text)) {
    return false;
  }

  state.taskMemory = normalizeTaskMemory(state.taskMemory);
  const previousGoal = state.taskMemory.currentGoal || state.taskMemory.rootGoal || "";
  if (!previousGoal || areTaskGoalsRelated(previousGoal, text)) {
    return false;
  }

  const hadMaterial = Boolean(
    state.taskMemory.rootGoal
    || state.taskMemory.currentGoal
    || state.taskMemory.explored.length
    || state.taskMemory.findings.length
    || state.taskMemory.deadEnds.length
    || state.taskMemory.nextSteps.length
  );
  if (!hadMaterial) {
    return false;
  }

  addDebugLog("task_memory.reset", {
    previousGoal,
    nextGoal: text
  }, "Reset stale task memory for a new unrelated user goal.");
  state.taskMemory = createEmptyTaskMemory();
  resetLinkReferenceRegistry();
  return true;
}

function areTaskGoalsRelated(previousGoal, nextGoal) {
  const previousTokens = getTaskGoalTokens(previousGoal);
  const nextTokens = getTaskGoalTokens(nextGoal);
  if (!previousTokens.size || !nextTokens.size) {
    return false;
  }

  for (const token of nextTokens) {
    if (previousTokens.has(token)) {
      return true;
    }
  }

  return false;
}

function getTaskGoalTokens(text) {
  const generic = new Set([
    "cerca",
    "search",
    "trova",
    "find",
    "online",
    "apri",
    "open",
    "page",
    "pagina",
    "tab",
    "tabs",
    "nuova",
    "nuove",
    "risultati",
    "results"
  ]);
  return new Set(
    normalizeTextBlock(text || "")
      .split(" ")
      .map((token) => token.trim())
      .map(canonicalTaskGoalToken)
      .filter((token) => token.length >= 4 && !generic.has(token))
  );
}

function canonicalTaskGoalToken(token) {
  const value = String(token || "").trim();
  if (value.length > 5 && /[aeio]$/.test(value)) {
    return value.slice(0, -1);
  }
  return value;
}

function rememberTaskMemoryGoal(goal, options = {}) {
  const text = normalizeTaskMemoryText(goal);
  if (!text) {
    return;
  }

  state.taskMemory = normalizeTaskMemory(state.taskMemory);
  if (!state.taskMemory.rootGoal) {
    state.taskMemory.rootGoal = text;
  }
  state.taskMemory.currentGoal = text;
  state.taskMemory.goals = mergeTaskMemoryEntries(
    state.taskMemory.goals,
    [{
      text,
      source: options.source || "user",
      at: new Date().toISOString()
    }],
    TASK_MEMORY_GOAL_LIMIT,
    (entry) => `${entry.source}|${entry.text}`
  );

  const constraints = extractTaskMemoryConstraints(text);
  state.taskMemory.constraints = mergeTaskMemoryEntries(
    state.taskMemory.constraints.map((value) => ({ label: value })),
    constraints.map((value) => ({ label: value })),
    TASK_MEMORY_CONSTRAINT_LIMIT,
    (entry) => entry.label.toLowerCase()
  ).map((entry) => entry.label);

  touchTaskMemory();
}

function extractTaskMemoryConstraints(text) {
  const raw = String(text || "");
  const clauses = raw
    .split(/[\n.;]+/)
    .map((part) => normalizeTaskMemoryText(part))
    .filter(Boolean);

  const matches = clauses.filter((clause) => (
    /\b(no|not|without|exclude|excluding|only|must|avoid|remote|europe|european|non[-\s])/i.test(clause)
    || /\b(no|non|senza|esclud|solo|deve|evita|remoto|europeo|europa)\b/i.test(clause)
  ));

  return [...new Set(matches)].slice(0, TASK_MEMORY_CONSTRAINT_LIMIT);
}

function rememberTaskMemoryObservation(observation, source = "observation") {
  const tab = observation?.tab || {};
  const url = String(tab.url || "").slice(0, 500);
  const title = normalizeTaskMemoryText(tab.title || "");
  if (!url && !title) {
    return;
  }

  state.taskMemory = normalizeTaskMemory(state.taskMemory);
  state.taskMemory.explored = mergeTaskMemoryEntries(
    state.taskMemory.explored,
    [{
      kind: "page_observation",
      label: title || url,
      url,
      title,
      status: "observed",
      source,
      at: observation?.capturedAt || new Date().toISOString()
    }],
    TASK_MEMORY_EXPLORED_LIMIT,
    (entry) => `${entry.kind}|${normalizeUrlForContext(entry.url || entry.label || "")}`
  );
  touchTaskMemory();
}

function rememberTaskMemoryPlannedActions(plan) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  if (!actions.length) {
    return;
  }

  state.taskMemory = normalizeTaskMemory(state.taskMemory);
  state.taskMemory.nextSteps = mergeTaskMemoryEntries(
    [],
    actions.map((action) => ({
      kind: action?.type || "action",
      label: formatTaskMemoryActionLabel(action),
      url: String(action?.tab?.url || action?.value || "").slice(0, 500),
      source: "agent_plan",
      at: new Date().toISOString()
    })),
    TASK_MEMORY_NEXT_STEP_LIMIT,
    (entry) => `${entry.kind}|${entry.label}|${entry.url}`
  );
  touchTaskMemory();
}

function formatTaskMemoryActionLabel(action) {
  const parts = [action?.type || "action"];
  const targetName = normalizeTaskMemoryText(action?.target?.name || "");
  const queryLikeValue = normalizeTaskMemoryText(action?.value || "");
  const tabTitle = normalizeTaskMemoryText(action?.tab?.title || "");

  if (targetName) parts.push(targetName);
  else if (tabTitle) parts.push(tabTitle);
  else if (queryLikeValue) parts.push(queryLikeValue);

  return parts.join(": ").slice(0, TASK_MEMORY_TEXT_LIMIT);
}

function rememberTaskMemoryActionResults(plan, results) {
  const actionsById = new Map(
    (Array.isArray(plan?.actions) ? plan.actions : [])
      .filter((action) => action?.id)
      .map((action) => [action.id, action])
  );
  const explored = [];
  const deadEnds = [];

  for (const result of Array.isArray(results) ? results : []) {
    const action = actionsById.get(result?.action_id) || null;
    const artifact = result?.artifact || null;
    const logMessage = normalizeTaskMemoryText(result?.log_message || "");

    if (artifact?.kind === "web_search") {
      const resultCount = Array.isArray(artifact.results) ? artifact.results.length : (artifact.resultCount || 0);
      explored.push({
        kind: "web_search",
        label: normalizeTaskMemoryText(artifact.query || action?.value || ""),
        query: normalizeTaskMemoryText(artifact.query || action?.value || ""),
        results: compactWebSearchResultsForProvider(artifact.results, 6),
        status: `${resultCount} results`,
        source: action?.id || result?.action_id || "",
        at: result?.createdAt || new Date().toISOString()
      });
      if (resultCount === 0) {
        deadEnds.push({
          kind: "web_search",
          label: normalizeTaskMemoryText(artifact.query || action?.value || ""),
          reason: "No public results found.",
          source: action?.id || result?.action_id || "",
          at: result?.createdAt || new Date().toISOString()
        });
      }
      continue;
    }

    if (artifact?.kind === "http_response") {
      explored.push({
        kind: "http_request",
        label: normalizeTaskMemoryText(artifact.finalUrl || artifact.url || action?.value || ""),
        url: String(artifact.finalUrl || artifact.url || "").slice(0, 500),
        status: normalizeTaskMemoryText(String(artifact.statusCode || "")),
        source: action?.id || result?.action_id || "",
        at: result?.createdAt || new Date().toISOString()
      });
      continue;
    }

    if (artifact?.kind === "tab_opened") {
      explored.push({
        kind: "tab_opened",
        label: normalizeTaskMemoryText(artifact.title || artifact.url || action?.value || ""),
        url: String(artifact.url || "").slice(0, 500),
        title: normalizeTaskMemoryText(artifact.title || ""),
        status: "opened",
        source: action?.id || result?.action_id || "",
        at: result?.createdAt || new Date().toISOString()
      });
      continue;
    }

    if (artifact?.kind === "page_observation") {
      explored.push({
        kind: "page_observation",
        label: normalizeTaskMemoryText(artifact.title || artifact.url || action?.tab?.title || ""),
        url: String(artifact.url || "").slice(0, 500),
        title: normalizeTaskMemoryText(artifact.title || ""),
        status: "observed",
        source: action?.id || result?.action_id || "",
        at: result?.createdAt || new Date().toISOString()
      });
      continue;
    }

    if (result?.status !== "success") {
      deadEnds.push({
        kind: action?.type || "action",
        label: formatTaskMemoryActionLabel(action || { type: result?.action_id || "action" }),
        reason: logMessage || normalizeTaskMemoryText(result?.status || "Action failed."),
        source: action?.id || result?.action_id || "",
        at: result?.createdAt || new Date().toISOString()
      });
    } else if (action) {
      explored.push({
        kind: action.type || "action",
        label: formatTaskMemoryActionLabel(action),
        status: logMessage || "success",
        source: action.id || result?.action_id || "",
        at: result?.createdAt || new Date().toISOString()
      });
    }
  }

  state.taskMemory = normalizeTaskMemory(state.taskMemory);
  state.taskMemory.explored = mergeTaskMemoryEntries(
    state.taskMemory.explored,
    explored.map(normalizeTaskMemoryEntry).filter(Boolean),
    TASK_MEMORY_EXPLORED_LIMIT,
    (entry) => `${entry.kind}|${entry.query || normalizeUrlForContext(entry.url || "") || entry.label}|${entry.status}`
  );
  state.taskMemory.deadEnds = mergeTaskMemoryEntries(
    state.taskMemory.deadEnds,
    deadEnds.map(normalizeTaskMemoryEntry).filter(Boolean),
    TASK_MEMORY_DEAD_END_LIMIT,
    (entry) => `${entry.kind}|${entry.label}|${entry.reason}`
  );
  state.taskMemory.nextSteps = [];
  touchTaskMemory();
}

function rememberTaskMemoryFinding(text, source = "assistant") {
  const normalized = normalizeTaskMemoryText(text);
  if (!normalized || isActionOnlyCompletionText(normalized)) {
    return;
  }

  state.taskMemory = normalizeTaskMemory(state.taskMemory);
  state.taskMemory.findings = mergeTaskMemoryEntries(
    state.taskMemory.findings,
    [{
      kind: "finding",
      label: normalized,
      source,
      at: new Date().toISOString()
    }],
    TASK_MEMORY_FINDING_LIMIT,
    (entry) => `${entry.source}|${entry.label}`
  );
  state.taskMemory.nextSteps = [];
  touchTaskMemory();
}

function getTaskMemoryForProvider(currentGoal) {
  const memory = normalizeTaskMemory(state.taskMemory);
  if (!memory.rootGoal && !memory.currentGoal && !memory.goals.length && !memory.explored.length && !memory.findings.length && !memory.deadEnds.length) {
    return null;
  }

  return {
    rootGoal: memory.rootGoal || normalizeTaskMemoryText(currentGoal || ""),
    currentGoal: normalizeTaskMemoryText(currentGoal || memory.currentGoal || ""),
    brief: buildTaskMemoryBrief(memory),
    constraints: memory.constraints.slice(0, TASK_MEMORY_CONSTRAINT_LIMIT),
    goals: memory.goals.slice(0, TASK_MEMORY_GOAL_LIMIT),
    explored: memory.explored.slice(0, TASK_MEMORY_EXPLORED_LIMIT),
    findings: memory.findings.slice(0, TASK_MEMORY_FINDING_LIMIT),
    deadEnds: memory.deadEnds.slice(0, TASK_MEMORY_DEAD_END_LIMIT),
    nextSteps: memory.nextSteps.slice(0, TASK_MEMORY_NEXT_STEP_LIMIT),
    updatedAt: memory.updatedAt || ""
  };
}

function buildTaskMemoryBrief(memory) {
  const lines = [];
  if (memory.rootGoal) {
    lines.push(`Root goal: ${memory.rootGoal}`);
  }
  if (memory.currentGoal && memory.currentGoal !== memory.rootGoal) {
    lines.push(`Current goal: ${memory.currentGoal}`);
  }
  if (memory.constraints.length) {
    lines.push(`Constraints: ${memory.constraints.slice(0, TASK_MEMORY_BRIEF_SECTION_LIMIT).join(" | ")}`);
  }
  if (memory.explored.length) {
    lines.push(`Explored: ${memory.explored.slice(0, TASK_MEMORY_BRIEF_SECTION_LIMIT).map(formatTaskMemoryBriefEntry).join(" | ")}`);
  }
  if (memory.deadEnds.length) {
    lines.push(`Dead ends: ${memory.deadEnds.slice(0, TASK_MEMORY_BRIEF_SECTION_LIMIT).map(formatTaskMemoryBriefEntry).join(" | ")}`);
  }
  if (memory.findings.length) {
    lines.push(`Findings: ${memory.findings.slice(0, TASK_MEMORY_BRIEF_SECTION_LIMIT).map((entry) => entry.label).join(" | ")}`);
  }
  if (memory.nextSteps.length) {
    lines.push(`Pending leads: ${memory.nextSteps.slice(0, TASK_MEMORY_BRIEF_SECTION_LIMIT).map((entry) => entry.label).join(" | ")}`);
  }
  return lines.join("\n").slice(0, 2000);
}

function formatTaskMemoryBriefEntry(entry) {
  const parts = [];
  if (entry.kind) parts.push(entry.kind);
  if (entry.label) parts.push(entry.label);
  if (entry.status) parts.push(entry.status);
  if (entry.reason) parts.push(entry.reason);
  return parts.join(": ").slice(0, TASK_MEMORY_TEXT_LIMIT);
}

async function getAccessibleTabsForProvider() {
  await refreshAccessibleTabsState();
  const currentTab = await getCurrentActiveTab().catch(() => null);
  if (currentTab) {
    rememberActiveTab(currentTab);
  }

  return getRecentAccessibleTabs(currentTab?.id || null)
    .slice(0, PROVIDER_RECENT_TAB_LIMIT)
    .map((tab) => ({
      tabId: tab.tabId || null,
      title: tab.title || "",
      url: tab.url || "",
      source: tab.source || "",
      isCurrent: Boolean(tab.isCurrent),
      accessStatus: tab.accessStatus || "unknown",
      lastObservedAt: tab.lastObservedAt || "",
      lastActiveAt: tab.lastActiveAt || "",
      visibleTextLength: tab.visibleTextLength || 0,
      links: tab.links || 0,
      buttons: tab.buttons || 0,
      lastActionLog: tab.lastActionLog || ""
    }));
}

function getObservationForContext(context) {
  const observation = state.page.observation || null;
  if (!observation || !context) {
    return observation;
  }

  const observedTab = observation.tab || {};
  const sameTab = context.tabId && observedTab.id && context.tabId === observedTab.id;
  const sameWindow = !context.windowId || !observedTab.windowId || context.windowId === observedTab.windowId;
  const sameUrl = normalizeUrlForContext(context.url) === normalizeUrlForContext(observedTab.url || state.page.url);

  return sameTab || (sameWindow && sameUrl) ? observation : null;
}

async function refreshAccessibleTabsState() {
  const entries = Object.entries(state.accessibleTabs || {});
  if (!entries.length) {
    return;
  }

  const refreshedEntries = await Promise.all(
    entries.map(async ([key, tab]) => {
      const tabId = Number.isInteger(tab?.tabId)
        ? tab.tabId
        : Number.parseInt(String(tab?.tabId || ""), 10);

      if (!Number.isInteger(tabId)) {
        return [key, tab];
      }

      const liveTab = await chrome.tabs.get(tabId).catch(() => null);
      if (!liveTab?.id) {
        return null;
      }

      return [key, {
        ...tab,
        tabId: liveTab.id,
        windowId: liveTab.windowId,
        url: liveTab.url || tab.url || "",
        title: liveTab.title || tab.title || ""
      }];
    })
  );

  state.accessibleTabs = Object.fromEntries(refreshedEntries.filter(Boolean));
  pruneAccessibleTabs();
}

function handleTabRemoved(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  if (state.sidebarContext?.tabId === tabId) {
    state.sidebarContext = {
      ...state.sidebarContext,
      tabId: null
    };
  }

  const entries = Object.entries(state.accessibleTabs || {});
  let removed = false;
  const nextEntries = entries.filter(([, tab]) => {
    const matches = tab?.tabId === tabId;
    if (matches) {
      removed = true;
    }
    return !matches;
  });

  if (!removed) {
    return;
  }

  state.accessibleTabs = Object.fromEntries(nextEntries);
  persistSession();
  render();
}

function getActionTargetTabId(action) {
  const directCandidates = [
    action?.tab?.tabId,
    action?.tab?.id,
    action?.tabId
  ];

  for (const candidate of directCandidates) {
    if (Number.isInteger(candidate)) {
      return candidate;
    }

    const parsed = Number.parseInt(String(candidate || ""), 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  if (action?.type === "observe_known_tab") {
    const legacy = Number.parseInt(String(action.value || action.target?.agent_id || ""), 10);
    return Number.isInteger(legacy) ? legacy : null;
  }

  return null;
}

function actionUsesCurrentPageContext(action) {
  return isPageBoundAction(action) && !getActionTargetTabId(action);
}

function findAccessibleTabById(tabId) {
  if (!Number.isInteger(tabId)) {
    return null;
  }

  return Object.values(state.accessibleTabs || {}).find((tab) => tab.tabId === tabId) || null;
}

function compactObservationForProvider(observation, context = {}, mode = "standard") {
  if (!observation) return null;

  const visibleText = String(observation.visible_text || "");
  const compactMode = mode === "compact";
  const useFullDump = !compactMode && shouldUseFullObservationDump(observation);
  const visibleTextExcerpt = useFullDump
    ? {
        text: visibleText,
        truncated: false,
        strategy: "full_dump_small_page"
      }
    : buildSegmentAwareVisibleTextExcerpt(observation, context);
  const elementLimit = useFullDump
    ? Number.MAX_SAFE_INTEGER
    : (compactMode ? PROVIDER_COMPACT_ELEMENT_LIMIT : PROVIDER_ELEMENT_LIMIT);
  const formLimit = useFullDump
    ? Number.MAX_SAFE_INTEGER
    : (compactMode ? PROVIDER_COMPACT_FORM_LIMIT : PROVIDER_FORM_LIMIT);
  const counts = {
    headings: observation.headings?.length || 0,
    links: observation.links?.length || 0,
    buttons: observation.buttons?.length || 0,
    forms: observation.forms?.length || 0,
    interactive_elements: observation.interactive_elements?.length || 0,
    structured_items: observation.structured_items?.length || 0,
    content_blocks: observation.content_blocks?.length || 0
  };
  const pageOutline = compactPageOutlineForProvider(
    observation.page_outline,
    useFullDump ? Number.MAX_SAFE_INTEGER : (compactMode ? 5 : PROVIDER_SECTION_LIMIT)
  );
  const structuredItems = compactStructuredItemsForProvider(
    observation.structured_items,
    context,
    useFullDump
      ? Number.MAX_SAFE_INTEGER
      : (compactMode ? PROVIDER_COMPACT_STRUCTURED_ITEM_LIMIT : PROVIDER_STRUCTURED_ITEM_LIMIT),
    { mode }
  );
  const focusedContext = buildFocusedContextForProvider(observation, context, useFullDump ? "full" : "compact");
  const contentBlocks = compactContentBlocksForProvider(
    observation.content_blocks,
    context,
    useFullDump ? Number.MAX_SAFE_INTEGER : (compactMode ? PROVIDER_COMPACT_CONTENT_BLOCK_LIMIT : 16)
  );

  return {
    type: observation.type || "page_observation",
    tab: compactTabForProvider(observation.tab || {}),
    viewport: observation.viewport || null,
    capturedAt: observation.capturedAt || "",
    visible_text: compactMode
      ? String(visibleTextExcerpt.text || "").slice(0, PROVIDER_COMPACT_VISIBLE_TEXT_LIMIT)
      : visibleTextExcerpt.text,
    visibleTextLength: visibleText.length,
    visibleTextTruncated: visibleTextExcerpt.truncated,
    visibleTextExcerptStrategy: visibleTextExcerpt.strategy,
    headings: compactElementsForProvider(observation.headings, compactMode ? Math.min(6, elementLimit) : elementLimit, { mode }),
    links: compactElementsForProvider(observation.links, elementLimit, { mode }),
    buttons: compactElementsForProvider(observation.buttons, compactMode ? Math.min(6, elementLimit) : elementLimit, { mode }),
    forms: compactFormsForProvider(observation.forms, formLimit, { mode }),
    interactive_elements: compactElementsForProvider(observation.interactive_elements, elementLimit, { mode }),
    counts,
    page_outline: pageOutline,
    structured_items: structuredItems,
    focused_context: focusedContext,
    content_blocks: contentBlocks,
    note: useFullDump
      ? "Observation kept in full because the page is small enough for the local model context."
      : compactMode
        ? "Observation compacted aggressively for provider retry/context-window safety."
      : "Observation compacted with page outline, structured items, and focused context."
  };
}

function shouldUseFullObservationDump(observation) {
  const visibleTextLength = String(observation?.visible_text || "").length;
  const totalElements = (observation?.headings?.length || 0)
    + (observation?.links?.length || 0)
    + (observation?.buttons?.length || 0)
    + (observation?.forms?.length || 0);

  return visibleTextLength <= PROVIDER_FULL_OBSERVATION_TEXT_LIMIT
    && totalElements <= PROVIDER_FULL_OBSERVATION_ELEMENT_TOTAL_LIMIT;
}

function buildSegmentAwareVisibleTextExcerpt(observation, context = {}) {
  const visibleText = String(observation?.visible_text || "");
  const focusedBlocks = buildFocusedContextForProvider(observation, context, "full");
  if (!visibleText) {
    return {
      text: "",
      truncated: false,
      strategy: "empty"
    };
  }

  if (!focusedBlocks.length) {
    return smartExcerptForProvider(visibleText, PROVIDER_VISIBLE_TEXT_LIMIT);
  }

  const snippets = focusedBlocks
    .map((block) => {
      const title = String(block.title || block.section_title || "").trim();
      const body = String(block.text || "").trim();
      const destination = String(block.destination_url || "").trim();
      return [title, body, destination].filter(Boolean).join("\n");
    })
    .filter(Boolean);

  const stitched = snippets.join("\n\n").slice(0, PROVIDER_VISIBLE_TEXT_LIMIT);
  if (!stitched) {
    return smartExcerptForProvider(visibleText, PROVIDER_VISIBLE_TEXT_LIMIT);
  }

  return {
    text: stitched,
    truncated: stitched.length < visibleText.length,
    strategy: "focused_blocks"
  };
}

function compactPageOutlineForProvider(pageOutline = null, limit = PROVIDER_SECTION_LIMIT) {
  if (!pageOutline) {
    return null;
  }

  return {
    page_type: pageOutline.page_type || "general",
    repeated_item_summary: String(pageOutline.repeated_item_summary || "").slice(0, 300),
    counts: pageOutline.counts || null,
    sections: (Array.isArray(pageOutline.sections) ? pageOutline.sections : [])
      .slice(0, limit)
      .map((section) => ({
        section_id: section.section_id || "",
        title: section.title || "",
        preview: String(section.preview || "").slice(0, 220),
        item_count: Number(section.item_count || 0),
        level: section.level || ""
      }))
  };
}

function compactStructuredItemsForProvider(items = [], context = {}, limit = PROVIDER_STRUCTURED_ITEM_LIMIT, options = {}) {
  const compactMode = options.mode === "compact";
  const ranked = rankStructuredItems(items, context).slice(0, limit);
  return ranked.map((item) => ({
    item_id: item.item_id || "",
    agent_id: item.agent_id || "",
    role: item.role || "",
    title: String(item.title || "").slice(0, compactMode ? 140 : 220),
    label: String(item.label || "").slice(0, compactMode ? 140 : 220),
    metadata: String(item.metadata || "").slice(0, compactMode ? 160 : 260),
    text_preview: String(item.text_preview || "").slice(0, compactMode ? 180 : 320),
    destination_url: item.destination_url || item.href || "",
    link_candidates: Array.isArray(item.link_candidates)
      ? item.link_candidates.slice(0, compactMode ? 2 : 6).map((candidate) => ({
          href: candidate.href || "",
          text: String(candidate.text || "").slice(0, compactMode ? 100 : 180),
          aria_label: String(candidate.aria_label || "").slice(0, compactMode ? 80 : 120),
          title: String(candidate.title || "").slice(0, compactMode ? 80 : 120)
        }))
      : [],
    href: item.href || "",
    section_id: item.section_id || "",
    section_title: item.section_title || "",
    selector_candidates: compactMode
      ? []
      : (Array.isArray(item.selector_candidates) ? item.selector_candidates.slice(0, PROVIDER_SELECTOR_LIMIT) : []),
    source_agent_ids: Array.isArray(item.source_agent_ids) ? item.source_agent_ids.slice(0, 4) : []
  }));
}

function compactContentBlocksForProvider(blocks = [], context = {}, limit = 16) {
  const ranked = rankContentBlocks(blocks, context).slice(0, limit);
  return ranked.map((block) => ({
    block_id: block.block_id || "",
    kind: block.kind || "section",
    section_id: block.section_id || "",
    section_title: block.section_title || "",
    item_id: block.item_id || "",
    title: String(block.title || "").slice(0, 200),
    text: String(block.text || "").slice(0, 320),
    destination_url: block.destination_url || ""
  }));
}

function buildFocusedContextForProvider(observation, context = {}, mode = "full") {
  const blocks = buildRetrievalBlocks(observation);
  if (!blocks.length) {
    return [];
  }

  const ranked = rankContentBlocks(blocks, context).map((block, index) => ({
    ...block,
    __rank_index: index
  }));
  const limit = mode === "compact" ? PROVIDER_FOCUSED_CONTEXT_COMPACT_LIMIT : PROVIDER_FOCUSED_CONTEXT_LIMIT;
  const textBudget = mode === "compact" ? PROVIDER_FOCUSED_CONTEXT_TEXT_COMPACT_LIMIT : PROVIDER_FOCUSED_CONTEXT_TEXT_LIMIT;
  const selected = [];
  let used = 0;

  for (const block of ranked) {
    const text = String(block.text || "").trim();
    if (!text) {
      continue;
    }
    if (used >= textBudget || selected.length >= limit) {
      break;
    }

    const slice = text.slice(0, Math.max(120, textBudget - used));
    selected.push({
      block_id: block.block_id || "",
      kind: block.kind || "section",
      section_id: block.section_id || "",
      section_title: block.section_title || "",
      item_id: block.item_id || "",
      title: String(block.title || "").slice(0, 200),
      text: slice,
      destination_url: block.destination_url || "",
      bbox: block.bbox || null,
      __rank_index: block.__rank_index || 0
    });
    used += slice.length;
  }

  return orderFocusedContextForPresentation(selected, context).map((block) => ({
    block_id: block.block_id || "",
    kind: block.kind || "section",
    section_id: block.section_id || "",
    section_title: block.section_title || "",
    item_id: block.item_id || "",
    title: String(block.title || "").slice(0, 200),
    text: String(block.text || ""),
    destination_url: block.destination_url || ""
  }));
}

function buildRetrievalBlocks(observation) {
  const blocks = [];
  for (const block of Array.isArray(observation?.content_blocks) ? observation.content_blocks : []) {
    blocks.push(block);
  }
  for (const element of Array.isArray(observation?.interactive_elements) ? observation.interactive_elements : []) {
    if (!element || !["button", "combobox", "searchbox", "textbox", "link"].includes(element.role)) {
      continue;
    }
    blocks.push({
      block_id: `interactive_block_${element.agent_id || blocks.length + 1}`,
      kind: "interactive",
      section_id: element.nearest_heading?.agent_id ? `section_${element.nearest_heading.agent_id}` : "section_root",
      section_title: element.nearest_heading?.name || observation.tab?.title || "Current page",
      item_id: element.agent_id || "",
      title: element.name || element.text || element.agent_id || "",
      text: [
        element.name || "",
        element.text || "",
        element.nearby_text || "",
        element.popup_role ? `popup_role=${element.popup_role}` : "",
        Array.isArray(element.controlled_region?.titles) ? element.controlled_region.titles.join(" | ") : "",
        Array.isArray(element.link_candidates)
          ? element.link_candidates.map((candidate) => candidate.text || candidate.aria_label || candidate.title || "").filter(Boolean).join(" | ")
          : ""
      ].filter(Boolean).join(" | "),
      destination_url: element.destination_url || element.href || "",
      bbox: element.bbox || null
    });
  }
  for (const item of Array.isArray(observation?.structured_items) ? observation.structured_items : []) {
    blocks.push({
      block_id: `item_block_${item.item_id || item.agent_id || blocks.length + 1}`,
      kind: "item",
      section_id: item.section_id || "",
      section_title: item.section_title || "",
      item_id: item.item_id || "",
      title: item.title || item.label || "",
      text: [item.title, item.metadata, item.text_preview].filter(Boolean).join(" | "),
      destination_url: item.destination_url || item.href || "",
      bbox: item.bbox || null
    });
  }
  if (!blocks.length && observation?.visible_text) {
    blocks.push({
      block_id: "root_visible_text",
      kind: "section",
      section_id: "section_root",
      section_title: observation.tab?.title || "Current page",
      title: observation.tab?.title || "Current page",
      text: String(observation.visible_text || "").slice(0, 500)
    });
  }
  return blocks;
}

function orderFocusedContextForPresentation(blocks = [], context = {}) {
  const items = [...(Array.isArray(blocks) ? blocks : [])];
  if (!isFilterIntentContext(context)) {
    return items;
  }

  return items.sort((a, b) => {
    const aControl = isControlLikeBlock(a);
    const bControl = isControlLikeBlock(b);
    if (aControl !== bControl) {
      return aControl ? -1 : 1;
    }

    if (aControl && bControl) {
      const visual = compareBlocksByVisualOrder(a, b);
      if (visual !== 0) {
        return visual;
      }
    }

    return (a.__rank_index || 0) - (b.__rank_index || 0);
  });
}

function isFilterIntentContext(context = {}) {
  const goal = String(context.goal || "").toLowerCase();
  return /\b(filter|filters|search|form|dropdown|drop-down|menu|menus|location|remote|country|region|city|role type|skill set|other filters|areas)\b/i.test(goal);
}

function isControlLikeBlock(block = {}) {
  return ["form", "field", "interactive"].includes(block.kind);
}

function compareBlocksByVisualOrder(a = {}, b = {}) {
  const boxA = a.bbox || null;
  const boxB = b.bbox || null;
  if (!boxA && !boxB) {
    return 0;
  }
  if (!boxA) {
    return 1;
  }
  if (!boxB) {
    return -1;
  }

  const yDiff = Number(boxA.y || 0) - Number(boxB.y || 0);
  if (Math.abs(yDiff) > 24) {
    return yDiff;
  }

  const xDiff = Number(boxA.x || 0) - Number(boxB.x || 0);
  if (Math.abs(xDiff) > 12) {
    return xDiff;
  }

  return (Number(boxA.h || 0) - Number(boxB.h || 0));
}

function rankStructuredItems(items = [], context = {}) {
  return [...(Array.isArray(items) ? items : [])]
    .map((item) => ({
      ...item,
      __score: scoreContextText([
        item.title,
        item.label,
        item.metadata,
        item.text_preview,
        item.section_title
      ].filter(Boolean).join(" "), context) + (item.destination_url ? 2 : 0)
    }))
    .sort((a, b) => b.__score - a.__score || String(a.title || "").localeCompare(String(b.title || "")));
}

function rankContentBlocks(blocks = [], context = {}) {
  return [...(Array.isArray(blocks) ? blocks : [])]
    .map((block) => ({
      ...block,
      __score: scoreContextText([
        block.title,
        block.text,
        block.section_title
      ].filter(Boolean).join(" "), context)
        + (block.kind === "item" ? 1 : 0)
        + getListingPenalty(block, context)
        + getFilterIntentBlockBoost(block, context)
    }))
    .sort((a, b) => b.__score - a.__score || String(a.title || "").localeCompare(String(b.title || "")));
}

function getFilterIntentBlockBoost(block = {}, context = {}) {
  const goal = String(context.goal || "").toLowerCase();
  if (!/\b(filter|filters|search|form|dropdown|drop-down|menu|menus|location|remote|country|region|city|role type|skill set|other filters|areas)\b/i.test(goal)) {
    return 0;
  }

  if (block.kind === "form") {
    return 24;
  }

  if (block.kind === "field") {
    return 22;
  }

  if (block.kind === "interactive") {
    return 18;
  }

  return 0;
}

function getListingPenalty(block = {}, context = {}) {
  const goal = String(context.goal || "").toLowerCase();
  if (!/\b(filter|filters|dropdown|drop-down|menu|menus|location|remote|country|region|role type)\b/i.test(goal)) {
    return 0;
  }

  return block.kind === "item" ? -6 : 0;
}

function scoreContextText(text, context = {}) {
  const haystack = normalizeTextBlock(text || "");
  if (!haystack) {
    return 0;
  }

  const queryTerms = deriveObservationQueryTerms(context);
  let score = 0;
  for (const term of queryTerms) {
    if (haystack.includes(term)) {
      score += term.length >= 10 ? 4 : 2;
    }
  }

  const unresolvedReferences = Array.isArray(context?.recentReferences?.unresolved_references)
    ? context.recentReferences.unresolved_references
    : [];
  if (unresolvedReferences.length) {
    score += 1;
  }

  return score;
}

function deriveObservationQueryTerms(context = {}) {
  const terms = new Set();
  const addTermsFromText = (value) => {
    const normalized = normalizeTextBlock(value || "");
    if (!normalized) {
      return;
    }
    normalized.split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 4)
      .forEach((token) => terms.add(token));
  };

  addTermsFromText(context.goal || "");
  for (const message of Array.isArray(context.conversationContext) ? context.conversationContext : []) {
    addTermsFromText(message.text || "");
  }
  for (const memory of Array.isArray(context.userMemory) ? context.userMemory : []) {
    addTermsFromText(memory.title || "");
    addTermsFromText(String(memory.content || "").slice(0, 240));
  }
  for (const item of Array.isArray(context.recentReferences?.mentioned_items) ? context.recentReferences.mentioned_items : []) {
    addTermsFromText(item.title || "");
    addTermsFromText(item.metadata || "");
  }

  return [...terms].slice(0, 40);
}

function compactTabForProvider(tab) {
  return {
    id: tab.id || null,
    url: tab.url || "",
    title: tab.title || ""
  };
}

function compactElementsForProvider(elements, limit, options = {}) {
  const compactMode = options.mode === "compact";
  return (Array.isArray(elements) ? elements : []).slice(0, limit).map((element) => {
    const base = {
      agent_id: element.agent_id || "",
      role: element.role || "",
      tag: element.tag || "",
      type: element.type || "",
      name: String(element.name || element.text || "").slice(0, compactMode ? 140 : 260),
      text: String(element.text || "").slice(0, compactMode ? 140 : 260),
      nearby_text: String(element.nearby_text || "").slice(0, compactMode ? 120 : 220),
      href: element.href || "",
      destination_url: element.destination_url || "",
      expandable: Boolean(element.expandable),
      expanded: typeof element.expanded === "boolean" ? element.expanded : null,
      popup_role: element.popup_role || "",
      level: element.level || ""
    };

    if (compactMode) {
      return {
        ...base,
        controlled_region: element.controlled_region
          ? {
              role: element.controlled_region.role || "",
              label: String(element.controlled_region.label || "").slice(0, 100),
              hidden: Boolean(element.controlled_region.hidden),
              item_count: Number(element.controlled_region.item_count || 0),
              titles: Array.isArray(element.controlled_region.titles)
                ? element.controlled_region.titles.slice(0, 3).map((title) => String(title || "").slice(0, 80))
                : []
            }
          : null,
        link_candidates: Array.isArray(element.link_candidates)
          ? element.link_candidates.slice(0, 1).map((candidate) => ({
              href: candidate.href || "",
              text: String(candidate.text || "").slice(0, 100)
            }))
          : []
      };
    }

    return {
      ...base,
      controlled_region: element.controlled_region
        ? {
            id: element.controlled_region.id || "",
            role: element.controlled_region.role || "",
            label: String(element.controlled_region.label || "").slice(0, 120),
            hidden: Boolean(element.controlled_region.hidden),
            item_count: Number(element.controlled_region.item_count || 0),
            titles: Array.isArray(element.controlled_region.titles)
              ? element.controlled_region.titles.slice(0, 6).map((title) => String(title || "").slice(0, 120))
              : [],
            actions: Array.isArray(element.controlled_region.actions)
              ? element.controlled_region.actions.slice(0, 8).map((action) => ({
                  role: action.role || "",
                  label: String(action.label || "").slice(0, 120),
                  href: action.href || "",
                  value: String(action.value || "").slice(0, 120)
                }))
              : []
          }
        : null,
      link_candidates: Array.isArray(element.link_candidates)
        ? element.link_candidates.slice(0, 4).map((candidate) => ({
            href: candidate.href || "",
            text: String(candidate.text || "").slice(0, 180),
            aria_label: String(candidate.aria_label || "").slice(0, 120),
            title: String(candidate.title || "").slice(0, 120)
          }))
        : [],
      bbox: element.bbox || null,
      nearest_heading: element.nearest_heading || null,
      selector_candidates: compactSelectorsForProvider(element.selector_candidates)
    };
  });
}

function compactFormsForProvider(forms, limit = PROVIDER_FORM_LIMIT, options = {}) {
  const compactMode = options.mode === "compact";
  return (Array.isArray(forms) ? forms : []).slice(0, limit).map((form) => ({
    agent_id: form.agent_id || "",
    title: String(form.title || "").slice(0, compactMode ? 140 : 260),
    bbox: compactMode ? null : form.bbox || null,
    fields: (Array.isArray(form.fields) ? form.fields : [])
      .slice(0, compactMode ? PROVIDER_COMPACT_FIELD_LIMIT : PROVIDER_FIELD_LIMIT)
      .map((field) => ({
      agent_id: field.agent_id || "",
      role: field.role || "",
      tag: field.tag || "",
      type: field.type || "",
      name: String(field.name || "").slice(0, compactMode ? 120 : 220),
      value: String(field.value || "").slice(0, compactMode ? 80 : 180),
      disabled: Boolean(field.disabled),
      required: Boolean(field.required),
      expanded: typeof field.expanded === "boolean" ? field.expanded : null,
      popup_role: field.popup_role || "",
      nearby_text: String(field.nearby_text || "").slice(0, compactMode ? 100 : 220),
      bbox: compactMode ? null : field.bbox || null,
      selector_candidates: compactMode ? [] : compactSelectorsForProvider(field.selector_candidates),
      options: Array.isArray(field.options) ? field.options.slice(0, compactMode ? 6 : 12) : [],
      controlled_region: field.controlled_region
        ? {
            role: field.controlled_region.role || "",
            label: String(field.controlled_region.label || "").slice(0, compactMode ? 100 : 180),
            hidden: Boolean(field.controlled_region.hidden),
            item_count: field.controlled_region.item_count || 0,
            titles: Array.isArray(field.controlled_region.titles)
              ? field.controlled_region.titles.slice(0, compactMode ? 3 : 8)
              : []
          }
        : null
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
    const resolvedPlan = resolvePlanLinkReferences(result);
    if (resolvedPlan.unresolved.length) {
      addDebugLog("link_ref.unresolved", {
        refs: resolvedPlan.unresolved,
        plan: result
      }, "Agent returned link refs that are not available in the current registry.");
      state.messages.push({
        role: "assistant",
        text: `The model referenced link ${resolvedPlan.unresolved.join(", ")}, but that link reference is no longer available. Retry the request so I can rebuild the current link map.`,
        variant: "error",
        createdAt: Date.now()
      });
      render();
      return;
    }
    result = resolvedPlan.plan;
    rememberTaskMemoryPlannedActions(result);
    const hasPageBoundActions = (result.actions || []).some(isPageBoundAction);
    const planContext = hasPageBoundActions ? (createPlanPageContext(result) || options.planContext || null) : null;
    const policyResponse = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.VALIDATE_ACTION_PLAN, { plan: result }));
    addDebugLog("policy.validation", {
      plan: result,
      ok: policyResponse.ok,
      policy: policyResponse.envelope?.payload || null,
      error: policyResponse.error || ""
    }, policyResponse.ok ? "Policy validated" : policyResponse.error);
    state.confirmationText = "";
    state.pendingPermissionRequest = null;
    const policy = policyResponse.envelope.payload;
    const silentReadOnlyAutoPlan = policy.allowed && !policy.requiresConfirmation && isReadOnlyContextPlan(result);

    if (!silentReadOnlyAutoPlan) {
      state.messages.push({
        role: "assistant",
        text: result.summary_for_user,
        thinking: getAgentDisplayThinking(result),
        createdAt: Date.now()
      });
    }
    queueSelectedProviderUsageRefresh();

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
    state.pendingActionSelection = (Array.isArray(result.actions) ? result.actions : []).map(() => true);
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
    rememberTaskMemoryFinding(result.question, "ask_user");
    state.messages.push({ role: "assistant", text: result.question, thinking: getAgentDisplayThinking(result), createdAt: Date.now() });
    queueSelectedProviderUsageRefresh();
    render();
    return;
  }

  if (result?.type === "stop_for_human") {
    rememberTaskMemoryFinding(result.reason, "stop_for_human");
    state.messages.push({ role: "assistant", text: result.reason, thinking: getAgentDisplayThinking(result), createdAt: Date.now() });
    state.activity.unshift("Automation stopped for human action.");
    queueSelectedProviderUsageRefresh();
    render();
    return;
  }

  if (result?.type === "memory_proposal") {
    queueSelectedProviderUsageRefresh();
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
    logProviderError("provider.error", result, `${provider?.label || "Selected provider"} error`);
    state.messages.push({
      role: "assistant",
      text: formatProviderAgentErrorMessage(result),
      thinking: getAgentDisplayThinking(result),
      variant: "error",
      createdAt: Date.now()
    });
    state.activity.unshift(`${provider?.label || "Selected provider"} was unavailable.`);
    if (isProviderQuotaExhaustedResult(result)) {
      markSelectedProviderQuotaExhausted(result);
      queueConnectorRefresh();
    } else {
      queueSelectedProviderUsageRefresh();
    }
    render();
    return;
  }

  const responseText = getAgentDisplayText(result) || "I could not produce a safe browser action from that request yet.";
  const plannerDraft = extractPlannerDraftFromText(responseText);
  const memoryProposal = await maybeSaveDeferredMemory(responseText);
  rememberTaskMemoryFinding(plannerDraft?.summaryForUser || responseText, "assistant_response");
  state.messages.push({
    role: "assistant",
    text: plannerDraft
      ? (plannerDraft.summaryForUser || "The provider returned a planner draft, but it was not valid enough to execute.")
      : (memoryProposal ? appendMemorySavedNote(responseText) : responseText),
    ...(plannerDraft ? { plannerDraft } : {}),
    thinking: getAgentDisplayThinking(result),
    createdAt: Date.now()
  });
  if (memoryProposal) {
    queueSelectedProviderUsageRefresh();
    proposeMemorySave(memoryProposal.item, memoryProposal.responseLanguage, memoryProposal.goal);
    return;
  }
  queueSelectedProviderUsageRefresh();
  if (getSelectedProviderStatus()?.quotaState === "exhausted") {
    queueConnectorRefresh();
  }
  render();
}

function normalizeAgentControlFlow(result) {
  const embeddedStructured = extractStructuredPayloadFromAgentResult(result);
  if (embeddedStructured) {
    result = embeddedStructured;
  }

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

function extractStructuredPayloadFromAgentResult(result) {
  if (!result || typeof result !== "object") {
    return null;
  }

  const nestedText = compact(
    result?.text
    || result?.answer
    || result?.response
    || result?.message
    || result?.result
    || result?.output
    || ""
  );
  const structured = extractStructuredAgentPayloadFromText(nestedText);
  if (!structured) {
    return null;
  }

  addDebugLog("agent.embedded_payload_unwrapped", {
    wrapper: result,
    embedded: structured
  }, "Unwrapped structured Browser Companion payload from provider text.");
  return normalizeEmbeddedAgentPayload(structured, result);
}

function extractPlannerDraftFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const structuredDraft = extractStructuredPlannerDraftFromText(raw);
  if (structuredDraft) {
    return structuredDraft;
  }

  return extractConversationalPlannerDraftFromText(raw);
}

function extractStructuredPlannerDraftFromText(raw) {
  if (!/"agent_plan"|"summary_for_user"|"actions"/.test(raw)) {
    return null;
  }

  const summaryForUser = decodePlannerDraftString(extractPlannerDraftField(raw, "summary_for_user"));
  const title = decodePlannerDraftString(extractPlannerDraftField(raw, "title"));
  const actionMatches = [...raw.matchAll(/"id"\s*:\s*"([^"]+)"/g)];
  const actionTypeMatches = [...raw.matchAll(/"type"\s*:\s*"([^"]+)"/g)];
  if (!summaryForUser && !actionMatches.length && !actionTypeMatches.length) {
    return null;
  }

  const actionCount = Math.max(actionMatches.length, actionTypeMatches.filter((match) => match[1] !== "agent_plan").length);
  const actionSummaries = [];
  for (let index = 0; index < Math.max(actionMatches.length, actionTypeMatches.length); index += 1) {
    const id = actionMatches[index]?.[1] || "";
    const type = actionTypeMatches[index]?.[1] || "";
    const label = [id, type].filter(Boolean).join(" · ");
    if (label) {
      actionSummaries.push(label);
    }
  }

  return {
    title: title || "Planner Draft",
    summaryForUser,
    actionCount,
    actionSummaries: actionSummaries.slice(0, 8),
    detectedWrappedPlan: /"agent_plan"\s*:\s*\{/.test(raw),
    draftKind: "structured_json",
    raw
  };
}

function extractConversationalPlannerDraftFromText(raw) {
  const hasPlanCue = /(?:^|\n)(?:#{1,6}\s*)?plan\b|proposed plan|strategy summary|implementation steps|phase 1|phase 2|phase 3|does this approach work\?|if so, i will proceed|if this approach works|se sei d'accordo|se questo approccio/i.test(raw);
  const numberedSteps = [...raw.matchAll(/^\s*\d+\.\s+(.+)$/gm)].map((match) => compact(match[1]));
  const bulletSteps = [...raw.matchAll(/^\s*[-*]\s+(.+)$/gm)].map((match) => compact(match[1]));

  if (!hasPlanCue || (numberedSteps.length + bulletSteps.length) < 3) {
    return null;
  }

  const splitMarker = raw.match(/(?:^|\n)(?:#{1,6}\s*)?(?:proposed plan|plan)\b[:\s-]*/i);
  const summarySource = splitMarker && splitMarker.index > 0
    ? raw.slice(0, splitMarker.index).trim()
    : raw;
  const summaryForUser = compact(
    summarySource
      .replace(/(?:does this approach work\?|if so, i will proceed\.?|if this approach works.*|se sei d'accordo.*|se questo approccio.*)$/i, "")
      .replace(/^companion\s*/i, "")
  );
  const titleMatch = raw.match(/(?:^|\n)#{1,6}\s*plan\b[:\s-]*(.+)?$/im)
    || raw.match(/(?:^|\n)(?:proposed plan|strategy summary)[:\s-]*(.+)?$/im);
  const askMatch = raw.match(/(does this approach work\?|if this approach works.*|if so, i will proceed\.?|se sei d'accordo.*|ti va bene.*)$/i);
  const stepLines = [...numberedSteps, ...bulletSteps]
    .map((item) => item.replace(/\s{2,}/g, " ").trim())
    .filter(Boolean);

  return {
    title: compact(titleMatch?.[1] || "") || "Planner Draft",
    summaryForUser,
    actionCount: stepLines.length,
    actionSummaries: stepLines.slice(0, 8),
    detectedWrappedPlan: false,
    draftKind: "conversational_plan",
    question: compact(askMatch?.[1] || ""),
    raw
  };
}

function extractPlannerDraftField(text, key) {
  const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"])*)"`, "i");
  const match = String(text || "").match(pattern);
  return match?.[1] || "";
}

function decodePlannerDraftString(value) {
  const raw = String(value || "");
  if (!raw) {
    return "";
  }

  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`);
  } catch {
    return raw
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function normalizeEmbeddedAgentPayload(structured, wrapper = {}) {
  const type = ["natural_response", "ask_user", "stop_for_human", "memory_proposal", "agent_plan"].includes(structured?.type)
    ? structured.type
    : (Array.isArray(structured?.actions) && structured.actions.length ? "agent_plan" : "natural_response");

  return {
    type,
    text: String(structured?.text || wrapper?.text || wrapper?.answer || wrapper?.response || ""),
    question: String(structured?.question || wrapper?.question || ""),
    reason: String(structured?.reason || wrapper?.reason || ""),
    goal: String(structured?.goal || wrapper?.goal || ""),
    risk_level: ["low", "medium", "high", "sensitive", "blocked"].includes(structured?.risk_level) ? structured.risk_level : "low",
    summary_for_user: String(structured?.summary_for_user || structured?.summary || wrapper?.summary_for_user || structured?.text || ""),
    needs_clarification: Boolean(structured?.needs_clarification),
    requires_confirmation: Boolean(structured?.requires_confirmation),
    will_submit: Boolean(structured?.will_submit),
    actions: Array.isArray(structured?.actions) ? structured.actions : [],
    uncertain_fields: Array.isArray(structured?.uncertain_fields) ? structured.uncertain_fields : [],
    ...(structured?.memory_title ? { memory_title: String(structured.memory_title) } : {}),
    ...(structured?.memory_content ? { memory_content: String(structured.memory_content) } : {})
  };
}

function isProviderTimeoutResult(result) {
  const text = `${result?.message || ""} ${result?.error || ""}`;
  return result?.type === "agent_error" && (/\b(?:408|524)\b/.test(text) || /request timeout|timeout occurred|timed out|aborted due to timeout|etimedout|inactivity timeout/i.test(text));
}

function isProviderContextLimitResult(result) {
  const text = `${result?.message || ""} ${result?.error || ""} ${result?.text || ""}`;
  return result?.type === "agent_error"
    && /exceeds the available context size|exceed_context_size_error|context window|supplied context/i.test(text);
}

function isProviderErrorLikeResult(result) {
  const text = `${result?.message || ""} ${result?.error || ""} ${result?.text || ""}`;
  return /\b(?:408|524)\b/.test(text)
    || /request timeout|timeout occurred|timed out|aborted due to timeout|etimedout|inactivity timeout/i.test(text)
    || /stream stalled|terminated/i.test(text)
    || /exceeds the available context size|exceed_context_size_error|context window|supplied context/i.test(text)
    || /upstream error page/i.test(text)
    || /HTTP provider returned \d+/i.test(text)
    || /<!doctype html>|<html\b|cloudflare/i.test(text);
}

function isProviderQuotaExhaustedResult(result) {
  const text = `${result?.message || ""} ${result?.error || ""} ${result?.text || ""}`;
  return /\blimit reached\b/i.test(text)
    || /insufficient[_\s-]?quota/i.test(text)
    || /\bout of credits?\b/i.test(text)
    || /\bbilling hard limit\b/i.test(text)
    || /\bresource has been exhausted\b/i.test(text)
    || /\byou have exhausted your capacity on this model\b/i.test(text)
    || /\bout of capacity\b/i.test(text)
    || /\brate-limited\b/i.test(text)
    || /\bquota reset\b/i.test(text)
    || /\bquota exceeded\b/i.test(text);
}

function markSelectedProviderQuotaExhausted(result) {
  const providerId = state.codex.provider;
  const nextProviders = state.connector.providers.map((provider) => {
    if (provider.id !== providerId) {
      return provider;
    }

    const label = provider.label || "Provider";
    const quotaMessage = formatProviderQuotaExhaustedMessage(result, label);
    return {
      ...provider,
      quotaState: "exhausted",
      quotaMessage,
      message: quotaMessage
    };
  });

  state.connector.providers = nextProviders;
  state.connector.status = "quota_exhausted";
  state.connector.message = formatProviderQuotaExhaustedMessage(result, getSelectedProviderStatus()?.label || "Provider");
}

function formatProviderQuotaExhaustedMessage(result, label = "Provider") {
  const text = `${result?.message || ""} ${result?.error || ""} ${result?.text || ""}`;
  if (/insufficient[_\s-]?quota|billing hard limit|out of credits?/i.test(text)) {
    return `${label} has no remaining credits or has reached its billing limit.`;
  }

  return `${label} has reached its current usage limit. Wait for quota reset or switch provider.`;
}

function extractProviderErrorMeta(result) {
  const text = `${result?.message || ""} ${result?.error || ""} ${result?.text || ""}`.trim();
  const statusMatch = text.match(/\bHTTP provider returned (\d{3})\b/i) || text.match(/\b(52[0-9]|50[0-9]|40[0-9])\b/);
  const statusCode = statusMatch ? Number.parseInt(statusMatch[1], 10) : null;
  let kind = "provider_error";

  if (/\b(?:408|524)\b/.test(text) || /request timeout|timeout occurred|timed out|aborted due to timeout|etimedout|inactivity timeout/i.test(text)) {
    kind = "timeout";
  } else if (/stream stalled|terminated/i.test(text)) {
    kind = "stalled";
  } else if (/exceeds the available context size|exceed_context_size_error|context window|supplied context/i.test(text)) {
    kind = "context_limit";
  } else if (/<!doctype html>|<html\b|cloudflare/i.test(text)) {
    kind = "upstream_html";
  } else if (/HTTP provider returned \d+/i.test(text)) {
    kind = "http_error";
  }

  return {
    kind,
    statusCode,
    raw: text.slice(0, 1200)
  };
}

function logProviderError(event, result, summary = "") {
  const meta = extractProviderErrorMeta(result);
  addDebugLog(event, {
    ...meta,
    result
  }, summary || buildProviderErrorSummary(meta));
}

function buildProviderErrorSummary(meta = {}) {
  if (meta.kind === "timeout") {
    return meta.statusCode ? `Provider timeout (${meta.statusCode})` : "Provider timeout";
  }
  if (meta.kind === "stalled") {
    return "Provider stream stalled";
  }
  if (meta.kind === "upstream_html") {
    return meta.statusCode ? `Provider upstream HTML error (${meta.statusCode})` : "Provider upstream HTML error";
  }
  if (meta.kind === "context_limit") {
    return "Provider context limit error";
  }
  if (meta.statusCode) {
    return `Provider HTTP error (${meta.statusCode})`;
  }
  return "Provider error";
}

function isUserStoppedResult(result) {
  const text = `${result?.message || ""} ${result?.error || ""}`;
  return result?.type === "agent_error" && /stopped by the user/i.test(text);
}

function formatProviderAgentErrorMessage(result) {
  const raw = String(result?.message || result?.text || "").trim();

  if (/etimedout|inactivity timeout|stopped producing output/i.test(raw)) {
    return "The local CLI provider stopped producing output before it completed the response and hit the inactivity timeout. Try again, reduce the request context, or switch provider.";
  }

  if (/\b(?:408|524)\b/.test(raw) || /request timeout|timeout occurred|timed out|aborted due to timeout/i.test(raw)) {
    return "The HTTP provider timed out before the model completed its response. If this happens often, the model is too slow for this page or the local bridge timeout needs to be increased.";
  }

  if (/stream stalled/i.test(raw) || /^terminated$/i.test(raw)) {
    return "The HTTP provider started streaming thinking, but then stopped making real progress before producing a final answer.";
  }

  if (/exceeds the available context size|exceed_context_size_error|context window|supplied context/i.test(raw)) {
    return "The HTTP provider rejected the request because the supplied context exceeds the model's available context window.";
  }

  if (/HTTP provider returned \d+/i.test(raw) || /<!doctype html>|<html\b|cloudflare/i.test(raw)) {
    return "The HTTP provider returned an upstream error page instead of a usable model response.";
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

  return compactThinkingForDisplay(extractNestedReasoningText(text));
}

function compactThinkingForDisplay(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length <= DISPLAY_THINKING_MAX_CHARS) {
    return raw;
  }

  const headLength = Math.floor(DISPLAY_THINKING_MAX_CHARS * 0.65);
  const tailLength = DISPLAY_THINKING_MAX_CHARS - headLength;
  return [
    raw.slice(0, headLength).trimEnd(),
    "",
    `[thinking truncated: ${raw.length - DISPLAY_THINKING_MAX_CHARS} characters omitted]`,
    "",
    raw.slice(-tailLength).trimStart()
  ].join("\n");
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
  const plan = getSelectedPendingPlan();

  if (!plan || !Array.isArray(plan.actions) || !plan.actions.length) {
    return;
  }

  const planContext = state.pendingPlanContext;
  const pendingPolicy = getSelectedPendingPolicy();
  if (options.approvalScope === "session") {
    addSessionApprovalForPlan(plan, pendingPolicy, planContext);
  }

  state.pendingPlan = null;
  state.pendingPlanContext = null;
  state.pendingPolicy = null;
  state.pendingActionSelection = [];
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
  const resolvedPlan = resolvePlanLinkReferences(plan);
  if (resolvedPlan.unresolved.length) {
    state.messages.push({
      role: "assistant",
      text: `I could not execute the plan because link reference ${resolvedPlan.unresolved.join(", ")} is no longer available. Retry the request so I can rebuild the current link map.`,
      variant: "error",
      createdAt: Date.now()
    });
    state.activity.unshift("Execution blocked because a link reference could not be resolved.");
    addDebugLog("link_ref.execution_blocked", {
      refs: resolvedPlan.unresolved,
      plan
    }, "Blocked action execution with unresolved link references.");
    render();
    return;
  }
  const normalizedPlan = normalizePlan(resolvedPlan.plan);
  const actions = normalizedPlan?.actions || [];
  const pageMatch = await verifyActionPlanPageContext(actions, options.planContext);

  if (!pageMatch.ok) {
    const recovered = await recoverAndRetryStaleActionPlan(normalizedPlan, pageMatch, options);
    if (recovered) {
      return;
    }

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

  const permission = await ensurePermissionForActionPlan(actions, { planContext: options.planContext });

  if (!permission.ok) {
    if (permission.permissionRequest) {
      state.pendingPermissionRequest = {
        ...permission.permissionRequest,
        plan: normalizedPlan,
        planContext: getLatestPlanContext(options.planContext)
      };
      state.messages.push({
        role: "assistant",
        text: permission.error,
        createdAt: Date.now()
      });
      state.activity.unshift("Waiting for site access before continuing the action plan.");
      render();
      return;
    }

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

  state.pendingPermissionRequest = null;
  state.activity.unshift("Executing browser action plan...");
  addActionNote("Executing browser actions", actions.map(formatActionDetail));
  addDebugLog("action.execute.start", { plan: normalizedPlan }, `${actions.length} action(s).`);
  render();

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.EXECUTE_ACTION_PLAN, {
    plan: normalizedPlan,
    executionContext: getLatestPlanContext(options.planContext)
  }));
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
  rememberRecentActionResults(normalizedPlan, results);
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
      planContext: getLatestPlanContext(options.planContext)
    });
    await handleAgentResult(followUpResult, {
      continuationDepth,
      planContext: getLatestPlanContext(options.planContext)
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
  if (synthesized.error) {
    pushPostActionSynthesisError(synthesized.error);
    await refreshPageAfterAction();
    return;
  }
  if (steeredQueueItem || shouldContinueAfterActionPlan(normalizedPlan, completionResults, synthesized.text, options)) {
    const goal = buildSteeredContinuationGoal(normalizedPlan.goal || getLastUserMessageText() || "", steeredQueueItem);
    const continuationDepth = (options.continuationDepth || 0) + 1;
    const planContext = getLatestPlanContext(options.planContext);
    state.activity.unshift("Continuing with the latest action results.");
    addDebugLog("agent.auto_continue_after_actions", {
      goal,
      continuationDepth,
      actions,
      results: completionResults,
      synthesized: synthesized.text
    }, "Continuing after browser actions because the current context is not sufficient yet.");
    render();
    const followUpResult = await getAgentResult(goal, {
      continuationDepth,
      continuationReason: appendSteeredContinuationReason(
        buildPostActionContinuationReason(normalizedPlan, completionResults, synthesized.text),
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
  const answerText = synthesized.text || getExecutionSummary(completionResults);
  rememberTaskMemoryFinding(answerText, "post_action_answer");
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
  const planContext = getLatestPlanContext(options.planContext);
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
  if (synthesized.error) {
    pushPostActionSynthesisError(synthesized.error);
    return true;
  }
  if (synthesized.text && !isActionOnlyCompletionText(synthesized.text)) {
    rememberTaskMemoryFinding(synthesized.text, "post_action_synthesis");
    const memoryProposal = await maybeSaveResearchMemory(plan, completionResults, synthesized.text);
    state.messages.push({
      role: "assistant",
      text: memoryProposal ? appendMemorySavedNote(synthesized.text) : synthesized.text,
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
    || actions.some((action) => POST_ACTION_OBSERVATION_ACTION_TYPES.has(action?.type))
    || shouldContinueAfterNavigationAction(plan, results);
}

function shouldContinueAfterNavigationAction(plan, results) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const hasSuccessfulNavigation = actions.some((action) => action?.type === "open_url")
    && results.some((result) => result?.status === "success" && result?.page_changed);

  if (!hasSuccessfulNavigation) {
    return false;
  }

  const goalText = [
    plan?.goal || "",
    plan?.summary_for_user || "",
    plan?.text || "",
    actions.map((action) => [
      action?.type || "",
      action?.value || "",
      action?.target?.name || "",
      action?.reason || ""
    ].join(" ")).join(" ")
  ].join(" ");

  const needsMoreThanNavigation = /\b(trova|find|cerca|search|ricerca|offerte|annunci|jobs?|risultati|results?|fonti|sources?|almeno\s+\d+|at least\s+\d+|apri\s+(?:ogni|tutte|tutti)|open\s+(?:each|all)|nuov[ae]\s+schede?|new\s+tabs?)\b/i.test(goalText);
  const openedSearchPage = actions.some((action) => action?.type === "open_url"
    && /(?:\/search\?|[?&]q=|search_results|risultati|\bsearch\b|\bcerca\b)/i.test(`${action?.value || ""} ${action?.target?.name || ""} ${action?.reason || ""}`));

  return needsMoreThanNavigation || openedSearchPage;
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
  const searchResultSummary = buildSearchResultsContinuationSummary(results);
  const navigationNote = (plan?.actions || []).some((action) => action?.type === "open_url")
    ? "A successful open_url can be only an intermediate navigation. If the user's goal requires reading results or opening multiple destinations, use the latest observation or request the next necessary page-read/open-tab action instead of stopping."
    : "";
  const fallbackNote = synthesized
    ? `The intermediate answer was not sufficient yet: "${compact(synthesized).slice(0, 240)}".`
    : "No final answer is available yet from the last action batch.";

  return [
    "A browser action batch has just completed. Use the newest context to either answer directly or choose the next necessary action plan.",
    latestObservation ? `Latest observed page after the actions: ${formatObservationForContinuation(latestObservation)}.` : "",
    actionSummary ? `Recent action results: ${actionSummary}.` : "",
    searchResultSummary,
    navigationNote,
    fallbackNote,
    "If web_search results include URLs, treat those URLs as available evidence and use them directly for http_request or open_url_new_tab actions. Do not repeat the same search only to recover links already listed here.",
    "Do not stop only because the previous action batch finished. If the user's goal still needs more context, return the next best action plan."
  ].filter(Boolean).join("\n");
}

function buildSearchResultsContinuationSummary(results) {
  const searchArtifacts = (Array.isArray(results) ? results : [])
    .map((result) => result?.artifact)
    .filter((artifact) => artifact?.kind === "web_search");

  if (!searchArtifacts.length) {
    return "";
  }

  const lines = [];
  for (const artifact of searchArtifacts.slice(0, 4)) {
    const items = compactWebSearchResultsForProvider(artifact.results, 8);
    if (!items.length) {
      lines.push(`Search "${artifact.query || ""}" returned no listed URLs.`);
      continue;
    }

    lines.push(`Search "${artifact.query || ""}" URLs:`);
    items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title || "Untitled"} - ${item.url}${item.snippet ? ` - ${item.snippet}` : ""}`);
    });
  }

  return lines.join("\n");
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

function getLatestPlanContext(fallbackContext = null) {
  const observed = getObservedPageContext();
  if (observed) {
    return observed;
  }

  if (fallbackContext) {
    return {
      ...fallbackContext,
      windowId: fallbackContext.windowId || state.sidebarContext.windowId || null
    };
  }

  if (state.sidebarContext?.windowId || state.sidebarContext?.tabId) {
    return {
      tabId: state.sidebarContext.tabId || null,
      windowId: state.sidebarContext.windowId || null,
      url: "",
      title: "",
      capturedAt: ""
    };
  }

  return null;
}

function expandAgentGoal(goal) {
  const rawGoal = compact(goal || "");
  if (!isRetryLikeGoal(rawGoal)) {
    return rawGoal;
  }

  const previousMeaningfulUserMessage = [...state.messages]
    .reverse()
    .filter((message) => message.role === "user")
    .map((message) => compact(message.text || ""))
    .find((text) => text && text !== rawGoal && !isRetryLikeGoal(text));

  if (!previousMeaningfulUserMessage) {
    return rawGoal;
  }

  return compact(`Retry the previous user request: ${previousMeaningfulUserMessage}`);
}

function isRetryLikeGoal(text) {
  const value = compact(text || "").toLowerCase();
  if (!value) {
    return false;
  }

  return /^(retry|try again|riprova|again|again please|ripeti|ritenta)\b/.test(value);
}

async function getCurrentActiveTab(options = {}) {
  try {
    const context = options?.context || null;
    if (context?.windowId) {
      const [tab] = await chrome.tabs.query({ active: true, windowId: context.windowId });
      if (tab) {
        return tab;
      }
    }

    if (state.sidebarContext?.windowId) {
      const [tab] = await chrome.tabs.query({ active: true, windowId: state.sidebarContext.windowId });
      if (tab) {
        return tab;
      }
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

async function captureSidebarContext() {
  const tab = await getCurrentActiveTab({ context: null });
  rememberSidebarContextFromTab(tab);
  return tab;
}

function rememberSidebarContextFromTab(tab) {
  const windowId = Number.isInteger(tab?.windowId) ? tab.windowId : Number.parseInt(String(tab?.windowId || ""), 10);
  const tabId = Number.isInteger(tab?.id) ? tab.id : Number.parseInt(String(tab?.id || tab?.tabId || ""), 10);
  state.sidebarContext = {
    windowId: Number.isInteger(windowId) ? windowId : (state.sidebarContext?.windowId ?? null),
    tabId: Number.isInteger(tabId) ? tabId : (state.sidebarContext?.tabId ?? null)
  };
}

async function recoverAndRetryStaleActionPlan(plan, pageMatch, options = {}) {
  if (options.stalePageRecoveryAttempted) {
    return false;
  }

  const goal = buildSteeredContinuationGoal(plan.goal || getLastUserMessageText() || "", options.steeredQueueItem);
  if (!goal) {
    return false;
  }

  state.activity.unshift("Page changed; re-observing the current tab and retrying the request.");
  addDebugLog("action.stale_page_recovery.start", {
    goal,
    expected: options.planContext || null,
    current: pageMatch?.current || null,
    plan
  }, "Action plan page context became stale; attempting automatic recovery.");
  render();

  const recoveredObservation = await observePage({
    reason: "refresh the current page before retrying the request",
    silent: true,
    skipWaitingMessage: true
  });
  const recoveredContext = getLatestPlanContext(tabToPageContext(await getCurrentActiveTab()));

  if (!recoveredObservation || !recoveredContext) {
    addDebugLog("action.stale_page_recovery.failed", {
      goal,
      expected: options.planContext || null,
      current: pageMatch?.current || null,
      recoveredObservation: recoveredObservation ? summarizeObservationForLog(recoveredObservation) : null
    }, "Automatic recovery after stale page context failed.");
    return false;
  }

  addDebugLog("action.stale_page_recovery.observed", {
    goal,
    recoveredContext,
    observation: summarizeObservationForLog(recoveredObservation)
  }, "Recovered the current page observation; requesting a fresh plan.");

  const followUpResult = await getAgentResult(goal, {
    continuationDepth: options.continuationDepth || 0,
    continuationReason: appendSteeredContinuationReason(
      "The previous browser action plan became stale because the page or tab context changed before execution. The current active page has now been re-observed. Re-evaluate the user's request against the latest observed page and continue from there. Do not reuse the stale tab or page assumptions from the previous plan.",
      options.steeredQueueItem
    ),
    planContext: recoveredContext
  });

  addDebugLog("action.stale_page_recovery.end", {
    goal,
    recoveredContext,
    result: followUpResult
  }, "Retried the request after re-observing the page.");

  await handleAgentResult(followUpResult, {
    ...options,
    planContext: recoveredContext,
    stalePageRecoveryAttempted: true
  });
  return true;
}

function createPlanPageContext(plan) {
  const actions = plan?.actions || [];

  if (!actions.some(actionUsesCurrentPageContext)) {
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
    windowId: tab.windowId || state.sidebarContext.windowId || null,
    url: tab.url || state.page.url || "",
    title: tab.title || state.page.title || "",
    capturedAt: state.page.observation?.capturedAt || ""
  };
}

function tabToPageContext(tab) {
  if (!tab?.id && !tab?.url && !tab?.title && !tab?.windowId) {
    return null;
  }

  return {
    tabId: tab?.id || null,
    windowId: tab?.windowId || null,
    url: tab?.url || "",
    title: tab?.title || "",
    capturedAt: new Date().toISOString()
  };
}

async function verifyActionPlanPageContext(actions, expectedContext) {
  if (!actions.some(actionUsesCurrentPageContext) || !expectedContext) {
    return { ok: true };
  }

  const tab = await getCurrentActiveTab({ context: expectedContext });
  const current = {
    tabId: tab?.id || null,
    windowId: tab?.windowId || null,
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
          windowId: tab?.windowId || null,
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
        windowId: tab.windowId || null,
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
    windowId: tab.windowId || previous.windowId || null,
    url: tab.url || previous.url || "",
    title: tab.title || previous.title || "",
    source,
    accessStatus: "observed",
    lastObservedAt: observation.capturedAt || now,
    lastActiveAt: previous.lastActiveAt || "",
    visibleTextLength: String(observation.visible_text || "").length,
    links: Array.isArray(observation.links) ? observation.links.length : 0,
    buttons: Array.isArray(observation.buttons) ? observation.buttons.length : 0,
    lastActionLog: previous.lastActionLog || ""
  };
  rememberTaskMemoryObservation(observation, source);
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
    windowId: tab.windowId || previous.windowId || null,
    url: tab.url || previous.url || "",
    title: tab.title || previous.title || "",
    source: previous.source || "active-tab",
    accessStatus: previous.accessStatus || "unknown",
    lastObservedAt: previous.lastObservedAt || "",
    lastActiveAt: new Date().toISOString(),
    visibleTextLength: previous.visibleTextLength || 0,
    links: previous.links || 0,
    buttons: previous.buttons || 0,
    lastActionLog: previous.lastActionLog || ""
  };
  pruneAccessibleTabs();
}

function rememberActionResultTabs(results) {
  results.forEach((result) => {
    if (result?.artifact?.kind === "tab_opened") {
      rememberOpenedTab(result.artifact, result);
      if (result.artifact.observation) {
        rememberObservedTab(result.artifact.observation, "opened-tab-auto-observe");
      }
      return;
    }

    const observation = result?.artifact?.kind === "page_observation"
      ? result.artifact.observation
      : result?.artifact?.observation;
    rememberObservedTab(observation, "action-artifact");
  });
}

function rememberOpenedTab(artifact, result = null) {
  if (!artifact?.tabId && !artifact?.url) {
    return;
  }

  const id = String(artifact.tabId || normalizeUrlForContext(artifact.url));
  const previous = state.accessibleTabs[id] || {};
  state.accessibleTabs[id] = {
    id,
    tabId: artifact.tabId || previous.tabId || null,
    windowId: artifact.windowId || previous.windowId || null,
    url: artifact.url || previous.url || "",
    title: artifact.title || previous.title || "",
    source: "opened-tab",
    accessStatus: artifact.accessStatus || previous.accessStatus || "known",
    lastObservedAt: artifact.observation?.capturedAt || previous.lastObservedAt || "",
    lastActiveAt: previous.lastActiveAt || new Date().toISOString(),
    visibleTextLength: artifact.observation ? String(artifact.observation.visible_text || "").length : (previous.visibleTextLength || 0),
    links: artifact.observation && Array.isArray(artifact.observation.links) ? artifact.observation.links.length : (previous.links || 0),
    buttons: artifact.observation && Array.isArray(artifact.observation.buttons) ? artifact.observation.buttons.length : (previous.buttons || 0),
    lastActionLog: result?.log_message || previous.lastActionLog || ""
  };
  pruneAccessibleTabs();
}

function rememberRecentActionResults(plan, results) {
  const actionIndex = new Map(
    (Array.isArray(plan?.actions) ? plan.actions : [])
      .filter((action) => action?.id)
      .map((action) => [action.id, action])
  );
  const summarized = (Array.isArray(results) ? results : [])
    .map((result) => summarizeRecentActionResult(result, actionIndex.get(result?.action_id)))
    .filter(Boolean);

  if (!summarized.length) {
    return;
  }

  rememberTaskMemoryActionResults(plan, results);
  state.recentActions = dedupeRecentActions([
    ...summarized,
    ...(Array.isArray(state.recentActions) ? state.recentActions : [])
  ]).slice(0, 24);
}

function summarizeRecentActionResult(result, action = null) {
  if (!result) {
    return null;
  }

  const artifact = summarizeRecentActionArtifact(result.artifact);
  const logMessage = String(result.log_message || "").trim();
  if (!logMessage && !artifact && !result.action_id) {
    return null;
  }

  return {
    action_id: result.action_id || "",
    action_type: action?.type || result.type || "",
    status: result.status || "",
    log_message: logMessage,
    target_verified: Boolean(result.target_verified),
    page_changed: Boolean(result.page_changed),
    createdAt: new Date().toISOString(),
    artifact
  };
}

function summarizeRecentActionArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") {
    return null;
  }

  if (artifact.kind === "tab_opened") {
    return {
      kind: artifact.kind,
      url: artifact.url || "",
      tabId: artifact.tabId || null,
      title: artifact.title || artifact.observation?.tab?.title || "",
      accessStatus: artifact.accessStatus || "",
      observed: Boolean(artifact.observation)
    };
  }

  if (artifact.kind === "page_observation") {
    return {
      kind: artifact.kind,
      url: artifact.observation?.tab?.url || "",
      title: artifact.observation?.tab?.title || ""
    };
  }

  if (artifact.kind === "http_response") {
    return {
      kind: artifact.kind,
      url: artifact.finalUrl || artifact.url || "",
      statusCode: artifact.statusCode || null
    };
  }

  if (artifact.kind === "web_search") {
    return {
      kind: artifact.kind,
      query: artifact.query || "",
      resultCount: Array.isArray(artifact.results) ? artifact.results.length : 0,
      results: compactWebSearchResultsForProvider(artifact.results, 10)
    };
  }

  return {
    kind: artifact.kind || "",
    url: artifact.url || "",
    title: artifact.title || ""
  };
}

function compactWebSearchResultsForProvider(results, limit = 8) {
  return (Array.isArray(results) ? results : [])
    .slice(0, limit)
    .map((result) => ({
      title: compact(result?.title || "").slice(0, 180),
      url: String(result?.url || "").slice(0, 600),
      snippet: compact(result?.snippet || "").slice(0, 280)
    }))
    .filter((result) => result.url || result.title || result.snippet);
}

function dedupeRecentActions(entries) {
  const seen = new Set();
  const output = [];

  for (const entry of entries) {
    const key = JSON.stringify({
      action_id: entry.action_id || "",
      action_type: entry.action_type || "",
      status: entry.status || "",
      log_message: entry.log_message || "",
      artifact: entry.artifact || null
    });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(entry);
  }

  return output;
}

function getRecentAccessibleTabs(currentTabId) {
  return Object.values(state.accessibleTabs || {})
    .sort((a, b) => String(b.lastActiveAt || b.lastObservedAt || "").localeCompare(String(a.lastActiveAt || a.lastObservedAt || "")))
    .slice(0, 8)
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

async function ensurePermissionForActionPlan(actions, options = {}) {
  const permissionRequest = await buildPermissionRequestForActionPlan(actions, options);
  if (!permissionRequest) {
    return { ok: true };
  }

  return {
    ok: false,
    error: permissionRequest.message,
    permissionRequest
  };
}

async function buildPermissionRequestForActionPlan(actions, options = {}) {
  const missingOrigins = new Map();
  const currentPageOriginPattern = await getActionPlanCurrentOriginPattern(actions, options.planContext);
  const requiresCurrentPageAccess = actions.some((action) => needsActiveTabReadPermission(action) && !getActionTargetTabId(action));

  if (requiresCurrentPageAccess) {
    if (!currentPageOriginPattern) {
      return {
        origins: [],
        message: "I need site access before I can continue, but I could not determine the current page origin. Open the target page and click Observe, then retry.",
        summary: "The pending action plan needs access to the current page.",
        details: ["The current page is not a normal http or https tab, or it is no longer available."]
      };
    }

    const hasCurrentPagePermission = await chrome.permissions.contains({
      origins: [currentPageOriginPattern]
    }).catch(() => false);

    if (!hasCurrentPagePermission) {
      missingOrigins.set(currentPageOriginPattern, `Grant access to ${currentPageOriginPattern} so Browser Companion can continue on the current page.`);
    }
  }

  const knownTabReadActions = actions
    .filter((action) => action?.type === "observe_known_tab" || (needsActiveTabReadPermission(action) && getActionTargetTabId(action)));

  for (const action of knownTabReadActions) {
    const tabId = getActionTargetTabId(action);
    if (!Number.isInteger(tabId)) {
      continue;
    }

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const originPattern = getOriginPatternForTab(tab);

    if (!originPattern) {
      return {
        origins: [],
        message: "The target tab cannot be read by Browser Companion. Open a normal http or https page in that tab and retry.",
        summary: "The pending action plan points to a tab that is not readable.",
        details: [`Tab ${tabId} is missing or uses a restricted URL.`]
      };
    }

    const hasPermission = await chrome.permissions.contains({
      origins: [originPattern]
    }).catch(() => false);

    if (!hasPermission) {
      const label = tab?.title || tab?.url || `tab ${tabId}`;
      missingOrigins.set(originPattern, `Grant access to ${originPattern} so Browser Companion can inspect ${label}.`);
    }
  }

  if (!missingOrigins.size) {
    return null;
  }

  const origins = [...missingOrigins.keys()];
  const message = origins.length === 1
    ? `I need site access for ${origins[0]} before I can continue this action. Use the button below and Chrome will show the permission prompt if needed.`
    : "I need site access for the listed sites before I can continue this action. Use the button below and Chrome will show the permission prompt if needed.";

  return {
    origins,
    message,
    summary: "The action plan is ready to continue as soon as the required host permissions are granted.",
    details: [...missingOrigins.values()]
  };
}

async function getActionPlanCurrentOriginPattern(actions, planContext) {
  if (!actions.some((action) => needsActiveTabReadPermission(action) && !getActionTargetTabId(action))) {
    return "";
  }

  const contextUrl = planContext?.url || state.page.observation?.tab?.url || state.page.url || "";
  const contextOriginPattern = getOriginPatternForUrl(contextUrl);
  if (contextOriginPattern) {
    return contextOriginPattern;
  }

  const tab = await getCurrentActiveTab({ context: planContext }).catch(() => null);
  return getOriginPatternForTab(tab);
}

function getOriginPatternForTab(tab) {
  return getOriginPatternForUrl(tab?.url || "");
}

function getOriginPatternForUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || "");
    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }
    return `${url.origin}/*`;
  } catch {
    return "";
  }
}

async function grantPendingPermissionRequest() {
  const pending = state.pendingPermissionRequest;
  if (!pending?.origins?.length) {
    return;
  }

  let granted = false;

  try {
    granted = await chrome.permissions.request({
      origins: pending.origins
    });
  } catch (error) {
    state.messages.push({
      role: "assistant",
      text: error.message || "Chrome could not show the site access prompt from this request.",
      variant: "error",
      createdAt: Date.now()
    });
    state.activity.unshift(`Permission request failed: ${error.message || "Unexpected error."}`);
    render();
    return;
  }

  if (!granted) {
    state.messages.push({
      role: "assistant",
      text: "Site access was not granted, so I paused the pending browser action.",
      createdAt: Date.now()
    });
    state.activity.unshift("Permission request was declined.");
    render();
    return;
  }

  const plan = normalizePlan(pending.plan);
  const planContext = pending.planContext || null;
  state.pendingPermissionRequest = null;
  state.activity.unshift(`Granted site access for ${pending.origins.join(", ")}.`);
  render();
  await executeActionPlan(plan, { planContext });
}

function cancelPendingPermissionRequest() {
  state.pendingPermissionRequest = null;
  state.activity.unshift("Permission request canceled.");
  addActionNote("Canceled permission request", ["The pending browser action will not continue until site access is granted."]);
  persistSession();
  render();
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
  const tab = await getCurrentActiveTab({ context: getLatestPlanContext(state.pendingPlanContext) });

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

function resolvePlanLinkReferences(plan) {
  const normalized = normalizePlan(plan);
  if (!normalized) {
    return {
      plan,
      unresolved: []
    };
  }

  const unresolved = [];
  const actions = normalized.actions.map((action) => {
    const resolved = { ...action };
    const actionRef = normalizeLinkReferenceToken(action?.url_ref || action?.urlRef || action?.value || action?.url || "");

    if (actionRef) {
      const entry = resolveLinkReference(actionRef);
      if (entry?.url) {
        resolved.url_ref = actionRef;
        resolved.value = entry.url;
        if ("url" in resolved) {
          resolved.url = entry.url;
        }
        resolved.source = {
          ...(resolved.source || {}),
          file_id: resolved.source?.file_id || actionRef
        };
      } else if (["open_url", "open_url_new_tab", "http_request"].includes(action?.type)) {
        unresolved.push(actionRef);
      }
    }

    const tabRef = normalizeLinkReferenceToken(action?.tab?.url || "");
    if (tabRef) {
      const tabEntry = resolveLinkReference(tabRef);
      if (tabEntry?.url) {
        resolved.tab = {
          ...resolved.tab,
          url: tabEntry.url
        };
      } else {
        unresolved.push(tabRef);
      }
    }

    return resolved;
  });

  return {
    plan: {
      ...normalized,
      actions
    },
    unresolved: [...new Set(unresolved)]
  };
}

function cancelPendingPlan() {
  state.pendingPlan = null;
  state.pendingPlanContext = null;
  state.pendingPolicy = null;
  state.pendingActionSelection = [];
  state.pendingPermissionRequest = null;
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
  const entries = [];

  for (const policyResult of results) {
    if (!policyResult?.requiresConfirmation) {
      continue;
    }

    const action = actions[policyResult.index];
    if (!isSessionApprovableAction(action, policyResult)) {
      return [];
    }

    const origin = getActionApprovalOrigin(action, planContext);
    if (!origin) {
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

function getActionApprovalOrigin(action, planContext) {
  const targetTabId = getActionTargetTabId(action);
  if (targetTabId) {
    const knownTab = findAccessibleTabById(targetTabId);
    const targetOrigin = getApprovalOrigin(action?.tab?.url || knownTab?.url || "");
    if (targetOrigin) {
      return targetOrigin;
    }
  }

  return getApprovalOrigin(planContext?.url || state.page.observation?.tab?.url || "");
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
  const tabInfo = action?.tab?.tabId
    ? ` [tab ${action.tab.tabId}${action.tab.title ? `: ${action.tab.title}` : ""}]`
    : "";
  const target = action.target?.name ? ` on ${action.target.name}` : "";
  const value = action.value ? ` -> ${action.value}` : "";
  return `${action.type}${tabInfo}${target}${value}${action.reason ? `: ${action.reason}` : ""}`;
}

function addDebugLog(event, data = {}, summary = "") {
  if (event === "provider.progress") {
    updateProviderProgressDebugLog(data, summary);
    persistSession();
    return;
  }

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

function updateProviderProgressDebugLog(data = {}, summary = "") {
  const time = new Date().toISOString();
  const requestId = String(data?.requestId || "");
  const thinkingLength = Number.parseInt(String(data?.thinkingLength || 0), 10) || 0;
  const sample = {
    time,
    thinkingLength
  };
  const existingIndex = state.debugLogs.findIndex((entry) => (
    entry.event === "provider.progress"
    && String(entry.data?.requestId || "") === requestId
  ));

  if (existingIndex >= 0) {
    const [entry] = state.debugLogs.splice(existingIndex, 1);
    const nextUpdates = (Number.parseInt(String(entry.data?.updates || 0), 10) || 0) + 1;
    const nextEntry = {
      ...entry,
      time,
      summary: summary || `Received provider thinking progress (${nextUpdates} updates).`,
      data: {
        requestId,
        updates: nextUpdates,
        firstAt: entry.data?.firstAt || entry.time || time,
        lastAt: time,
        latestThinkingLength: thinkingLength,
        samples: [sample, ...(Array.isArray(entry.data?.samples) ? entry.data.samples : [])].slice(0, 80)
      }
    };
    state.debugLogs.unshift(nextEntry);
    return;
  }

  state.debugLogs.unshift({
    id: crypto.randomUUID(),
    time,
    event: "provider.progress",
    summary: summary || "Received provider thinking progress.",
    data: {
      requestId,
      updates: 1,
      firstAt: time,
      lastAt: time,
      latestThinkingLength: thinkingLength,
      samples: [sample]
    }
  });
  state.debugLogs = state.debugLogs.slice(0, 200);
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
  await navigator.clipboard.writeText(JSON.stringify(getAllDebugLogs(), null, 2));
  state.activity.unshift("Diagnostic logs copied.");
  render();
}

async function clearDebugLogs() {
  state.debugLogs = [];
  state.externalDebugLogs = [];
  state.activity.unshift("Diagnostic logs cleared.");
  await clearExternalDebugLogs();
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

  if (!isSelectedProviderConnected()) {
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
  const response = await requestSelectedProviderSynthesis(payload);
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

function extractStructuredAgentPayloadFromText(text) {
  const parsed = parseLooseJsonObject(text);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const unwrapped = unwrapStructuredAgentPayload(parsed);
  if (!unwrapped) {
    return null;
  }

  return unwrapped;
}

function unwrapStructuredAgentPayload(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  if (looksLikeStructuredAgentPayload(parsed)) {
    return parsed;
  }

  const wrappedKeys = ["agent_plan", "natural_response", "ask_user", "stop_for_human", "memory_proposal"];
  for (const key of wrappedKeys) {
    const nested = parsed[key];
    if (!nested || typeof nested !== "object") {
      continue;
    }
    if (!looksLikeStructuredAgentPayload(nested) && !Array.isArray(nested?.actions)) {
      continue;
    }
    return {
      ...nested,
      type: nested.type || key
    };
  }

  return null;
}

function looksLikeStructuredAgentPayload(parsed) {
  const hasActions = Array.isArray(parsed.actions) && parsed.actions.length > 0;
  const hasControlType = ["agent_plan", "natural_response", "ask_user", "stop_for_human", "memory_proposal"].includes(parsed.type);
  const hasCompanionFields = typeof parsed.summary_for_user === "string"
    || typeof parsed.question === "string"
    || typeof parsed.reason === "string"
    || typeof parsed.goal === "string"
    || typeof parsed.text === "string";

  if (!hasActions && !hasControlType && !hasCompanionFields) {
    return null;
  }

  return true;
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
  const hasResearchArtifact = results.some((result) => ["web_search", "http_response", "page_observation", "screenshot", "numbered_overlay", "tab_opened"].includes(result.artifact?.kind));

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
  "observe_known_tab",
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
  "tab_opened",
  "screenshot",
  "numbered_overlay"
]);

const MAX_READ_ONLY_CONTINUATIONS = 4;
const MAX_ACTION_CONTINUATIONS = 4;
const DISPLAY_THINKING_MAX_CHARS = 2400;

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
  const imperativeNavigation = /\b(open|apri|go to|vai su|naviga a)\b/i.test(goal);
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
  if (imperativeNavigation && explicitUrls.length > 1) {
    return buildOpenUrlsInNewTabsPlan(goal, explicitUrls, responseLanguage);
  }

  const openMatch = imperativeNavigation
    ? goal.match(/\b(?:open|apri|go to|vai su|naviga a)\s+((?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?)/i)
    : null;
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
  const openableCandidates = getOpenableObservationTargets(observation);

  if (requestedNames.length >= 2) {
    const used = new Set();
    const matches = [];

    for (const name of requestedNames) {
      const target = findNamedElement(openableCandidates.filter((item) => !used.has(item.agent_id)), name);
      if (!target?.href) {
        return null;
      }
      used.add(target.agent_id);
      matches.push(target);
    }

    return buildOpenTargetsPlan(goal, matches, responseLanguage, {
      summary: localText(responseLanguage, "openUrlsInNewTabs", matches.length),
      reasonIt: "L'utente ha chiesto di aprire piu' link osservati, quindi li apro in nuove schede.",
      reasonEn: "The user asked to open multiple observed links, so I am opening them in new tabs."
    });
  }

  if (!hasPriorMentionReference(goal)) {
    return null;
  }

  const mentionedTargets = getRecentlyMentionedOpenableTargets(observation);
  if (!mentionedTargets.length) {
    return null;
  }

  return buildOpenTargetsPlan(goal, mentionedTargets, responseLanguage, {
    summary: localText(responseLanguage, "openUrlsInNewTabs", mentionedTargets.length),
    reasonIt: "Apro in nuove schede gli elementi che avevo menzionato in precedenza e per cui ho una destinazione osservata affidabile.",
    reasonEn: "Open in new tabs the items previously mentioned that have a reliable observed destination."
  });
}

function getOpenableObservationTargets(observation) {
  const structuredItems = (observation?.structured_items || [])
    .filter((item) => item.agent_id && (item.destination_url || chooseBestObservedLinkCandidate(item.link_candidates)))
    .map((item) => ({
      agent_id: item.agent_id,
      role: item.role || "button",
      name: item.title || item.label || "",
      href: item.destination_url || chooseBestObservedLinkCandidate(item.link_candidates),
      selector_candidates: item.selector_candidates || []
    }));
  const links = (observation?.links || [])
    .filter((item) => item.agent_id && item.name && (item.destination_url || item.href || chooseBestObservedLinkCandidate(item.link_candidates)))
    .map((item) => ({
      ...item,
      href: item.destination_url || item.href || chooseBestObservedLinkCandidate(item.link_candidates)
    }));

  const merged = [];
  const used = new Set();
  for (const target of [...structuredItems, ...links]) {
    const key = `${target.agent_id}|${target.href}`;
    if (!target.href || used.has(key)) {
      continue;
    }
    used.add(key);
    merged.push(target);
  }
  return merged;
}

function chooseBestObservedLinkCandidate(candidates) {
  const items = Array.isArray(candidates) ? candidates : [];
  const ctaPattern = /\b(view|details|detail|opportunity|apply|application|job|role|learn more|open|read more|view opportunity details|vedi|dettagli|offerta|candid|apri|scopri)\b/i;
  const weakPattern = /\b(share|copy|bookmark|save|feedback|expand|collapse|menu|organization|profile|open roles|largest funder)\b/i;

  return items
    .map((candidate) => {
      const text = [candidate.text, candidate.aria_label, candidate.title].filter(Boolean).join(" ").trim();
      let score = 0;
      if (ctaPattern.test(text)) score += 8;
      if (weakPattern.test(text)) score -= 4;
      if (!text) score += 1;
      return {
        href: candidate.href || "",
        score,
        textLength: text.length
      };
    })
    .filter((candidate) => candidate.href)
    .sort((a, b) => b.score - a.score || b.textLength - a.textLength)
    .map((candidate) => candidate.href)[0] || "";
}

function getRecentlyMentionedOpenableTargets(observation) {
  const assistantMessages = [...state.messages]
    .filter((message) => message.role === "assistant" && String(message.text || "").trim())
    .slice(-PROVIDER_CONVERSATION_CONTEXT_LIMIT);
  const candidates = getOpenableObservationTargets(observation);
  const matches = [];
  const used = new Set();

  for (const candidate of candidates) {
    const normalizedName = normalizeElementName(candidate.name);
    if (!normalizedName) {
      continue;
    }
    const mentioned = assistantMessages.some((message) => normalizeElementName(message.text || "").includes(normalizedName));
    if (!mentioned) {
      continue;
    }
    const key = `${candidate.agent_id}|${candidate.href}`;
    if (used.has(key)) {
      continue;
    }
    used.add(key);
    matches.push(candidate);
  }

  return matches.slice(0, 6);
}

function hasPriorMentionReference(goal) {
  return /\b(those|them|ones|mentioned|earlier|previous|recommend(ed)?|those jobs|those offers|quelle|quelli|quelle offerte|hai menzionato|prima|consigliat[eo]|raccomandat[eo]|second[oa]?|terz[oa]?|quart[oa]?)\b/i.test(String(goal || ""));
}

function buildOpenTargetsPlan(goal, matches, responseLanguage, copy = {}) {
  return {
    type: "agent_plan",
    goal,
    risk_level: "low",
    summary_for_user: copy.summary || localText(responseLanguage, "openUrlsInNewTabs", matches.length),
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
        ? (copy.reasonIt || "L'utente ha chiesto di aprire piu' link osservati, quindi li apro in nuove schede.")
        : (copy.reasonEn || "The user asked to open multiple observed links, so I am opening them in new tabs.")
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
  const linkCandidates = getOpenableObservationTargets(observation);
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
  const linkLabel = formatCapturedCount(observation.links.length, observation.capture_meta?.estimated_counts?.links, "link", "link");
  const buttonLabel = formatCapturedCount(observation.buttons.length, observation.capture_meta?.estimated_counts?.buttons, "pulsante", "pulsanti");
  const headingText = headings.length ? ` Main sections: ${headings.join("; ")}.` : "";
  if (responseLanguage === "it") {
    const italianHeadingText = headings.length ? ` Sezioni principali: ${headings.join("; ")}.` : "";
    return `Ho osservato la pagina: ${linkLabel}, ${buttonLabel} e ${fieldCount} campi modulo catturati.${italianHeadingText}`;
  }
  return `I observed the page: ${formatCapturedCount(observation.links.length, observation.capture_meta?.estimated_counts?.links, "link", "links")}, ${formatCapturedCount(observation.buttons.length, observation.capture_meta?.estimated_counts?.buttons, "button", "buttons")}, and ${fieldCount} captured form fields.${headingText}`;
}

function summarizeObservation(observation) {
  const fieldCount = observation.forms.reduce((total, form) => total + form.fields.length, 0);
  const meta = observation.capture_meta || {};
  const linkText = formatCapturedCount(observation.links.length, meta.estimated_counts?.links, "link", "links");
  const buttonText = formatCapturedCount(observation.buttons.length, meta.estimated_counts?.buttons, "button", "buttons");
  const fieldText = `${fieldCount} fields`;
  const visibleTextLength = meta.visible_text_length || observation.visible_text.length;
  const visibleTextText = meta.truncated?.visible_text && visibleTextLength > observation.visible_text.length
    ? `${observation.visible_text.length}/${visibleTextLength} visible-text chars`
    : `${observation.visible_text.length} visible-text chars`;
  const cappedNote = hasObservationCap(meta)
    ? " Some page content was capped during observe."
    : "";
  return `${linkText}, ${buttonText}, ${fieldText}, and ${visibleTextText} captured.${cappedNote}`;
}

function formatCapturedCount(captured, estimated, singular, plural) {
  const safeCaptured = Number(captured) || 0;
  const safeEstimated = Number(estimated) || 0;
  const label = safeCaptured === 1 ? singular : plural;

  if (safeEstimated > safeCaptured) {
    return `${safeCaptured}/${safeEstimated} ${label}`;
  }

  return `${safeCaptured} ${label}`;
}

function hasObservationCap(meta = {}) {
  const truncated = meta.truncated || {};
  return Object.values(truncated).some(Boolean);
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
  const hasResearchArtifact = results.some((result) => ["web_search", "http_response", "page_observation", "numbered_overlay", "tab_opened"].includes(result.artifact?.kind));

  if (!hasResearchArtifact || !isSelectedProviderConnected()) {
    addDebugLog("provider.synthesis.skipped", {
      hasResearchArtifact,
      connectorStatus: state.connector.status,
      resultKinds: results.map((result) => result.artifact?.kind || result.status)
    }, "Synthesis skipped.");
    return { text: "", error: null };
  }

  const lastUserEntry = [...state.messages].reverse().find((message) => message.role === "user") || null;
  const lastUserMessage = lastUserEntry?.text || plan.goal || "";
  const loggedLastUserMessage = getProviderLoggedUserText(lastUserMessage, lastUserEntry?.createdAt || Date.now());
  const selectedHttpProvider = getSelectedHttpProvider();
  let latestObservation = getLatestObservationFromResults(results);
  if (!latestObservation) {
    latestObservation = await recoverObservationForProvider("refresh page context before synthesis");
  }
  const conversationContext = getRecentConversationForProvider(lastUserMessage);
  const recentReferences = getRecentReferencesForProvider(loggedLastUserMessage, latestObservation, conversationContext);
  const taskMemory = getTaskMemoryForProvider(lastUserMessage);
  const accessibleTabs = getRecentAccessibleTabs(null)
    .slice(0, PROVIDER_RECENT_TAB_LIMIT)
    .map((tab) => ({
      tabId: tab.tabId || null,
      title: tab.title || "",
      url: tab.url || "",
      source: tab.source || "",
      isCurrent: Boolean(tab.isCurrent),
      accessStatus: tab.accessStatus || "unknown",
      lastObservedAt: tab.lastObservedAt || "",
      lastActiveAt: tab.lastActiveAt || "",
      visibleTextLength: tab.visibleTextLength || 0,
      links: tab.links || 0,
      buttons: tab.buttons || 0,
      lastActionLog: tab.lastActionLog || ""
    }));
  const recentActions = getRecentActionsForProvider();
  const buildPayload = (mode = "full") => {
    const contextPayload = applyLinkReferencesForProvider({
      conversationContext,
      recentReferences,
      accessibleTabs,
      recentActions,
      taskMemory,
      observation: compactObservationForSynthesis(latestObservation, mode, {
        goal: loggedLastUserMessage,
        conversationContext,
        userMemory: state.userMemory.items,
        recentReferences
      }),
      userMemory: getUserMemoryForSynthesis(mode),
      results: compactResultsForSynthesis(results, mode)
    });

    return {
      goal: loggedLastUserMessage,
      responseLanguage: detectUserLanguage(lastUserMessage),
      provider: state.codex.provider,
      model: state.codex.model,
      httpProvider: selectedHttpProvider,
      ...contextPayload,
      linkReferences: getLinkReferencesForProvider()
    };
  };

  const runSynthesisAttempt = async (mode = "full") => {
    const payload = buildPayload(mode);
    addDebugLog("provider.synthesis.start", payload, `${state.codex.provider} / ${state.codex.model}${mode === "compact" ? " (compact retry)" : ""}`);
    const response = await requestSelectedProviderSynthesis(payload);
    addDebugLog("provider.synthesis.end", {
      ok: response.ok,
      error: response.error || "",
      result: response.envelope?.payload || null,
      mode
    }, response.ok ? `Synthesis response received${mode === "compact" ? " after compact retry" : ""}.` : response.error);

    if (!response.ok) {
      return {
        text: "",
        error: {
          message: response.error || "Synthesis failed.",
          thinking: ""
        }
      };
    }

    const payloadResult = response.envelope?.payload || {};
    if (isProviderErrorLikeResult(payloadResult)) {
      return {
        text: "",
        error: {
          message: formatProviderAgentErrorMessage(payloadResult),
          thinking: getAgentDisplayThinking(payloadResult)
        }
      };
    }

    const structuredPayload = extractStructuredAgentPayloadFromText(payloadResult.text || "");
    if (structuredPayload) {
      addDebugLog("provider.synthesis.unexpected_structured_payload", {
        mode,
        payloadResult,
        structuredPayload
      }, "Synthesis returned a structured Browser Companion payload instead of final answer text.");
      return {
        text: "",
        error: null
      };
    }

    return {
      text: getAgentDisplayText(payloadResult) || "",
      error: null
    };
  };

  const firstAttempt = await runSynthesisAttempt("full");
  if (!firstAttempt.error) {
    return firstAttempt;
  }

  if (!isProviderErrorLikeResult(firstAttempt.error)) {
    state.activity.unshift(`Synthesis failed: ${firstAttempt.error.message}`);
    return firstAttempt;
  }

  state.activity.unshift("Synthesis hit a provider error; retrying with compact context.");
  addDebugLog("provider.synthesis.retry", {
    error: firstAttempt.error,
    reason: "provider_error_compact_retry"
  }, "Retrying synthesis with compact context.");
  const compactAttempt = await runSynthesisAttempt("compact");
  if (compactAttempt.error) {
    state.activity.unshift(`Synthesis failed: ${compactAttempt.error.message}`);
  }
  return compactAttempt;
}

function getUserMemoryForSynthesis(mode = "full") {
  return state.userMemory.items.map((item) => ({
      id: item.id,
      title: item.title,
      content: mode === "compact" ? "" : item.content,
      updatedAt: item.updatedAt
    }));
}

function compactObservationForSynthesis(observation, mode = "full", context = {}) {
  const compacted = compactObservationForProvider(observation, context);
  if (!compacted) {
    return compacted;
  }

  const dedupedVisibleText = dedupeObservationTextForSynthesis(compacted.visible_text || "");
  const baseObservation = {
    ...compacted,
    visible_text: dedupedVisibleText.text,
    note: dedupedVisibleText.removedCount > 0
      ? `Observation compacted for synthesis; removed ${dedupedVisibleText.removedCount} near-duplicate text block${dedupedVisibleText.removedCount === 1 ? "" : "s"}.`
      : compacted.note
  };

  if (mode !== "compact") {
    return baseObservation;
  }

  return {
    type: baseObservation.type,
    tab: baseObservation.tab,
    viewport: baseObservation.viewport,
    capturedAt: baseObservation.capturedAt,
    visible_text: String(baseObservation.visible_text || "").slice(0, 2200),
    visibleTextLength: baseObservation.visibleTextLength,
    visibleTextTruncated: baseObservation.visibleTextTruncated,
    headings: Array.isArray(baseObservation.headings) ? baseObservation.headings.slice(0, 12) : [],
    links: [],
    buttons: [],
    forms: Array.isArray(baseObservation.forms) ? baseObservation.forms.slice(0, 3).map((form) => ({
      agent_id: form.agent_id || "",
      title: form.title || "",
      fields: (Array.isArray(form.fields) ? form.fields : []).slice(0, 4).map((field) => ({
        agent_id: field.agent_id || "",
        role: field.role || "",
        type: field.type || "",
        name: field.name || "",
        value: field.value || ""
      }))
    })) : [],
    counts: baseObservation.counts,
    page_outline: compactPageOutlineForProvider(baseObservation.page_outline, 6),
    structured_items: compactStructuredItemsForProvider(baseObservation.structured_items, context, 8),
    focused_context: buildFocusedContextForProvider(observation, context, "compact"),
    note: "Observation compacted aggressively for synthesis retry."
  };
}

function dedupeObservationTextForSynthesis(text) {
  const blocks = splitTextIntoDedupBlocks(text);
  if (blocks.length <= 1) {
    return {
      text: String(text || ""),
      removedCount: 0
    };
  }

  const kept = [];
  const fingerprints = new Set();
  let removedCount = 0;

  for (const block of blocks) {
    const fingerprint = fingerprintTextBlock(block);
    if (!fingerprint) {
      continue;
    }
    if (fingerprints.has(fingerprint) || kept.some((candidate) => areTextBlocksVerySimilar(candidate, block))) {
      removedCount += 1;
      continue;
    }
    kept.push(block);
    fingerprints.add(fingerprint);
  }

  return {
    text: kept.join("\n\n"),
    removedCount
  };
}

function splitTextIntoDedupBlocks(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!raw) {
    return [];
  }

  const paragraphChunks = raw.split(/\n\s*\n+/).map((chunk) => chunk.trim()).filter(Boolean);
  if (paragraphChunks.length > 1) {
    return paragraphChunks;
  }

  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    return [];
  }

  const blocks = [];
  let current = [];
  let currentLength = 0;
  for (const line of lines) {
    current.push(line);
    currentLength += line.length;
    if (currentLength >= 180 || /[.!?]$/.test(line)) {
      blocks.push(current.join(" ").trim());
      current = [];
      currentLength = 0;
    }
  }
  if (current.length) {
    blocks.push(current.join(" ").trim());
  }
  return blocks.filter(Boolean);
}

function normalizeTextBlock(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprintTextBlock(text) {
  return normalizeTextBlock(text)
    .replace(/\b(the|and|for|with|this|that|from|amazon|ssd|sono|della|delle|degli|dello|dell|con|per|che|una|uno)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function areTextBlocksVerySimilar(a, b) {
  const normA = normalizeTextBlock(a);
  const normB = normalizeTextBlock(b);
  if (!normA || !normB) {
    return false;
  }
  if (normA === normB) {
    return true;
  }

  const tokensA = new Set(normA.split(" ").filter((token) => token.length >= 4));
  const tokensB = new Set(normB.split(" ").filter((token) => token.length >= 4));
  if (!tokensA.size || !tokensB.size) {
    return false;
  }

  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      overlap += 1;
    }
  }

  const containment = overlap / Math.min(tokensA.size, tokensB.size);
  const balance = Math.min(normA.length, normB.length) / Math.max(normA.length, normB.length);
  return containment >= 0.82 && balance >= 0.7;
}

function compactResultsForSynthesis(results, mode = "full") {
  const items = Array.isArray(results) ? results : [];
  const latestObservation = getLatestObservationFromResults(items);
  const limit = mode === "compact" ? 10 : 16;
  const summarized = items
    .slice(0, limit)
    .map((result) => summarizeResultForSynthesis(result, latestObservation, mode))
    .filter(Boolean);

  return dedupeSummarizedResults(summarized);
}

function summarizeResultForSynthesis(result, latestObservation, mode = "full") {
  if (!result) {
    return null;
  }

  const artifact = summarizeArtifactForSynthesis(result.artifact, latestObservation, mode);
  const entry = {
    action_id: result.action_id || "",
    status: result.status || "",
    target_verified: Boolean(result.target_verified),
    page_changed: Boolean(result.page_changed),
    type: result.type || "",
    log_message: result.log_message || "",
    validation_messages: Array.isArray(result.validation_messages) ? result.validation_messages.slice(0, 3) : []
  };

  if (mode !== "compact") {
    if (result.before?.value != null) {
      entry.before = { value: String(result.before.value).slice(0, 200) };
    }
    if (result.after?.value != null) {
      entry.after = { value: String(result.after.value).slice(0, 200) };
    }
  }

  if (artifact) {
    entry.artifact = artifact;
  }

  if (!entry.log_message && !entry.artifact && !entry.action_id) {
    return null;
  }

  return entry;
}

function dedupeSummarizedResults(results) {
  const seen = new Set();
  const output = [];

  for (const result of results) {
    const key = JSON.stringify({
      action_id: result.action_id || "",
      status: result.status || "",
      log_message: result.log_message || "",
      artifact: result.artifact || null
    });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(result);
  }

  return output;
}

function summarizeArtifactForSynthesis(artifact, latestObservation = null, mode = "full") {
  if (!artifact) {
    return null;
  }

  if (artifact.kind === "page_observation") {
    const observation = artifact.observation || {};
    const sameAsTopLevel = isObservationEquivalentForSynthesis(observation, latestObservation);
    if (sameAsTopLevel) {
      return {
        kind: "page_observation",
        duplicateOfTopLevelObservation: true,
        title: observation.tab?.title || "",
        url: observation.tab?.url || ""
      };
    }

    return {
      kind: "page_observation",
      title: observation.tab?.title || "",
      url: observation.tab?.url || "",
      visibleTextLength: observation.visibleTextLength || String(observation.visible_text || "").length,
      counts: observation.counts || null,
      page_outline: compactPageOutlineForProvider(observation.page_outline, mode === "compact" ? 4 : 6),
      structured_items: compactStructuredItemsForProvider(observation.structured_items, {}, mode === "compact" ? 4 : 6)
    };
  }

  if (artifact.kind === "http_response") {
    return {
      kind: "http_response",
      statusCode: artifact.statusCode || null,
      finalUrl: artifact.finalUrl || artifact.url || "",
      bodyPreview: formatHttpBodyPreview(artifact).slice(0, mode === "compact" ? 700 : 1200)
    };
  }

  if (artifact.kind === "web_search") {
    return {
      kind: "web_search",
      query: artifact.query || "",
      results: compactWebSearchResultsForProvider(artifact.results, mode === "compact" ? 3 : 8)
    };
  }

  if (artifact.kind === "screenshot") {
    return {
      kind: "screenshot",
      ocrText: String(artifact.ocrText || "").slice(0, mode === "compact" ? 700 : 1200)
    };
  }

  if (artifact.kind === "numbered_overlay") {
    return {
      kind: "numbered_overlay",
      screenshotAvailable: Boolean(artifact.dataUrl),
      captureError: String(artifact.captureError || "").slice(0, mode === "compact" ? 300 : 600),
      overlayMap: Array.isArray(artifact.overlayMap)
        ? artifact.overlayMap.slice(0, mode === "compact" ? 10 : 18)
        : []
    };
  }

  if (artifact.kind === "tab_opened") {
    return {
      kind: "tab_opened",
      tabId: artifact.tabId || null,
      url: artifact.url || "",
      title: artifact.title || artifact.observation?.tab?.title || "",
      accessStatus: artifact.accessStatus || "",
      observation: artifact.observation
        ? summarizeArtifactForSynthesis({ kind: "page_observation", observation: artifact.observation }, latestObservation, mode)
        : null
    };
  }

  return {
    kind: artifact.kind || "artifact"
  };
}

function isObservationEquivalentForSynthesis(a, b) {
  if (!a || !b) {
    return false;
  }

  const urlA = normalizeUrlForContext(a.tab?.url || "");
  const urlB = normalizeUrlForContext(b.tab?.url || "");
  if (urlA && urlB && urlA === urlB) {
    return true;
  }

  const titleA = normalizeTextBlock(a.tab?.title || "");
  const titleB = normalizeTextBlock(b.tab?.title || "");
  return Boolean(titleA && titleB && titleA === titleB);
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

  if (result.artifact?.kind === "numbered_overlay") {
    return {
      ...result,
      artifact: {
        kind: "numbered_overlay",
        captureError: String(result.artifact.captureError || "").slice(0, 1000),
        overlayMap: Array.isArray(result.artifact.overlayMap)
          ? result.artifact.overlayMap.slice(0, 24)
          : []
      }
    };
  }

  return result;
}

function pushPostActionSynthesisError(error = {}) {
  logProviderError("provider.synthesis.error", error, "Post-action synthesis failed.");
  state.messages.push({
    role: "assistant",
    text: "The browser action completed, but the HTTP provider failed while preparing the final answer. " + (error.message || "The provider did not return a usable response."),
    thinking: String(error.thinking || "").trim(),
    variant: "error",
    createdAt: Date.now()
  });
  state.activity.unshift("Post-action answer synthesis failed.");
  render();
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

  if (artifact.kind === "numbered_overlay") {
    return "Numbered overlay captured";
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

  if (artifact.kind === "numbered_overlay") {
    return [
      `${Array.isArray(artifact.overlayMap) ? artifact.overlayMap.length : 0} visible controls were numbered.`,
      artifact.captureError
        ? `Screenshot unavailable: ${String(artifact.captureError).slice(0, 600)}`
        : "Overlay screenshot captured successfully."
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

  const openedTabs = results
    .map((result) => result?.artifact)
    .filter((artifact) => artifact?.kind === "tab_opened" && artifact.url);
  if (openedTabs.length) {
    const lines = openedTabs.slice(0, 30).map((artifact, index) => {
      const title = compact(artifact.title || "").slice(0, 120);
      return `${index + 1}. ${title ? `${title} - ` : ""}${artifact.url}`;
    });
    const omitted = openedTabs.length > lines.length
      ? `\n...and ${openedTabs.length - lines.length} more.`
      : "";
    return `Opened ${openedTabs.length} tab${openedTabs.length === 1 ? "" : "s"}:\n${lines.join("\n")}${omitted}`;
  }

  const navigations = results.filter((result) => result?.page_changed && /^Opened\s+/i.test(result?.log_message || ""));
  if (navigations.length) {
    const lines = navigations.slice(0, 10).map((result, index) => `${index + 1}. ${compact(result.log_message || "")}`);
    return `Opened ${navigations.length} page${navigations.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
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
  const stored = await chrome.storage.local.get(["browserCompanionSession", "browserCompanionTheme", EXTERNAL_DEBUG_LOGS_KEY]);
  const session = stored.browserCompanionSession;
  const selectedProvider = state.codex.provider;
  const selectedModel = state.codex.model;
  state.theme = stored.browserCompanionTheme || "system";
  state.externalDebugLogs = normalizeDebugLogs(stored[EXTERNAL_DEBUG_LOGS_KEY] || []);

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
  state.recentActions = Array.isArray(session.recentActions) ? session.recentActions : [];
  state.accessibleTabs = session.accessibleTabs || {};
  state.taskMemory = normalizeTaskMemory(session.taskMemory);
  state.sessionApprovals = Array.isArray(session.sessionApprovals) ? session.sessionApprovals : [];
  state.activity = session.activity || [];
  state.debugLogs = normalizeDebugLogs(session.debugLogs || []);
  state.pendingMemoryProposal = session.pendingMemoryProposal || null;
}

async function restoreProviderSettings() {
  const stored = await chrome.storage.local.get(["browserCompanionProviderSettings"]);
  const settings = stored.browserCompanionProviderSettings || {};
  state.httpProviders = Array.isArray(settings.httpProviders)
    ? settings.httpProviders.map((provider) => {
      const providerKind = normalizeHttpProviderKind(provider.providerKind);
      const accountId = String(provider.accountId || extractCloudflareAccountIdFromBaseUrl(provider.baseUrl) || "").trim();
      return {
        ...provider,
        providerKind,
        accountId,
        token: provider.token || "",
        authType: normalizeHttpProviderAuthType(
          providerKind === HTTP_PROVIDER_KIND_CLOUDFLARE
            ? "bearer"
            : (provider.authType || ((provider.username || provider.password) ? "basic" : (provider.token ? "bearer" : "none")))
        ),
        useStreaming: Boolean(provider.useStreaming),
        plannerEnabled: Boolean(provider.plannerEnabled),
        maxTokens: sanitizePositiveInteger(provider.maxTokens, HTTP_PROVIDER_DEFAULT_MAX_TOKENS, HTTP_PROVIDER_DEFAULT_MAX_TOKENS),
        retryMaxTokens: sanitizePositiveInteger(provider.retryMaxTokens, HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS, HTTP_PROVIDER_DEFAULT_RETRY_MAX_TOKENS),
        timeoutMs: normalizeStoredTimeoutMs(provider),
        timeoutConfigured: normalizeStoredTimeoutMs(provider) > 0,
        baseUrl: providerKind === HTTP_PROVIDER_KIND_CLOUDFLARE
          ? computeCloudflareWorkersAiBaseUrl(accountId)
          : provider.baseUrl
      };
    })
    : [];
  state.codex = {
    ...state.codex,
    ...(settings.selectedProvider ? { provider: settings.selectedProvider } : {}),
    ...(settings.selectedModel ? { model: settings.selectedModel } : {})
  };
  state.connector.providers = normalizeProviderStatuses(state.connector.providers);
}

function handleStorageChange(changes, area) {
  if (area !== "local") {
    return;
  }

  if (changes[EXTERNAL_DEBUG_LOGS_KEY]) {
    state.externalDebugLogs = normalizeDebugLogs(changes[EXTERNAL_DEBUG_LOGS_KEY].newValue || []);
    if (state.view === "settings" && state.settingsSection === "logs") {
      render();
    }
  }
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

async function persistDeepSearchRun(run) {
  const stored = await chrome.storage.local.get([DEEP_SEARCH_STORAGE_KEY]);
  const runs = Array.isArray(stored[DEEP_SEARCH_STORAGE_KEY])
    ? stored[DEEP_SEARCH_STORAGE_KEY].map((item) => normalizeDeepSearchRun(item))
    : [];
  const nextRuns = upsertDeepSearchRunList(runs, run);
  await chrome.storage.local.set({
    [DEEP_SEARCH_STORAGE_KEY]: nextRuns
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
      recentActions: state.recentActions.slice(0, 24),
      accessibleTabs: Object.fromEntries(Object.entries(state.accessibleTabs || {}).slice(0, 12)),
      taskMemory: normalizeTaskMemory(state.taskMemory),
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
  state.pendingPlanContext = null;
  state.pendingPolicy = null;
  state.pendingPermissionRequest = null;
  state.pendingMemoryProposal = null;
  state.pendingMemoryIntent = null;
  state.sessionApprovals = [];
  state.confirmationText = "";
  state.actionNotes = [];
  state.recentActions = [];
  state.taskMemory = createEmptyTaskMemory();
  resetLinkReferenceRegistry();
  state.debugLogs = [];
  state.activity = ["Local session cleared."];
  chrome.storage.local.remove("browserCompanionSession");
  render();
}

function sendRuntimeMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function getConnectorClass() {
  const selected = getSelectedConnectorState();
  if (selected.quotaExhausted) return "warn";
  if (selected.status === "connected") return "ok";
  if (selected.status === "unknown" || selected.status === "connecting") return "neutral";
  return "warn";
}

function getConnectorStatusLabel() {
  const selected = getSelectedConnectorState();
  const provider = getSelectedProviderStatus();
  const name = provider?.label || "Provider";
  const isHttpProvider = isHttpProviderStatus(provider);

  if (selected.quotaExhausted) {
    return `${name} limit reached`;
  }

  if (selected.status === "connected") {
    if (isHttpProvider) {
      return "LLM ready";
    }
    return `${name} connected`;
  }

  if (selected.status === "error") {
    if (isHttpProvider) {
      return "LLM offline";
    }
    return `${name} offline`;
  }

  if (isHttpProvider && selected.status === "ready") {
    return "LLM ready";
  }

  if (isHttpProvider && ["unknown", "missing"].includes(selected.status)) {
    return "LLM unavailable";
  }

  return selected.status;
}

function getSelectedConnectorState() {
  const provider = getSelectedProviderStatus();
  const isHttpProvider = isHttpProviderStatus(provider);
  if (provider?.quotaState === "exhausted") {
    return {
      status: provider.connected ? "connected" : "quota_exhausted",
      quotaExhausted: true,
      message: provider.quotaMessage || provider.message || `${provider.label || "Provider"} has reached its current usage limit.`
    };
  }
  if (provider?.connected) {
    return {
      status: "connected",
      message: provider.message || `${provider.label || "Provider"} is connected.`
    };
  }

  if (provider?.status === "error") {
    return {
      status: "error",
      message: provider.message || (isHttpProvider
        ? "The selected LLM endpoint is offline or unreachable."
        : `${provider.label || "Provider"} is unavailable.`)
    };
  }

  if (provider?.status) {
    return {
      status: provider.status,
      message: provider.message || state.connector.message || "Connector status received."
    };
  }

  return {
    status: state.connector.status,
    message: state.connector.message
  };
}

function isSelectedProviderConnected() {
  return getSelectedConnectorState().status === "connected";
}

function renderProviderQuotaNotice() {
  const provider = getSelectedProviderStatus();
  if (provider?.quotaState !== "exhausted") {
    return "";
  }

  return `
    <section class="quota-notice" aria-label="Provider usage limit">
      <strong>${escapeHtml(provider.label || "Provider")} limit reached</strong>
      <span>${escapeHtml(provider.quotaMessage || provider.message || "The selected provider has reached its current usage limit.")}</span>
    </section>
  `;
}

function getHighestRisk(policy) {
  const order = ["low", "medium", "high", "sensitive", "blocked"];
  return (policy?.results || []).reduce((highest, result) => {
    return order.indexOf(result.risk) > order.indexOf(highest) ? result.risk : highest;
  }, "low");
}

function getPreviewRiskClass(risk, policy) {
  return risk || "low";
}

function getConfirmationLabel(risk, policy) {
  if (!policy?.requiresConfirmation) return "Ready";
  if (risk === "high") return "Explicit final-action confirmation required";
  if (risk === "sensitive") return "Sensitive data confirmation required";
  if (risk === "blocked") return "Strong manual review recommended";
  return "Confirmation required";
}

function getActionPreviewNote(risk, policy, plan, totalActions = 0) {
  const actionCount = Array.isArray(plan?.actions) ? plan.actions.length : 0;
  const actionLabel = actionCount === 1 ? "1 action" : `${actionCount} actions`;
  const skippedCount = Math.max(0, totalActions - actionCount);

  if (risk === "blocked") {
    return {
      tone: "blocked",
      title: "Review carefully before confirming",
      body: `One or more selected actions fall into a high-attention category. You can still approve them, but review the notes below carefully before continuing with ${actionLabel}.${skippedCount ? ` ${skippedCount} action${skippedCount === 1 ? " is" : "s are"} currently skipped.` : ""}`
    };
  }

  if (risk === "sensitive") {
    return {
      tone: "sensitive",
      title: "Extra confirmation required",
      body: `Type ${getRequiredConfirmationPhrase(risk, plan)} to continue with ${actionLabel}.${skippedCount ? ` ${skippedCount} action${skippedCount === 1 ? " is" : "s are"} currently skipped.` : ""}`
    };
  }

  if (plan?.will_submit || risk === "high") {
    return {
      tone: "high",
      title: "Final acceptance step",
      body: `Confirm will continue with ${actionLabel} and may accept or submit on the site. Review the target fields before proceeding.${skippedCount ? ` ${skippedCount} action${skippedCount === 1 ? " is" : "s are"} currently skipped.` : ""}`
    };
  }

  return {
    tone: risk === "medium" ? "medium" : "low",
    title: policy?.requiresConfirmation ? "Ready to proceed" : "Ready",
    body: `Confirm will run ${actionLabel} on this page. It will not click the final submit button.${skippedCount ? ` ${skippedCount} action${skippedCount === 1 ? " is" : "s are"} currently skipped.` : ""}`
  };
}

function getConfirmDisabledReason(risk, policy, plan) {
  if (!plan?.actions?.length) {
    return "Select at least one action to continue.";
  }

  if (risk === "sensitive") {
    return `Confirm unlocks after you type ${getRequiredConfirmationPhrase(risk, plan)} exactly.`;
  }

  return "";
}

function isPendingActionSelected(index) {
  if (!Number.isInteger(index) || index < 0) {
    return true;
  }

  if (!Array.isArray(state.pendingActionSelection) || index >= state.pendingActionSelection.length) {
    return true;
  }

  return state.pendingActionSelection[index] !== false;
}

function handlePendingActionSelectionChange(event) {
  const index = Number.parseInt(event.target?.dataset?.pendingActionIndex || "", 10);
  if (!Number.isInteger(index) || index < 0) {
    return;
  }

  const next = Array.isArray(state.pendingActionSelection)
    ? [...state.pendingActionSelection]
    : (Array.isArray(state.pendingPlan?.actions) ? state.pendingPlan.actions.map(() => true) : []);
  next[index] = Boolean(event.target.checked);
  state.pendingActionSelection = next;
  render();
}

function getSelectedPendingActionIndexes() {
  const actions = Array.isArray(state.pendingPlan?.actions) ? state.pendingPlan.actions : [];
  if (!actions.length) {
    return [];
  }

  return actions.reduce((indexes, _action, index) => {
    if (isPendingActionSelected(index)) {
      indexes.push(index);
    }
    return indexes;
  }, []);
}

function getSelectedPendingPlan() {
  const plan = normalizePlan(state.pendingPlan);
  if (!plan) {
    return null;
  }

  const selectedIndexes = getSelectedPendingActionIndexes();
  return {
    ...plan,
    actions: selectedIndexes.map((index) => plan.actions[index]).filter(Boolean)
  };
}

function getSelectedPendingPolicy() {
  const policy = state.pendingPolicy;
  const results = Array.isArray(policy?.results) ? policy.results : [];
  const selectedIndexSet = new Set(getSelectedPendingActionIndexes());
  const selectedResults = results
    .filter((result) => selectedIndexSet.has(result.index))
    .map((result, nextIndex) => ({ ...result, index: nextIndex }));

  return {
    ...(policy || {}),
    allowed: selectedResults.every((result) => result.allowed),
    requiresConfirmation: selectedResults.some((result) => result.requiresConfirmation),
    results: selectedResults
  };
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
