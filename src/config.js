import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FIXTURES_DIR = path.join(root, "fixtures");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

/**
 * 加载政策样例、字段字典、冲突口径。全部为只读配置，
 * 优先级、排他分组、脱敏策略均从这些文件驱动。
 */
export async function loadConfig(dir = FIXTURES_DIR) {
  const [policies, dictionary, conflicts, context] = await Promise.all([
    readJson(path.join(dir, "policies.json")),
    readJson(path.join(dir, "field-dictionary.json")),
    readJson(path.join(dir, "conflicts.json")),
    readJson(path.join(dir, "context.json")).catch(() => null),
  ]);
  return { policies, dictionary, conflicts, context };
}

/** 取救助项目配置；项目不存在或尚未生效时抛错。 */
export function getProgram(config, programCode, at = new Date()) {
  const program = config.policies.programs[programCode];
  if (!program) {
    throw new Error(`未知救助项目：${programCode}`);
  }
  if (new Date(program.effectiveFrom + "T00:00:00+08:00") > new Date(at)) {
    throw new Error(`救助项目 ${programCode} 自 ${program.effectiveFrom} 起生效`);
  }
  return program;
}

/** 两个项目是否处于同一排他分组（或同为一个项目）。 */
export function shareExclusivityGroup(config, codeA, codeB) {
  if (codeA === codeB) return true;
  return config.policies.exclusivityGroups.some(
    (g) => g.programs.includes(codeA) && g.programs.includes(codeB),
  );
}

export function findExclusivityGroup(config, codeA, codeB) {
  return config.policies.exclusivityGroups.find(
    (g) => g.programs.includes(codeA) && g.programs.includes(codeB),
  );
}

/** 冲突规则口径查询。 */
export function getConflictRule(config, ruleCode) {
  return config.conflicts.rules.find((r) => r.code === ruleCode) ?? null;
}
