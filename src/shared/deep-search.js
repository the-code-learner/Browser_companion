export const DEEP_SEARCH_STORAGE_KEY = "browserCompanionDeepSearchRuns";
export const DEEP_SEARCH_RUN_LIMIT = 10;
export const DEEP_SEARCH_FIRST_WAVE_QUERY_LIMIT = 16;
export const DEEP_SEARCH_SECOND_WAVE_QUERY_LIMIT = 8;
export const DEEP_SEARCH_REFINEMENT_ROUND_LIMIT = 3;
export const DEEP_SEARCH_RESULTS_PER_QUERY_LIMIT = 16;
export const DEEP_SEARCH_FETCH_LIMIT = 40;
export const DEEP_SEARCH_FETCHES_PER_DOMAIN_LIMIT = 5;

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
    parentRunId: compact(payload.parentRunId || ""),
    followUpInstruction: compact(payload.followUpInstruction || ""),
    followUpRuns: Array.isArray(payload.followUpRuns) ? payload.followUpRuns : [],
    reviewNotes: Array.isArray(payload.reviewNotes) ? payload.reviewNotes : [],
    threadMessages: Array.isArray(payload.threadMessages) ? payload.threadMessages : [],
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
    parentRunId: compact(run.parentRunId || ""),
    followUpInstruction: compact(run.followUpInstruction || ""),
    followUpRuns: normalizeStringList(run.followUpRuns || [], 20),
    reviewNotes: normalizeStringList(run.reviewNotes || [], 20),
    threadMessages: normalizeThreadMessages(run.threadMessages || []),
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

  const normalized = {
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
    sources: normalizeSourceList(report.sources || []),
    presentation: normalizePresentation(report.presentation || null),
    collections: normalizeCollectionList(report.collections || []),
    document: normalizeDocument(report.document || null),
    map_data: normalizeMapDataList(report.map_data || []),
    media: normalizeMediaList(report.media || [])
  };

  const availableViews = inferAvailableViews(normalized);
  const preferredView = normalizeViewName(normalized.presentation?.primary_view || inferPrimaryView(normalized));

  normalized.presentation = {
    primary_view: availableViews.includes(preferredView) ? preferredView : availableViews[0],
    available_views: availableViews,
    print_ready: Boolean(normalized.presentation?.print_ready || normalized.document)
  };

  if (normalized.document && !normalized.document.title) {
    normalized.document.title = normalized.title || normalized.objective || "Deep Search document";
  }

  return normalized;
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
    query: compact(source?.query || ""),
    siteName: compact(source?.siteName || ""),
    canonicalUrl: normalizeUrl(source?.canonicalUrl || ""),
    description: sanitizePreviewText(source?.description || ""),
    heroImageUrl: normalizeUrl(source?.heroImageUrl || ""),
    imageCandidates: normalizeMediaList(source?.imageCandidates || [], 4),
    publishedAt: normalizeIsoString(source?.publishedAt),
    locationHints: normalizeStringList(source?.locationHints || [], 10)
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
    statusCode: normalizeOptionalNumber(source?.statusCode),
    siteName: compact(source?.siteName || ""),
    heroImageUrl: normalizeUrl(source?.heroImageUrl || "")
  }));
}

export function normalizePresentation(presentation = null) {
  if (!presentation || typeof presentation !== "object") {
    return {
      primary_view: "report",
      available_views: ["report"],
      print_ready: false
    };
  }

  const availableViews = Array.isArray(presentation.available_views)
    ? presentation.available_views.map((value) => normalizeViewName(value)).filter(Boolean)
    : [];

  return {
    primary_view: normalizeViewName(presentation.primary_view || "report"),
    available_views: availableViews.length ? [...new Set(availableViews)] : ["report"],
    print_ready: Boolean(presentation.print_ready)
  };
}

export function normalizeCollectionList(collections = []) {
  if (!Array.isArray(collections)) {
    return [];
  }

  return collections.slice(0, 8).map((collection, index) => ({
    id: compact(collection?.id || `collection-${index + 1}`),
    title: compact(collection?.title || ""),
    description: sanitizePreviewText(collection?.description || ""),
    record_type: compact(collection?.record_type || "result"),
    columns: normalizeCollectionColumns(collection?.columns || []),
    items: normalizeCollectionItems(collection?.items || []),
    source_urls: normalizeUrlList(collection?.source_urls || [], 20)
  })).filter((collection) => collection.items.length || collection.title);
}

function normalizeCollectionColumns(columns = []) {
  if (!Array.isArray(columns)) {
    return [];
  }

  return columns.slice(0, 12).map((column, index) => ({
    key: compact(column?.key || `column_${index + 1}`),
    label: compact(column?.label || column?.key || `Column ${index + 1}`),
    kind: compact(column?.kind || "text")
  })).filter((column) => column.key);
}

function normalizeCollectionItems(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.slice(0, 120).map((item, index) => ({
    id: compact(item?.id || `item-${index + 1}`),
    label: compact(item?.label || item?.title || ""),
    title: compact(item?.title || item?.label || ""),
    description: sanitizePreviewText(item?.description || ""),
    primary_url: normalizeUrl(item?.primary_url || item?.url || ""),
    evidence_note: sanitizePreviewText(item?.evidence_note || item?.note || ""),
    tags: normalizeStringList(item?.tags || [], 10),
    source_urls: normalizeUrlList(item?.source_urls || [], 12),
    fields: normalizeCollectionFields(item?.fields || {}),
    links: normalizeCollectionLinks(item?.links || []),
    location: normalizeMapPointLocation(item?.location || null)
  })).filter((item) => item.label || item.primary_url || Object.keys(item.fields).length);
}

function normalizeCollectionFields(fields = {}) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return {};
  }

  const entries = Object.entries(fields).slice(0, 20).map(([key, value]) => {
    return [compact(key), sanitizePreviewText(value)];
  }).filter(([key, value]) => key && value);

  return Object.fromEntries(entries);
}

function normalizeCollectionLinks(links = []) {
  if (!Array.isArray(links)) {
    return [];
  }

  return links.slice(0, 12).map((link, index) => ({
    id: compact(link?.id || `link-${index + 1}`),
    label: compact(link?.label || link?.type || link?.url || ""),
    type: compact(link?.type || "source"),
    url: normalizeUrl(link?.url || ""),
    note: sanitizePreviewText(link?.note || "")
  })).filter((link) => link.label && link.url);
}

function normalizeDocument(document = null) {
  if (!document || typeof document !== "object") {
    return null;
  }

  return {
    title: compact(document?.title || ""),
    subtitle: sanitizePreviewText(document?.subtitle || ""),
    toc: normalizeDocumentToc(document?.toc || []),
    chapters: normalizeDocumentChapters(document?.chapters || []),
    appendix: normalizeDocumentAppendix(document?.appendix || []),
    selected_images: normalizeMediaList(document?.selected_images || [], 8)
  };
}

function normalizeDocumentToc(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.slice(0, 24).map((item, index) => ({
    id: compact(item?.id || `toc-${index + 1}`),
    label: compact(item?.label || item?.title || "")
  })).filter((item) => item.label);
}

function normalizeDocumentChapters(chapters = []) {
  if (!Array.isArray(chapters)) {
    return [];
  }

  return chapters.slice(0, 20).map((chapter, index) => ({
    id: compact(chapter?.id || `chapter-${index + 1}`),
    heading: compact(chapter?.heading || chapter?.title || ""),
    summary: sanitizePreviewText(chapter?.summary || ""),
    body: sanitizePreviewText(chapter?.body || ""),
    source_urls: normalizeUrlList(chapter?.source_urls || [], 16),
    image_urls: normalizeUrlList(chapter?.image_urls || [], 6)
  })).filter((chapter) => chapter.heading || chapter.body);
}

function normalizeDocumentAppendix(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.slice(0, 20).map((item, index) => ({
    id: compact(item?.id || `appendix-${index + 1}`),
    heading: compact(item?.heading || item?.title || ""),
    body: sanitizePreviewText(item?.body || "")
  })).filter((item) => item.heading || item.body);
}

export function normalizeMapDataList(mapData = []) {
  if (!Array.isArray(mapData)) {
    return [];
  }

  return mapData.slice(0, 4).map((entry, index) => ({
    id: compact(entry?.id || `map-${index + 1}`),
    title: compact(entry?.title || ""),
    description: sanitizePreviewText(entry?.description || ""),
    points: normalizeMapPoints(entry?.points || []),
    bounds: normalizeMapBounds(entry?.bounds || null),
    source_urls: normalizeUrlList(entry?.source_urls || [], 20)
  })).filter((entry) => entry.points.length || entry.title);
}

function normalizeMapPoints(points = []) {
  if (!Array.isArray(points)) {
    return [];
  }

  return points.slice(0, 20).map((point, index) => ({
    id: compact(point?.id || `point-${index + 1}`),
    label: compact(point?.label || point?.title || ""),
    note: sanitizePreviewText(point?.note || point?.description || ""),
    source_url: normalizeUrl(point?.source_url || ""),
    primary_url: normalizeUrl(point?.primary_url || point?.url || ""),
    lat: normalizeCoordinate(point?.lat),
    lng: normalizeCoordinate(point?.lng),
    location: normalizeMapPointLocation(point?.location || point)
  })).filter((point) => point.label || point.location?.label || Number.isFinite(point.lat));
}

function normalizeMapPointLocation(location = null) {
  if (!location || typeof location !== "object") {
    return {
      label: "",
      address: "",
      query: ""
    };
  }

  return {
    label: compact(location?.label || location?.name || location?.place || ""),
    address: compact(location?.address || ""),
    query: compact(location?.query || location?.location_text || "")
  };
}

function normalizeMapBounds(bounds = null) {
  if (!bounds || typeof bounds !== "object") {
    return null;
  }

  const north = normalizeCoordinate(bounds?.north);
  const south = normalizeCoordinate(bounds?.south);
  const east = normalizeCoordinate(bounds?.east);
  const west = normalizeCoordinate(bounds?.west);

  if (![north, south, east, west].every((value) => Number.isFinite(value))) {
    return null;
  }

  return { north, south, east, west };
}

export function normalizeMediaList(media = [], limit = 12) {
  if (!Array.isArray(media)) {
    return [];
  }

  return media.slice(0, limit).map((item, index) => ({
    id: compact(item?.id || `media-${index + 1}`),
    kind: compact(item?.kind || "image"),
    url: normalizeUrl(item?.url || item?.src || ""),
    alt: sanitizePreviewText(item?.alt || ""),
    caption: sanitizePreviewText(item?.caption || ""),
    source_url: normalizeUrl(item?.source_url || "")
  })).filter((item) => item.url);
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
  const fallbackCollection = buildFallbackCollection(normalized);
  const fallbackMedia = buildFallbackMedia(normalized);

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
      statusCode: source.statusCode,
      siteName: source.siteName,
      heroImageUrl: source.heroImageUrl
    })),
    collections: fallbackCollection ? [fallbackCollection] : [],
    document: buildFallbackDocument(normalized, topSources, fallbackMedia),
    media: fallbackMedia,
    presentation: {
      primary_view: fallbackCollection ? "hybrid" : "report",
      available_views: fallbackCollection ? ["report", "list", "print"] : ["report", "print"],
      print_ready: true
    }
  });
}

export function normalizeThreadMessages(messages = []) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.slice(0, 80).map((message, index) => ({
    id: compact(message?.id || `thread-${index}`),
    role: message?.role === "assistant" ? "assistant" : "user",
    mode: message?.mode === "refine" ? "refine" : "ask",
    text: sanitizePreviewText(message?.text || ""),
    createdAt: normalizeIsoString(message?.createdAt) || new Date().toISOString(),
    status: compact(message?.status || "")
  }));
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

function normalizeViewName(value) {
  return ["report", "list", "hybrid", "map", "print", "auto"].includes(compact(value))
    ? compact(value)
    : "";
}

function inferPrimaryView(report = {}) {
  if (Array.isArray(report.collections) && report.collections.length && Array.isArray(report.sections) && report.sections.length) {
    return "hybrid";
  }
  if (Array.isArray(report.collections) && report.collections.length) {
    return "list";
  }
  if (Array.isArray(report.map_data) && report.map_data.some((entry) => entry.points.length)) {
    return "map";
  }
  return "report";
}

function inferAvailableViews(report = {}) {
  const views = ["report"];
  if (Array.isArray(report.collections) && report.collections.length) {
    views.push("list");
  }
  if (Array.isArray(report.map_data) && report.map_data.some((entry) => entry.points.length)) {
    views.push("map");
  }
  if (report.document || (Array.isArray(report.collections) && report.collections.length) || (Array.isArray(report.sections) && report.sections.length)) {
    views.push("print");
  }
  if (
    Array.isArray(report.collections) && report.collections.length
    && (
      (Array.isArray(report.sections) && report.sections.length)
      || (Array.isArray(report.key_findings) && report.key_findings.length)
      || report.executive_summary
    )
  ) {
    views.unshift("hybrid");
  }
  return [...new Set(views)];
}

function normalizeCoordinate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildFallbackCollection(run = {}) {
  const items = (run.fetchedSources || []).slice(0, 30).map((source, index) => ({
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

  if (!items.length) {
    return null;
  }

  return {
    id: "fallback-results",
    title: "Collected Sources",
    description: "Fallback list built from the fetched sources collected during the run.",
    record_type: "source",
    columns: [
      { key: "title", label: "Title", kind: "text" },
      { key: "domain", label: "Domain", kind: "text" },
      { key: "query", label: "Query", kind: "text" },
      { key: "status", label: "Status", kind: "text" }
    ],
    items,
    source_urls: items.flatMap((item) => item.source_urls).slice(0, 20)
  };
}

function buildFallbackMedia(run = {}) {
  return (run.fetchedSources || [])
    .flatMap((source, index) => {
      const media = [];
      if (source.heroImageUrl) {
        media.push({
          id: `hero-${index + 1}`,
          kind: "image",
          url: source.heroImageUrl,
          alt: source.title || source.siteName || "Source image",
          caption: source.description || source.snippet || "",
          source_url: source.url
        });
      }
      return media;
    })
    .slice(0, 6);
}

function buildFallbackDocument(run = {}, topSources = [], media = []) {
  const chapters = [];
  if (run.executive_summary || run.latestSummary || run.goal) {
    chapters.push({
      heading: "Executive Summary",
      summary: run.latestSummary || "",
      body: run.goal || "",
      source_urls: []
    });
  }
  if (topSources.length) {
    chapters.push({
      heading: "Collected Evidence",
      summary: `Fetched ${topSources.length} source ${topSources.length === 1 ? "page" : "pages"}.`,
      body: topSources.map((source) => `${source.title || source.url}: ${source.description || source.snippet || source.bodyPreview.slice(0, 180)}`).join(" | "),
      source_urls: topSources.map((source) => source.url)
    });
  }

  return {
    title: run.plan?.title || run.goal || "Deep Search document",
    subtitle: run.plan?.objective || "",
    toc: chapters.map((chapter, index) => ({
      id: `fallback-chapter-${index + 1}`,
      label: chapter.heading
    })),
    chapters: chapters.map((chapter, index) => ({
      id: `fallback-chapter-${index + 1}`,
      heading: chapter.heading,
      summary: chapter.summary,
      body: chapter.body,
      source_urls: chapter.source_urls,
      image_urls: media.slice(index, index + 1).map((item) => item.url)
    })),
    appendix: [],
    selected_images: media
  };
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
