export const DEEP_SEARCH_STORAGE_KEY = "browserCompanionDeepSearchRuns";
export const DEEP_SEARCH_RUN_LIMIT = 10;
export const DEEP_SEARCH_FIRST_WAVE_QUERY_LIMIT = 10;
export const DEEP_SEARCH_SECOND_WAVE_QUERY_LIMIT = 5;
export const DEEP_SEARCH_REFINEMENT_ROUND_LIMIT = 2;
export const DEEP_SEARCH_RESULTS_PER_QUERY_LIMIT = 8;
export const DEEP_SEARCH_FETCH_LIMIT = 24;
export const DEEP_SEARCH_FETCHES_PER_DOMAIN_LIMIT = 3;

export function createDeepSearchRun(payload = {}) {
  const now = new Date().toISOString();
  const id = String(payload.id || crypto.randomUUID());
  const goal = compact(payload.goal || payload.prompt || "");
  return normalizeDeepSearchRun({
    id,
    status: "queued",
    phase: "queued",
    createdAt: payload.createdAt || now,
    updatedAt: payload.updatedAt || now,
    goal,
    provider: payload.provider || "openai-codex",
    providerLabel: payload.providerLabel || "",
    model: payload.model || "",
    providerSnapshot: normalizeProviderSnapshot(payload.providerSnapshot || null),
    windowId: normalizeOptionalNumber(payload.windowId),
    originTabId: normalizeOptionalNumber(payload.originTabId),
    responseLanguage: compact(payload.responseLanguage || ""),
    userMessageLog: compact(payload.userMessageLog || ""),
    seedContext: {
      page: summarizeObservationForDeepSearch(payload.observation, payload.page || {}),
      runtimeContext: compact(payload.runtimeContext || "")
    },
    plan: null,
    plannedQueries: [],
    refinementQueries: [],
    desiredSections: [],
    evaluationFocus: [],
    constraints: [],
    searchArtifacts: [],
    fetchedSources: [],
    finalReport: null,
    lastError: null,
    notes: [],
    latestSummary: "",
    ...payload
  });
}

export function normalizeDeepSearchRun(run = {}) {
  const goal = compact(run.goal || run.prompt || "");
  const plannedQueries = normalizeStringList(run.plannedQueries || run.plan?.search_queries || [], DEEP_SEARCH_FIRST_WAVE_QUERY_LIMIT);
  const refinementQueries = normalizeStringList(run.refinementQueries || run.plan?.additional_queries || [], DEEP_SEARCH_SECOND_WAVE_QUERY_LIMIT);

  return {
    id: String(run.id || ""),
    status: normalizeRunStatus(run.status),
    phase: compact(run.phase || ""),
    createdAt: normalizeIsoString(run.createdAt),
    updatedAt: normalizeIsoString(run.updatedAt),
    goal,
    provider: compact(run.provider || ""),
    providerLabel: compact(run.providerLabel || ""),
    model: compact(run.model || ""),
    providerSnapshot: normalizeProviderSnapshot(run.providerSnapshot || null),
    windowId: normalizeOptionalNumber(run.windowId),
    originTabId: normalizeOptionalNumber(run.originTabId),
    responseLanguage: compact(run.responseLanguage || ""),
    userMessageLog: compact(run.userMessageLog || ""),
    seedContext: {
      page: summarizeObservationForDeepSearch(run.seedContext?.page, run.seedContext?.page || {}),
      runtimeContext: compact(run.seedContext?.runtimeContext || "")
    },
    plan: normalizeDeepSearchPlan(run.plan || null),
    plannedQueries,
    refinementQueries,
    desiredSections: normalizeStringList(run.desiredSections || run.plan?.desired_sections || [], 18),
    evaluationFocus: normalizeStringList(run.evaluationFocus || run.plan?.evaluation_focus || [], 18),
    constraints: normalizeStringList(run.constraints || run.plan?.constraints || [], 20),
    searchArtifacts: normalizeSearchArtifacts(run.searchArtifacts || []),
    fetchedSources: normalizeFetchedSources(run.fetchedSources || []),
    finalReport: normalizeDeepSearchReport(run.finalReport || null),
    lastError: normalizeDeepSearchError(run.lastError || null),
    notes: normalizeStringList(run.notes || [], 40),
    latestSummary: compact(run.latestSummary || "")
  };
}

export function normalizeDeepSearchPlan(plan = null) {
  if (!plan || typeof plan !== "object") {
    return null;
  }

  return {
    title: compact(plan.title || ""),
    objective: compact(plan.objective || ""),
    search_queries: normalizeStringList(plan.search_queries || [], DEEP_SEARCH_FIRST_WAVE_QUERY_LIMIT),
    desired_sections: normalizeStringList(plan.desired_sections || [], 18),
    evaluation_focus: normalizeStringList(plan.evaluation_focus || [], 18),
    constraints: normalizeStringList(plan.constraints || [], 20),
    stop_early_if_sufficient: Boolean(plan.stop_early_if_sufficient)
  };
}

export function normalizeDeepSearchRefinement(plan = null) {
  if (!plan || typeof plan !== "object") {
    return {
      additional_queries: [],
      rationale: "",
      stop_early: false
    };
  }

  return {
    additional_queries: normalizeStringList(plan.additional_queries || [], DEEP_SEARCH_SECOND_WAVE_QUERY_LIMIT),
    rationale: compact(plan.rationale || ""),
    stop_early: Boolean(plan.stop_early)
  };
}

export function normalizeDeepSearchReport(report = null) {
  if (!report || typeof report !== "object") {
    return null;
  }

  return {
    title: compact(report.title || ""),
    objective: compact(report.objective || ""),
    executive_summary: sanitizePreviewText(report.executive_summary || ""),
    key_findings: Array.isArray(report.key_findings)
      ? report.key_findings.slice(0, 16).map((item) => ({
          title: compact(item?.title || ""),
          summary: sanitizePreviewText(item?.summary || ""),
          source_urls: normalizeUrlList(item?.source_urls || [], 10)
        }))
      : [],
    sections: Array.isArray(report.sections)
      ? report.sections.slice(0, 18).map((item) => ({
          heading: compact(item?.heading || ""),
          body: sanitizePreviewText(item?.body || ""),
          source_urls: normalizeUrlList(item?.source_urls || [], 16)
        }))
      : [],
    methodology: normalizeStringList(report.methodology || [], 24),
    open_questions: normalizeStringList(report.open_questions || [], 20),
    sources: normalizeSourceList(report.sources || [])
  };
}

export function normalizeSearchArtifacts(artifacts = []) {
  if (!Array.isArray(artifacts)) {
    return [];
  }

  return artifacts.slice(0, 160).map((artifact) => ({
    query: compact(artifact?.query || ""),
    provider: compact(artifact?.provider || ""),
    searchedAt: normalizeIsoString(artifact?.searchedAt),
    results: Array.isArray(artifact?.results)
      ? artifact.results.slice(0, DEEP_SEARCH_RESULTS_PER_QUERY_LIMIT).map((result) => ({
          title: compact(result?.title || ""),
          url: normalizeUrl(result?.url || result?.href || ""),
          snippet: sanitizePreviewText(result?.snippet || result?.description || ""),
          domain: extractDomain(result?.url || result?.href || "")
        }))
      : []
  }));
}

export function normalizeFetchedSources(sources = []) {
  if (!Array.isArray(sources)) {
    return [];
  }

  return sources.slice(0, DEEP_SEARCH_FETCH_LIMIT).map((source) => ({
    url: normalizeUrl(source?.url || ""),
    title: compact(source?.title || ""),
    domain: extractDomain(source?.url || source?.domain || ""),
    status: compact(source?.status || ""),
    statusCode: normalizeOptionalNumber(source?.statusCode),
    snippet: sanitizePreviewText(source?.snippet || ""),
    bodyPreview: sanitizePreviewText(source?.bodyPreview || source?.body || "").slice(0, 12000),
    fetchedAt: normalizeIsoString(source?.fetchedAt),
    query: compact(source?.query || "")
  }));
}

export function normalizeSourceList(sources = []) {
  if (!Array.isArray(sources)) {
    return [];
  }

  return sources.slice(0, 40).map((source) => ({
    url: normalizeUrl(source?.url || ""),
    title: compact(source?.title || ""),
    snippet: sanitizePreviewText(source?.snippet || ""),
    statusCode: normalizeOptionalNumber(source?.statusCode)
  }));
}

export function normalizeDeepSearchError(error = null) {
  if (!error || typeof error !== "object") {
    return null;
  }

  return {
    phase: compact(error.phase || ""),
    message: compact(error.message || ""),
    detail: compact(error.detail || ""),
    at: normalizeIsoString(error.at)
  };
}

export function summarizeObservationForDeepSearch(observation = null, fallbackPage = {}) {
  const page = observation && typeof observation === "object" ? observation : {};
  const tab = page.tab && typeof page.tab === "object" ? page.tab : {};
  const viewport = page.viewport && typeof page.viewport === "object" ? page.viewport : {};
  const url = compact(tab.url || fallbackPage.url || "");
  const title = compact(tab.title || fallbackPage.title || "");
  const visibleText = compact(page.visible_text || fallbackPage.visible_text || "");

  return {
    url,
    title,
    windowId: normalizeOptionalNumber(tab.windowId || fallbackPage.windowId),
    tabId: normalizeOptionalNumber(tab.id || fallbackPage.tabId),
    capturedAt: normalizeIsoString(page.capturedAt || fallbackPage.capturedAt),
    visibleTextExcerpt: visibleText.slice(0, 1400),
    visibleTextLength: Number.isFinite(page.visibleTextLength) ? page.visibleTextLength : visibleText.length,
    headings: Array.isArray(page.headings)
      ? page.headings.slice(0, 8).map((item) => compact(item?.name || item?.text || ""))
      : [],
    pageType: compact(page.page_outline?.page_type || ""),
    viewport: {
      width: normalizeOptionalNumber(viewport.width),
      height: normalizeOptionalNumber(viewport.height)
    }
  };
}

export function dedupeSearchResults(results = [], options = {}) {
  const maxPerDomain = normalizePositiveInt(options.maxPerDomain, DEEP_SEARCH_FETCHES_PER_DOMAIN_LIMIT);
  const seenUrls = new Set();
  const domainCounts = new Map();
  const deduped = [];

  for (const result of results) {
    const url = normalizeUrl(result?.url || result?.href || "");
    if (!url || seenUrls.has(url)) {
      continue;
    }
    const domain = extractDomain(url);
    const domainCount = domain ? (domainCounts.get(domain) || 0) : 0;
    if (domain && domainCount >= maxPerDomain) {
      continue;
    }
    seenUrls.add(url);
    if (domain) {
      domainCounts.set(domain, domainCount + 1);
    }
    deduped.push({
      title: compact(result?.title || ""),
      url,
      snippet: compact(result?.snippet || result?.description || ""),
      domain
    });
  }

  return deduped;
}

export function collectFetchCandidates(searchArtifacts = [], options = {}) {
  const maxTotal = normalizePositiveInt(options.maxTotal, DEEP_SEARCH_FETCH_LIMIT);
  const maxPerDomain = normalizePositiveInt(options.maxPerDomain, DEEP_SEARCH_FETCHES_PER_DOMAIN_LIMIT);
  const flattened = [];

  for (const artifact of searchArtifacts) {
    const query = compact(artifact?.query || "");
    for (const result of artifact?.results || []) {
      flattened.push({
        query,
        title: compact(result?.title || ""),
        url: normalizeUrl(result?.url || ""),
        snippet: compact(result?.snippet || ""),
        domain: extractDomain(result?.url || result?.domain || "")
      });
    }
  }

  return dedupeSearchResults(flattened, { maxPerDomain }).slice(0, maxTotal);
}

export function upsertDeepSearchRunList(existingRuns = [], run, options = {}) {
  const limit = normalizePositiveInt(options.limit, DEEP_SEARCH_RUN_LIMIT);
  const normalizedRun = normalizeDeepSearchRun(run);
  const normalizedRuns = Array.isArray(existingRuns)
    ? existingRuns.map((item) => normalizeDeepSearchRun(item))
    : [];
  const filtered = normalizedRuns.filter((item) => item.id && item.id !== normalizedRun.id);
  const merged = [normalizedRun, ...filtered];
  const completed = [];
  const active = [];

  for (const item of merged) {
    if (item.status === "completed" || item.status === "failed_partial") {
      completed.push(item);
    } else {
      active.push(item);
    }
  }

  completed.sort((left, right) => {
    return new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime();
  });

  const keptCompleted = completed.slice(0, Math.max(0, limit - active.length));
  return [...active, ...keptCompleted].slice(0, limit);
}

export function updateDeepSearchRun(run, patch = {}) {
  return normalizeDeepSearchRun({
    ...normalizeDeepSearchRun(run),
    ...patch,
    updatedAt: patch.updatedAt || new Date().toISOString()
  });
}

export function buildFallbackDeepSearchReport(run = {}) {
  const normalized = normalizeDeepSearchRun(run);
  const searchTrail = normalized.searchArtifacts
    .map((artifact) => artifact.query)
    .filter(Boolean);
  const topSources = normalized.fetchedSources.slice(0, 12);

  return normalizeDeepSearchReport({
    title: normalized.plan?.title || normalized.goal || "Deep Search report",
    objective: normalized.plan?.objective || normalized.goal,
    executive_summary: normalized.fetchedSources.length
      ? "Deep Search gathered source material but could not complete the full final synthesis. The partial report below preserves the strongest findings and source trail."
      : "Deep Search could not gather enough source material to complete the report.",
    key_findings: topSources.slice(0, 6).map((source) => ({
      title: source.title || source.url,
      summary: source.snippet || source.bodyPreview.slice(0, 220),
      source_urls: [source.url]
    })),
    sections: [
      {
        heading: "What Was Collected",
        body: normalized.fetchedSources.length
          ? `Fetched ${normalized.fetchedSources.length} source page${normalized.fetchedSources.length === 1 ? "" : "s"} across ${new Set(topSources.map((source) => source.domain).filter(Boolean)).size} domain${new Set(topSources.map((source) => source.domain).filter(Boolean)).size === 1 ? "" : "s"}.`
          : "No public source pages were fetched successfully."
      },
      {
        heading: "Method Notes",
        body: searchTrail.length
          ? `Searches run: ${searchTrail.join(" | ")}`
          : "No successful searches were recorded before the run stopped."
      }
    ],
    methodology: [
      "The report used web search to collect candidate public URLs.",
      "The top results were deduped by URL and domain before HTTP fetches.",
      "This fallback report was generated from the persisted artifacts after the full synthesis step failed."
    ],
    open_questions: normalized.lastError?.message ? [normalized.lastError.message] : [],
    sources: topSources.map((source) => ({
      url: source.url,
      title: source.title,
      snippet: source.snippet || source.bodyPreview.slice(0, 220),
      statusCode: source.statusCode
    }))
  });
}

export function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function sanitizePreviewText(value) {
  const raw = String(value || "");
  if (!raw) {
    return "";
  }

  const withoutScripts = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, digits) => {
      const codePoint = Number.parseInt(digits, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : " ";
    });

  return compact(decoded);
}

function normalizeRunStatus(status) {
  return ["queued", "running", "completed", "failed_partial"].includes(status)
    ? status
    : "queued";
}

function normalizeStringList(values, limit) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => compact(value))
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeUrlList(values, limit) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeUrl(value))
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeIsoString(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function normalizeOptionalNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeProviderSnapshot(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  return {
    id: compact(snapshot.id || ""),
    label: compact(snapshot.label || ""),
    model: compact(snapshot.model || ""),
    httpProvider: snapshot.httpProvider && typeof snapshot.httpProvider === "object"
      ? {
          id: compact(snapshot.httpProvider.id || ""),
          name: compact(snapshot.httpProvider.name || ""),
          providerKind: compact(snapshot.httpProvider.providerKind || ""),
          baseUrl: compact(snapshot.httpProvider.baseUrl || ""),
          accountId: compact(snapshot.httpProvider.accountId || ""),
          token: compact(snapshot.httpProvider.token || ""),
          authType: compact(snapshot.httpProvider.authType || ""),
          username: compact(snapshot.httpProvider.username || ""),
          password: compact(snapshot.httpProvider.password || ""),
          model: compact(snapshot.httpProvider.model || snapshot.model || ""),
          useStreaming: Boolean(snapshot.httpProvider.useStreaming),
          maxTokens: normalizeOptionalNumber(snapshot.httpProvider.maxTokens),
          retryMaxTokens: normalizeOptionalNumber(snapshot.httpProvider.retryMaxTokens),
          timeoutMs: normalizeOptionalNumber(snapshot.httpProvider.timeoutMs)
        }
      : null
  };
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) {
    return "";
  }
  try {
    return new URL(text).toString();
  } catch {
    return "";
  }
}

function extractDomain(value) {
  const url = normalizeUrl(value);
  if (!url) {
    return "";
  }
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}
