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
const DEEP_SEARCH_GEOCODE_CACHE_KEY = "browserCompanionDeepSearchGeoCache";
const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_DELAY_MS = 1100;
let leafletModulePromise = null;
const initialParams = new URLSearchParams(window.location.search);
const state = {
  runId: initialParams.get("run") || "",
  run: null,
  loading: true,
  orchestrationStarted: false,
  error: "",
  threadDraft: "",
  threadMode: "ask",
  threadBusy: false,
  selectedView: normalizeViewMode(initialParams.get("view") || "auto"),
  mapHydrationToken: "",
  layoutMode: initialParams.get("layout") === "print" ? "print" : "default"
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
  bindInteractiveControls();
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
  bindInteractiveControls();

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
    const metadata = extractFetchedPageMetadata(payload, candidate);
    const fetchedSources = [
      ...nextRun.fetchedSources,
      {
        url: payload.finalUrl || payload.url || candidate.url,
        title: metadata.title || candidate.title,
        domain: metadata.domain || candidate.domain,
        status: payload.status,
        statusCode: payload.statusCode,
        snippet: candidate.snippet,
        bodyPreview: String(payload.bodyPreview || "").slice(0, 16000),
        fetchedAt: new Date().toISOString(),
        query: candidate.query,
        siteName: metadata.siteName,
        canonicalUrl: metadata.canonicalUrl,
        description: metadata.description,
        heroImageUrl: metadata.heroImageUrl,
        imageCandidates: metadata.imageCandidates,
        publishedAt: metadata.publishedAt,
        locationHints: metadata.locationHints
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
  bindInteractiveControls();
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
  const report = getRenderableReport(run);
  const collections = getRenderableCollections(run, report);
  const sources = getRenderableSources(run, report);
  const media = getRenderableMedia(run, report, sources);
  const documentView = getRenderableDocument(run, report, media);
  const mapEntries = getRenderableMapData(run, report, collections);
  const viewOptions = getRenderableViews(report, collections, mapEntries, documentView);
  const activeView = resolveActiveView(viewOptions, report?.presentation?.primary_view || "report");
  const findings = report?.key_findings?.length ? report.key_findings : buildFindingFallback(run);
  const sections = report?.sections?.length ? report.sections : buildSectionFallback(run);
  const openQuestions = report?.open_questions?.length ? report.open_questions : buildOpenQuestionsFallback(run);
  state.renderContext = {
    report,
    collections,
    sources,
    media,
    documentView,
    mapEntries,
    activeView,
    viewOptions
  };

  if (state.layoutMode === "print") {
    app.innerHTML = renderPrintLayout({
      run,
      report,
      documentView,
      media
    });
    return;
  }

  app.innerHTML = `
    <section class="report-shell">
      <header class="hero">
        <div class="hero-copy">
          <span class="eyebrow">Browser Companion Deep Search</span>
          <h1>${escapeHtml(report?.title || run.plan?.title || run.goal || "Deep Search")}</h1>
          <p class="hero-summary">${escapeHtml(report?.executive_summary || run.plan?.objective || run.goal || "")}</p>
        </div>
        <div class="hero-meta">
          <div class="hero-status-row">
            <span class="status-chip status-${escapeHtml(run.status)}">${escapeHtml(formatStatusLabel(run.status))}</span>
            ${report?.presentation?.print_ready ? `<button type="button" class="secondary-button" id="open-print-view-button">Open Print View</button>` : ""}
          </div>
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

      <section class="panel view-switcher-panel">
        <div>
          <h2>View</h2>
          <p class="muted">Auto follows the model's preferred format. You can switch the same run between report, list, map, and print views.</p>
        </div>
        <div class="view-switcher" role="tablist" aria-label="Deep Search view mode">
          ${renderViewButton("auto", "Auto")}
          ${viewOptions.includes("report") ? renderViewButton("report", "Report") : ""}
          ${viewOptions.includes("hybrid") ? renderViewButton("hybrid", "Hybrid") : ""}
          ${viewOptions.includes("list") ? renderViewButton("list", "List") : ""}
          ${viewOptions.includes("map") ? renderViewButton("map", "Map") : ""}
        </div>
      </section>

      <section class="grid main-grid">
        <div class="stack">
          ${renderPrimarySurface(activeView, {
            run,
            report,
            collections,
            sources,
            media,
            documentView,
            mapEntries,
            findings,
            sections
          })}

          <article class="panel">
            <h2>Sources</h2>
            <div class="sources-list">
              ${sources.length ? sources.map((source) => `
                <a class="source-item" href="${escapeAttribute(source.url)}" target="_blank" rel="noreferrer">
                  <div class="source-item-copy">
                    <strong>${escapeHtml(source.title || source.url)}</strong>
                    <span>${escapeHtml(source.siteName || formatDomain(source.url))}</span>
                    <span>${escapeHtml(source.snippet || source.description || source.bodyPreview || source.url)}</span>
                  </div>
                  ${source.heroImageUrl ? `<img class="source-thumb" src="${escapeAttribute(source.heroImageUrl)}" alt="${escapeAttribute(source.title || "Source image")}">` : ""}
                </a>
              `).join("") : `<p class="muted">No fetched sources yet.</p>`}
            </div>
          </article>

          ${media.length ? `
            <article class="panel">
              <h2>Images</h2>
              <div class="media-grid">
                ${media.map((item) => `
                  <a class="media-card" href="${escapeAttribute(item.source_url || item.url)}" target="_blank" rel="noreferrer">
                    <img src="${escapeAttribute(item.url)}" alt="${escapeAttribute(item.alt || item.caption || "Deep Search image")}">
                    <div class="media-card-copy">
                      <strong>${escapeHtml(item.caption || item.alt || formatDomain(item.source_url || item.url))}</strong>
                      <span>${escapeHtml(item.source_url ? formatDomain(item.source_url) : "")}</span>
                    </div>
                  </a>
                `).join("")}
              </div>
            </article>
          ` : ""}

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
            ${renderList(openQuestions)}
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

function bindInteractiveControls() {
  const form = document.getElementById("thread-form");
  const input = document.getElementById("thread-input");
  const openPrintViewButton = document.getElementById("open-print-view-button");
  const printNowButton = document.getElementById("print-now-button");
  const printBackButton = document.getElementById("print-back-button");
  if (form) {
    form.addEventListener("submit", handleThreadSubmit);
  }
  if (input) {
    input.addEventListener("input", (event) => {
      state.threadDraft = event.target.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      event.preventDefault();
      form?.requestSubmit();
    });
  }
  document.querySelectorAll("[data-thread-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.threadMode = button.dataset.threadMode === "refine" ? "refine" : "ask";
      render();
      bindInteractiveControls();
    });
  });
  document.querySelectorAll("[data-view-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedView = normalizeViewMode(button.dataset.viewMode || "auto");
      syncUrlState();
      render();
      bindInteractiveControls();
    });
  });
  if (openPrintViewButton) {
    openPrintViewButton.addEventListener("click", () => {
      const printUrl = buildRunUrl(state.runId, {
        layout: "print",
        view: "print"
      });
      window.open(printUrl, "_blank", "noopener,noreferrer");
    });
  }
  if (printNowButton) {
    printNowButton.addEventListener("click", () => window.print());
  }
  if (printBackButton) {
    printBackButton.addEventListener("click", () => {
      state.layoutMode = "default";
      state.selectedView = "print";
      syncUrlState();
      render();
      bindInteractiveControls();
    });
  }
  void hydrateMaps();
}

function getRenderableReport(run) {
  return run.finalReport || buildFallbackDeepSearchReport(run);
}

function getRenderableSources(run, report) {
  return report?.sources?.length ? report.sources : run.fetchedSources;
}

function getRenderableCollections(run, report) {
  if (report?.collections?.length) {
    return report.collections;
  }

  const sourceItems = run.fetchedSources.slice(0, 30).map((source, index) => ({
    id: `source-${index + 1}`,
    label: source.title || source.url,
    title: source.title || source.url,
    description: source.description || source.snippet || source.bodyPreview.slice(0, 220),
    primary_url: source.url,
    evidence_note: source.snippet || "",
    tags: [source.domain].filter(Boolean),
    source_urls: [source.url],
    fields: {
      domain: source.domain || "",
      query: source.query || "",
      status: source.statusCode == null ? "" : String(source.statusCode)
    },
    links: [
      {
        label: "Source",
        type: "source",
        url: source.url
      }
    ]
  })).filter((item) => item.primary_url);

  if (!sourceItems.length) {
    return [];
  }

  return [
    {
      id: "fallback-results",
      title: "Collected Sources",
      description: "Source-derived list built from the pages fetched during this run.",
      record_type: "source",
      columns: [
        { key: "title", label: "Title", kind: "text" },
        { key: "domain", label: "Domain", kind: "text" },
        { key: "query", label: "Query", kind: "text" },
        { key: "status", label: "Status", kind: "text" }
      ],
      items: sourceItems,
      source_urls: sourceItems.flatMap((item) => item.source_urls).slice(0, 20)
    }
  ];
}

function getRenderableMedia(run, report, sources) {
  if (report?.media?.length) {
    return report.media;
  }
  if (report?.document?.selected_images?.length) {
    return report.document.selected_images;
  }
  return (sources || []).flatMap((source, index) => {
    if (!source.heroImageUrl) {
      return [];
    }
    return [{
      id: `hero-${index + 1}`,
      kind: "image",
      url: source.heroImageUrl,
      alt: source.title || source.siteName || "Source image",
      caption: source.description || source.snippet || "",
      source_url: source.url
    }];
  }).slice(0, 6);
}

function getRenderableDocument(run, report, media) {
  if (report?.document) {
    return report.document;
  }

  const sections = report?.sections?.length ? report.sections : buildSectionFallback(run);
  const findings = report?.key_findings?.length ? report.key_findings : buildFindingFallback(run);
  const chapters = [
    {
      id: "chapter-summary",
      heading: "Executive Summary",
      summary: report?.executive_summary || run.latestSummary || "",
      body: report?.objective || run.goal,
      source_urls: []
    },
    ...sections.map((section, index) => ({
      id: `chapter-${index + 1}`,
      heading: section.heading || `Section ${index + 1}`,
      summary: findings[index]?.summary || "",
      body: section.body || "",
      source_urls: section.source_urls || [],
      image_urls: media.slice(index, index + 1).map((item) => item.url)
    }))
  ];

  return {
    title: report?.title || run.goal || "Deep Search document",
    subtitle: report?.objective || run.plan?.objective || "",
    toc: chapters.map((chapter) => ({
      id: chapter.id,
      label: chapter.heading
    })),
    chapters,
    appendix: (run.notes || []).slice(0, 6).map((note, index) => ({
      id: `appendix-${index + 1}`,
      heading: `Run note ${index + 1}`,
      body: note
    })),
    selected_images: media
  };
}

function getRenderableMapData(run, report, collections) {
  if (report?.map_data?.length) {
    return report.map_data;
  }

  const points = collections.flatMap((collection, collectionIndex) => {
    return (collection.items || []).flatMap((item, itemIndex) => {
      const location = item.location || {};
      if (!location.label && !location.address && !location.query) {
        return [];
      }
      return [{
        id: `${collection.id || collectionIndex}-point-${item.id || itemIndex}`,
        label: item.title || item.label || location.label,
        note: item.evidence_note || item.description || collection.title || "",
        source_url: item.source_urls?.[0] || item.primary_url || "",
        primary_url: item.primary_url || item.links?.[0]?.url || "",
        lat: null,
        lng: null,
        location
      }];
    });
  }).slice(0, 20);

  if (!points.length) {
    return [];
  }

  return [{
    id: "derived-map",
    title: "Mapped results",
    description: "Locations inferred from the result list.",
    points,
    bounds: null,
    source_urls: points.map((point) => point.source_url).filter(Boolean).slice(0, 20)
  }];
}

function getRenderableViews(report, collections, mapEntries, documentView) {
  const views = new Set(["report"]);
  if (collections.length) {
    views.add("list");
  }
  if (collections.length && (report?.sections?.length || report?.key_findings?.length)) {
    views.add("hybrid");
  }
  if (mapEntries.some((entry) => entry.points?.length)) {
    views.add("map");
  }
  if (documentView) {
    views.add("print");
  }
  return Array.from(views);
}

function resolveActiveView(viewOptions, primaryView) {
  if (state.layoutMode !== "print" && state.selectedView === "print") {
    state.selectedView = "auto";
  }
  const preferred = state.selectedView === "auto"
    ? primaryView
    : state.selectedView;
  if (preferred && viewOptions.includes(preferred)) {
    return preferred;
  }
  if (primaryView && viewOptions.includes(primaryView)) {
    return primaryView;
  }
  return viewOptions[0] || "report";
}

function renderViewButton(mode, label) {
  const selected = state.selectedView === mode;
  return `<button type="button" class="view-button${selected ? " active" : ""}" data-view-mode="${escapeAttribute(mode)}" aria-pressed="${selected ? "true" : "false"}">${escapeHtml(label)}</button>`;
}

function renderPrimarySurface(activeView, context) {
  if (activeView === "list") {
    return renderCollectionsPanel(context.collections);
  }
  if (activeView === "map") {
    return renderMapPanels(context.mapEntries, context.collections);
  }
  if (activeView === "print") {
    return renderPrintDocument(context.documentView);
  }
  if (activeView === "hybrid") {
    return [
      renderFindingsGrid(context.findings),
      renderSectionsPanel(context.sections),
      renderCollectionsPanel(context.collections)
    ].join("");
  }
  return [
    renderFindingsGrid(context.findings),
    renderSectionsPanel(context.sections)
  ].join("");
}

function renderFindingsGrid(findings = []) {
  return `
    <section class="grid findings-grid">
      ${findings.map((item) => `
        <article class="finding-card">
          <h3>${escapeHtml(item.title || "Finding")}</h3>
          <p>${escapeHtml(item.summary || "")}</p>
          ${renderSourceLinks(item.source_urls || [])}
        </article>
      `).join("")}
    </section>
  `;
}

function renderSectionsPanel(sections = []) {
  return `
    <article class="panel prose">
      <h2>Detailed Sections</h2>
      ${sections.map((section) => `
        <section class="report-section">
          <h3>${escapeHtml(section.heading || "Section")}</h3>
          <div class="rich-prose">${renderRichText(section.body || "")}</div>
          ${renderSourceLinks(section.source_urls || [])}
        </section>
      `).join("")}
    </article>
  `;
}

function renderCollectionsPanel(collections = []) {
  if (!collections.length) {
    return `
      <article class="panel">
        <h2>Result List</h2>
        <p class="muted">No structured result list was produced for this run.</p>
      </article>
    `;
  }

  return collections.map((collection) => {
    const columns = deriveCollectionColumns(collection);
    return `
      <article class="panel list-panel">
        <div class="panel-header">
          <div>
            <h2>${escapeHtml(collection.title || "Results")}</h2>
            <p class="muted">${escapeHtml(collection.description || `${collection.items.length} records`)}</p>
          </div>
          <span class="collection-count">${escapeHtml(String(collection.items.length))}</span>
        </div>
        <div class="records-table-wrap">
          <table class="records-table">
            <thead>
              <tr>
                ${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}
              </tr>
            </thead>
            <tbody>
              ${collection.items.map((item) => `
                <tr>
                  ${columns.map((column) => `<td>${renderCollectionCell(item, column)}</td>`).join("")}
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
        <div class="record-cards">
          ${collection.items.map((item) => renderCollectionCard(item, columns)).join("")}
        </div>
      </article>
    `;
  }).join("");
}

function deriveCollectionColumns(collection) {
  if (Array.isArray(collection.columns) && collection.columns.length) {
    return collection.columns;
  }

  const firstItem = collection.items?.[0];
  const fieldKeys = firstItem ? Object.keys(firstItem.fields || {}).slice(0, 4) : [];
  return [
    { key: "title", label: "Title", kind: "text" },
    ...fieldKeys.map((key) => ({ key, label: key, kind: "text" })),
    { key: "links", label: "Links", kind: "link" }
  ];
}

function renderCollectionCell(item, column) {
  const key = column.key;
  if (key === "title") {
    return `
      <div class="record-title-cell">
        <strong>${item.primary_url ? `<a href="${escapeAttribute(item.primary_url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title || item.label || "Untitled")}</a>` : escapeHtml(item.title || item.label || "Untitled")}</strong>
        ${item.description ? `<span>${escapeHtml(item.description)}</span>` : ""}
      </div>
    `;
  }
  if (key === "links") {
    return renderCollectionLinks(item.links || [], item.primary_url);
  }
  const value = item.fields?.[key] || "";
  if (!value && key === "location") {
    return escapeHtml(item.location?.label || item.location?.address || item.location?.query || "");
  }
  return value ? escapeHtml(value) : `<span class="muted">—</span>`;
}

function renderCollectionCard(item, columns) {
  return `
    <article class="record-card">
      <div class="record-card-header">
        <strong>${item.primary_url ? `<a href="${escapeAttribute(item.primary_url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title || item.label || "Untitled")}</a>` : escapeHtml(item.title || item.label || "Untitled")}</strong>
        ${item.tags?.length ? `<div class="tag-row">${item.tags.map((tag) => `<span class="tag-pill">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      </div>
      ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
      <dl class="record-meta">
        ${columns.filter((column) => !["title", "links"].includes(column.key)).map((column) => {
          const value = item.fields?.[column.key] || (column.key === "location" ? (item.location?.label || item.location?.address || item.location?.query || "") : "");
          if (!value) {
            return "";
          }
          return `<div><dt>${escapeHtml(column.label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
        }).join("")}
      </dl>
      ${item.evidence_note ? `<p class="muted">${escapeHtml(item.evidence_note)}</p>` : ""}
      ${renderCollectionLinks(item.links || [], item.primary_url)}
    </article>
  `;
}

function renderCollectionLinks(links = [], primaryUrl = "") {
  const safeLinks = Array.isArray(links) ? links.filter((link) => link?.url) : [];
  const deduped = primaryUrl && !safeLinks.some((link) => link.url === primaryUrl)
    ? [{ label: "Open", type: "primary", url: primaryUrl }, ...safeLinks]
    : safeLinks;
  if (!deduped.length) {
    return `<span class="muted">No direct links.</span>`;
  }
  return `<div class="record-links">${deduped.map((link) => `<a href="${escapeAttribute(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label || link.type || "Link")}</a>`).join("")}</div>`;
}

function renderPrintLayout({ run, report, documentView, media }) {
  return `
    <section class="print-layout-shell">
      <header class="print-layout-toolbar">
        <div class="print-layout-copy">
          <span class="eyebrow">Printable Document</span>
          <h1>${escapeHtml(documentView?.title || report?.title || run.goal || "Deep Search document")}</h1>
          <p class="muted">${escapeHtml(documentView?.subtitle || report?.objective || run.plan?.objective || "")}</p>
        </div>
        <div class="print-layout-actions">
          <button type="button" class="secondary-button" id="print-back-button">Back to Report</button>
          <button type="button" class="thread-submit" id="print-now-button">Print / Save PDF</button>
        </div>
      </header>
      <section class="print-layout-document">
        ${renderPrintDocument(documentView, {
          standalone: true,
          media
        })}
      </section>
    </section>
  `;
}

function renderPrintDocument(documentView, options = {}) {
  if (!documentView) {
    return `
      <article class="panel">
        <h2>Print View</h2>
        <p class="muted">No printable document is available for this run yet.</p>
      </article>
    `;
  }

  const standalone = Boolean(options.standalone);
  const media = options.media || documentView.selected_images || [];

  return `
    <article class="${standalone ? "print-document" : "panel print-panel"}">
      <div class="print-cover">
        <span class="eyebrow">${standalone ? "Ready to Print" : "Print View"}</span>
        <h2>${escapeHtml(documentView.title || "Deep Search document")}</h2>
        ${documentView.subtitle ? `<p class="hero-summary">${escapeHtml(documentView.subtitle)}</p>` : ""}
      </div>
      ${documentView.toc?.length ? `
        <section class="print-section">
          <h3>Contents</h3>
          <ol class="plain-list toc-list">
            ${documentView.toc.map((item) => `<li><a href="#${escapeAttribute(item.id)}">${escapeHtml(item.label)}</a></li>`).join("")}
          </ol>
        </section>
      ` : ""}
      ${media?.length ? `
        <section class="print-section">
          <h3>Selected Images</h3>
          <div class="media-grid">
            ${media.map((item) => `
              <figure class="print-figure">
                <img src="${escapeAttribute(item.url)}" alt="${escapeAttribute(item.alt || item.caption || "Selected image")}">
                ${item.caption ? `<figcaption>${escapeHtml(item.caption)}</figcaption>` : ""}
              </figure>
            `).join("")}
          </div>
        </section>
      ` : ""}
      ${documentView.chapters.map((chapter) => `
        <section class="print-section" id="${escapeAttribute(chapter.id)}">
          <h3>${escapeHtml(chapter.heading || "Chapter")}</h3>
          ${chapter.summary ? `<p class="muted">${escapeHtml(chapter.summary)}</p>` : ""}
          <div class="rich-prose">${renderRichText(chapter.body || "")}</div>
          ${renderSourceLinks(chapter.source_urls || [])}
        </section>
      `).join("")}
      ${documentView.appendix?.length ? `
        <section class="print-section">
          <h3>Appendix</h3>
          ${documentView.appendix.map((item) => `
            <section class="report-section">
              <h4>${escapeHtml(item.heading || "Appendix item")}</h4>
              <p>${escapeHtml(item.body || "")}</p>
            </section>
          `).join("")}
        </section>
      ` : ""}
    </article>
  `;
}

function renderMapPanels(mapEntries = [], collections = []) {
  if (!mapEntries.length) {
    return `
      <article class="panel">
        <h2>Map</h2>
        <p class="muted">No geographic view was generated for this run.</p>
      </article>
    `;
  }

  return mapEntries.map((entry) => `
    <article class="panel map-panel">
      <div class="panel-header">
        <div>
          <h2>${escapeHtml(entry.title || "Map")}</h2>
          <p class="muted">${escapeHtml(entry.description || "Mapped points inferred from the current research.")}</p>
        </div>
        <span class="collection-count">${escapeHtml(String(entry.points.length))}</span>
      </div>
      <div class="map-canvas" data-map-entry-id="${escapeAttribute(entry.id)}" aria-label="${escapeAttribute(entry.title || "Deep Search map")}"></div>
      <div class="map-point-list">
        ${entry.points.map((point) => `
          <article class="map-point-card">
            <strong>${point.primary_url ? `<a href="${escapeAttribute(point.primary_url)}" target="_blank" rel="noreferrer">${escapeHtml(point.label || point.location?.label || "Point")}</a>` : escapeHtml(point.label || point.location?.label || "Point")}</strong>
            <span>${escapeHtml(point.location?.address || point.location?.query || point.location?.label || "")}</span>
            ${point.note ? `<p>${escapeHtml(point.note)}</p>` : ""}
          </article>
        `).join("")}
      </div>
      ${collections.length ? `<p class="muted">Tip: switch to List to compare the same results in a denser format.</p>` : ""}
    </article>
  `).join("");
}

async function hydrateMaps() {
  if (!state.renderContext?.mapEntries?.length) {
    return;
  }

  const token = `${state.runId}:${state.run?.updatedAt || ""}:${state.renderContext.activeView}`;
  state.mapHydrationToken = token;

  for (const container of document.querySelectorAll(".map-canvas[data-map-entry-id]")) {
    if (container.dataset.hydrated === token) {
      continue;
    }
    const entry = state.renderContext.mapEntries.find((item) => item.id === container.dataset.mapEntryId);
    if (!entry) {
      continue;
    }
    const hydratedEntry = await ensureMapPointsResolved(entry);
    if (state.mapHydrationToken !== token) {
      return;
    }
    await mountLeafletMap(container, hydratedEntry);
    container.dataset.hydrated = token;
  }
}

async function ensureMapPointsResolved(entry) {
  const points = [];
  for (const point of entry.points || []) {
    if (Number.isFinite(point.lat) && Number.isFinite(point.lng)) {
      points.push(point);
      continue;
    }
    const resolved = await geocodePoint(point);
    points.push(resolved || point);
  }

  return {
    ...entry,
    points: points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
  };
}

async function geocodePoint(point) {
  const query = [
    point.location?.query,
    point.location?.address,
    point.location?.label,
    point.label
  ].map((value) => String(value || "").trim()).find(Boolean);

  if (!query) {
    return null;
  }

  const cache = await loadGeocodeCache();
  if (cache[query]) {
    return {
      ...point,
      lat: cache[query].lat,
      lng: cache[query].lng,
      location: {
        ...point.location,
        label: point.location?.label || cache[query].label || "",
        address: point.location?.address || cache[query].display_name || ""
      }
    };
  }

  await wait(NOMINATIM_DELAY_MS);
  const url = `${NOMINATIM_SEARCH_URL}?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const response = await sendRuntimeMessage(makeEnvelope(MESSAGE_TYPES.HTTP_REQUEST, {
    url,
    method: "GET",
    headers: {
      "Accept-Language": "en,it;q=0.8",
      "User-Agent": "BrowserCompanion/0.1 (DeepSearchMap)"
    }
  })).catch(() => null);

  const bodyPreview = String(response?.envelope?.payload?.bodyPreview || "");
  if (!response?.ok || !bodyPreview) {
    return null;
  }

  let parsed = [];
  try {
    parsed = JSON.parse(bodyPreview);
  } catch {
    parsed = [];
  }
  const first = Array.isArray(parsed) ? parsed[0] : null;
  if (!first || !Number.isFinite(Number(first.lat)) || !Number.isFinite(Number(first.lon))) {
    return null;
  }

  const nextCache = {
    ...cache,
    [query]: {
      lat: Number(first.lat),
      lng: Number(first.lon),
      label: first.name || point.label || "",
      display_name: first.display_name || "",
      updatedAt: new Date().toISOString()
    }
  };
  await saveGeocodeCache(nextCache);

  return {
    ...point,
    lat: Number(first.lat),
    lng: Number(first.lon),
    location: {
      ...point.location,
      label: point.location?.label || first.name || point.label || "",
      address: point.location?.address || first.display_name || ""
    }
  };
}

async function loadGeocodeCache() {
  const stored = await chrome.storage.local.get([DEEP_SEARCH_GEOCODE_CACHE_KEY]);
  const cache = stored[DEEP_SEARCH_GEOCODE_CACHE_KEY];
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    return {};
  }
  return cache;
}

async function saveGeocodeCache(cache) {
  const entries = Object.entries(cache || {}).slice(-200);
  await chrome.storage.local.set({
    [DEEP_SEARCH_GEOCODE_CACHE_KEY]: Object.fromEntries(entries)
  });
}

async function mountLeafletMap(container, entry) {
  container.innerHTML = "";
  if (!entry.points.length) {
    container.innerHTML = `<p class="muted">No geocoded points were available for this map.</p>`;
    return;
  }

  const L = await loadLeaflet().catch(() => null);
  if (!L) {
    container.innerHTML = `<p class="muted">Map rendering could not start because Leaflet did not load correctly.</p>`;
    return;
  }

  const map = L.map(container, {
    zoomControl: true,
    scrollWheelZoom: false
  });

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  const latLngs = [];
  entry.points.forEach((point) => {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
      return;
    }
    const marker = L.circleMarker([point.lat, point.lng], {
      radius: 7,
      color: "#7aa2ff",
      weight: 2,
      fillColor: "#7aa2ff",
      fillOpacity: 0.7
    }).addTo(map);
    const popupBits = [
      `<strong>${escapeHtml(point.label || point.location?.label || "Point")}</strong>`,
      point.location?.address ? `<div>${escapeHtml(point.location.address)}</div>` : "",
      point.note ? `<div>${escapeHtml(point.note)}</div>` : "",
      point.primary_url ? `<div><a href="${escapeAttribute(point.primary_url)}" target="_blank" rel="noreferrer">Open result</a></div>` : ""
    ].filter(Boolean).join("");
    marker.bindPopup(popupBits);
    latLngs.push([point.lat, point.lng]);
  });

  if (entry.bounds) {
    map.fitBounds([
      [entry.bounds.south, entry.bounds.west],
      [entry.bounds.north, entry.bounds.east]
    ], { padding: [24, 24] });
  } else if (latLngs.length === 1) {
    map.setView(latLngs[0], 11);
  } else {
    map.fitBounds(latLngs, { padding: [24, 24] });
  }
}

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function loadLeaflet() {
  if (!leafletModulePromise) {
    leafletModulePromise = import("../../node_modules/leaflet/dist/leaflet-src.esm.js")
      .then((module) => module && typeof module === "object" ? module : null);
  }
  return leafletModulePromise;
}

function normalizeViewMode(value) {
  return ["auto", "report", "hybrid", "list", "map", "print"].includes(String(value || "").trim())
    ? String(value || "").trim()
    : "auto";
}

function buildRunUrl(runId, options = {}) {
  const params = new URLSearchParams();
  params.set("run", runId || state.runId || "");
  const view = normalizeViewMode(options.view || state.selectedView || "auto");
  if (view && view !== "auto") {
    params.set("view", view);
  }
  if (options.layout === "print" || state.layoutMode === "print") {
    params.set("layout", "print");
  }
  return `./index.html?${params.toString()}`;
}

function syncUrlState() {
  const nextUrl = buildRunUrl(state.runId, {
    view: state.selectedView,
    layout: state.layoutMode
  });
  window.history.replaceState({}, "", nextUrl);
}

function extractFetchedPageMetadata(payload = {}, candidate = {}) {
  const html = String(payload.bodyPreview || "");
  const fallbackUrl = payload.finalUrl || payload.url || candidate.url || "";
  const contentType = String(payload.contentType || "").toLowerCase();
  const metadata = {
    title: compactText(candidate.title || ""),
    domain: formatDomain(fallbackUrl),
    siteName: "",
    canonicalUrl: "",
    description: "",
    heroImageUrl: "",
    imageCandidates: [],
    publishedAt: "",
    locationHints: []
  };

  if (!html || !contentType.includes("html")) {
    return metadata;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const pickMeta = (selector) => doc.querySelector(selector)?.getAttribute("content") || "";
  const canonical = doc.querySelector("link[rel='canonical']")?.getAttribute("href") || "";
  const images = [
    pickMeta("meta[property='og:image']"),
    pickMeta("meta[name='twitter:image']"),
    ...Array.from(doc.querySelectorAll("img[src]")).slice(0, 3).map((img) => img.getAttribute("src") || "")
  ].map((value) => absolutizeUrl(value, fallbackUrl)).filter(Boolean);
  const locationHints = [
    pickMeta("meta[property='place:location:latitude']") && pickMeta("meta[property='place:location:longitude']")
      ? `${pickMeta("meta[property='place:location:latitude']")}, ${pickMeta("meta[property='place:location:longitude']")}`
      : "",
    pickMeta("meta[property='og:locality']"),
    pickMeta("meta[name='geo.position']"),
    ...extractAddressHints(doc)
  ].filter(Boolean);

  metadata.title = compactText(doc.querySelector("title")?.textContent || metadata.title || "");
  metadata.siteName = compactText(pickMeta("meta[property='og:site_name']") || doc.location?.hostname || "");
  metadata.canonicalUrl = absolutizeUrl(canonical, fallbackUrl);
  metadata.description = compactText(pickMeta("meta[name='description']") || pickMeta("meta[property='og:description']") || "");
  metadata.heroImageUrl = images[0] || "";
  metadata.imageCandidates = images.slice(0, 4).map((url, index) => ({
    id: `image-${index + 1}`,
    kind: "image",
    url,
    alt: metadata.title || metadata.siteName || "Source image",
    caption: metadata.description,
    source_url: fallbackUrl
  }));
  metadata.publishedAt = normalizeMaybeIso(pickMeta("meta[property='article:published_time']") || pickMeta("meta[name='date']"));
  metadata.locationHints = Array.from(new Set(locationHints.map((value) => compactText(value)).filter(Boolean))).slice(0, 8);
  return metadata;
}

function extractAddressHints(doc) {
  const scripts = Array.from(doc.querySelectorAll("script[type='application/ld+json']")).slice(0, 6);
  const hints = [];
  for (const script of scripts) {
    const text = script.textContent || "";
    if (!text.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      collectAddressHintsFromJsonLd(parsed, hints);
    } catch {
      continue;
    }
  }
  return hints;
}

function collectAddressHintsFromJsonLd(value, hints) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 12).forEach((entry) => collectAddressHintsFromJsonLd(entry, hints));
    return;
  }
  const address = value.address;
  if (address && typeof address === "object") {
    const line = [
      address.streetAddress,
      address.addressLocality,
      address.addressRegion,
      address.postalCode,
      address.addressCountry
    ].map((item) => compactText(item)).filter(Boolean).join(", ");
    if (line) {
      hints.push(line);
    }
  }
  if (value.location && typeof value.location === "object") {
    collectAddressHintsFromJsonLd(value.location, hints);
  }
}

function absolutizeUrl(value, baseUrl) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  try {
    return new URL(text, baseUrl).toString();
  } catch {
    return "";
  }
}

function normalizeMaybeIso(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function handleThreadSubmit(event) {
  event.preventDefault();
  const text = String(state.threadDraft || "").trim();
  if (!text || state.threadBusy || !state.run) {
    return;
  }

  state.threadBusy = true;
  state.threadDraft = "";
  render();
  bindInteractiveControls();
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
    bindInteractiveControls();
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
      <div class="thread-message-body">${renderRichText(message.text || "")}</div>
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

function renderRichText(text) {
  const raw = String(text || "");
  return renderMarkdown(raw) || "<p></p>";
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
