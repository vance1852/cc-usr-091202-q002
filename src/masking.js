/**
 * 按角色脱敏：策略来自字段字典 fixtures/field-dictionary.json。
 * full 原样 / partial 保留首尾 / hidden 一律 "***"。
 */
export function maskValue(value, strategy, def = {}) {
  if (value == null) return value;
  const s = String(value);
  if (strategy === "full") return value;
  if (strategy === "partial") {
    const head = def.keepHead ?? 3;
    const tail = def.keepTail ?? 0;
    if (s.length <= head + tail) return "*".repeat(Math.max(s.length, 1));
    const masked = "*".repeat(Math.max(4, s.length - head - tail));
    return s.slice(0, head) + masked + (tail > 0 ? s.slice(s.length - tail) : "");
  }
  return "***";
}

function strategyFor(def, role) {
  if (!def) return "full";
  const fromDict = def.mask?.[role] ?? def.mask?.default;
  if (fromDict) return fromDict;
  // 字典未显式配置时按敏感度兜底
  if (def.sensitivity === "high") return "hidden";
  if (def.sensitivity === "medium") return "partial";
  return "full";
}

/** 用字段字典（applicantFields / memberFields）脱敏一个对象，返回新对象 */
export function maskParty(party, fieldDefs, role) {
  if (party == null || typeof party !== "object") return party;
  const out = {};
  for (const [key, value] of Object.entries(party)) {
    const def = fieldDefs?.[key];
    out[key] = def ? maskValue(value, strategyFor(def, role), def) : value;
  }
  return out;
}

export function maskApplicationParties(view, dictionary, role) {
  return {
    ...view,
    applicant: maskParty(view.applicant, dictionary.applicantFields, role),
    members: (view.members ?? []).map((m) => maskParty(m, dictionary.memberFields, role)),
  };
}
