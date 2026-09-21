import { getConflictRule, shareExclusivityGroup } from "../config.js";
import { dayKey, overlaps } from "./time.js";
import { isActive, membersAt, materialVersionAt, latestVerification } from "./projection.js";

// 资格评估：对一笔申请在 asOf 时点给出
//   - eligible：是否满足发放前置条件
//   - issues：具体缺件/失效/冲突清单（每条带补正指引）
//   - basis：资格依据（命中政策、标准、计算过程）
// 全部从投影状态推导，重启后结论一致。

export function evaluateApplication(app, state, config, asOf = new Date()) {
  const program = config.policies.programs[app.programCode];
  const asOfDay = dayKey(asOf);
  const issues = [];
  const basis = {
    programCode: program.code,
    programName: program.name,
    priority: program.priority,
    cycle: program.cycle,
    period: app.period,
    evaluatedAt: asOfDay,
    materialChecks: [],
    criteriaChecks: [],
    conflicts: [],
  };

  // 1) 材料检查：按生效日判断，跨月失效的证明会被点名。
  const members = membersAt(app, asOf);
  for (const code of program.requiredMaterials) {
    const materialCfg = config.dictionary.materials[code];
    const label = materialCfg?.label ?? code;
    const version = materialVersionAt(app, code, asOf, state);
    const check = { materialCode: code, label, ok: !!version && !version.verification };
    if (!version) {
      const bucket = app.materials[code];
      const stale = bucket?.versions.find((v) => v.effectiveUntil && v.effectiveUntil < asOfDay);
      if (stale) {
        check.detail = `已提交版本有效期至 ${stale.effectiveUntil}，跨月失效`;
        issues.push(issue("CROSS_MONTH_PROOF_EXPIRED", config, {
          materialCode: code,
          message: `${label}已于 ${stale.effectiveUntil} 失效（审核日 ${asOfDay}）`,
        }));
      } else {
        check.detail = "未提交";
        issues.push({
          code: "MATERIAL_MISSING",
          materialCode: code,
          severity: "supplement",
          message: `缺少${label}`,
          advice: `请补交${label}`,
        });
      }
    } else if (version.verification) {
      check.detail = `核验${version.verification.verdict === "EXPIRED" ? "失效" : "未通过"}：${version.verification.message ?? ""}`;
      issues.push({
        code: "MATERIAL_VERIFICATION_FAILED",
        materialCode: code,
        severity: "supplement",
        message: `${label}核验未通过：${version.verification.message ?? "请重新提交"}`,
        advice: `请补交有效的${label}`,
      });
    } else {
      check.detail = version.effectiveUntil
        ? `有效期 ${version.effectiveFrom} ~ ${version.effectiveUntil}`
        : "长期有效";
    }
    basis.materialChecks.push(check);
  }

  // 2) 政策标准：以 asOf 时点有效成员版本计算。
  const incomeTotal = members.reduce((s, m) => s + (Number(m.fields.monthlyIncome) || 0), 0);
  const incomePerMember = members.length ? incomeTotal / members.length : 0;
  const hasDisabledMember = members.some((m) => m.fields.disabled === true);
  const facts = { incomePerMember, hasDisabledMember, memberCount: members.length, incomeTotal };
  for (const criterion of program.criteria) {
    const actual = facts[criterion.field];
    const ok = compare(actual, criterion.op, criterion.value);
    basis.criteriaChecks.push({
      code: criterion.code,
      name: criterion.name,
      expected: `${criterion.field} ${criterion.op} ${criterion.value}`,
      actual,
      ok,
    });
    if (!ok) {
      issues.push({
        code: "CRITERION_NOT_MET",
        criterion: criterion.code,
        severity: "reject",
        message: `不满足「${criterion.name}」（实际值 ${formatActual(actual)}）`,
        advice: "如家庭情况变化，请更新成员版本后重新评估",
      });
    }
  }

  // 3) 同周期重复申报：同一家庭、同一排他分组、周期重叠的有效申请只留一笔。
  //    新申请优先级更高时旧申请将被替代，不构成本申请的阻碍。
  const duplicates = [...state.apps.values()].filter(
    (other) =>
      other.applicationId !== app.applicationId &&
      other.familyKey === app.familyKey &&
      other.district === app.district &&
      isActive(other) &&
      shareExclusivityGroup(config, other.programCode, app.programCode) &&
      overlaps(
        other.period.periodStart, other.period.periodEnd,
        app.period.periodStart, app.period.periodEnd,
      ),
  );
  for (const dup of duplicates) {
    const dupProgram = config.policies.programs[dup.programCode];
    if (dup.programCode !== app.programCode && dupProgram.priority < program.priority) continue;
    const rule = getConflictRule(config, "DUPLICATE_FAMILY_APPLICATION");
    basis.conflicts.push({ code: rule.code, with: dup.applicationId, programCode: dup.programCode });
    issues.push(issue("DUPLICATE_FAMILY_APPLICATION", config, {
      ref: dup.applicationId,
      message: `${rule.message}（${dup.applicationId} / ${config.policies.programs[dup.programCode].name}）`,
    }));
  }

  // 4) 同一人员出现在多个“不同家庭”的有效申请中（同家庭多笔申请由重复申报规则处理）。
  const myPersonIds = new Set(members.map((m) => m.personId));
  const personClashes = [...state.apps.values()].filter(
    (other) =>
      other.applicationId !== app.applicationId &&
      other.familyKey !== app.familyKey &&
      other.district === app.district &&
      isActive(other) &&
      membersAt(other, asOf).some((m) => myPersonIds.has(m.personId)),
  );
  for (const clash of personClashes) {
    basis.conflicts.push({ code: "PERSON_IN_MULTIPLE_FAMILIES", with: clash.applicationId });
    issues.push(issue("PERSON_IN_MULTIPLE_FAMILIES", config, { ref: clash.applicationId }));
  }

  // 5) 优先级冲突：同排他分组内，高优先级申请存在时低优先级不得发放。
  const priorityClashes = [...state.apps.values()].filter(
    (other) =>
      other.applicationId !== app.applicationId &&
      other.familyKey === app.familyKey &&
      other.district === app.district &&
      isActive(other) &&
      other.programCode !== app.programCode &&
      shareExclusivityGroup(config, other.programCode, app.programCode) &&
      overlaps(
        other.period.periodStart, other.period.periodEnd,
        app.period.periodStart, app.period.periodEnd,
      ),
  );
  for (const other of priorityClashes) {
    const otherProgram = config.policies.programs[other.programCode];
    if (otherProgram.priority > program.priority && (other.status === "PAID" || other.status === "APPROVED")) {
      basis.conflicts.push({ code: "PRIORITY_PAYMENT_CONFLICT", with: other.applicationId });
      issues.push(issue("PRIORITY_PAYMENT_CONFLICT", config, {
        ref: other.applicationId,
        message: `同周期内高优先级的${otherProgram.name}（${other.applicationId}）已${other.status === "PAID" ? "发放" : "核准"}`,
      }));
    }
  }

  // 6) 已挂接的开放冲突（含乱序回执产生的迟到支付等）。
  for (const c of app.conflicts.filter((x) => x.status === "open")) {
    basis.conflicts.push({ code: c.code, refs: c.refs });
    if (c.severity === "review" || c.severity === "reject") {
      issues.push({ code: c.code, severity: c.severity, message: c.message, advice: c.advice });
    }
  }

  const blocking = issues.filter((i) => i.severity !== "warn");
  return {
    eligible: blocking.length === 0,
    issues,
    blocking,
    basis,
    facts,
  };
}

function issue(code, config, extra = {}) {
  const rule = getConflictRule(config, code) ?? {};
  return {
    code,
    severity: rule.severity ?? "review",
    message: extra.message ?? rule.message ?? code,
    advice: extra.advice ?? rule.advice ?? "请转人工核实",
    ...("ref" in extra ? { ref: extra.ref } : {}),
    ...("materialCode" in extra ? { materialCode: extra.materialCode } : {}),
  };
}

function compare(actual, op, expected) {
  switch (op) {
    case "<=": return actual <= expected;
    case "<": return actual < expected;
    case ">=": return actual >= expected;
    case ">": return actual > expected;
    case "==": return actual === expected;
    case "!=": return actual !== expected;
    default: throw new Error(`不支持的比较符：${op}`);
  }
}

function formatActual(v) {
  return typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v);
}

/** 最新一条资格评估结论（按申请维度）。 */
export function latestEvaluation(app) {
  return app.evaluations.length ? app.evaluations[app.evaluations.length - 1] : null;
}

/** 乱序到达的支付回执若找不到支付单，派生迟到冲突。 */
export function latePaymentReceipts(app, state) {
  const ids = state.receiptsByApp.get(app.applicationId) ?? [];
  return ids
    .map((id) => state.receipts.get(id))
    .filter((r) => r && r.kind === "PAYMENT" && !app.payments.some((p) => p.receiptId === r.receiptId));
}

export { latestVerification };
