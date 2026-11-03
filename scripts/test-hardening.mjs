import assert from "node:assert/strict";
import fs from "node:fs";
import { validateActionPlan } from "../src/shared/policy.js";
import { renderRichText } from "../src/shared/markdown.js";

const blocked = validateActionPlan({ actions: [{ type: "click_element", target: { role: "button", name: "Solve CAPTCHA" } }] });
assert.equal(blocked.allowed, false, "non-automatable actions must fail closed");
assert.equal(blocked.results[0].allowed, false);
const medium = validateActionPlan({ actions: [{ type: "fill_field", target: { role: "textbox", name: "Public note" }, value: "hello" }] });
assert.equal(medium.requiresConfirmation, true);
const sensitive = validateActionPlan({ actions: [{ type: "fill_field", target: { name: "Password" }, value: "test" }] });
assert.equal(sensitive.requiresConfirmation, true);
const mermaid = renderRichText("Here is a diagram:\n\`\`\`mermaid\nA-->B\n\`\`\`", { allowMermaid: true });
assert.match(mermaid, /data-language="mermaid"/);
assert.doesNotMatch(mermaid, /mermaid\.ink/);

const worker = fs.readFileSync(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
assert.match(worker, /pendingActionApprovals/);
assert.match(worker, /APPROVE_ACTION_PLAN/);
assert.match(worker, /approved\.planDigest !== JSON\.stringify\(plan\)/);
const native = fs.readFileSync(new URL("../native-host/bridge.js", import.meta.url), "utf8");
assert.match(native, /NATIVE_MAX_INPUT_BYTES/);
assert.match(native, /assertPublicHttpTarget\(currentUrl\)/);
assert.match(native, /provider\.detailedDebug === true/);
assert.match(native, /v1beta/);
console.log("Security invariants passed.");
