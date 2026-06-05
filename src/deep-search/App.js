import { MESSAGE_TYPES, makeEnvelope } from "../shared/messages.js";
import {
  DEEP_SEARCH_FETCH_LIMIT,
  DEEP_SEARCH_FETCHES_PER_DOMAIN_LIMIT,
  DEEP_SEARCH_FIRST_WAVE_QUERY_LIMIT,
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
  error: ""
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

  if (run.status === "queued" && !state.orchestrationStarted) {
    state.orchestrationStarted = true;
    await orchestrateRun();
  }
}

async function orchestrateRun() {
  let run = state.run;
  const userMemory = await loadUserMemory();

  run = await saveRun(updateDeepSearchRun(run, {
    status: "running",
    phase: "planning",
    notes: appendNote(run.notes, "Started Deep Search planning.")
  }));

  const planResponse = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.DEEP_SEARCH_PLAN_REQUEST, {
    stage: "initial",
    goal: run.goal,
    responseLanguage: run.responseLanguage || "same language as the user",
    provider: run.providerSnapshot?.id || run.provider,
    model: run.providerSnapshot?.model || run.model,
    httpProvider: run.providerSnapshot?.httpProvider || null,
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
    notes: appendNote(run.notes, `Planned ${plan.search_queries.length} first-wave query${plan.search_queries.length === 1 ? "" : "ies"}.`)
  }));

  run = await collectWave(run, run.plannedQueries.slice(0, DEEP_SEARCH_FIRST_WAVE_QUERY_LIMIT));
  if (run.status === "failed_partial") {
    return;
  }

  const refinementResponse = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.DEEP_SEARCH_PLAN_REQUEST, {
    stage: "refine",
    goal: run.goal,
    responseLanguage: run.responseLanguage || "same language as the user",
    provider: run.providerSnapshot?.id || run.provider,
    model: run.providerSnapshot?.model || run.model,
    httpProvider: run.providerSnapshot?.httpProvider || null,
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
    refinementQueries: refinement.additional_queries || [],
    notes: refinement.stop_early
      ? appendNote(run.notes, "Provider marked the evidence as sufficient; skipping second-wave search.")
      : appendNote(run.notes, refinement.additional_queries.length
        ? `Added ${refinement.additional_queries.length} second-wave query${refinement.additional_queries.length === 1 ? "" : "ies"}.`
        : "No second-wave queries were proposed.")
  }));

  if (!refinement.stop_early && refinement.additional_queries.length && run.fetchedSources.length < DEEP_SEARCH_FETCH_LIMIT) {
    run = await collectWave(run, refinement.additional_queries.slice(0, DEEP_SEARCH_SECOND_WAVE_QUERY_LIMIT));
    if (run.status === "failed_partial") {
      return;
    }
  }

  run = await saveRun(updateDeepSearchRun(run, {
    phase: "synthesizing",
    notes: appendNote(run.notes, "Building the final Deep Search report.")
  }));

  const reportResponse = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.DEEP_SEARCH_REPORT_REQUEST, {
    goal: run.goal,
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

async function collectWave(run, queries = []) {
  let nextRun = run;
  for (const query of queries.slice(0, DEEP_SEARCH_FIRST_WAVE_QUERY_LIMIT + DEEP_SEARCH_SECOND_WAVE_QUERY_LIMIT)) {
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
      notes: appendNote(nextRun.notes, `Collected ${payload.results?.length || 0} result${payload.results?.length === 1 ? "" : "s"} for "${query}".`)
    }));
  }

  const usedUrls = new Set(nextRun.fetchedSources.map((source) => source.url));
  const candidates = collectFetchCandidates(nextRun.searchArtifacts, {
    maxTotal: DEEP_SEARCH_FETCH_LIMIT,
    maxPerDomain: DEEP_SEARCH_FETCHES_PER_DOMAIN_LIMIT
  }).filter((candidate) => candidate.url && !usedUrls.has(candidate.url));

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

function buildMethodologyFallback(run) {
  return [
    `Ran ${run.searchArtifacts.length} web search query${run.searchArtifacts.length === 1 ? "" : "ies"} against public search results.`,
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
        ? `Fetched ${run.fetchedSources.length} public page${run.fetchedSources.length === 1 ? "" : "s"} after ${run.searchArtifacts.length} search query${run.searchArtifacts.length === 1 ? "" : "ies"}.`
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
