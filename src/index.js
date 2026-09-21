import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntakeService } from "./domain/service.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STORE_FILE = path.join(root, "data", "events.jsonl");

const HELP = `困难群众补贴受理服务

用法：
  node src/index.js --help                 显示本说明
  node src/index.js demo                    跑通完整演示（受理→补正→核验→发放→重启恢复）
  node src/index.js view <申请号> [--role 角色] [--district 街道] [--store 事件日志]
  node src/index.js queue [--role 角色] [--district 街道] [--store 事件日志]

角色：coordinator / staff / approver / finance / auditor / applicant
`;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command || command === "--help" || command === "help") {
    console.log(HELP);
    return;
  }
  if (command === "demo") {
    const { runDemo } = await import("./demo.js");
    await runDemo();
    return;
  }
  const service = await IntakeService.open(argValue("--store") ?? STORE_FILE);
  const actor = {
    role: argValue("--role") ?? "staff",
    district: argValue("--district") ?? null,
  };
  if (command === "view") {
    const view = await service.getApplicationView(rest[0], actor);
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  if (command === "queue") {
    const rows = await service.listQueue(actor);
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.error(`未知命令：${command}\n`);
  console.log(HELP);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
