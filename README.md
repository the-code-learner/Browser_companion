# Browser Companion

Browser Companion is a Chrome MV3 extension scaffold for a chat-first browser agent. The extension observes the active page through constrained tools, keeps risky browser actions behind policy checks and confirmations, and is designed to connect to Codex through a local ChatGPT/OAuth connector.

## Current state

- Side panel chat UI
- Active-tab page observation
- DOM, visible text, link, button, and form extraction
- Attachment registration for local context
- Local text, CSV, JSON, Markdown, HTML, CSS, JavaScript, TypeScript, PDF, DOCX, XLSX, and image OCR attachment extraction through the native connector
- Native host health, sign-in start, and Codex request protocol
- Safe action preview and confirmation for form filling and final submit or accept actions
- Typed `SUBMIT` confirmation before high-risk submit, accept, send, publish, or finalize clicks
- Constrained browser action executor for scroll, highlight, focus, fill, select, checkbox, radio, click, viewport screenshot, numbered overlay, wait, and back actions
- Enter sends the chat message; Shift+Enter inserts a new line
- Assistant responses follow the user's language unless the user asks otherwise
- Shared message, schema, and policy modules

## Load locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this project folder.
5. Open a normal web page and click the Browser Companion extension icon.
6. If you change extension files during development, click Reload for the extension in `chrome://extensions`.
7. When observing a new site, approve the site access prompt for that origin.

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

Chrome extensions cannot start local processes directly. To connect Browser Companion to Codex, register the native messaging host after loading the unpacked extension.

On Windows:

```powershell
powershell -ExecutionPolicy Bypass -File native-host/install-windows.ps1 -ExtensionId YOUR_EXTENSION_ID
```

Then click Connect in the side panel. The connector starts the ChatGPT/Codex sign-in flow through `codex login --device-auth`.

The extension cannot run this PowerShell command before the native host is registered. When the connector is missing, the side panel shows a Copy Command button with the correct extension ID already filled in.

Attachment extraction uses local Node dependencies in the native host. Extracted text stays local unless the privacy toggle allows it to be sent in a Codex request.

`LOCAL_CONTEXT.md` is the local project memory and is intentionally ignored by git.

## License

Browser Companion uses the custom non-commercial license in `LICENSE`.
