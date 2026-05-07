import { MESSAGE_TYPES, makeEnvelope } from "../shared/messages.js";

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
        models: ["default", "gemini-3-pro", "gemini-2.5-pro", "gemini-2.5-flash"],
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
  pendingPlan: null,
  pendingPolicy: null,
  confirmationText: "",
  privacy: {
    persistSession: false,
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
    model: ""
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
  chatAtBottom: true,
  activity: []
};

const app = document.getElementById("app");

initialize();

async function initialize() {
  await restoreProviderSettings();
  await restoreSession();
  applyTheme();
  render();
  checkConnector();
  loadUserMemory();
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

    ${renderComposer()}
  `;

  document.getElementById("observe-page").addEventListener("click", observePage);
  const observePageSettings = document.getElementById("observe-page-settings");
  if (observePageSettings) observePageSettings.addEventListener("click", observePage);
  document.getElementById("theme-toggle").addEventListener("click", cycleTheme);
  document.getElementById("open-settings-view").addEventListener("click", () => {
    state.view = "settings";
    render();
  });
  document.getElementById("close-settings-view").addEventListener("click", () => {
    state.view = "chat";
    render();
  });
  document.querySelectorAll("[data-settings-section]").forEach((button) => {
    button.addEventListener("click", () => {
      state.settingsSection = button.dataset.settingsSection;
      state.view = "settings";
      render();
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
  if (codexModel) codexModel.addEventListener("change", (event) => {
    state.codex.model = event.target.value;
    state.activity.unshift(`Model set to ${state.codex.model}.`);
    persistSession();
    render();
  });
  const providerSelect = document.getElementById("provider-select");
  if (providerSelect) providerSelect.addEventListener("change", (event) => {
    state.codex.provider = event.target.value;
    const provider = getSelectedProviderStatus();
    state.codex.model = provider?.defaultModel || provider?.models?.[0] || "default";
    state.activity.unshift(`Provider set to ${provider?.label || state.codex.provider}.`);
    persistSession();
    render();
  });
  const clearActivityButton = document.getElementById("clear-activity");
  if (clearActivityButton) clearActivityButton.addEventListener("click", () => {
    state.activity = [];
    persistSession();
    render();
  });
  const clearAttachmentsButton = document.getElementById("clear-attachments");
  if (clearAttachmentsButton) clearAttachmentsButton.addEventListener("click", clearAttachments);
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
  document.getElementById("chat-input").addEventListener("keydown", handleComposerKeydown);

  if (state.pendingPlan) {
    document.getElementById("confirm-plan").addEventListener("click", confirmPendingPlan);
    document.getElementById("cancel-plan").addEventListener("click", cancelPendingPlan);
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
    activity: "Recent events"
  };

  return labels[state.settingsSection] || "Settings";
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
    <button id="clear-attachments" type="button" class="wide-button">Clear Attachments</button>
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
          <button id="test-http-provider" type="button">Test</button>
          <button type="submit">Save HTTP Provider</button>
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
  return `
    <li>
      <strong>${escapeHtml(provider.name)}</strong>
      <span>${escapeHtml(provider.baseUrl)} - ${escapeHtml(provider.model || "No model selected")}</span>
      <div class="button-row">
        <button type="button" data-http-provider-edit="${escapeHtml(provider.id)}">Edit</button>
        <button type="button" data-http-provider-delete="${escapeHtml(provider.id)}">Delete</button>
      </div>
    </li>
  `;
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

function renderComposer() {
  return `
    <form id="chat-form" class="composer">
      <label class="file-input">
        <input id="attachment-input" type="file" multiple>
        <span>Attach</span>
      </label>
      <textarea id="chat-input" rows="3" placeholder="Describe your goal on this page"></textarea>
      <button type="submit">Send</button>
    </form>
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

function updateConfirmButtonState() {
  const button = document.getElementById("confirm-plan");
  if (!button || !state.pendingPlan) {
    return;
  }

  const highestRisk = getHighestRisk(state.pendingPolicy);
  const needsTypedConfirmation = ["high", "sensitive"].includes(highestRisk);
  const requiredPhrase = getRequiredConfirmationPhrase(highestRisk, state.pendingPlan);
  button.disabled = !state.pendingPolicy?.allowed || (needsTypedConfirmation && state.confirmationText !== requiredPhrase);
}

function renderMessage(message) {
  return `
    <article class="message ${message.role}">
      <span>${message.role === "user" ? "You" : "Companion"}</span>
      <div class="message-body">${renderRichText(message.text)}</div>
    </article>
  `;
}

function renderChatTimeline() {
  const items = [
    ...state.messages.map((item) => ({ kind: "message", createdAt: item.createdAt || 0, item })),
    ...state.actionNotes.map((item) => ({ kind: "note", createdAt: item.createdAt || 0, item }))
  ].sort((a, b) => a.createdAt - b.createdAt);

  return items.map((entry) => entry.kind === "message" ? renderMessage(entry.item) : renderActionNote(entry.item)).join("");
}

function renderActionNote(note) {
  const details = note.details.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  return `
    <details class="action-note">
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
  const needsTypedConfirmation = ["high", "sensitive"].includes(highestRisk);
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
      <div class="preview-actions">
        <button id="cancel-plan" type="button">Cancel</button>
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
    <li>
      <strong>${escapeHtml(file.name)}</strong>
      <span>${escapeHtml(file.status)} - ${formatBytes(file.size)}</span>
      ${detail ? `<small class="attachment-detail">${escapeHtml(detail)}</small>` : ""}
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
      models: ["default", "gemini-3-pro", "gemini-2.5-pro", "gemini-2.5-flash"],
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
    if (!silent) {
      state.page.status = "error";
      state.page.summary = permission.error;
      state.messages.push({
        role: "assistant",
        text: permission.error,
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
  state.page = {
    status: "ready",
    title: observation.tab.title || "Untitled page",
    url: observation.tab.url || "",
    summary: summarizeObservation(observation),
    observation
  };
  await enrichGoogleDocObservation();
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
  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.NATIVE_HEALTH));

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
  const selectedModel = models.includes(provider.model) ? provider.model : (models[0] || provider.model || "");
  state.httpProviderDraft = {
    ...provider,
    model: selectedModel,
    models,
    lastStatus: payload.status || "ready",
    lastMessage: payload.message || "HTTP provider test completed."
  };
  state.connector.providers = normalizeProviderStatuses(state.connector.providers);
  state.codex.provider = `http:${state.httpProviderDraft.id}`;
  state.codex.model = selectedModel || "default";
  state.connector.message = `${state.httpProviderDraft.lastMessage} Select a model above, then Save HTTP Provider to keep it.`;
  state.activity.unshift(`HTTP provider ${state.httpProviderDraft.name} found ${models.length} model${models.length === 1 ? "" : "s"}.`);
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
  if (existingIndex >= 0) {
    state.httpProviders[existingIndex] = provider;
  } else {
    state.httpProviders.push(provider);
  }
  state.httpProviderDraft = { id: "", name: "", baseUrl: "", username: "", password: "", model: "" };
  state.connector.providers = normalizeProviderStatuses(state.connector.providers);
  if (state.codex.provider === `http:${provider.id}` || existingIndex < 0) {
    state.codex.provider = `http:${provider.id}`;
    state.codex.model = provider.model || provider.models?.[0] || "default";
  }
  ensureSelectedProviderAvailable();
  await persistProviderSettings();
  state.connector.message = `Saved HTTP provider ${provider.name}.`;
  render();
}

function readHttpProviderDraft() {
  const existingId = state.httpProviderDraft.id || "";
  const name = document.getElementById("http-provider-name")?.value.trim() || "Local LLM";
  const baseUrl = document.getElementById("http-provider-base-url")?.value.trim().replace(/\/+$/, "") || "";
  const username = document.getElementById("http-provider-username")?.value.trim() || "";
  const password = document.getElementById("http-provider-password")?.value || "";
  const model = document.getElementById("http-provider-model")?.value.trim() || state.httpProviderDraft.model || "";
  return {
    ...state.httpProviderDraft,
    id: existingId || crypto.randomUUID(),
    name,
    baseUrl,
    username,
    password,
    authType: username || password ? "basic" : "none",
    model,
    models: state.httpProviderDraft.models?.length ? state.httpProviderDraft.models : (model ? [model] : []),
    lastStatus: state.httpProviderDraft.lastStatus || "ready",
    lastMessage: state.httpProviderDraft.lastMessage || "OpenAI-compatible HTTP provider is configured."
  };
}

function editHttpProvider(id) {
  const provider = state.httpProviders.find((item) => item.id === id);
  if (!provider) return;
  state.httpProviderDraft = { ...provider };
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
  const input = document.getElementById("chat-input");
  const text = input.value.trim();

  if (!text) {
    return;
  }

  state.messages.push({ role: "user", text, createdAt: Date.now() });
  input.value = "";
  render();

  const memoryRequest = parseDirectMemoryRequest(text);
  if (memoryRequest) {
    const saved = await saveUserMemory(memoryRequest);
    state.messages.push({
      role: "assistant",
      text: saved
        ? localText(detectUserLanguage(text), "memorySaved")
        : localText(detectUserLanguage(text), "memorySaveFailed"),
      createdAt: Date.now()
    });
    render();
    return;
  }
  state.pendingMemoryIntent = parseDeferredMemoryIntent(text);

  const agentResult = await getAgentResult(text);
  handleAgentResult(agentResult);
}

async function getAgentResult(goal) {
  const responseLanguage = detectUserLanguage(goal);
  const navigationPlan = buildNavigationPlan(goal, responseLanguage);

  if (navigationPlan) {
    return navigationPlan;
  }

  if (state.connector.status === "connected") {
    const selectedHttpProvider = getSelectedHttpProvider();
    const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.AGENT_REQUEST, {
      goal,
      responseLanguage,
      provider: state.codex.provider,
      model: state.codex.model,
      httpProvider: selectedHttpProvider,
      observation: state.page.observation || null,
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
        text: state.privacy.sendAttachmentsToCodex ? file.text : ""
      }))
    }));

    if (response.ok) {
      return response.envelope.payload;
    }

    state.activity.unshift(`Provider request failed: ${response.error}`);
  }

  if (isSimpleConversationalMessage(goal)) {
    return buildSimpleConversationalResponse(goal, responseLanguage);
  }

  if (!state.page.observation) {
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
    || buildRequestedClickPlan(goal, state.page.observation, responseLanguage);
}

async function handleAgentResult(result) {
  if (result?.type === "agent_plan") {
    const policyResponse = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.VALIDATE_ACTION_PLAN, { plan: result }));
    state.confirmationText = "";
    state.messages.push({
      role: "assistant",
      text: result.summary_for_user,
      createdAt: Date.now()
    });

    const policy = policyResponse.envelope.payload;

    if (policy.allowed && !policy.requiresConfirmation) {
      state.activity.unshift("Executing low-risk action plan.");
      addActionNote("Executed low-risk action plan", result.actions.map(formatActionDetail));
      render();
      await executeActionPlan(result);
      return;
    }

    state.pendingPlan = result;
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
    state.messages.push({ role: "assistant", text: result.question, createdAt: Date.now() });
    render();
    return;
  }

  if (result?.type === "stop_for_human") {
    state.messages.push({ role: "assistant", text: result.reason, createdAt: Date.now() });
    state.activity.unshift("Automation stopped for human action.");
    render();
    return;
  }

  if (result?.type === "agent_unavailable" || result?.type === "agent_error") {
    state.messages.push({
      role: "assistant",
      text: result.message || "The selected local provider is not ready, so I used only local page context.",
      createdAt: Date.now()
    });
    state.activity.unshift("Codex agent was unavailable.");
    render();
    return;
  }

  const responseText = result?.text || "I could not produce a safe browser action from that request yet.";
  const memorySaved = await maybeSaveDeferredMemory(responseText);
  state.messages.push({
    role: "assistant",
    text: memorySaved ? appendMemorySavedNote(responseText) : responseText,
    createdAt: Date.now()
  });
  render();
}

async function confirmPendingPlan() {
  const plan = normalizePlan(state.pendingPlan);

  if (!plan) {
    return;
  }

  state.pendingPlan = null;
  state.pendingPolicy = null;
  state.confirmationText = "";

  try {
    await executeActionPlan(plan);
  } catch (error) {
    state.messages.push({
      role: "assistant",
      text: error.message || "The confirmed action could not be executed.",
      createdAt: Date.now()
    });
    state.activity.unshift(`Execution failed: ${error.message || "Unexpected error."}`);
    render();
  }
}

async function executeActionPlan(plan) {
  const normalizedPlan = normalizePlan(plan);
  const actions = normalizedPlan?.actions || [];
  const permission = await ensurePermissionForActionPlan(actions);

  if (!permission.ok) {
    state.messages.push({
      role: "assistant",
      text: permission.error,
      createdAt: Date.now()
    });
    state.activity.unshift(`Execution blocked: ${permission.error}`);
    render();
    return;
  }

  state.activity.unshift("Executing browser action plan...");
  addActionNote("Executing browser actions", actions.map(formatActionDetail));
  render();

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.EXECUTE_ACTION_PLAN, { plan: normalizedPlan }));

  if (!response.ok) {
    state.messages.push({ role: "assistant", text: response.error, createdAt: Date.now() });
    state.activity.unshift(`Execution failed: ${response.error}`);
    render();
    return;
  }

  const results = response.envelope.payload.results || [];
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

  const synthesized = await maybeSynthesizeResults(plan, results);
  const answerText = synthesized || getExecutionSummary(results);
  const memorySaved = await maybeSaveResearchMemory(plan, results, answerText);
  state.messages.push({
    role: "assistant",
    text: memorySaved ? appendMemorySavedNote(answerText) : answerText,
    createdAt: Date.now()
  });
  await refreshPageAfterAction();
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

function parseDirectMemoryRequest(text) {
  const raw = String(text || "").trim();
  if (isResearchIntent(raw)) {
    return null;
  }

  const match = raw.match(/^(?:remember|save|store|ricordati|salva|memorizza)\b(?:\s+(?:that|che|questo|this))?\s*[:,-]?\s+([\s\S]{6,})/i);

  if (!match) {
    return null;
  }

  const content = match[1].trim();
  if (!content || /\?$/.test(content)) {
    return null;
  }

  return {
    title: createMemoryTitle(content),
    content
  };
}

function isResearchIntent(text) {
  return /\b(cerca|search|look up|find|internet|online|web|google|fonti|sources|dettagli|details|informazioni|information)\b/i.test(text);
}

function isDeferredMemoryIntent(text) {
  return /\b(ricordati|remember|save|store|memorizza|salva|aggiungi|add)\b/i.test(text)
    && /\b(sintesi|summary|profilo|profile|cv|chi sono|who i am|findings|risultati|results)\b/i.test(text);
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
  const saved = await saveUserMemory({
    title,
    content: curateMemoryContent(answerText)
  });

  if (saved) {
    state.pendingMemoryIntent = null;
    state.activity.unshift(`Saved research summary to user memory: ${title}.`);
  }

  return saved;
}

async function maybeSaveDeferredMemory(answerText) {
  const intent = state.pendingMemoryIntent;

  if (!intent || !answerText || /^I could not produce/.test(answerText)) {
    return false;
  }

  const saved = await saveUserMemory({
    title: intent.title || inferResearchMemoryTitle(intent.goal),
    content: curateMemoryContent(answerText)
  });

  if (saved) {
    state.pendingMemoryIntent = null;
  }

  return saved;
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
  return `${text}\n\n_Memory saved locally._`;
}

function inferResearchMemoryTitle(goal) {
  if (/\bchi sono\b/i.test(goal)) {
    return "User profile and public work context";
  }

  if (/\bcv|curriculum|resume\b/i.test(goal)) {
    return "User CV summary";
  }

  if (/\benti|istituzioni|ambasciate|consolati|ICE|ITA|camere di commercio|hotel|UAE|Hong Kong\b/i.test(goal)) {
    return "User institutions and project context";
  }

  return "User research memory";
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
      summary_for_user: localText(responseLanguage, "openSearch", query.trim()),
      needs_clarification: false,
      requires_confirmation: false,
      will_submit: false,
      actions: [
        {
          id: "act_open_url_001",
          type: "open_url",
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

  const openMatch = goal.match(/\b(?:open|apri|go to|vai su|naviga a)\s+((?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?)/i)
    || goal.match(/\b((?:https?:\/\/)[^\s]+)\b/i);
  if (!openMatch) {
    return null;
  }

  return {
    type: "agent_plan",
    goal,
    risk_level: "low",
    summary_for_user: localText(responseLanguage, "openUrl", openMatch[1]),
    needs_clarification: false,
    requires_confirmation: false,
    will_submit: false,
    actions: [
      {
        id: "act_open_url_001",
        type: "open_url",
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

function buildRequestedClickPlan(goal, observation, responseLanguage) {
  if (!/\b(click|clicca|press|premi|open|apri)\b/i.test(goal)) {
    return null;
  }

  const wanted = extractRequestedElementName(goal);
  if (!wanted) {
    return null;
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
    return "";
  }

  const lastUserMessage = [...state.messages].reverse().find((message) => message.role === "user")?.text || plan.goal || "";
  const selectedHttpProvider = getSelectedHttpProvider();
  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.SYNTHESIS_REQUEST, {
    goal: lastUserMessage,
    responseLanguage: detectUserLanguage(lastUserMessage),
    provider: state.codex.provider,
    model: state.codex.model,
    httpProvider: selectedHttpProvider,
    observation: state.page.observation,
    userMemory: state.userMemory.items.map((item) => ({
      id: item.id,
      title: item.title,
      content: item.content,
      updatedAt: item.updatedAt
    })),
    results: results.map(stripLargeArtifactsForSynthesis)
  }));

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
    return `${total - failedCount} of ${total} action${total === 1 ? "" : "s"} completed. ${failedCount} need${failedCount === 1 ? "s" : ""} attention; see the expandable action details above.`;
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
  state.theme = stored.browserCompanionTheme || "system";

  if (!session?.privacy?.persistSession) {
    return;
  }

  state.privacy = session.privacy;
  state.codex = {
    provider: "openai-codex",
    model: "gpt-5.5",
    ...(session.codex || {})
  };
  state.attachments = session.attachments || [];
  state.messages = session.messages || state.messages;
  state.actionNotes = session.actionNotes || [];
  state.activity = session.activity || [];
}

async function restoreProviderSettings() {
  const stored = await chrome.storage.local.get(["browserCompanionProviderSettings"]);
  const settings = stored.browserCompanionProviderSettings || {};
  state.httpProviders = Array.isArray(settings.httpProviders) ? settings.httpProviders : [];
  state.connector.providers = normalizeProviderStatuses(state.connector.providers);
}

async function persistProviderSettings() {
  await chrome.storage.local.set({
    browserCompanionProviderSettings: {
      httpProviders: state.httpProviders
    }
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
      activity: state.activity.slice(0, 80)
    }
  });
}

function clearAttachments() {
  state.attachments = [];
  state.activity.unshift("Attachments cleared from local session memory.");
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
  state.confirmationText = "";
  state.actionNotes = [];
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
  if (plan?.will_submit || risk === "high") return "SUBMIT";
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
  if (/\b(cosa|vedi|compila|invia|accetta|pagina|campo|allega|modulo|devo|puoi|voglio|questa|questo|ricordati|salva|memorizza|ciao|chi|sei|sono|funzioni)\b/i.test(text)) {
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
      submitFound: `I found "${value}". This may submit, accept, send, or finalize something on the website. Type SUBMIT to enable the final action.`,
      fillSummary: `I can fill ${value} non-sensitive field${value === 1 ? "" : "s"} from local attachment context. I will not submit the form.`,
      openUrl: `I will open ${value}.`,
      openSearch: `I will open Google search results for "${value}".`,
      memorySaved: "Saved that to local user memory.",
      memorySaveFailed: "I could not save that to local user memory."
    },
    it: {
      needObservation: "Devo osservare la scheda corrente prima di aiutarti con questa pagina.",
      humanOnly: "Questa richiesta riguarda un flusso sensibile o da gestire manualmente, quindi mi fermo invece di automatizzarlo.",
      attachClearProfile: "Ho trovato un modulo, ma non riesco ad abbinare con sicurezza i dati allegati ai campi. Allega un file TXT, CSV, JSON, Markdown, PDF, DOCX, XLSX o immagine con etichette chiare.",
      noSubmitControl: "Non ho trovato un controllo di invio o accettazione nella pagina osservata.",
      submitFound: `Ho trovato "${value}". Potrebbe inviare, accettare, spedire o finalizzare qualcosa sul sito. Digita SUBMIT per abilitare l'azione finale.`,
      fillSummary: `Posso compilare ${value} camp${value === 1 ? "o non sensibile" : "i non sensibili"} usando il contesto degli allegati locali. Non inviero' il modulo.`,
      openUrl: `Apro ${value}.`,
      openSearch: `Apro i risultati Google per "${value}".`,
      memorySaved: "Salvato nella memoria utente locale.",
      memorySaveFailed: "Non sono riuscito a salvarlo nella memoria utente locale."
    }
  };

  return messages[language]?.[key] || messages.en[key];
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
