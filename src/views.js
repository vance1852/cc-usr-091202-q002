import { evaluateDocuments, evaluateConflicts, evaluateEligibility, toDateStr, addDays } from "./eligibility.js";
import { STATUS_LABELS } from "./engine.js";

/**
 * 专干工作视图：打开一笔申请，直接看到
 *  - 资格依据（政策 + 逐条规则结果）
 *  - 具体缺件（哪份材料、为什么：未提交 / 已于某日失效）
 *  - 下一位办理人（申请人补正 / 哪个核验部门未回 / 发放岗 / 已办结）
 * 无需再跨部门比对回执。
 */
export function buildDetailView(engine, app, now) {
  const config = engine.config;
  const policy = config.policies.find((p) => p.code === app.policyCode);
  const version = app.versions.at(-1);
  const materials = version?.materials ?? [];
  const members = version?.members ?? [];

  const docEval = evaluateDocuments(policy, materials, now);
  const conflicts = evaluateConflicts(config.conflictRules, materials, now);
  const eligibility = evaluateEligibility(policy, { applicant: app.applicant, members }, materials, now);

  const latest = engine.latestReceipts(app);
  const verification = {
    expected: app.expectedChecks,
    received: app.expectedChecks.map((c) => ({ checkType: c.checkType, label: c.label, ...(latest.get(c.checkType) ?? { pending: true }) })),
    pending: app.expectedChecks.filter((c) => !latest.has(c.checkType)).map((c) => c.label),
  };

  const decision = app.decisions.at(-1) ?? null;
  const openNotice = app.status === "PENDING_SUPPLEMENT" ? app.notices.at(-1) ?? null : null;

  // 即将到期提醒：有效但 7 日内到期的材料，提前告知专干，避免审核跨月失效
  const day = toDateStr(now);
  const expiringSoon = docEval.valid
    .filter((m) => m.effectiveTo && m.effectiveTo <= addDays(day, 7))
    .map((m) => ({ docType: m.docType, docId: m.docId ?? null, effectiveTo: m.effectiveTo }));

  return {
    applicationId: app.applicationId,
    status: app.status,
    statusLabel: STATUS_LABELS[app.status] ?? app.status,
    street: app.street,
    community: app.community,
    familyKey: app.familyKey,
    policyCode: app.policyCode,
    policyName: policy.name,
    period: app.period.label,
    submittedAt: app.submittedAt,
    applicant: app.applicant,
    members,
    eligibilityBasis: decision
      ? { verdict: decision.outcome, rules: decision.basis.eligibility ?? [], evaluatedAt: decision.basis.evaluatedAt }
      : { verdict: "PENDING", rules: eligibility, evaluatedAt: day },
    missingItems: openNotice ? openNotice.missing : docEval.missing,
    conflicts: openNotice ? openNotice.conflicts : conflicts,
    expiringSoon,
    nextHandler: nextHandler(app, { openNotice, verification, decision }),
    verification,
    versions: app.versions.map((v) => ({
      versionNo: v.versionNo,
      parentVersionNo: v.parentVersionNo,
      noticeId: v.noticeId,
      at: v.at,
      materialsCount: v.materials.length,
      membersCount: v.members.length,
      delta: v.delta,
    })),
    notices: app.notices,
    receipts: app.receipts,
    revocations: app.revocations ?? [],
    decision,
    supersededBy: app.supersededBy,
    disbursement: app.disbursement,
  };
}

function nextHandler(app, { openNotice, verification, decision }) {
  switch (app.status) {
    case "PENDING_SUPPLEMENT":
      return {
        queue: "申请人",
        action: "按补正通知补交材料",
        noticeId: openNotice?.noticeId ?? null,
        items: [...(openNotice?.missing ?? []).map((m) => `${m.label}（${m.reason}）`),
                ...(openNotice?.conflicts ?? []).map((c) => `材料冲突：${c.desc}`)],
      };
    case "VERIFYING":
      return {
        queue: "联合核验部门",
        action: "等待核验回执",
        pendingChecks: verification.pending,
      };
    case "APPROVED":
      return { queue: "街道发放岗", action: "执行补贴发放" };
    case "REJECTED":
      return { queue: "已办结", action: "驳回原因已告知申请人", reasons: (decision?.reasons ?? []).map((r) => r.desc) };
    case "DISBURSED":
      return { queue: "已办结", action: "补贴已发放", disbursementId: app.disbursement?.disbursementId };
    case "SUPERSEDED":
      return { queue: "已办结", action: `已由优先申请 ${app.supersededBy} 覆盖` };
    default:
      return { queue: "街道民政专干", action: "受理初审" };
  }
}

export function buildListItemView(app) {
  return {
    applicationId: app.applicationId,
    status: app.status,
    statusLabel: STATUS_LABELS[app.status] ?? app.status,
    familyKey: app.familyKey,
    policyCode: app.policyCode,
    period: app.period.label,
    community: app.community,
    submittedAt: app.submittedAt,
    applicant: app.applicant,
  };
}
