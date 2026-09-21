import { randomUUID } from "node:crypto";
import { EventStore } from "./store.js";
import {
  evaluateDocuments,
  evaluateConflicts,
  evaluateEligibility,
  periodsOverlap,
} from "./eligibility.js";

/** 业务错误：携带 HTTP 状态码与稳定错误码，由 server 层翻译 */
export class BizError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 有效（在办）状态：同一政策周期内同一家庭只允许一个有效申请 */
const ACTIVE_STATUSES = new Set(["SUBMITTED", "PENDING_SUPPLEMENT", "VERIFYING", "APPROVED", "DISBURSED"]);

const STATUS_LABELS = {
  SUBMITTED: "已受理",
  PENDING_SUPPLEMENT: "待补正",
  VERIFYING: "核验中",
  APPROVED: "已批准",
  REJECTED: "已驳回",
  DISBURSED: "已发放",
  SUPERSEDED: "已被优先政策覆盖",
};

export class Engine {
  #store;
  #config;
  #clock;
  #apps = new Map(); // applicationId -> aggregate
  #idempotency = new Map(); // key -> {type, applicationId, ...}
  #disburseLedger = new Map(); // familyKey|policyCode|period -> disbursement
  #tail = Promise.resolve();

  constructor({ store, config, clock }) {
    this.#store = store;
    this.#config = config;
    this.#clock = clock;
  }

  static async open({ dir, store, config, clock }) {
    const s = store ?? new EventStore(dir);
    await s.init();
    const engine = new Engine({ store: s, config, clock: clock ?? (() => new Date().toISOString()) });
    for (const event of s.events) engine.#apply(event);
    return engine;
  }

  get config() {
    return this.#config;
  }

  now() {
    return this.#clock();
  }

  // ---------- 投影：事件折叠（提交与重放共用同一套逻辑，保证重启后状态一致） ----------

  #apply(event) {
    const app = event.data?.applicationId ? this.#apps.get(event.data.applicationId) : null;
    switch (event.type) {
      case "ApplicationSubmitted": {
        const d = event.data;
        this.#apps.set(d.applicationId, {
          applicationId: d.applicationId,
          street: d.street,
          community: d.community,
          familyKey: d.familyKey,
          policyCode: d.policyCode,
          period: d.period,
          applicant: d.applicant,
          submittedAt: d.submittedAt,
          actor: d.actor,
          versions: [],
          notices: [],
          receipts: [],
          expectedChecks: [],
          decisions: [],
          decisionRevoked: false,
          supersededBy: null,
          disbursement: null,
          status: "SUBMITTED",
        });
        if (d.idempotencyKey) this.#idempotency.set(d.idempotencyKey, { type: "submit", applicationId: d.applicationId });
        break;
      }
      case "VersionAppended": {
        app.versions.push(event.data.version);
        // 补正到达：若此前已发起核验则回到核验中（同批后续事件可能再转为待补正）
        if (app.expectedChecks.length > 0) app.status = "VERIFYING";
        if (event.data.idempotencyKey) {
          this.#idempotency.set(event.data.idempotencyKey, {
            type: "supplement",
            applicationId: app.applicationId,
            versionNo: event.data.version.versionNo,
          });
        }
        break;
      }
      case "SupplementNoticeIssued": {
        app.notices.push(event.data.notice);
        app.status = "PENDING_SUPPLEMENT";
        break;
      }
      case "VerificationRequested": {
        app.expectedChecks = event.data.checks;
        app.verificationRequestedAt = event.at;
        app.status = "VERIFYING";
        break;
      }
      case "ReceiptRecorded": {
        // 幂等：回执按 receiptId 去重，乱序/重复到达不产生二次效果
        if (!app.receipts.some((r) => r.receiptId === event.data.receipt.receiptId)) {
          app.receipts.push(event.data.receipt);
        }
        break;
      }
      case "DecisionMade": {
        app.decisions.push(event.data.decision);
        app.decisionRevoked = false;
        app.status = event.data.decision.outcome === "APPROVED" ? "APPROVED" : "REJECTED";
        break;
      }
      case "ApprovalRevoked": {
        // 批准后收到更晚的 FAIL 回执：撤销批准回到核验中，原因留痕
        app.decisionRevoked = true;
        app.revocations = [...(app.revocations ?? []), { reason: event.data.reason, at: event.at }];
        app.status = "VERIFYING";
        break;
      }
      case "ApplicationSuperseded": {
        app.supersededBy = event.data.byApplicationId;
        app.status = "SUPERSEDED";
        break;
      }
      case "DuplicateSubmissionRecorded": {
        // 只留审计痕迹，不形成申请
        break;
      }
      case "DisbursementRecorded": {
        app.disbursement = event.data.disbursement;
        app.status = "DISBURSED";
        this.#disburseLedger.set(
          `${app.familyKey}|${app.policyCode}|${app.period.label}`,
          event.data.disbursement
        );
        break;
      }
      default:
        throw new Error(`未知事件类型 ${event.type}`);
    }
  }

  async #commit(events) {
    const at = this.#clock();
    const stamped = events.map((e) => ({ ...e, at: e.at ?? at, eventId: e.eventId ?? randomUUID() }));
    await this.#store.append(stamped);
    for (const e of stamped) this.#apply(e);
    return stamped;
  }

  /** 命令串行化：读-改-写不允许交错，杜绝并发导致的重复发放 */
  async #run(fn) {
    const run = this.#tail.then(fn);
    this.#tail = run.catch(() => {});
    return run;
  }

  // ---------- 查询 ----------

  getApplication(applicationId) {
    return this.#apps.get(applicationId) ?? null;
  }

  listApplications({ street, status, familyKey } = {}) {
    return [...this.#apps.values()].filter(
      (a) =>
        (!street || a.street === street) &&
        (!status || a.status === status) &&
        (!familyKey || a.familyKey === familyKey)
    );
  }

  /** 每个核验环节的最新回执（按签发日，取晚者），乱序到达不影响结论 */
  latestReceipts(app) {
    const byType = new Map();
    for (const r of app.receipts) {
      const prev = byType.get(r.checkType);
      if (!prev || String(r.issuedAt) >= String(prev.issuedAt)) byType.set(r.checkType, r);
    }
    return byType;
  }

  currentMaterials(app) {
    return app.versions.at(-1)?.materials ?? [];
  }

  currentMembers(app) {
    return app.versions.at(-1)?.members ?? [];
  }

  // ---------- 命令 ----------

  async submitApplication(cmd, ctx) {
    return this.#run(async () => {
      const idemKey = cmd.idempotencyKey ?? null;
      if (idemKey && this.#idempotency.has(idemKey)) {
        const hit = this.#idempotency.get(idemKey);
        return { replayed: true, applicationId: hit.applicationId, application: this.#apps.get(hit.applicationId) };
      }

      const policy = this.#config.policies.find((p) => p.code === cmd.policyCode);
      if (!policy) throw new BizError(422, "UNKNOWN_POLICY", `未知政策 ${cmd.policyCode}`);

      const submittedAt = cmd.submittedAt ?? this.#clock();
      const submitDay = String(submittedAt).slice(0, 10);
      if (submitDay < policy.effectiveFrom || (policy.effectiveTo && submitDay > policy.effectiveTo)) {
        throw new BizError(422, "POLICY_NOT_IN_FORCE", `政策 ${policy.code} 在 ${submitDay} 不在有效期内`);
      }

      const fieldErrors = validateParty(this.#config.dictionary, cmd.applicant, cmd.members);
      if (fieldErrors.length) throw new BizError(422, "VALIDATION", "申报字段未通过字段字典校验", fieldErrors);
      if (!cmd.familyKey) throw new BizError(422, "VALIDATION", "缺少 familyKey");

      // 同一政策周期内同一家庭只允许一个有效申请（跨社区、跨街道全局查重）
      const dup = [...this.#apps.values()].find(
        (a) =>
          a.familyKey === cmd.familyKey &&
          a.policyCode === policy.code &&
          a.period.label === policy.period.label &&
          ACTIVE_STATUSES.has(a.status)
      );
      if (dup) {
        await this.#commit([
          {
            type: "DuplicateSubmissionRecorded",
            data: {
              street: ctx.street,
              familyKey: cmd.familyKey,
              policyCode: policy.code,
              period: policy.period.label,
              duplicateOf: dup.applicationId,
              crossStreet: dup.street !== ctx.street,
              actor: ctx.actor,
            },
          },
        ]);
        throw new BizError(
          409,
          "DUPLICATE_APPLICATION",
          `家庭 ${cmd.familyKey} 在政策周期 ${policy.period.label} 内已存在有效申请`,
          // 跨街道时不回显对方申请号，避免泄露其他街道数据
          dup.street === ctx.street ? { existingApplicationId: dup.applicationId } : undefined
        );
      }

      const applicationId = cmd.applicationId ?? `A-${randomUUID().slice(0, 8).toUpperCase()}`;
      const version = {
        versionNo: 1,
        parentVersionNo: null,
        noticeId: null,
        members: cmd.members ?? [],
        materials: cmd.materials ?? [],
        delta: { initial: true },
        at: submittedAt,
      };
      const events = [
        {
          type: "ApplicationSubmitted",
          data: {
            applicationId,
            street: ctx.street,
            community: cmd.community ?? null,
            familyKey: cmd.familyKey,
            policyCode: policy.code,
            period: policy.period,
            applicant: cmd.applicant,
            submittedAt,
            actor: ctx.actor,
            idempotencyKey: idemKey,
          },
        },
        { type: "VersionAppended", data: { applicationId, version, idempotencyKey: null } },
      ];

      // 材料完整性 / 冲突按提交日判断
      const docEval = evaluateDocuments(policy, version.materials, submittedAt);
      const conflicts = evaluateConflicts(this.#config.conflictRules, version.materials, submittedAt);
      if (docEval.missing.length || conflicts.length) {
        events.push({
          type: "SupplementNoticeIssued",
          data: {
            applicationId,
            notice: {
              noticeId: `N-${applicationId}-1`,
              versionNo: 1,
              missing: docEval.missing,
              conflicts,
              at: submittedAt,
            },
          },
        });
      } else {
        events.push({
          type: "VerificationRequested",
          data: { applicationId, checks: policy.verifications },
        });
      }
      await this.#commit(events);
      await this.#attemptDecision(applicationId);
      return { replayed: false, applicationId, application: this.#apps.get(applicationId) };
    });
  }

  async submitSupplement(applicationId, cmd, ctx) {
    return this.#run(async () => {
      const idemKey = cmd.idempotencyKey ?? null;
      if (idemKey && this.#idempotency.has(idemKey)) {
        const hit = this.#idempotency.get(idemKey);
        return { replayed: true, applicationId, versionNo: hit.versionNo, application: this.#apps.get(applicationId) };
      }
      const app = this.#apps.get(applicationId);
      if (!app || app.street !== ctx.street) throw new BizError(404, "NOT_FOUND", "申请不存在");
      if (app.status !== "PENDING_SUPPLEMENT") {
        throw new BizError(409, "NO_SUPPLEMENT_NEEDED", `当前状态 ${app.status} 无需补正`);
      }

      const prev = app.versions.at(-1);
      const openNotice = app.notices.at(-1);
      // 连续版本：材料按 docId 合并覆盖，成员整体替换，版本链指向上一版与所答补正通知
      const merged = new Map(prev.materials.map((m) => [m.docId ?? m.docType, m]));
      for (const m of cmd.materials ?? []) merged.set(m.docId ?? m.docType, m);
      const version = {
        versionNo: prev.versionNo + 1,
        parentVersionNo: prev.versionNo,
        noticeId: cmd.noticeId ?? openNotice?.noticeId ?? null,
        members: cmd.members ?? prev.members,
        materials: [...merged.values()],
        delta: {
          addedMaterials: (cmd.materials ?? []).map((m) => m.docId ?? m.docType),
          membersReplaced: cmd.members !== undefined,
        },
        at: this.#clock(),
      };
      const events = [
        { type: "VersionAppended", data: { applicationId, version, idempotencyKey: idemKey } },
      ];

      const policy = this.#config.policies.find((p) => p.code === app.policyCode);
      const docEval = evaluateDocuments(policy, version.materials, version.at);
      const conflicts = evaluateConflicts(this.#config.conflictRules, version.materials, version.at);
      if (docEval.missing.length || conflicts.length) {
        events.push({
          type: "SupplementNoticeIssued",
          data: {
            applicationId,
            notice: {
              noticeId: `N-${applicationId}-${app.notices.length + 1}`,
              versionNo: version.versionNo,
              missing: docEval.missing,
              conflicts,
              at: version.at,
            },
          },
        });
      } else if (app.expectedChecks.length === 0) {
        // 受理时材料不全、补正后首次齐备：此刻才发起部门核验
        events.push({ type: "VerificationRequested", data: { applicationId, checks: policy.verifications } });
      }
      await this.#commit(events);
      await this.#attemptDecision(applicationId);
      return { replayed: false, applicationId, versionNo: version.versionNo, application: this.#apps.get(applicationId) };
    });
  }

  async recordReceipt(applicationId, cmd, ctx) {
    return this.#run(async () => {
      const app = this.#apps.get(applicationId);
      if (!app || app.street !== ctx.street) throw new BizError(404, "NOT_FOUND", "申请不存在");
      if (!cmd.receiptId || !cmd.checkType || !["PASS", "FAIL"].includes(cmd.result)) {
        throw new BizError(422, "VALIDATION", "回执需包含 receiptId / checkType / result(PASS|FAIL)");
      }
      if (app.receipts.some((r) => r.receiptId === cmd.receiptId)) {
        return { replayed: true, applicationId, application: app }; // 幂等：重复回执直接确认
      }
      const receipt = {
        receiptId: cmd.receiptId,
        checkType: cmd.checkType,
        result: cmd.result,
        reason: cmd.reason ?? null,
        issuedAt: cmd.issuedAt ?? this.#clock(),
        receivedAt: this.#clock(),
      };
      await this.#commit([{ type: "ReceiptRecorded", data: { applicationId, receipt } }]);

      // 乱序场景：批准后才到的 FAIL 回执 → 撤销批准并立即按最新回执重判，原因不丢
      const expected = app.expectedChecks.some((c) => c.checkType === receipt.checkType);
      if (app.status === "APPROVED" && receipt.result === "FAIL" && expected) {
        await this.#commit([
          {
            type: "ApprovalRevoked",
            data: { applicationId, reason: `核验环节 ${receipt.checkType} 迟到的未通过回执: ${receipt.reason ?? "未说明"}` },
          },
        ]);
      }
      await this.#attemptDecision(applicationId);
      return { replayed: false, applicationId, application: this.#apps.get(applicationId) };
    });
  }

  async disburse(applicationId, ctx) {
    return this.#run(async () => {
      const app = this.#apps.get(applicationId);
      if (!app || app.street !== ctx.street) throw new BizError(404, "NOT_FOUND", "申请不存在");
      if (app.disbursement) return { replayed: true, disbursement: app.disbursement }; // 幂等：重复发放请求返回原记录
      if (app.status !== "APPROVED") {
        throw new BizError(409, "NOT_APPROVED", `当前状态 ${app.status} 不可发放`);
      }
      // 兜底：发放前再核一次最新回执，任何 FAIL 都阻断发放且原因留痕
      const latest = this.latestReceipts(app);
      const fails = app.expectedChecks
        .map((c) => latest.get(c.checkType))
        .filter((r) => r && r.result === "FAIL");
      if (fails.length) {
        throw new BizError(409, "BLOCKED_BY_RECEIPT", "存在未通过的核验回执，禁止发放", fails);
      }
      const ledgerKey = `${app.familyKey}|${app.policyCode}|${app.period.label}`;
      if (this.#disburseLedger.has(ledgerKey)) {
        throw new BizError(409, "DOUBLE_PAYMENT_GUARD", "该家庭本周期已发放，拒绝重复发放");
      }
      const policy = this.#config.policies.find((p) => p.code === app.policyCode);
      const [stamped] = await this.#commit([
        {
          type: "DisbursementRecorded",
          data: {
            applicationId,
            disbursement: {
              disbursementId: `D-${applicationId}`,
              familyKey: app.familyKey,
              policyCode: app.policyCode,
              period: app.period.label,
              amount: policy.amount,
              actor: ctx.actor,
              at: this.#clock(),
            },
          },
        },
      ]);
      return { replayed: false, disbursement: stamped.data.disbursement };
    });
  }

  async rejectApplication(applicationId, cmd, ctx) {
    return this.#run(async () => {
      const app = this.#apps.get(applicationId);
      if (!app || app.street !== ctx.street) throw new BizError(404, "NOT_FOUND", "申请不存在");
      if (!ACTIVE_STATUSES.has(app.status) || app.status === "DISBURSED") {
        throw new BizError(409, "NOT_REJECTABLE", `当前状态 ${app.status} 不可驳回`);
      }
      if (!cmd.reason) throw new BizError(422, "VALIDATION", "驳回必须填写原因");
      await this.#commit([
        {
          type: "DecisionMade",
          data: {
            applicationId,
            decision: {
              outcome: "REJECTED",
              reasons: [{ type: "MANUAL", desc: cmd.reason }],
              basis: { manual: true, actor: ctx.actor },
              at: this.#clock(),
            },
          },
        },
      ]);
      return { applicationId, application: this.#apps.get(applicationId) };
    });
  }

  // ---------- 决策 ----------

  /**
   * 决策尝试（幂等、可重入）：
   * 1. 材料按“今天”重新判断 —— 审核跨月导致证明失效时退回待补正，补正链不断；
   * 2. 等齐全部核验回执（乱序无所谓，按 checkType 取最新）；
   * 3. 汇总资格规则、回执 FAIL、跨政策优先级，任何不满足都进入驳回原因，一条不丢。
   */
  async #attemptDecision(applicationId) {
    const app = this.#apps.get(applicationId);
    if (!app || app.status !== "VERIFYING") return;
    const policy = this.#config.policies.find((p) => p.code === app.policyCode);
    const now = this.#clock();
    const materials = this.currentMaterials(app);

    const docEval = evaluateDocuments(policy, materials, now);
    const conflicts = evaluateConflicts(this.#config.conflictRules, materials, now);
    if (docEval.missing.length || conflicts.length) {
      await this.#commit([
        {
          type: "SupplementNoticeIssued",
          data: {
            applicationId,
            notice: {
              noticeId: `N-${applicationId}-${app.notices.length + 1}`,
              versionNo: app.versions.at(-1).versionNo,
              missing: docEval.missing,
              conflicts,
              at: now,
            },
          },
        },
      ]);
      return;
    }

    const latest = this.latestReceipts(app);
    const pending = app.expectedChecks.filter((c) => !latest.has(c.checkType));
    if (pending.length > 0) return; // 回执未齐，继续等

    const receiptReasons = app.expectedChecks
      .map((c) => ({ check: c, receipt: latest.get(c.checkType) }))
      .filter(({ receipt }) => receipt.result === "FAIL")
      .map(({ check, receipt }) => ({
        type: "VERIFICATION",
        checkType: check.checkType,
        desc: `${check.label}未通过：${receipt.reason ?? "未说明原因"}`,
      }));

    const members = this.currentMembers(app);
    const eligibility = evaluateEligibility(
      policy,
      { applicant: app.applicant, members },
      materials,
      now
    );
    const eligibilityReasons = eligibility
      .filter((r) => !r.pass)
      .map((r) => ({ type: "ELIGIBILITY", code: r.code, desc: `${r.desc}（${r.detail}）` }));

    const priorityReasons = this.#priorityBlockers(app, policy);

    const reasons = [...receiptReasons, ...eligibilityReasons, ...priorityReasons];
    const basis = {
      policyCode: policy.code,
      policyName: policy.name,
      period: app.period.label,
      eligibility,
      verifications: app.expectedChecks.map((c) => ({
        checkType: c.checkType,
        label: c.label,
        result: latest.get(c.checkType).result,
        reason: latest.get(c.checkType).reason ?? null,
      })),
      evaluatedAt: now,
    };

    if (reasons.length > 0) {
      await this.#commit([
        { type: "DecisionMade", data: { applicationId, decision: { outcome: "REJECTED", reasons, basis, at: now } } },
      ]);
      return;
    }

    await this.#commit([
      { type: "DecisionMade", data: { applicationId, decision: { outcome: "APPROVED", reasons: [], basis, at: now } } },
    ]);
    await this.#supersedeLowerPriority(app, policy);
  }

  /** 同家庭、周期重叠、更高优先级（或同级先到）的有效申请存在时，本申请应被优先级驳回 */
  #priorityBlockers(app, policy) {
    if (this.#config.settings.priorityStrategy !== "EXCLUSIVE_BY_PRIORITY") return [];
    const reasons = [];
    for (const other of this.#apps.values()) {
      if (other.applicationId === app.applicationId || other.familyKey !== app.familyKey) continue;
      if (!["APPROVED", "DISBURSED"].includes(other.status)) continue;
      if (!periodsOverlap(app.period, other.period)) continue;
      const otherPolicy = this.#config.policies.find((p) => p.code === other.policyCode);
      if (!otherPolicy) continue;
      if (otherPolicy.priority > policy.priority) {
        reasons.push({
          type: "PRIORITY",
          desc: `同一政策周期内已由优先级更高的「${otherPolicy.name}」覆盖（申请 ${other.applicationId}）`,
        });
      } else if (
        otherPolicy.priority === policy.priority &&
        this.#config.settings.tieBreak === "FIRST_COME" &&
        other.policyCode === policy.code &&
        String(other.submittedAt) < String(app.submittedAt)
      ) {
        reasons.push({ type: "PRIORITY", desc: `同政策同周期已有在先有效申请 ${other.applicationId}` });
      }
    }
    return reasons;
  }

  /** 本申请获批后，覆盖同家庭周期重叠且优先级更低的在办申请 */
  async #supersedeLowerPriority(app, policy) {
    if (this.#config.settings.priorityStrategy !== "EXCLUSIVE_BY_PRIORITY") return;
    for (const other of this.#apps.values()) {
      if (other.applicationId === app.applicationId || other.familyKey !== app.familyKey) continue;
      if (!["SUBMITTED", "PENDING_SUPPLEMENT", "VERIFYING", "APPROVED"].includes(other.status)) continue;
      if (!periodsOverlap(app.period, other.period)) continue;
      const otherPolicy = this.#config.policies.find((p) => p.code === other.policyCode);
      if (!otherPolicy || otherPolicy.priority >= policy.priority) continue;
      await this.#commit([
        {
          type: "ApplicationSuperseded",
          data: {
            applicationId: other.applicationId,
            byApplicationId: app.applicationId,
            reason: `按优先级策略由「${policy.name}」(priority=${policy.priority}) 覆盖「${otherPolicy.name}」(priority=${otherPolicy.priority})`,
          },
        },
      ]);
    }
  }
}

/** 按字段字典校验申请人与成员字段 */
function validateParty(dictionary, applicant, members) {
  const errors = [];
  const check = (defs, obj, prefix) => {
    for (const [field, def] of Object.entries(defs ?? {})) {
      const value = obj?.[field];
      if (def.required && (value === undefined || value === null || value === "")) {
        errors.push({ field: `${prefix}${field}`, message: `缺少必填项「${def.label}」` });
        continue;
      }
      if (value === undefined || value === null) continue;
      if (def.type === "number" && typeof value !== "number") {
        errors.push({ field: `${prefix}${field}`, message: `「${def.label}」应为数字` });
      }
      if (def.pattern && !new RegExp(def.pattern).test(String(value))) {
        errors.push({ field: `${prefix}${field}`, message: `「${def.label}」格式不合法` });
      }
      if (def.enum && !def.enum.includes(value)) {
        errors.push({ field: `${prefix}${field}`, message: `「${def.label}」须为 ${def.enum.join("/")}` });
      }
    }
  };
  check(dictionary.applicantFields, applicant ?? {}, "applicant.");
  (members ?? []).forEach((m, i) => check(dictionary.memberFields, m, `members[${i}].`));
  return errors;
}

export { ACTIVE_STATUSES, STATUS_LABELS };
