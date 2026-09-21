import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import { EventStore } from "../src/store/event-store.js";

async function tmpFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "event-store-test-"));
  return path.join(dir, "events.jsonl");
}

test("事件追加后重放：seq 连续、内容完整", async () => {
  const file = await tmpFile();
  const store = new EventStore(file);
  await store.append("A", { n: 1 });
  await store.append("B", { n: 2 });

  const reopened = new EventStore(file);
  const events = await reopened.load();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  assert.equal(events[1].payload.n, 2);

  // 重启后续写，seq 接着走。
  const third = await reopened.append("C", { n: 3 });
  assert.equal(third.seq, 3);
});

test("崩溃留下半行：重启时截断残行，已落盘事件不丢", async () => {
  const file = await tmpFile();
  const store = new EventStore(file);
  await store.append("A", { n: 1 });
  await store.append("B", { n: 2 });

  // 模拟写入中断：文件尾部多出半行 JSON。
  await fs.appendFile(file, '{"id":"broken","seq":3,"payl');

  const reopened = new EventStore(file);
  const events = await reopened.load();
  assert.equal(events.length, 2, "残行被截断，完好事件保留");

  // 截断后可以继续写入，且不复用已有序号之外的 seq。
  const third = await reopened.append("C", { n: 3 });
  assert.equal(third.seq, 3);
  const final = await new EventStore(file).load();
  assert.equal(final.length, 3);
  assert.equal(final[2].type, "C");
});

test("中间行损坏：拒绝启动而不是静默丢数据", async () => {
  const file = await tmpFile();
  const store = new EventStore(file);
  await store.append("A", { n: 1 });
  await store.append("B", { n: 2 });
  const raw = await fs.readFile(file, "utf8");
  const lines = raw.split("\n");
  lines[0] = "{corrupted";
  await fs.writeFile(file, lines.join("\n"));

  await assert.rejects(new EventStore(file).load(), /损坏/);
});
