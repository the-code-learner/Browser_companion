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
  pendingPlan: null,
  pendingPolicy: null,
  activity: []
};

const app = document.getElementById("app");

render();
checkConnector();

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
      ${state.messages.map(renderMessage).join("")}
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
      </article>
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
  document.getElementById("clear-activity").addEventListener("click", () => {
    state.activity = [];
    render();
  });
  document.getElementById("attachment-input").addEventListener("change", handleAttachments);
  document.getElementById("chat-form").addEventListener("submit", handleChatSubmit);

  if (state.pendingPlan) {
    document.getElementById("confirm-plan").addEventListener("click", confirmPendingPlan);
    document.getElementById("cancel-plan").addEventListener("click", cancelPendingPlan);
  }
}

function renderMessage(message) {
  return `
    <article class="message ${message.role}">
      <span>${message.role === "user" ? "You" : "Companion"}</span>
      <p>${escapeHtml(message.text)}</p>
    </article>
  `;
}

function renderActionPreview() {
  const policy = state.pendingPolicy;
  const blocked = policy && !policy.allowed;
  const confirmation = policy?.requiresConfirmation ? "Confirmation required" : "Ready";

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
      <div class="preview-actions">
        <button id="cancel-plan" type="button">Cancel</button>
        <button id="confirm-plan" type="button" ${blocked ? "disabled" : ""}>Confirm</button>
      </div>
    </section>
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

async function observePage() {
  state.page.status = "observing";
  state.page.summary = "Observing the active tab...";
  render();

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
  render();
}

function readAttachment(file) {
  const textLike = /^text\/|json|csv|xml|markdown|javascript|typescript/i.test(file.type) || /\.(txt|md|csv|json|xml|html|css|js|ts)$/i.test(file.name);

  if (!textLike) {
    return Promise.resolve({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      type: file.type || "unknown",
      status: "registered",
      text: ""
    });
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        type: file.type || "text",
        status: "text ready",
        text: String(reader.result || "").slice(0, 30000)
      });
    };
    reader.onerror = () => {
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        type: file.type || "unknown",
        status: "read failed",
        text: ""
      });
    };
    reader.readAsText(file);
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
  if (state.connector.status === "connected") {
    const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.AGENT_REQUEST, {
      goal,
      observation: state.page.observation,
      attachments: state.attachments.map((file) => ({
        id: file.id,
        name: file.name,
        type: file.type,
        status: file.status,
        text: file.text
      }))
    }));

    if (response.ok) {
      return response.envelope.payload;
    }

    state.activity.unshift(`Codex request failed: ${response.error}`);
  }

  return buildLocalAgentResult(goal);
}

async function handleAgentResult(result) {
  if (result?.type === "agent_plan") {
    const policyResponse = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.VALIDATE_ACTION_PLAN, { plan: result }));
    state.pendingPlan = result;
    state.pendingPolicy = policyResponse.envelope.payload;
    state.messages.push({
      role: "assistant",
      text: result.summary_for_user
    });
    state.activity.unshift("Action plan prepared for confirmation.");
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

  state.activity.unshift("Executing confirmed action plan...");
  state.pendingPlan = null;
  state.pendingPolicy = null;
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
  state.messages.push({
    role: "assistant",
    text: results.every((result) => result.status === "success")
      ? "The confirmed browser actions were completed. I stopped before any submit-like final action."
      : "Some browser actions could not be completed. Check the activity log for details."
  });
  await observePage();
}

function cancelPendingPlan() {
  state.pendingPlan = null;
  state.pendingPolicy = null;
  state.activity.unshift("Action plan canceled.");
  render();
}

function buildLocalAgentResult(goal) {
  const observation = state.page.observation;
  const lowerGoal = goal.toLowerCase();

  if (!observation) {
    return {
      type: "ask_user",
      question: "I need to observe the current tab before I can help with that page."
    };
  }

  if (/\b(captcha|password|payment|card|delete account|sign contract)\b/i.test(goal)) {
    return {
      type: "stop_for_human",
      reason: "This request touches a human-only or sensitive flow, so I will stop instead of automating it."
    };
  }

  if (/\b(fill|complete|register|apply|form|profile)\b/i.test(lowerGoal)) {
    const plan = buildFormFillPlan(goal, observation);
    if (plan.actions.length > 0) {
      return plan;
    }

    return {
      type: "ask_user",
      question: "I found form context, but I could not confidently match attachment data to fields. Attach a text, CSV, JSON, or Markdown profile with clear labels."
    };
  }

  return {
    type: "natural_response",
    text: summarizePageForUser(observation)
  };
}

function buildFormFillPlan(goal, observation) {
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
    summary_for_user: `I can fill ${actions.length} non-sensitive field${actions.length === 1 ? "" : "s"} from local attachment context. I will not submit the form.`,
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

function summarizePageForUser(observation) {
  const headings = (observation.headings || []).map((heading) => heading.text).filter(Boolean).slice(0, 5);
  const fieldCount = observation.forms.reduce((total, form) => total + form.fields.length, 0);
  const headingText = headings.length ? ` Main sections: ${headings.join("; ")}.` : "";
  return `I observed the page: ${observation.links.length} links, ${observation.buttons.length} buttons, and ${fieldCount} form fields.${headingText}`;
}

function summarizeObservation(observation) {
  const fieldCount = observation.forms.reduce((total, form) => total + form.fields.length, 0);
  return `${observation.links.length} links, ${observation.buttons.length} buttons, ${fieldCount} fields, and ${observation.visible_text.length} characters of visible text captured.`;
}

function sendRuntimeMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function getConnectorClass() {
  if (state.connector.status === "connected") return "ok";
  if (state.connector.status === "unknown" || state.connector.status === "connecting") return "neutral";
  return "warn";
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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
