import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// 只追加事件日志（JSONL）。
// - 以 append 方式写入并 fsync，事件行一次性写入；
//   服务中途崩溃若留下半行，重启时只截断最后一条残行，已落盘事件不丢。
// - 每个事件携带全局递增 seq；乱序到达的外部回执按 receiptId 幂等去重。

export class EventStore {
  constructor(file) {
    this.file = file;
    this._seq = 0;
    this._appendChain = Promise.resolve();
  }

  async load() {
    let raw = "";
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return [];
    }
    const lines = raw.split("\n");
    // 末尾换行产生的空串直接丢弃；其余空行属于异常。
    if (lines.length && lines[lines.length - 1] === "") lines.pop();

    const events = [];
    for (const [i, line] of lines.entries()) {
      try {
        events.push(JSON.parse(line));
      } catch (err) {
        if (i === lines.length - 1) {
          // 最后一行写入中断：截掉残行后继续，seq 由完好事件重建。
          const goodLength = raw.length - line.length - (raw.endsWith("\n") ? 1 : 0);
          await fs.truncate(this.file, Math.max(goodLength, 0));
          break;
        }
        throw new Error(`事件日志第 ${i + 1} 行损坏，拒绝启动：${err.message}`);
      }
    }
    this._seq = events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
    return events;
  }

  /** 串行化追加，避免并发写入交错。 */
  append(type, payload = {}, { eventId = randomUUID(), at = new Date().toISOString() } = {}) {
    const run = this._appendChain.then(async () => {
      this._seq += 1;
      const event = { id: eventId, seq: this._seq, at, type, payload };
      const line = JSON.stringify(event) + "\n";
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const fh = await fs.open(this.file, "a");
      try {
        await fh.appendFile(line);
        await fh.syncFile?.();
      } finally {
        await fh.close();
      }
      return event;
    });
    // 链条保持 resolved：单次写入失败不阻塞后续事件。
    this._appendChain = run.then(() => {}, () => {});
    return run;
  }
}
