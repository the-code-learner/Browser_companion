import { MESSAGE_TYPES, makeEnvelope } from "../shared/messages.js";
import { prefixUserMessageWithTimestamp } from "../shared/runtime-log.js";
import {
  DEEP_SEARCH_FETCH_LIMIT,
  DEEP_SEARCH_FETCHES_PER_DOMAIN_LIMIT,
  DEEP_SEARCH_FIRST_WAVE_QUERY_LIMIT,
  DEEP_SEARCH_REFINEMENT_ROUND_LIMIT,
  DEEP_SEARCH_RESULTS_PER_QUERY_LIMIT,
  DEEP_SEARCH_SECOND_WAVE_QUERY_LIMIT,
  DEEP_SEARCH_STORAGE_KEY,
  buildFallbackDeepSearchReport,
  collectFetchCandidates,
  normalizeDeepSearchRefinement,
  normalizeDeepSearchRun,
  upsertDeepSearchRunList,
  updateDeepSearchRun
} from "../shared/deep-search.js";

const app = document.getElementById("app");
const state = {
  runId: new URLSearchParams(window.location.search).get("run") || "",
  run: null,
  loading: true,
  orchestrationStarted: false,
  error: "",
  threadDraft: "",
  threadMode: "ask",
  threadBusy: false
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[DEEP_SEARCH_STORAGE_KEY] || !state.runId) {
    return;
  }

  const nextRuns = Array.isArray(changes[DEEP_SEARCH_STORAGE_KEY].newValue)
    ? changes[DEEP_SEARCH_STORAGE_KEY].newValue.map((run) => normalizeDeepSearchRun(run))
    : [];
  const matched = nextRuns.find((run) => run.id === state.runId);
  if (!matched) {
    return;
  }
  state.run = matched;
  render();
  bindThreadControls();
});

boot().catch((error) => {
  state.loading = false;
  state.error = error.message || "Deep Search could not start.";
  render();
});

async function boot() {
  if (!state.runId) {
    throw new Error("Missing Deep Search run id.");
  }

  const run = await loadRun(state.runId);
  if (!run) {
    throw new Error("Deep Search run was not found in local storage.");
  }

  state.run = run;
  state.loading = false;
  render();
  bindThreadControls();

  if (run.status === "queued" && !state.orchestrationStarted) {
    state.orchestrationStarted = true;
    await orchestrateRun();
  }
}

async function orchestrateRun() {
  let run = state.run;
  const userMemory = await loadUserMemory();
  const parentRun = run.parentRunId ? await loadRun(run.parentRunId) : null;
  const loggedGoal = run.userMessageLog || prefixUserMessageWithTimestamp(run.goal, run.createdAt || Date.now(), {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  });

  run = await saveRun(updateDeepSearchRun(run, {
    status: "running",
    phase: "planning",
    notes: appendNote(run.notes, "Started Deep Search planning.")
  }));

  const planResponse = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.DEEP_SEARCH_PLAN_REQUEST, {
    stage: "initial",
    goal: loggedGoal,
    responseLanguage: run.responseLanguage || "same language as the user",
    provider: run.providerSnapshot?.id || run.provider,
    model: run.providerSnapshot?.model || run.model,
    httpProvider: run.providerSnapshot?.httpProvider || null,
    followUpInstruction: run.followUpInstruction || "",
    reviewNotes: run.reviewNotes || [],
    priorReport: parentRun?.finalReport || null,
    priorSearchArtifacts: parentRun?.searchArtifacts || [],
    priorFetchedSources: parentRun?.fetchedSources || [],
    seedPageContext: run.seedContext?.page || null,
    userMemory
  }));

  if (!planResponse.ok || planResponse.envelope?.payload?.status !== "ok") {
    await failRun("planning", planResponse.error || planResponse.envelope?.payload?.message || "Deep Search planning failed.");
    return;
  }

  const plan = planResponse.envelope.payload.plan;
  run = await saveRun(updateDeepSearchRun(run, {
    phase: "collecting",
    plan,
    plannedQueries: plan.search_queries || [],
    desiredSections: plan.desired_sections || [],
    evaluationFocus: plan.evaluation_focus || [],
    constraints: plan.constraints || [],
    latestSummary: plan.objective || plan.title,
    notes: appendNote(run.notes, `Planned ${plan.search_queries.length} first-wave ${pluralize("query", plan.search_queries.length)}.`)
  }));

  run = await collectWave(
    run,
    run.plannedQueries.slice(0, DEEP_SEARCH_FIRST_WAVE_QUERY_LIMIT),
    { waveLabel: "first-wave" }
  );
  if (run.status === "failed_partial") {
    return;
  }

  for (let round = 1; round <= DEEP_SEARCH_REFINEMENT_ROUND_LIMIT; round += 1) {
    if (run.fetchedSources.length >= DEEP_SEARCH_FETCH_LIMIT) {
      run = await saveRun(updateDeepSearchRun(run, {
        phase: "synthesizing",
        notes: appendNote(run.notes, "Reached the Deep Search fetch cap; moving to synthesis.")
      }));
      break;
    }

    const refinementResponse = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.DEEP_SEARCH_PLAN_REQUEST, {
      stage: "refine",
      goal: loggedGoal,
      responseLanguage: run.responseLanguage || "same language as the user",
      provider: run.providerSnapshot?.id || run.provider,
      model: run.providerSnapshot?.model || run.model,
      httpProvider: run.providerSnapshot?.httpProvider || null,
      round,
      plan: run.plan,
      searchArtifacts: run.searchArtifacts,
      sources: run.fetchedSources.map((source) => ({
        url: source.url,
        title: source.title,
        snippet: source.snippet || source.bodyPreview,
        statusCode: source.statusCode
      }))
    }));

    const refinement = refinementResponse.ok && refinementResponse.envelope?.payload?.status === "ok"
      ? normalizeDeepSearchRefinement(refinementResponse.envelope.payload.refinement)
      : { additional_queries: [], rationale: "", stop_early: false };

    run = await saveRun(updateDeepSearchRun(run, {
      phase: refinement.stop_early ? "synthesizing" : "refining",
      refinementQueries: [...run.refinementQueries, ...(refinement.additional_queries || [])],
      notes: refinement.stop_early
        ? appendNote(run.notes, `Refinement round ${round} marked the evidence as sufficient.`)
        : appendNote(run.notes, refinement.additional_queries.length
          ? `Refinement round ${round} added ${refinement.additional_queries.length} follow-up ${pluralize("query", refinement.additional_queries.length)}.`
          : `Refinement round ${round} produced no additional queries.`)
    }));

    if (refinement.stop_early || !refinement.additional_queries.length) {
      break;
    }

    run = await collectWave(
      run,
      refinement.additional_queries.slice(0, DEEP_SEARCH_SECOND_WAVE_QUERY_LIMIT),
      { waveLabel: `refinement round ${round}` }
    );
    if (run.status === "failed_partial") {
      return;
    }
  }

  run = await saveRun(updateDeepSearchRun(run, {
    phase: "synthesizing",
    notes: appendNote(run.notes, "Building the final Deep Search report.")
  }));

  const reportResponse = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.DEEP_SEARCH_REPORT_REQUEST, {
    goal: loggedGoal,
    responseLanguage: run.responseLanguage || "same language as the user",
    provider: run.providerSnapshot?.id || run.provider,
    model: run.providerSnapshot?.model || run.model,
    httpProvider: run.providerSnapshot?.httpProvider || null,
    plan: run.plan,
    searchArtifacts: run.searchArtifacts,
    fetchedSources: run.fetchedSources,
    userMemory
  }));

  if (!reportResponse.ok || reportResponse.envelope?.payload?.status !== "ok") {
    const fallback = buildFallbackDeepSearchReport(run);
    await saveRun(updateDeepSearchRun(run, {
      status: "failed_partial",
      phase: "failed_partial",
      finalReport: fallback,
      lastError: {
        phase: "synthesizing",
        message: reportResponse.error || reportResponse.envelope?.payload?.message || "Final report synthesis failed.",
        at: new Date().toISOString()
      },
      notes: appendNote(run.notes, "Final synthesis failed; rendered a partial fallback report instead.")
    }));
    return;
  }

  await saveRun(updateDeepSearchRun(run, {
    status: "completed",
    phase: "completed",
    finalReport: reportResponse.envelope.payload.report,
    notes: appendNote(run.notes, "Deep Search completed successfully.")
  }));
}

async function collectWave(run, queries = [], options = {}) {
  let nextRun = run;
  const waveLabel = String(options.waveLabel || "search wave");
  nextRun = await saveRun(updateDeepSearchRun(nextRun, {
    phase: "searching",
    notes: appendNote(nextRun.notes, `Starting ${waveLabel} with ${queries.length} ${pluralize("query", queries.length)}.`)
  }));

  for (const query of queries) {
    const searchResponse = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.WEB_SEARCH, {
      query,
      limit: DEEP_SEARCH_RESULTS_PER_QUERY_LIMIT
    }));

    if (!searchResponse.ok) {
      nextRun = await saveRun(updateDeepSearchRun(nextRun, {
        notes: appendNote(nextRun.notes, `Search failed for "${query}": ${searchResponse.error || "Unknown error"}.`)
      }));
      continue;
    }

    const payload = searchResponse.envelope?.payload || {};
    const searchArtifacts = [
      ...nextRun.searchArtifacts,
      {
        query,
        provider: "duckduckgo",
        searchedAt: new Date().toISOString(),
        results: Array.isArray(payload.results) ? payload.results.slice(0, DEEP_SEARCH_RESULTS_PER_QUERY_LIMIT) : []
      }
    ];

    nextRun = await saveRun(updateDeepSearchRun(nextRun, {
      searchArtifacts,
      latestSummary: payload.message || nextRun.latestSummary,
      notes: appendNote(nextRun.notes, `Collected ${payload.results?.length || 0} ${pluralize("result", payload.results?.length || 0)} for "${query}".`)
    }));
  }

  const usedUrls = new Set(nextRun.fetchedSources.map((source) => source.url));
  const candidates = collectFetchCandidates(nextRun.searchArtifacts, {
    maxTotal: DEEP_SEARCH_FETCH_LIMIT,
    maxPerDomain: DEEP_SEARCH_FETCHES_PER_DOMAIN_LIMIT
  }).filter((candidate) => candidate.url && !usedUrls.has(candidate.url));

  nextRun = await saveRun(updateDeepSearchRun(nextRun, {
    phase: "fetching",
    notes: appendNote(nextRun.notes, `${waveLabel} produced ${candidates.length} fetch candidate ${pluralize("page", candidates.length)} after dedupe.`)
  }));

  for (const candidate of candidates) {
    if (nextRun.fetchedSources.length >= DEEP_SEARCH_FETCH_LIMIT) {
      break;
    }

    const fetchResponse = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.HTTP_REQUEST, {
      url: candidate.url,
      method: "GET"
    }));

    if (!fetchResponse.ok) {
      nextRun = await saveRun(updateDeepSearchRun(nextRun, {
        notes: appendNote(nextRun.notes, `Fetch failed for ${candidate.url}: ${fetchResponse.error || "Unknown error"}.`)
      }));
      continue;
    }

    const payload = fetchResponse.envelope?.payload || {};
    const fetchedSources = [
      ...nextRun.fetchedSources,
      {
        url: payload.finalUrl || payload.url || candidate.url,
        title: candidate.title,
        domain: candidate.domain,
        status: payload.status,
        statusCode: payload.statusCode,
        snippet: candidate.snippet,
        bodyPreview: String(payload.bodyPreview || "").slice(0, 8000),
        fetchedAt: new Date().toISOString(),
        query: candidate.query
      }
    ];

    nextRun = await saveRun(updateDeepSearchRun(nextRun, {
      fetchedSources,
      latestSummary: `Fetched ${fetchedSources.length}/${DEEP_SEARCH_FETCH_LIMIT} sources so far across ${new Set(fetchedSources.map((source) => source.domain).filter(Boolean)).size} domains.`,
      notes: appendNote(nextRun.notes, `Fetched ${payload.statusCode || "?"} from ${candidate.url}.`)
    }));
  }

  return nextRun;
}

async function failRun(phase, message) {
  const run = state.run;
  const fallback = buildFallbackDeepSearchReport(run);
  await saveRun(updateDeepSearchRun(run, {
    status: "failed_partial",
    phase: "failed_partial",
    finalReport: fallback,
    lastError: {
      phase,
      message,
      at: new Date().toISOString()
    },
    notes: appendNote(run.notes, message || "Deep Search failed.")
  }));
}

async function loadUserMemory() {
  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.USER_MEMORY_GET, {})).catch(() => null);
  if (!response?.ok) {
    return [];
  }
  return Array.isArray(response.envelope?.payload?.items) ? response.envelope.payload.items : [];
}

async function loadRun(runId) {
  const stored = await chrome.storage.local.get([DEEP_SEARCH_STORAGE_KEY]);
  const runs = Array.isArray(stored[DEEP_SEARCH_STORAGE_KEY])
    ? stored[DEEP_SEARCH_STORAGE_KEY].map((run) => normalizeDeepSearchRun(run))
    : [];
  return runs.find((run) => run.id === runId) || null;
}

async function saveRun(run) {
  const stored = await chrome.storage.local.get([DEEP_SEARCH_STORAGE_KEY]);
  const runs = Array.isArray(stored[DEEP_SEARCH_STORAGE_KEY])
    ? stored[DEEP_SEARCH_STORAGE_KEY].map((item) => normalizeDeepSearchRun(item))
    : [];
  const nextRun = normalizeDeepSearchRun(run);
  const nextRuns = upsertDeepSearchRunList(runs, nextRun);
  await chrome.storage.local.set({
    [DEEP_SEARCH_STORAGE_KEY]: nextRuns
  });
  state.run = nextRun;
  render();
  bindThreadControls();
  return nextRun;
}

function appendNote(notes = [], note) {
  const text = String(note || "").trim();
  if (!text) {
    return notes || [];
  }
  return [text, ...(Array.isArray(notes) ? notes : [])].slice(0, 24);
}

function render() {
  if (state.loading) {
    app.innerHTML = `<section class="report-shell"><p class="muted">Loading Deep Search…</p></section>`;
    return;
  }

  if (state.error) {
    app.innerHTML = `<section class="report-shell"><p class="error-callout">${escapeHtml(state.error)}</p></section>`;
    return;
  }

  const run = state.run;
  const report = run.finalReport;
  const sources = report?.sources?.length ? report.sources : run.fetchedSources;
  app.innerHTML = `
    <section class="report-shell">
      <header class="hero">
        <div class="hero-copy">
          <span class="eyebrow">Browser Companion Deep Search</span>
          <h1>${escapeHtml(report?.title || run.plan?.title || run.goal || "Deep Search")}</h1>
          <p class="hero-summary">${escapeHtml(report?.executive_summary || run.plan?.objective || run.goal || "")}</p>
        </div>
        <div class="hero-meta">
          <span class="status-chip status-${escapeHtml(run.status)}">${escapeHtml(formatStatusLabel(run.status))}</span>
          <dl class="meta-grid">
            <div><dt>Provider</dt><dd>${escapeHtml(run.providerLabel || run.providerSnapshot?.label || run.provider || "Unknown")}</dd></div>
            <div><dt>Model</dt><dd>${escapeHtml(run.providerSnapshot?.model || run.model || "default")}</dd></div>
            <div><dt>Sources</dt><dd>${escapeHtml(String(run.fetchedSources.length))}</dd></div>
            <div><dt>Window</dt><dd>${escapeHtml(run.windowId == null ? "Unknown" : String(run.windowId))}</dd></div>
          </dl>
        </div>
      </header>

      <section class="grid two-up">
        <article class="panel">
          <h2>Objective</h2>
          <p>${escapeHtml(report?.objective || run.plan?.objective || run.goal)}</p>
        </article>
        <article class="panel">
          <h2>Methodology</h2>
          ${renderList(report?.methodology?.length ? report.methodology : buildMethodologyFallback(run))}
        </article>
      </section>

      <section class="grid findings-grid">
        ${(report?.key_findings?.length ? report.key_findings : buildFindingFallback(run)).map((item) => `
          <article class="finding-card">
            <h3>${escapeHtml(item.title || "Finding")}</h3>
            <p>${escapeHtml(item.summary || "")}</p>
            ${renderSourceLinks(item.source_urls || [])}
          </article>
        `).join("")}
      </section>

      <section class="grid main-grid">
        <div class="stack">
          <article class="panel prose">
            <h2>Detailed Sections</h2>
            ${(report?.sections?.length ? report.sections : buildSectionFallback(run)).map((section) => `
              <section class="report-section">
                <h3>${escapeHtml(section.heading || "Section")}</h3>
                <p>${escapeHtml(section.body || "")}</p>
                ${renderSourceLinks(section.source_urls || [])}
              </section>
            `).join("")}
          </article>

          <article class="panel">
            <h2>Sources</h2>
            <div class="sources-list">
              ${sources.length ? sources.map((source) => `
                <a class="source-item" href="${escapeAttribute(source.url)}" target="_blank" rel="noreferrer">
                  <strong>${escapeHtml(source.title || source.url)}</strong>
                  <span>${escapeHtml(source.snippet || source.bodyPreview || source.url)}</span>
                </a>
              `).join("") : `<p class="muted">No fetched sources yet.</p>`}
            </div>
          </article>

          <article class="panel thread-panel">
            <div class="thread-header">
              <div>
                <h2>Ask About This Research</h2>
                <p class="muted">Use Ask to navigate the existing findings. Use Refine to point out errors and launch a linked rerun.</p>
              </div>
              ${renderRunLineage(run)}
            </div>
            <div class="thread-mode-switch" role="tablist" aria-label="Research thread mode">
              <button type="button" class="thread-mode${state.threadMode === "ask" ? " active" : ""}" data-thread-mode="ask" aria-pressed="${state.threadMode === "ask" ? "true" : "false"}">Ask</button>
              <button type="button" class="thread-mode${state.threadMode === "refine" ? " active" : ""}" data-thread-mode="refine" aria-pressed="${state.threadMode === "refine" ? "true" : "false"}">Refine</button>
            </div>
            <div class="thread-messages">
              ${renderThreadMessages(run)}
            </div>
            <form id="thread-form" class="thread-form">
              <textarea id="thread-input" rows="3" placeholder="${escapeAttribute(state.threadMode === "ask"
                ? "Ask about these results, request a narrower view, or ask what seems weak."
                : "Tell Browser Companion what it missed, what was wrong, or how the next Deep Search should change.")}">${escapeHtml(state.threadDraft)}</textarea>
              <div class="thread-actions">
                <span class="muted">${escapeHtml(state.threadMode === "ask" ? "No new search. Uses the current Deep Search results." : "Creates a linked Deep Search rerun from this report.")}</span>
                <button type="submit" class="thread-submit" ${state.threadBusy ? "disabled" : ""}>${escapeHtml(state.threadBusy ? "Working..." : (state.threadMode === "ask" ? "Ask" : "Run Refined Search"))}</button>
              </div>
            </form>
          </article>
        </div>

        <aside class="stack">
          <article class="panel">
            <h2>Search Trail</h2>
            <div class="trail-list">
              ${run.searchArtifacts.length ? run.searchArtifacts.map((artifact) => `
                <div class="trail-item">
                  <strong>${escapeHtml(artifact.query)}</strong>
                  <span>${escapeHtml(`${artifact.results.length} result${artifact.results.length === 1 ? "" : "s"}`)}</span>
                </div>
              `).join("") : `<p class="muted">Searches have not started yet.</p>`}
            </div>
          </article>

          <article class="panel">
            <h2>Open Questions</h2>
            ${renderList(report?.open_questions?.length ? report.open_questions : buildOpenQuestionsFallback(run))}
          </article>

          <article class="panel">
            <h2>Run Notes</h2>
            ${renderList(run.notes.length ? run.notes : ["No orchestration notes yet."])}
          </article>
        </aside>
      </section>
    </section>
  `;
}

function bindThreadControls() {
  const form = document.getElementById("thread-form");
  const input = document.getElementById("thread-input");
  if (form) {
    form.addEventListener("submit", handleThreadSubmit);
  }
  if (input) {
    input.addEventListener("input", (event) => {
      state.threadDraft = event.target.value;
    });
  }
  document.querySelectorAll("[data-thread-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.threadMode = button.dataset.threadMode === "refine" ? "refine" : "ask";
      render();
      bindThreadControls();
    });
  });
}

async function handleThreadSubmit(event) {
  event.preventDefault();
  const text = String(state.threadDraft || "").trim();
  if (!text || state.threadBusy || !state.run) {
    return;
  }

  state.threadBusy = true;
  const createdAt = new Date().toISOString();
  const userMessage = {
    id: crypto.randomUUID(),
    role: "user",
    mode: state.threadMode,
    text,
    createdAt,
    status: "sent"
  };

  let run = await saveRun(updateDeepSearchRun(state.run, {
    threadMessages: [...(state.run.threadMessages || []), userMessage]
  }));
  state.threadDraft = "";

  try {
    if (state.threadMode === "refine") {
      await launchRefinedRun(run, userMessage);
      return;
    }

    const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.DEEP_SEARCH_CHAT_REQUEST, {
      goal: prefixUserMessageWithTimestamp(text, createdAt, {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      }),
      originalGoal: run.userMessageLog || run.goal,
      responseLanguage: run.responseLanguage || "same language as the user",
      provider: run.providerSnapshot?.id || run.provider,
      model: run.providerSnapshot?.model || run.model,
      httpProvider: run.providerSnapshot?.httpProvider || null,
      runStatus: run.status,
      report: run.finalReport || buildFallbackDeepSearchReport(run),
      fetchedSources: run.fetchedSources,
      searchArtifacts: run.searchArtifacts,
      threadMessages: toProviderThreadMessages(run.threadMessages || [])
    }));

    const assistantMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      mode: "ask",
      text: response.ok && response.envelope?.payload?.status === "ok"
        ? response.envelope.payload.text || "No answer returned."
        : (response.error || response.envelope?.payload?.message || "Deep Search follow-up failed."),
      createdAt: new Date().toISOString(),
      status: response.ok ? "sent" : "error"
    };

    run = await saveRun(updateDeepSearchRun(run, {
      threadMessages: [...(run.threadMessages || []), assistantMessage]
    }));
  } finally {
    state.threadBusy = false;
    render();
    bindThreadControls();
  }
}

async function launchRefinedRun(parentRun, feedbackMessage) {
  const feedbackText = prefixUserMessageWithTimestamp(feedbackMessage.text, feedbackMessage.createdAt, {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  });
  const childRun = normalizeDeepSearchRun({
    ...createChildRunFromParent(parentRun, feedbackText),
    threadMessages: [
      ...(parentRun.threadMessages || []),
      {
        id: crypto.randomUUID(),
        role: "assistant",
        mode: "refine",
        text: "Started a refined Deep Search run from the previous report and your feedback.",
        createdAt: new Date().toISOString(),
        status: "sent"
      }
    ]
  });
  const updatedParent = updateDeepSearchRun(parentRun, {
    followUpRuns: [...new Set([...(parentRun.followUpRuns || []), childRun.id])],
    reviewNotes: [...(parentRun.reviewNotes || []), feedbackText]
  });

  await persistRunPair(updatedParent, childRun);
  window.location.assign(`./index.html?run=${encodeURIComponent(childRun.id)}`);
}

function createChildRunFromParent(parentRun, feedbackText) {
  return {
    goal: parentRun.goal,
    provider: parentRun.provider,
    providerLabel: parentRun.providerLabel,
    model: parentRun.model,
    providerSnapshot: parentRun.providerSnapshot,
    windowId: parentRun.windowId,
    originTabId: parentRun.originTabId,
    responseLanguage: parentRun.responseLanguage,
    userMessageLog: parentRun.userMessageLog,
    seedContext: parentRun.seedContext,
    parentRunId: parentRun.id,
    followUpInstruction: feedbackText,
    reviewNotes: [...(parentRun.reviewNotes || []), feedbackText],
    threadMessages: parentRun.threadMessages || []
  };
}

async function persistRunPair(firstRun, secondRun) {
  const stored = await chrome.storage.local.get([DEEP_SEARCH_STORAGE_KEY]);
  let runs = Array.isArray(stored[DEEP_SEARCH_STORAGE_KEY])
    ? stored[DEEP_SEARCH_STORAGE_KEY].map((item) => normalizeDeepSearchRun(item))
    : [];
  runs = upsertDeepSearchRunList(runs, firstRun);
  runs = upsertDeepSearchRunList(runs, secondRun);
  await chrome.storage.local.set({
    [DEEP_SEARCH_STORAGE_KEY]: runs
  });
}

function renderThreadMessages(run) {
  const messages = Array.isArray(run.threadMessages) ? run.threadMessages : [];
  if (!messages.length) {
    return `<p class="muted">No local research thread yet. Ask something about the results or launch a refined rerun from here.</p>`;
  }

  return messages.map((message) => `
    <article class="thread-message ${message.role === "assistant" ? "assistant" : "user"}">
      <header>
        <strong>${escapeHtml(message.role === "assistant" ? "Companion" : (message.mode === "refine" ? "Refine request" : "Question"))}</strong>
        <span>${escapeHtml(formatThreadTimestamp(message.createdAt))}</span>
      </header>
      <p>${escapeHtml(message.text || "")}</p>
    </article>
  `).join("");
}

function renderRunLineage(run) {
  const bits = [];
  if (run.parentRunId) {
    bits.push(`<a class="lineage-link" href="./index.html?run=${encodeURIComponent(run.parentRunId)}">Parent run</a>`);
  }
  if (Array.isArray(run.followUpRuns) && run.followUpRuns.length) {
    bits.push(...run.followUpRuns.slice(-3).map((id, index) => `<a class="lineage-link" href="./index.html?run=${encodeURIComponent(id)}">Refined ${index + 1}</a>`));
  }
  if (!bits.length) {
    return "";
  }
  return `<div class="lineage-links">${bits.join("")}</div>`;
}

function toProviderThreadMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).slice(-16).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    text: message.role === "assistant"
      ? String(message.text || "")
      : prefixUserMessageWithTimestamp(message.text || "", message.createdAt, {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      }),
    createdAt: message.createdAt || ""
  }));
}

function formatThreadTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildMethodologyFallback(run) {
  return [
    `Ran ${run.searchArtifacts.length} web search ${pluralize("query", run.searchArtifacts.length)} against public search results.`,
    `Deduped candidate links before fetching up to ${DEEP_SEARCH_FETCH_LIMIT} public source pages.`,
    `Kept the run in the originating Chrome window ${run.windowId == null ? "?" : run.windowId}.`
  ];
}

function buildFindingFallback(run) {
  if (!run.fetchedSources.length) {
    return [{
      title: "Research still in progress",
      summary: "Deep Search has not collected enough public source material to form findings yet.",
      source_urls: []
    }];
  }

  return run.fetchedSources.slice(0, 4).map((source) => ({
    title: source.title || source.url,
    summary: source.snippet || source.bodyPreview.slice(0, 220),
    source_urls: [source.url]
  }));
}

function buildSectionFallback(run) {
  return [
    {
      heading: "Current Progress",
      body: run.latestSummary || "Deep Search is still collecting source material.",
      source_urls: []
    },
    {
      heading: "Evidence Collected So Far",
      body: run.fetchedSources.length
        ? `Fetched ${run.fetchedSources.length} public ${pluralize("page", run.fetchedSources.length)} after ${run.searchArtifacts.length} search ${pluralize("query", run.searchArtifacts.length)}.`
        : "No public pages have been fetched successfully yet.",
      source_urls: run.fetchedSources.slice(0, 4).map((source) => source.url)
    }
  ];
}

function buildOpenQuestionsFallback(run) {
  if (run.lastError?.message) {
    return [run.lastError.message];
  }
  if (run.status === "running") {
    return ["Deep Search is still in progress, so the final uncertainty notes are not ready yet."];
  }
  return ["No explicit open questions were recorded for this run."];
}

function renderList(items = []) {
  if (!items.length) {
    return `<p class="muted">None.</p>`;
  }
  return `<ul class="plain-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderSourceLinks(urls = []) {
  const safeUrls = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (!safeUrls.length) {
    return "";
  }
  return `
    <div class="source-links">
      ${safeUrls.map((url) => `<a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">${escapeHtml(formatDomain(url))}</a>`).join("")}
    </div>
  `;
}

function formatStatusLabel(status) {
  if (status === "completed") return "Completed";
  if (status === "failed_partial") return "Partial";
  if (status === "running") return "Running";
  return "Queued";
}

function formatDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

function pluralize(noun, count) {
  if (count === 1) {
    return noun;
  }
  if (/query$/i.test(noun)) {
    return noun.replace(/y$/i, "ies");
  }
  return `${noun}s`;
}

function sendRuntimeMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
