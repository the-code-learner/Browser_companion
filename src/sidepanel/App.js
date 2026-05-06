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
          <button id="check-connector" type="button">Check</button>
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
  document.getElementById("clear-activity").addEventListener("click", () => {
    state.activity = [];
    render();
  });
  document.getElementById("attachment-input").addEventListener("change", handleAttachments);
  document.getElementById("chat-form").addEventListener("submit", handleChatSubmit);
}

function renderMessage(message) {
  return `
    <article class="message ${message.role}">
      <span>${message.role === "user" ? "You" : "Companion"}</span>
      <p>${escapeHtml(message.text)}</p>
    </article>
  `;
}

function renderAttachment(file) {
  return `
    <li>
      <strong>${escapeHtml(file.name)}</strong>
      <span>${escapeHtml(file.status)} · ${formatBytes(file.size)}</span>
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
    return;
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

function handleChatSubmit(event) {
  event.preventDefault();
  const input = document.getElementById("chat-input");
  const text = input.value.trim();

  if (!text) {
    return;
  }

  state.messages.push({ role: "user", text });
  state.messages.push({
    role: "assistant",
    text: getMvpAssistantReply()
  });
  state.activity.unshift("User message queued for future Codex session.");
  input.value = "";
  render();
}

function getMvpAssistantReply() {
  if (!state.page.observation) {
    return "I need a page observation before I can reason over the current tab. Use Observe, then send the goal again.";
  }

  if (state.connector.status !== "connected") {
    return "The local Codex connector is not connected yet. I can show observed page context now, and real agent planning will start once the connector is installed and signed in.";
  }

  return "Connector support is ready, but live Codex planning is not wired in this scaffold yet.";
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
  if (state.connector.status === "unknown") return "neutral";
  return "warn";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

