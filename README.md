# Browser Companion

Browser Companion is a Chrome MV3 extension scaffold for a chat-first browser agent. The extension observes the active page through constrained tools, keeps risky browser actions behind policy checks and confirmations, and is designed to connect to local subscription-based CLI providers without API keys.

## Current state

- Side panel chat UI
- Active-tab page observation
- Full page dump for smaller pages; outline-plus-retrieval compaction for larger pages
- DOM, visible text, link, button, form, section, and structured item extraction
- Attachment registration for local context
- Local text, CSV, JSON, Markdown, HTML, CSS, JavaScript, TypeScript, PDF, DOCX, XLSX, and image OCR attachment extraction through the native connector
- Local user memory stored in `USER_MEMORY.md`, with preview-before-save confirmation
- Native host health, sign-in start, and local provider request protocol
- Safe action preview and confirmation for form filling and final submit or accept actions
- Typed `SUBMIT` confirmation before high-risk submit, accept, send, publish, or finalize clicks
- Constrained browser action executor for scroll, highlight, focus, fill, select, checkbox, radio, click, viewport screenshot, numbered overlay, wait, and back actions
- General http/https URL navigation through the `open_url` browser action
- Safe public HTTP analysis through `http_request` for GET, HEAD, and OPTIONS without browser cookies
- Public web search through `web_search` for context beyond the active tab
- Background reading of search-result pages through `http_request` GET for verification and detail
- Research behavior encourages reading additional sources or refining the search when the first source is weak
- Post-tool synthesis turns search and HTTP results into an answer instead of dumping raw results in chat
- Automatic compact-context retry when post-action synthesis hits provider-style failures
- Markdown rendering in chat, including Mermaid diagram blocks
- Enter sends the chat message; Shift+Enter inserts a new line
- Assistant responses follow the user's language unless the user asks otherwise
- Side panel connector for Codex, Claude Code, and Gemini CLI provider/model selection
- OpenAI-compatible HTTP provider configuration for local or private servers such as llama.cpp, LocalAI, LiteLLM, vLLM, or a custom proxy
- Streaming support for OpenAI-compatible HTTP providers, including live thinking updates in the side panel
- Opt-in provider CLI installation buttons; missing CLIs are never installed automatically
- Expandable one-line action notes inside the chat for approvals, executed actions, and results
- Top-right settings menu for memory, attachments, current page, connector, privacy, and activity
- Dedicated diagnostic Logs view with sanitized provider, action, and synthesis traces
- Sticky chat composer pinned to the bottom of the side panel
- System-aware light/dark theme with a small manual toggle
- Shared message, schema, and policy modules

## Load locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this project folder.
5. Open a normal web page and click the Browser Companion extension icon.
6. If you change extension files during development, click Reload for the extension in `chrome://extensions`.
7. When observing a new site, approve the site access prompt for that origin if Chrome shows it. The `Observe` action itself will request site access when needed; Chrome still controls and confirms the permission prompt.

## Development

Run a lightweight static check:

```bash
npm run check
```

Run policy tests:

```bash
npm test
```

## Local connector

Chrome extensions cannot start local processes directly. To connect Browser Companion to local AI CLI tools, register the native messaging host after loading the unpacked extension.

On Windows:

```powershell
powershell -ExecutionPolicy Bypass -File native-host/install-windows.ps1 -ExtensionId YOUR_EXTENSION_ID
```

Then use the Connector settings in the side panel. Browser Companion detects these local providers:

- Codex: install command `npm install -g @openai/codex`
- Claude Code: install command `npm install -g @anthropic-ai/claude-code`
- Gemini CLI: install command `npm install -g @google/gemini-cli`

Missing providers show an explicit Install button only. Browser Companion does not install Claude Code, Gemini CLI, or Codex just because they are missing. Install opens a visible terminal so the user can see and control the command. Connect is separate from Install and starts the selected provider's local sign-in flow.

Codex remains the default path when it is connected. Claude Code and Gemini CLI are used only when installed, signed in through their own local CLI session, and selected in Connector. Opening the Connector settings section refreshes provider status and model metadata automatically; the Check button does the same on demand. The selected provider and model are saved as Connector settings and restored on the next side panel session. Gemini CLI is shown with the provider default model unless the CLI exposes reliable account-specific model discovery.

Connector status in the side panel reflects the currently selected provider. For HTTP providers, Browser Companion refreshes live health when Connector opens, so an offline local server is shown as offline even if Codex or Gemini CLI are available on the same machine.

If provider install says Node/npm is missing but Node is already installed, reload Chrome after re-registering the native host. The Windows installer now writes the Node.js directory into `native-host/bridge-launcher.cmd` so the bridge can find `npm.cmd` even when Chrome starts with a reduced PATH.

For a local or private OpenAI-compatible server, open Connector and add an HTTP provider with:

- Base URL, for example `http://192.168.0.10:8080`
- optional Basic Auth username and password
- model selected from `GET /v1/models`

HTTP providers use `POST /v1/chat/completions`. When selected, observed page content, allowed attachment text, and local memory context may be sent to that server.

When `Use streaming responses` is enabled for an HTTP provider, Browser Companion sends `stream: true`, reads SSE responses, and shows live thinking progress in the side panel. Requests time out only when streamed activity stops or the user explicitly stops the request.

For smaller observed pages, Browser Companion can send the full page dump to the provider. Larger pages are compacted automatically into a page outline, structured items, focused context, and a smaller text dump so important middle-of-page content is less likely to disappear.

Listing-style cards on SPA sites are observed conservatively. When Browser Companion can deterministically recover a canonical destination URL from the DOM, that destination is preserved and can be used for `open_url_new_tab` instead of falling back to a plain button click.

The extension cannot run this PowerShell command before the native host is registered. When the connector is missing, the side panel shows a Copy Command button with the correct extension ID already filled in.

Attachment extraction uses local Node dependencies in the native host. Extracted text stays local unless the privacy toggle allows it to be sent in a provider request.

`LOCAL_CONTEXT.md` is the local project memory and is intentionally ignored by git.

## License

Browser Companion uses the custom non-commercial license in `LICENSE`.
