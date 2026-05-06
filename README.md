# Browser Companion

Browser Companion is a Chrome MV3 extension scaffold for a chat-first browser agent. The extension observes the active page through constrained tools, keeps risky browser actions behind policy checks and confirmations, and is designed to connect to Codex through a local ChatGPT/OAuth connector.

## Current state

- Side panel chat UI
- Active-tab page observation
- DOM, visible text, link, button, and form extraction
- Attachment registration for local context
- Local text, CSV, JSON, Markdown, HTML, CSS, JavaScript, and TypeScript attachment text extraction
- Native host health, sign-in start, and Codex request protocol
- Safe action preview and confirmation for form filling
- Constrained browser action executor for scroll, highlight, focus, fill, select, checkbox, radio, and click actions
- Shared message, schema, and policy modules

## Load locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this project folder.
5. Open a normal web page and click the Browser Companion extension icon.

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

`LOCAL_CONTEXT.md` is the local project memory and is intentionally ignored by git.

## License

Browser Companion uses the custom non-commercial license in `LICENSE`.
