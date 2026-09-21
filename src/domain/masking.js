// 按角色脱敏。策略来自 fixtures/field-dictionary.json：
// 每个字段声明各角色可见档位（full / 各掩码 / hidden），* 为兜底角色。

function maskName(value) {
  if (!value) return value;
  return value[0] + "*".repeat(Math.max(value.length - 1, 1));
}

function maskIdCard(value) {
  if (!value) return value;
  if (value.length <= 10) return "*".repeat(value.length);
  return value.slice(0, 6) + "*".repeat(value.length - 10) + value.slice(-4);
}

function maskIdCardStrict(value) {
  if (!value) return value;
  if (value.length <= 2) return "*".repeat(value.length);
  return value[0] + "*".repeat(value.length - 2) + value.slice(-1);
}

function maskPhone(value) {
  if (!value) return value;
  if (value.length <= 7) return "*".repeat(value.length);
  return value.slice(0, 3) + "****" + value.slice(-4);
}

function maskBankCard(value) {
  if (!value) return value;
  const tail = value.slice(-4);
  return "*".repeat(Math.max(value.length - 4, 4)) + tail;
}

function maskAddress(value) {
  if (!value) return value;
  const head = value.slice(0, 6);
  return head + "***";
}

const STRATEGIES = new Map([
  ["full", (v) => v],
  ["hidden", () => "***"],
  ["name", maskName],
  ["idCard", maskIdCard],
  ["idCardStrict", maskIdCardStrict],
  ["phone", maskPhone],
  ["bankCard", maskBankCard],
  ["address", maskAddress],
]);

/**
 * 对单个字段按角色脱敏。字段未在字典中登记时默认 hidden，
 * 保证新增敏感字段不会因为漏配置而明文外泄。
 */
export function maskField(dictionary, fieldKey, value, role) {
  if (value == null) return value;
  const field = dictionary.fields[fieldKey];
  if (!field) return "***";
  const strategy = field.mask[role] ?? field.mask["*"] ?? "hidden";
  const fn = STRATEGIES.get(strategy) ?? STRATEGIES.get("hidden");
  return fn(value);
}

const MEMBER_FIELD_MAP = {
  name: "person.name",
  idCard: "person.idCard",
  mobile: "person.mobile",
  bankAccount: "person.bankAccount",
  address: "person.address",
};

/** 对家庭成员视图按角色脱敏，非敏感字段（收入、残疾标识、关系）原样保留。 */
export function maskMember(dictionary, member, role) {
  const out = { ...member };
  for (const [key, fieldKey] of Object.entries(MEMBER_FIELD_MAP)) {
    if (key in out) out[key] = maskField(dictionary, fieldKey, out[key], role);
  }
  return out;
}
