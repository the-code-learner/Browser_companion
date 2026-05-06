import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const memoryPath = path.resolve("USER_MEMORY.md");
const bridgePath = path.resolve("native-host", "bridge.js");
const hadMemory = fs.existsSync(memoryPath);
const previousMemory = hadMemory ? fs.readFileSync(memoryPath, "utf8") : "";
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

try {
  const saved = await send({
    type: "user_memory_save",
    payload: {
      title: "Test memory",
      content: "Browser Companion memory test content."
    }
  });
  assert(saved.status === "saved", "save status should be saved");
  assert(saved.item?.id, "save should return an item id");

  const loaded = await send({ type: "user_memory_get" });
  assert(loaded.items.some((item) => item.id === saved.item.id), "get should include saved item");

  const deleted = await send({
    type: "user_memory_delete",
    payload: { id: saved.item.id }
  });
  assert(deleted.status === "deleted", "delete status should be deleted");
  assert(!deleted.items.some((item) => item.id === saved.item.id), "deleted item should be gone");

  console.log("PASS user memory save/get/delete");
} finally {
  bridge.stdin.end();
  bridge.kill();
  if (hadMemory) {
    fs.writeFileSync(memoryPath, previousMemory, "utf8");
  } else {
    fs.rmSync(memoryPath, { force: true });
  }
}

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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
