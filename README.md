# Browser Companion

Browser Companion is a Chrome Manifest V3 extension for chat-first, safety-gated browser assistance.

It combines:

- a persistent side panel chat UI
- constrained page observation and browser actions
- a background service worker that mediates all extension/runtime work
- a local native host for CLI-based providers such as Codex, Claude Code, and Gemini CLI
- an asynchronous Deep Search mode for broader web-first research and report generation

The project is intentionally plain JavaScript and can be loaded directly as an unpacked extension during development.

## What It Does

Browser Companion is built around a simple rule: the model can suggest, but the extension validates and executes.

Current capabilities include:

- active-tab observation with structured page summaries
- extraction of visible text, headings, links, buttons, forms, repeated cards/items, and page outline
- attachment registration plus local extraction for text, PDF, DOCX, XLSX, and OCR-able images
- local user memory with preview-before-save confirmation
- safe action planning with policy validation and typed confirmations for risky operations
- public `web_search` and `http_request` tools for research beyond the current tab
- post-tool answer synthesis instead of dumping raw search/fetch output into chat
- multi-provider connector for:
  - Codex CLI
  - Claude Code
  - Gemini CLI
  - OpenAI-compatible HTTP providers
  - experimental Chrome Gemini Nano / Prompt API
- Deep Search report tabs with findings, sources, methodology, list/map/document views, and follow-up chat
- sanitized diagnostic logs in the side panel

## Product Shape

The extension currently has five main surfaces:

1. **Side panel UI**
   - main chat surface
   - settings overlay
   - attachment and memory management
   - action approval UI
   - connector status
   - logs and activity

2. **Background service worker**
   - tab routing
   - content-script injection
   - native messaging
   - provider request routing
   - Deep Search request routing
   - action-plan policy validation

3. **Content scripts**
   - `page-probe.js` for safe observation
   - `actions.js` for constrained browser interaction

4. **Deep Search report tab**
   - asynchronous research orchestration
   - web-first source collection
   - digesting and synthesis pipeline
   - report/list/map/print-style output
   - local follow-up thread for `Ask` and `Refine`

5. **Native host**
   - CLI provider execution
   - local auth/connect/logout/install flows
   - HTTP provider probing
   - local attachment extraction

## Safety Model

Browser Companion does **not** let the model execute arbitrary code in the page.

Instead:

- the model returns structured action plans
- the extension validates those plans against local policy
- the content executor resolves targets using constrained logic
- sensitive actions require confirmation

Examples:

- read-only actions are low risk
- navigation, field filling, and selection are medium risk
- submit/delete/publish flows are high risk
- sensitive form fields and blocked categories require stronger gating or manual handling

File upload is intentionally a user handoff: Browser Companion can focus and highlight the field, but the user completes the browser file picker manually.

## Deep Search

Deep Search is the research-heavy mode.

It launches from the side panel but runs in a dedicated extension tab in the same Chrome window. The side panel stays usable while the run continues in the background.

### Current Deep Search pipeline

1. planning pass
2. web search collection
3. public HTTP fetching
4. source digest compression
5. batch synthesis
6. final report synthesis

### Current Deep Search limits

- initial queries: up to `32`
- refinement rounds: up to `4`
- refinement queries per round: up to `16`
- retained search results per query: up to `20`
- fetched public pages total: up to `80`
- fetches per domain: up to `8`
- selected compressed source digests for final synthesis: up to `24`

The collection side is intentionally broader than the final synthesis side. The run can gather a lot of evidence, but the final report consumes compressed digests and compacted search artifacts so prompts stay manageable.

### Deep Search outputs

Depending on the evidence, the report can render as:

- report
- hybrid report + structured list
- list/record collection
- map-backed view
- print/document view

Each run also keeps a local thread:

- **Ask**: question the existing findings without starting new research
- **Refine**: create a linked child run using the user’s critique or correction

## Providers and Connector

Browser Companion is designed around local or user-controlled providers rather than embedded API-key forms.

### Supported provider paths

- **Codex CLI**
- **Claude Code**
- **Gemini CLI**
- **OpenAI-compatible HTTP providers**
- **Chrome Gemini Nano / Prompt API** (experimental, on-device)

### Connector behavior

- opening Connector refreshes provider health and model metadata
- missing CLIs show explicit install buttons only
- install and connect are separate actions
- installed providers also expose logout/reset
- selected provider/model is persisted in extension settings

### Official install commands

- Codex: `npm install -g @openai/codex`
- Claude Code: `npm install -g @anthropic-ai/claude-code`
- Gemini CLI: `npm install -g @google/gemini-cli`

### Notes

- Gemini CLI is exposed with a safe `default` model option unless reliable account-specific model discovery is available
- HTTP providers are tested through `/v1/models` and used through `/v1/chat/completions`
- Cloudflare Workers AI is supported through a dedicated preset path
- streaming HTTP providers surface live progress in the side panel
- HTTP providers can opt into planner mode, which gives smaller/local models stricter loop-avoidance guidance and richer recent-observation summaries; malformed structured planner drafts, weak actionless final responses, and detected read-only/hidden-reasoning loops are retried once with compact recovery instructions before falling back to a non-executed draft or a precise user question

## UI Notes

The side panel includes:

- top status badge for the currently selected provider
- current-page strip with explicit `Observe`
- chat timeline with safe Markdown rendering
- sticky composer
- settings overlay for memory, attachments, page, connector, privacy, activity, and logs
- jump-to-latest affordance when the user scrolls away from the newest messages

The side panel log view is sanitized before display/copy. Long bodies, prompts, obvious secrets, auth fields, emails, phone-like strings, and local paths are redacted or omitted.

## Repository Layout

```text
.
|-- manifest.json
|-- src
|   |-- background
|   |   `-- service-worker.js
|   |-- content
|   |   |-- actions.js
|   |   |-- overlay.css
|   |   `-- page-probe.js
|   |-- deep-search
|   |   |-- App.js
|   |   |-- index.html
|   |   `-- styles.css
|   |-- shared
|   |   |-- debug-log.js
|   |   |-- deep-search.js
|   |   |-- markdown.js
|   |   |-- messages.js
|   |   |-- policy.js
|   |   |-- runtime-log.js
|   |   `-- schemas.js
|   `-- sidepanel
|       |-- App.js
|       |-- index.html
|       `-- styles.css
|-- native-host
|   |-- bridge.js
|   |-- host-manifest.json
|   `-- install-windows.ps1
|-- codex
|   |-- system-prompt.md
|   `-- tool-schema.json
`-- scripts
    |-- check-extension.mjs
    |-- test-attachment-extraction.mjs
    |-- test-deep-search.mjs
    |-- test-markdown.mjs
    |-- test-policy.mjs
    `-- test-user-memory.mjs
```

## Load the Extension Locally

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this repository folder
5. Open a normal web page
6. Click the Browser Companion extension icon to open the side panel

If you change extension files during development, reload the extension from `chrome://extensions`.

When observing a new site, Chrome may ask for site access. The explicit `Observe` action is the user-triggered path for that permission.

## Native Host Setup

Chrome extensions cannot start local processes directly, so CLI providers and local extraction run through a native messaging host.

### Windows

After loading the unpacked extension, register the native host:

```powershell
powershell -ExecutionPolicy Bypass -File native-host/install-windows.ps1 -ExtensionId YOUR_EXTENSION_ID
```

Then open Connector in the side panel and use **Check**, **Install**, **Connect**, or **Logout** as needed.

If Node/npm is already installed but the native host still cannot find it, reload Chrome after registration. The Windows installer writes a launcher that helps the bridge locate Node/npm even when Chrome starts with a reduced PATH.

## Development

### Requirements

- Node.js `>= 20`
- Chrome or Chromium with extension developer mode enabled

### Scripts

Run the scaffold and consistency check:

```bash
npm run check
```

Run the main test suite:

```bash
npm test
```

Run attachment extraction tests only:

```bash
npm run test:attachments
```

Run user-memory protocol tests only:

```bash
npm run test:memory
```

## Dependencies

Runtime dependencies currently used by the native-host / report stack:

- `exceljs`
- `leaflet`
- `mammoth`
- `pdf-parse`
- `tesseract.js`

The extension UI itself stays dependency-light and framework-free.

## Current Constraints

- MV3 extension architecture, so background logic lives in a service worker
- no arbitrary DOM execution by the model
- no built-in API-key UI for OpenAI/Anthropic/Google CLI providers
- file chooser dialogs still require user activation
- provider quota/status is mostly reactive except where a provider exposes usable local metadata
- Deep Search is web-first, not a browser-crawling tab-opener during the run

## License

Browser Companion uses the custom non-commercial license in `LICENSE`.
