import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const context = JSON.parse(await readFile(path.join(root, "fixtures", "context.json"), "utf8"));

if (process.argv.includes("--help")) {
  console.log("政务服务工作区已载入现场资料：" + context.domain);
} else {
  console.log("业务入口待接入，资料条数：" + context.records.length);
}
