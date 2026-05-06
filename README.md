# Browser Companion

Browser Companion is a Chrome MV3 extension scaffold for a chat-first browser agent. The extension observes the active page through constrained tools, keeps risky browser actions behind policy checks and confirmations, and is designed to connect to Codex through a local ChatGPT/OAuth connector.

## Current state

- Side panel chat UI
- Active-tab page observation
- DOM, visible text, link, button, and form extraction
- Attachment registration for local context
- Native host health check placeholder
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

`LOCAL_CONTEXT.md` is the local project memory and is intentionally ignored by git.

## License

Browser Companion uses the custom non-commercial license in `LICENSE`.
