import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 载入受理服务的全部参考数据：
 *  - fixtures/context.json           现有政策样例与脱敏现场记录（政策 code/生效日/优先级以此为准）
 *  - fixtures/policies.json          政策业务细节（周期、所需材料、核验项、资格规则、优先策略）
 *  - fixtures/field-dictionary.json  字段字典（校验规则 + 按角色脱敏策略）
 *  - fixtures/conflict-materials.json 冲突材料规则
 */
export async function loadConfig(root) {
  const fx = async (name) =>
    JSON.parse(await readFile(path.join(root, "fixtures", name), "utf8"));

  const [context, policiesFile, dictionary, conflictFile] = await Promise.all([
    fx("context.json"),
    fx("policies.json"),
    fx("field-dictionary.json"),
    fx("conflict-materials.json"),
  ]);

  // 以现有政策样例为准合并业务细节：context.json 中的 code/effectiveFrom/priority 覆盖 policies.json
  const byCode = new Map();
  for (const p of policiesFile.policies ?? []) byCode.set(p.code, { ...p });
  for (const sample of context.policies ?? []) {
    const base = byCode.get(sample.code) ?? { code: sample.code };
    byCode.set(sample.code, { ...base, ...sample });
  }

  const policies = [...byCode.values()];
  for (const p of policies) {
    for (const key of ["code", "priority", "effectiveFrom", "period", "requiredDocuments", "verifications"]) {
      if (p[key] === undefined) throw new Error(`政策 ${p.code ?? "?"} 缺少必要配置: ${key}`);
    }
    p.eligibility ??= [];
    p.name ??= p.code;
    p.shortName ??= p.name;
  }

  return {
    domain: context.domain,
    settings: {
      priorityStrategy: "EXCLUSIVE_BY_PRIORITY",
      tieBreak: "FIRST_COME",
      ...(policiesFile.settings ?? {}),
    },
    policies,
    dictionary,
    conflictRules: conflictFile.rules ?? [],
    // 脱敏现场记录，仅作启动自检与展示，不进入业务库
    legacyRecords: context.records ?? [],
  };
}

export function findPolicy(config, code) {
  return config.policies.find((p) => p.code === code) ?? null;
}
