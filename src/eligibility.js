/**
 * 资格与材料判断的纯函数集。
 * 关键原则：证明按生效日参与判断 —— 每份材料只在 [effectiveFrom, effectiveTo] 内有效，
 * 未填 effectiveTo 时按政策配置的 validityDays 从签发日起算。审核跨月后证明失效会被重新识别为缺件。
 */

export function toDateStr(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 材料在 asOf 当日是否有效；无效时给出具体原因（未生效 / 已于某日失效） */
export function materialValidity(material, docDef, asOf) {
  const day = toDateStr(asOf);
  const from = material.effectiveFrom ?? material.issuedAt ?? null;
  let to = material.effectiveTo ?? null;
  if (!to && docDef?.validityDays && material.issuedAt) {
    to = addDays(toDateStr(material.issuedAt), docDef.validityDays);
  }
  if (from && day < toDateStr(from)) {
    return { valid: false, reason: `${toDateStr(from)} 起生效`, effectiveTo: to };
  }
  if (to && day > toDateStr(to)) {
    return { valid: false, reason: `已于 ${toDateStr(to)} 失效`, effectiveTo: to };
  }
  return { valid: true, effectiveTo: to };
}

/**
 * 按政策所需材料清单核对当前有效材料集。
 * 返回 { missing: [{docType,label,reason}], valid: [material...] }
 * “已提交但过期”与“未提交”都会进入 missing，但原因不同，申请人能看懂该补什么。
 */
export function evaluateDocuments(policy, materials, asOf) {
  const missing = [];
  const valid = [];
  for (const docDef of policy.requiredDocuments) {
    const candidates = materials.filter((m) => m.docType === docDef.docType);
    let accepted = null;
    let expiredReason = null;
    for (const m of candidates) {
      const v = materialValidity(m, docDef, asOf);
      if (v.valid) {
        accepted = { ...m, effectiveTo: v.effectiveTo };
        break;
      }
      expiredReason ??= v.reason;
    }
    if (accepted) {
      valid.push(accepted);
    } else {
      missing.push({
        docType: docDef.docType,
        label: docDef.label,
        reason: candidates.length > 0 ? expiredReason : "未提交",
      });
    }
  }
  return { missing, valid };
}

/** 冲突材料规则：互斥材料不得同时有效；同类材料关键字段不得不一致 */
export function evaluateConflicts(rules, materials, asOf) {
  const conflicts = [];
  const validMaterials = materials.filter((m) => materialValidity(m, null, asOf).valid);
  for (const rule of rules) {
    if (rule.check === "MUTUALLY_EXCLUSIVE") {
      const present = rule.docTypes.filter((dt) => validMaterials.some((m) => m.docType === dt));
      if (present.length === rule.docTypes.length) {
        conflicts.push({ code: rule.code, desc: rule.desc, detail: `同时存在: ${present.join("、")}` });
      }
    } else if (rule.check === "SAME_FIELD_DIFFERENT_VALUE") {
      const group = validMaterials.filter((m) => m.docType === rule.docType);
      const values = new Set(group.map((m) => JSON.stringify(m.fields?.[rule.field] ?? null)));
      if (group.length >= 2 && values.size > 1) {
        conflicts.push({
          code: rule.code,
          desc: rule.desc,
          detail: `${rule.docType} 的 ${rule.field} 存在 ${values.size} 个不同取值`,
        });
      }
    }
  }
  return conflicts;
}

function getPath(obj, dottedPath) {
  return dottedPath.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/**
 * 资格规则评估，输出逐条依据（专干打开申请即可看到“资格依据”）。
 * 支持的规则类型：PER_CAPITA_INCOME_MAX / FIELD_EQUALS / HAS_VALID_MATERIAL
 */
export function evaluateEligibility(policy, application, materials, asOf) {
  const household = application.members?.length ? application.members : [application.applicant];
  return policy.eligibility.map(({ code, desc, rule }) => {
    if (rule.type === "PER_CAPITA_INCOME_MAX") {
      const total = household.reduce((s, m) => s + (Number(m?.monthlyIncome) || 0), 0);
      const perCapita = household.length ? total / household.length : 0;
      const pass = perCapita <= rule.value;
      return {
        code, desc, pass,
        detail: `家庭${household.length}口人，月总收入${total}元，人均${perCapita.toFixed(2)}元（标准≤${rule.value}元）`,
      };
    }
    if (rule.type === "FIELD_EQUALS") {
      const actual = getPath(application, rule.field);
      const pass = actual === rule.value;
      return { code, desc, pass, detail: `${rule.field} = ${JSON.stringify(actual)}（要求 ${JSON.stringify(rule.value)}）` };
    }
    if (rule.type === "HAS_VALID_MATERIAL") {
      const hit = materials.find(
        (m) => m.docType === rule.docType && materialValidity(m, null, asOf).valid
      );
      return { code, desc, pass: Boolean(hit), detail: hit ? `已提交有效 ${rule.docType}` : `缺少有效 ${rule.docType}` };
    }
    return { code, desc, pass: false, detail: `未知规则类型 ${rule.type}` };
  });
}

/** 两个政策周期是否在时间上重叠（用于跨政策优先互斥判断） */
export function periodsOverlap(a, b) {
  return a.start <= b.end && b.start <= a.end;
}
