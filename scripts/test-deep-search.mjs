import assert from "node:assert/strict";
import {
  buildFallbackDeepSearchReport,
  chunkItems,
  collectFetchCandidates,
  createDeepSearchRun,
  normalizeDeepSearchRun,
  selectTopSourceDigests,
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
assert.equal(fallback.presentation.available_views.includes("print"), true);
assert.equal(fallback.collections.length, 1);
assert.equal(fallback.document.chapters.length > 0, true);

const digestRun = normalizeDeepSearchRun({
  ...run,
  sourceDigests: [
    {
      url: "https://example.com/role-a",
      title: "Role A",
      domain: "example.com",
      relevance_score: 92,
      confidence: 80,
      summary: "Strong direct match"
    },
    {
      url: "https://example.com/role-b",
      title: "Role B",
      domain: "example.com",
      relevance_score: 91,
      confidence: 79,
      summary: "Second direct match"
    },
    {
      url: "https://second.com/role-c",
      title: "Role C",
      domain: "second.com",
      relevance_score: 89,
      confidence: 82,
      summary: "Good supporting source"
    }
  ],
  batchSummaries: [
    {
      title: "Batch 1",
      summary: "Compressed batch"
    }
  ]
});

assert.equal(digestRun.sourceDigests.length, 3);
assert.equal(digestRun.batchSummaries[0].title, "Batch 1");

const selectedDigests = selectTopSourceDigests(digestRun.sourceDigests, {
  maxTotal: 2,
  maxPerDomain: 1
});

assert.equal(selectedDigests.length, 2);
assert.equal(selectedDigests[0].url, "https://example.com/role-a");
assert.equal(selectedDigests[1].url, "https://second.com/role-c");

const digestChunks = chunkItems(digestRun.sourceDigests, 2);
assert.equal(digestChunks.length, 2);
assert.equal(digestChunks[0].length, 2);
assert.equal(digestChunks[1].length, 1);

const richReport = normalizeDeepSearchRun({
  ...run,
  status: "completed",
  finalReport: {
    title: "Rich output",
    objective: "Compare many options",
    executive_summary: "Summary",
    key_findings: [],
    sections: [],
    methodology: ["Collected sources"],
    open_questions: [],
    sources: [
      {
        url: "https://example.com/role-a",
        title: "Role A",
        snippet: "Strong match",
        heroImageUrl: "https://example.com/hero.jpg"
      }
    ],
    presentation: {
      primary_view: "hybrid",
      available_views: ["report", "list", "map", "print"],
      print_ready: true
    },
    collections: [
      {
        title: "Jobs",
        record_type: "job",
        columns: [
          { key: "organization", label: "Organization", kind: "text" }
        ],
        items: [
          {
            label: "Operations Lead",
            primary_url: "https://example.com/apply",
            fields: {
              organization: "Example Org"
            },
            location: {
              label: "Milan",
              query: "Milan Italy"
            }
          }
        ]
      }
    ],
    document: {
      title: "Printable report",
      chapters: [
        {
          heading: "Chapter 1",
          body: "Body"
        }
      ]
    },
    map_data: [
      {
        title: "Map",
        points: [
          {
            label: "Milan",
            location: {
              label: "Milan",
              query: "Milan Italy"
            }
          }
        ]
      }
    ],
    media: [
      {
        url: "https://example.com/hero.jpg",
        caption: "Hero"
      }
    ]
  }
});

assert.equal(richReport.finalReport.presentation.primary_view, "hybrid");
assert.equal(richReport.finalReport.collections[0].items[0].location.query, "Milan Italy");
assert.equal(richReport.finalReport.document.chapters[0].heading, "Chapter 1");
assert.equal(richReport.finalReport.map_data[0].points[0].label, "Milan");
assert.equal(richReport.finalReport.media[0].url, "https://example.com/hero.jpg");

console.log("Deep Search helper tests passed.");
