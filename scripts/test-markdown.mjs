import assert from "node:assert/strict";
import { renderRichText } from "../src/shared/markdown.js";

const headingSplit = renderRichText("Intro. ### Titolo");
assert.match(headingSplit, /<p>Intro\.<\/p>/);
assert.match(headingSplit, /<h5>Titolo<\/h5>/);

const complex = renderRichText(`
### 1. Smart&Start Italia
È il bando nazionale principale gestito da **Invitalia**.
* **A chi si rivolge:** Team di persone fisiche.
* **Percentuale a fondo perduto:** 0% al Centro-Nord.

| Tipo | Fondo Perduto |
| --- | --- |
| Smart&Start | 0% |
| Resto al Sud | 50% |
`);

assert.match(complex, /<h5>1\. Smart&amp;Start Italia<\/h5>/);
assert.match(complex, /<ul><li><strong>A chi si rivolge:<\/strong> Team di persone fisiche\.<\/li><li><strong>Percentuale a fondo perduto:<\/strong> 0% al Centro-Nord\.<\/li><\/ul>/);
assert.match(complex, /<table class="markdown-table">/);
assert.doesNotMatch(complex, /###/);

console.log("markdown tests passed");
