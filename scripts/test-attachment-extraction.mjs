import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const bridgePath = path.resolve("native-host", "bridge.js");
const bridge = spawn(process.execPath, [bridgePath], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"]
});

let stdout = Buffer.alloc(0);
let stderr = "";
const pending = [];

bridge.stdout.on("data", (chunk) => {
  stdout = Buffer.concat([stdout, chunk]);
  readFrames();
});

bridge.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

bridge.on("exit", (code) => {
  while (pending.length) {
    pending.shift().reject(new Error(`Bridge exited with code ${code}. ${stderr}`));
  }
});

function readFrames() {
  while (stdout.length >= 4) {
    const length = stdout.readUInt32LE(0);
    if (stdout.length < length + 4) return;

    const raw = stdout.subarray(4, 4 + length).toString("utf8");
    stdout = stdout.subarray(4 + length);
    const next = pending.shift();
    if (next) next.resolve(JSON.parse(raw));
  }
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);

  return new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
    bridge.stdin.write(frame, (error) => {
      if (error) reject(error);
    });
  });
}

function payload(name, type, bytes) {
  return {
    type: "extract_attachment",
    payload: {
      id: name,
      name,
      type,
      size: bytes.length,
      base64: Buffer.from(bytes).toString("base64")
    }
  };
}

async function createDocx(text) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder("word").file("document.xml", `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:body>
</w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function createXlsx(text) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["Label", "Value"]);
  sheet.addRow(["Fixture", text]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function createPdf(text) {
  const escapedText = text.replace(/[\\()]/g, "\\$&");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${escapedText.length + 41} >>\nstream\nBT /F1 16 Tf 40 90 Td (${escapedText}) Tj ET\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

function createBmp1x1() {
  return Buffer.from([
    0x42, 0x4d, 0x3a, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x36, 0x00, 0x00, 0x00, 0x28, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x18, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x13, 0x0b,
    0x00, 0x00, 0x13, 0x0b, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff,
    0xff, 0x00
  ]);
}

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const fixtures = [
  {
    name: "sample.txt",
    type: "text/plain",
    bytes: Buffer.from("Plain text fixture for Browser Companion.", "utf8"),
    expect: "Plain text fixture"
  },
  {
    name: "sample.json",
    type: "application/json",
    bytes: Buffer.from('{"fixture":"JSON attachment text"}', "utf8"),
    expect: "JSON attachment text"
  },
  {
    name: "sample.csv",
    type: "text/csv",
    bytes: Buffer.from("name,value\nfixture,CSV attachment text\n", "utf8"),
    expect: "CSV attachment text"
  },
  {
    name: "sample.html",
    type: "text/html",
    bytes: Buffer.from("<main>HTML attachment text</main>", "utf8"),
    expect: "HTML attachment text"
  },
  {
    name: "sample.pdf",
    type: "application/pdf",
    bytes: createPdf("PDF attachment text"),
    expect: "PDF attachment text"
  },
  {
    name: "sample.docx",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: await createDocx("DOCX attachment text"),
    expect: "DOCX attachment text"
  },
  {
    name: "sample.xlsx",
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: await createXlsx("XLSX attachment text"),
    expect: "XLSX attachment text"
  },
  {
    name: "sample.xls",
    type: "application/vnd.ms-excel",
    bytes: Buffer.from("legacy spreadsheet placeholder", "utf8"),
    expectStatus: "registered"
  },
  {
    name: "sample.bmp",
    type: "image/bmp",
    bytes: createBmp1x1(),
    expectStatus: "ocr text ready"
  }
];

const results = [];

for (const fixture of fixtures) {
  const result = await send(payload(fixture.name, fixture.type, fixture.bytes));
  const ok = fixture.expectStatus
    ? result.status === fixture.expectStatus
    : result.status !== "error" && String(result.text || "").includes(fixture.expect);

  results.push({
    name: fixture.name,
    status: result.status,
    ok,
    message: result.message,
    textPreview: String(result.text || "").slice(0, 80)
  });
}

bridge.stdin.end();
bridge.kill();

for (const result of results) {
  const marker = result.ok ? "PASS" : "FAIL";
  console.log(`${marker} ${result.name}: ${result.status} - ${result.message}`);
  if (!result.ok && result.textPreview) {
    console.log(`  preview: ${result.textPreview}`);
  }
}

if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}
