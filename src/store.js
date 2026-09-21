import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * 追加式事件日志（JSONL）。所有业务事实先落盘再更新内存投影，
 * 服务中途重启后通过重放日志完整恢复：不丢补正记录、不丢驳回原因、不重复发放。
 */
export class EventStore {
  #file;
  #events = [];
  #tail = Promise.resolve();

  constructor(dir) {
    this.dir = dir;
    this.#file = path.join(dir, "events.jsonl");
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    let raw = "";
    try {
      raw = await fs.readFile(this.#file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const lines = raw.split("\n").filter((l) => l.length > 0);
    for (let i = 0; i < lines.length; i++) {
      try {
        this.#events.push(JSON.parse(lines[i]));
      } catch (err) {
        // 只容忍最后一行的半截写入（进程在 fsync 前崩溃），其余损坏视为数据事故
        if (i !== lines.length - 1) throw new Error(`事件日志第 ${i + 1} 行损坏: ${err.message}`);
      }
    }
    return this.#events.length;
  }

  get events() {
    return this.#events;
  }

  /** 批量追加：同一批事件一次写入并 fsync，保证“命令产生的事实”要么全在要么全不在 */
  async append(events) {
    const run = this.#tail.then(async () => {
      const payload = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      const fh = await fs.open(this.#file, "a");
      try {
        await fh.write(payload);
        await fh.sync();
      } finally {
        await fh.close();
      }
      this.#events.push(...events);
    });
    // 失败不阻塞后续写入队列，但把错误抛给调用方
    this.#tail = run.catch(() => {});
    return run;
  }
}
