import assert from "node:assert/strict";
import {
  buildFallbackDeepSearchReport,
  collectFetchCandidates,
  createDeepSearchRun,
  normalizeDeepSearchRun,
  upsertDeepSearchRunList
} from "../src/shared/deep-search.js";

const run = createDeepSearchRun({
  id: "run-1",
  goal: "Find direct public AI operations roles in Europe.",
  provider: "openai-codex",
  model: "gpt-5.5",
  windowId: 12,
  originTabId: 88,
  observation: {
    tab: {
      id: 88,
      windowId: 12,
      url: "https://example.com/jobs",
      title: "Jobs"
    },
    visible_text: "Visible text ".repeat(50),
    headings: [{ name: "Jobs" }]
  }
});

assert.equal(run.status, "queued");
assert.equal(run.seedContext.page.tabId, 88);
assert.equal(run.seedContext.page.windowId, 12);

const normalized = normalizeDeepSearchRun({
  ...run,
  searchArtifacts: [
    {
      query: "remote ai operations jobs europe",
      results: [
        { title: "A", url: "https://example.com/role-a", snippet: "one" },
        { title: "A duplicate", url: "https://example.com/role-a", snippet: "dup" },
        { title: "B", url: "https://second.com/role-b", snippet: "two" },
        { title: "C", url: "https://third.com/role-c", snippet: "three" }
      ]
    }
  ]
});

const candidates = collectFetchCandidates(normalized.searchArtifacts, {
  maxTotal: 3,
  maxPerDomain: 1
});

assert.equal(candidates.length, 3);
assert.equal(candidates[0].url, "https://example.com/role-a");
assert.equal(candidates[1].url, "https://second.com/role-b");
assert.equal(candidates[2].url, "https://third.com/role-c");

const list = upsertDeepSearchRunList([
  createDeepSearchRun({ id: "old-1", goal: "Old one", status: "completed", updatedAt: "2026-01-01T00:00:00.000Z" }),
  createDeepSearchRun({ id: "old-2", goal: "Old two", status: "completed", updatedAt: "2026-01-02T00:00:00.000Z" })
], {
  ...run,
  status: "running",
  updatedAt: "2026-06-05T10:00:00.000Z"
}, { limit: 2 });

assert.equal(list.length, 2);
assert.equal(list[0].id, "run-1");

const fallback = buildFallbackDeepSearchReport({
  ...run,
  searchArtifacts: normalized.searchArtifacts,
  fetchedSources: [
    {
      url: "https://example.com/role-a",
      title: "Role A",
      snippet: "Strong match",
      bodyPreview: "Longer preview",
      statusCode: 200,
      domain: "example.com"
    }
  ],
  lastError: {
    phase: "synthesizing",
    message: "Provider timed out."
  }
});

assert.equal(fallback.title.length > 0, true);
assert.equal(fallback.key_findings.length, 1);
assert.equal(fallback.open_questions[0], "Provider timed out.");

console.log("Deep Search helper tests passed.");
