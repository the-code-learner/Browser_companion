import { MESSAGE_TYPES, makeEnvelope } from "../shared/messages.js";

const state = {
  connector: {
    status: "unknown",
    message: "Connector status has not been checked."
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
      text: "Tell me what you want to accomplish on the current page. I can observe the page first, then propose safe next steps."
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
    model: "gpt-5.5"
  },
  activity: []
};

const app = document.getElementById("app");

initialize();

async function initialize() {
  await restoreSession();
  render();
  checkConnector();
}

function render() {
  app.innerHTML = `
    <section class="topbar">
      <div>
        <h1>Browser Companion</h1>
        <p class="muted">Chat with a local browser agent that observes before acting.</p>
      </div>
      <span class="status ${getConnectorClass()}">${escapeHtml(state.connector.status)}</span>
    </section>

    <section class="page-strip" aria-label="Current page">
      <div>
        <span class="eyebrow">Current page</span>
        <strong>${escapeHtml(state.page.title)}</strong>
        <p>${escapeHtml(state.page.summary)}</p>
      </div>
      <button id="observe-page" type="button">Observe</button>
    </section>

    ${state.pendingPlan ? renderActionPreview() : ""}

    <section class="chat-log" aria-label="Chat messages">
      ${renderChatTimeline()}
    </section>

    <form id="chat-form" class="composer">
      <label class="file-input">
        <input id="attachment-input" type="file" multiple>
        <span>Attach</span>
      </label>
      <textarea id="chat-input" rows="3" placeholder="Describe your goal on this page"></textarea>
      <button type="submit">Send</button>
    </form>

    <section class="context-grid">
      <article>
        <div class="section-title">
          <h2>Attachments</h2>
          <span>${state.attachments.length}</span>
        </div>
        <ul class="compact-list">
          ${state.attachments.length ? state.attachments.map(renderAttachment).join("") : "<li>No files attached.</li>"}
        </ul>
        <button id="clear-attachments" type="button" class="wide-button">Clear Attachments</button>
      </article>

      <article>
        <div class="section-title">
          <h2>Connector</h2>
          <div class="button-row">
            <button id="check-connector" type="button">Check</button>
            <button id="connect-codex" type="button">Connect</button>
          </div>
        </div>
        <p>${escapeHtml(state.connector.message)}</p>
        <label class="field-stack">
          <span>Codex model</span>
          <select id="codex-model">
            ${renderModelOptions()}
          </select>
        </label>
        ${renderConnectorSetup()}
      </article>
    </section>

    <section class="privacy-panel">
      <div class="section-title">
        <h2>Privacy</h2>
        <button id="clear-session" type="button">Clear Session</button>
      </div>
      <label class="toggle-row">
        <input id="persist-session" type="checkbox" ${state.privacy.persistSession ? "checked" : ""}>
        <span>Persist this local session in Chrome storage</span>
      </label>
      <label class="toggle-row">
        <input id="send-attachments" type="checkbox" ${state.privacy.sendAttachmentsToCodex ? "checked" : ""}>
        <span>Allow extracted attachment text in Codex requests</span>
      </label>
    </section>

    <section class="activity">
      <div class="section-title">
        <h2>Activity</h2>
        <button id="clear-activity" type="button">Clear</button>
      </div>
      <ol>
        ${state.activity.length ? state.activity.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : "<li>No actions yet.</li>"}
      </ol>
    </section>
  `;

  document.getElementById("observe-page").addEventListener("click", observePage);
  document.getElementById("check-connector").addEventListener("click", checkConnector);
  document.getElementById("connect-codex").addEventListener("click", connectCodex);
  const copyInstallCommand = document.getElementById("copy-install-command");
  if (copyInstallCommand) {
    copyInstallCommand.addEventListener("click", copyConnectorInstallCommand);
  }
  const openExtensions = document.getElementById("open-extensions");
  if (openExtensions) {
    openExtensions.addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions" }));
  }
  document.getElementById("codex-model").addEventListener("change", (event) => {
    state.codex.model = event.target.value;
    state.activity.unshift(`Codex model set to ${state.codex.model}.`);
    persistSession();
    render();
  });
  document.getElementById("clear-activity").addEventListener("click", () => {
    state.activity = [];
    persistSession();
    render();
  });
  document.getElementById("clear-attachments").addEventListener("click", clearAttachments);
  document.getElementById("clear-session").addEventListener("click", clearSession);
  document.getElementById("persist-session").addEventListener("change", (event) => {
    state.privacy.persistSession = event.target.checked;
    persistSession();
    render();
  });
  document.getElementById("send-attachments").addEventListener("change", (event) => {
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
      <p>${escapeHtml(message.text)}</p>
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
  return `
    <li>
      <strong>${escapeHtml(file.name)}</strong>
      <span>${escapeHtml(file.status)} - ${formatBytes(file.size)}</span>
    </li>
  `;
}

function renderModelOptions() {
  const models = [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.2"
  ];

  return models.map((model) => {
    const selected = model === state.codex.model ? "selected" : "";
    return `<option value="${escapeHtml(model)}" ${selected}>${escapeHtml(model)}</option>`;
  }).join("");
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

function getConnectorInstallCommand() {
  return `powershell -ExecutionPolicy Bypass -File native-host/install-windows.ps1 -ExtensionId ${chrome.runtime.id}`;
}

async function observePage() {
  state.page.status = "observing";
  state.page.summary = "Observing the active tab...";
  render();

  const permission = await ensureCurrentSitePermission();

  if (!permission.ok) {
    state.page.status = "error";
    state.page.summary = permission.error;
    state.activity.unshift(`Observation blocked: ${permission.error}`);
    render();
    return null;
  }

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.OBSERVE_ACTIVE_TAB));

  if (!response.ok) {
    state.page.status = "error";
    state.page.summary = response.error;
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
  state.activity.unshift(`Observed ${state.page.title}.`);
  render();
  return observation;
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

async function checkConnector() {
  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.NATIVE_HEALTH));

  if (!response.ok) {
    state.connector = {
      status: "error",
      message: response.error
    };
    render();
    return;
  }

  const status = response.envelope.payload;
  state.connector = {
    status: status.connected ? "connected" : status.status,
    message: status.message || "Local connector status received."
  };
  render();
}

async function connectCodex() {
  state.connector = {
    status: "connecting",
    message: "Starting the local ChatGPT/Codex sign-in flow..."
  };
  render();

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.CONNECT_CODEX));

  if (!response.ok) {
    state.connector = {
      status: "missing",
      message: response.error
    };
    render();
    return;
  }

  const status = response.envelope.payload;
  state.connector = {
    status: status.connected ? "connected" : status.status,
    message: status.message || "Connector response received."
  };
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
    warnings: []
  };

  if (file.size > 15 * 1024 * 1024) {
    return {
      ...base,
      status: "too large",
      warnings: ["Files larger than 15 MB are not extracted in the side panel."]
    };
  }

  const extracted = await extractAttachmentViaBridge(file, base.id);

  if (extracted) {
    return {
      ...base,
      status: extracted.status || "text ready",
      text: extracted.text || "",
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

  state.messages.push({ role: "user", text });
  input.value = "";
  render();

  if (!state.page.observation) {
    await observePage();
  }

  const agentResult = await getAgentResult(text);
  handleAgentResult(agentResult);
}

async function getAgentResult(goal) {
  const responseLanguage = detectUserLanguage(goal);

  if (state.connector.status === "connected") {
    const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.AGENT_REQUEST, {
      goal,
      responseLanguage,
      model: state.codex.model,
      observation: state.page.observation,
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

    state.activity.unshift(`Codex request failed: ${response.error}`);
  }

  return buildLocalAgentResult(goal, responseLanguage);
}

async function handleAgentResult(result) {
  if (result?.type === "agent_plan") {
    const policyResponse = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.VALIDATE_ACTION_PLAN, { plan: result }));
    state.confirmationText = "";
    state.messages.push({
      role: "assistant",
      text: result.summary_for_user
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
    state.messages.push({ role: "assistant", text: result.question });
    render();
    return;
  }

  if (result?.type === "stop_for_human") {
    state.messages.push({ role: "assistant", text: result.reason });
    state.activity.unshift("Automation stopped for human action.");
    render();
    return;
  }

  if (result?.type === "agent_unavailable" || result?.type === "agent_error") {
    state.messages.push({
      role: "assistant",
      text: result.message || "The local Codex connector is not ready, so I used only local page context."
    });
    state.activity.unshift("Codex agent was unavailable.");
    render();
    return;
  }

  state.messages.push({
    role: "assistant",
    text: result?.text || "I could not produce a safe browser action from that request yet."
  });
  render();
}

async function confirmPendingPlan() {
  const plan = state.pendingPlan;

  if (!plan) {
    return;
  }

  state.pendingPlan = null;
  state.pendingPolicy = null;
  state.confirmationText = "";
  await executeActionPlan(plan);
}

async function executeActionPlan(plan) {
  state.activity.unshift("Executing browser action plan...");
  addActionNote("Executing browser actions", plan.actions.map(formatActionDetail));
  render();

  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.EXECUTE_ACTION_PLAN, { plan }));

  if (!response.ok) {
    state.messages.push({ role: "assistant", text: response.error });
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

  for (const artifact of httpArtifacts) {
    state.messages.push({
      role: "assistant",
      text: summarizeHttpArtifact(artifact)
    });
  }

  state.messages.push({
    role: "assistant",
    text: results.every((result) => result.status === "success")
      ? "The browser actions were completed."
      : "Some browser actions could not be completed. Check the activity log for details."
  });
  await observePage();
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
  const preview = String(artifact.bodyPreview || "").slice(0, 1200);
  const headerLines = Object.entries(artifact.headers || {})
    .filter(([key]) => ["content-type", "server", "location", "cache-control", "x-robots-tag"].includes(key.toLowerCase()))
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  return [
    `HTTP ${artifact.statusCode} ${artifact.finalUrl || artifact.url}`,
    artifact.contentType ? `Content-Type: ${artifact.contentType}` : "",
    headerLines ? `Headers:\n${headerLines}` : "",
    preview ? `Body preview:\n${preview}` : ""
  ].filter(Boolean).join("\n\n");
}

async function restoreSession() {
  const stored = await chrome.storage.local.get(["browserCompanionSession"]);
  const session = stored.browserCompanionSession;

  if (!session?.privacy?.persistSession) {
    return;
  }

  state.privacy = session.privacy;
  state.codex = session.codex || state.codex;
  state.attachments = session.attachments || [];
  state.messages = session.messages || state.messages;
  state.activity = session.activity || [];
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
      text: "Local session cleared. Tell me what you want to accomplish on the current page."
    }
  ];
  state.pendingPlan = null;
  state.pendingPolicy = null;
  state.confirmationText = "";
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

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectUserLanguage(text) {
  if (/\b(cosa|vedi|compila|invia|accetta|pagina|campo|allega|modulo|devo|puoi|voglio|questa|questo)\b/i.test(text)) {
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
      openSearch: `I will open Google search results for "${value}".`
    },
    it: {
      needObservation: "Devo osservare la scheda corrente prima di aiutarti con questa pagina.",
      humanOnly: "Questa richiesta riguarda un flusso sensibile o da gestire manualmente, quindi mi fermo invece di automatizzarlo.",
      attachClearProfile: "Ho trovato un modulo, ma non riesco ad abbinare con sicurezza i dati allegati ai campi. Allega un file TXT, CSV, JSON, Markdown, PDF, DOCX, XLSX o immagine con etichette chiare.",
      noSubmitControl: "Non ho trovato un controllo di invio o accettazione nella pagina osservata.",
      submitFound: `Ho trovato "${value}". Potrebbe inviare, accettare, spedire o finalizzare qualcosa sul sito. Digita SUBMIT per abilitare l'azione finale.`,
      fillSummary: `Posso compilare ${value} camp${value === 1 ? "o non sensibile" : "i non sensibili"} usando il contesto degli allegati locali. Non inviero' il modulo.`,
      openUrl: `Apro ${value}.`,
      openSearch: `Apro i risultati Google per "${value}".`
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
