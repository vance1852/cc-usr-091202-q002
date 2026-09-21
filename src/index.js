#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "./config.js";
import { Engine } from "./engine.js";
import { createServer } from "./server.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const HELP = `困难群众补贴受理服务

用法:
  npm start                 启动受理服务（默认端口 3000，数据目录 ./data）
  npm start -- --help       显示本说明
  npm test                  运行测试

环境变量:
  PORT        服务端口（默认 3000）
  DATA_DIR    事件日志目录（默认 ./data）

身份请求头（生产环境由网关/SSO 注入）:
  X-Actor-Id  工号    X-Role  角色    X-Street  所属街道
角色: caseworker 街道民政专干 | disburser 发放岗 | auditor 监督 |
      district-admin 区级(可跨街道只读) | verification-agent 核验部门回执

主要接口:
  POST /streets/:street/applications                 受理申请（支持 Idempotency-Key）
  GET  /streets/:street/applications/:id             工作视图：资格依据/具体缺件/下一位办理人
  POST /streets/:street/applications/:id/supplements 材料补交（连续版本）
  POST /streets/:street/applications/:id/receipts    核验回执（幂等、容忍乱序）
  POST /streets/:street/applications/:id/disburse    发放（幂等，防重复）
  POST /streets/:street/applications/:id/reject      驳回（原因留痕）
  GET  /meta                                         政策、优先级策略、字段角色
`;

/** 启动自检：现有现场记录中的同家庭重复申报，正是本服务要拦截的情形 */
function reportLegacyDuplicates(config) {
  const byFamily = new Map();
  for (const r of config.legacyRecords) {
    byFamily.set(r.familyKey, [...(byFamily.get(r.familyKey) ?? []), r.applicationId]);
  }
  for (const [familyKey, ids] of byFamily) {
    if (ids.length > 1) {
      console.log(`[自检] 历史记录中家庭 ${familyKey} 存在重复申报 (${ids.join(", ")}) —— 本服务已启用同政策周期查重`);
    }
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  const config = await loadConfig(root);
  console.log(`已载入 ${config.domain} 参考数据：政策 ${config.policies.length} 项，冲突材料规则 ${config.conflictRules.length} 条`);
  reportLegacyDuplicates(config);

  const dataDir = process.env.DATA_DIR ?? path.join(root, "data");
  // 业务日期按北京时间取（证明生效日按日历日判断）
  const clock = () => new Date(Date.now() + 8 * 3600_000).toISOString().replace("Z", "+08:00");
  const engine = await Engine.open({ dir: dataDir, config, clock });

  const server = createServer({ engine });
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    console.log(`受理服务已启动: http://localhost:${port} （--help 查看接口说明）`);
  });
}

await main();
