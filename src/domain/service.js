import { randomUUID } from "node:crypto";
import { EventStore } from "../store/event-store.js";
import { loadConfig, getProgram, getConflictRule, findExclusivityGroup } from "../config.js";
import { replay, applyEvent, isActive, membersAt } from "./projection.js";
import { evaluateApplication, latePaymentReceipts } from "./evaluation.js";
import { programPeriod, dayKey, overlaps } from "./time.js";
import { maskMember } from "./masking.js";

// 受理服务：所有写操作先落事件日志再更新投影，
// 重启后 replay 恢复同一状态；外部回执按 receiptId 幂等。

/** 申请的最近活动时间（历史轨迹中的最大时间戳），不早于 submittedAt。 */
function latestActivityAt(app, fallback) {
  let latest = new Date(app.submittedAt);
  for (const h of app.history) {
    if (!h.at) continue;
    const t = new Date(h.at);
    if (t > latest) latest = t;
  }
  return latest > fallback ? latest : fallback;
}

export class IntakeService {
  constructor(store, config, { now = () => new Date() } = {}) {
    this.store = store;
    this.config = config;
    this.now = now;
    this.state = null;
  }

  static async open(file, { fixturesDir, now } = {}) {
    const config = await loadConfig(fixturesDir);
    const store = new EventStore(file);
    const events = await store.load();
    const service = new IntakeService(store, config, { now });
    service.state = replay(events, config);
    return service;
  }

  async _emit(type, payload, opts = {}) {
    const event = await this.store.append(type, payload, {
      at: (opts.at ?? this.now()).toISOString?.() ?? opts.at,
      eventId: opts.eventId,
    });
    applyEvent(this.state, event, this.config);
    return event;
  }

  _app(applicationId) {
    const app = this.state.apps.get(applicationId);
    if (!app) throw new Error(`申请不存在：${applicationId}`);
    return app;
  }

  // ---------- 受理 ----------

  /**
   * 受理一笔家庭申请。同一家庭在同一政策周期（排他分组内）只允许一笔有效申请；
   * 重复申报不抛异常，而是登记冲突并返回 rejected 结果，保证回执链路完整。
   */
  async submitApplication(input, { at } = {}) {
    const now = at ?? this.now();
    const program = getProgram(this.config, input.programCode, now);
    if (this.state.apps.has(input.applicationId)) {
      return { applicationId: input.applicationId, accepted: false, reason: "DUPLICATE_ID" };
    }
    const period = programPeriod(program, input.submittedAt ?? now, input.eventKey);
    await this._emit("APPLICATION_SUBMITTED", {
      applicationId: input.applicationId,
      familyKey: input.familyKey,
      district: input.district,
      community: input.community ?? null,
      programCode: input.programCode,
      submittedAt: (input.submittedAt ?? now).toISOString?.() ?? input.submittedAt,
      period,
    }, { at: now });

    for (const member of input.members ?? []) {
      await this.recordMemberVersion(input.applicationId, member, { at: now });
    }
    for (const material of input.materials ?? []) {
      await this.submitMaterial(input.applicationId, material.materialCode, material.doc, { at: now });
    }

    const evaluation = await this.evaluate(input.applicationId, { at: now });
    const dup = evaluation.issues.find((i) => i.code === "DUPLICATE_FAMILY_APPLICATION");
    if (dup) {
      // 冲突只挂到被拦截的这笔申请上，不影响在办的原始有效申请。
      await this._raiseConflict(input.applicationId, "DUPLICATE_FAMILY_APPLICATION", {
        applicationIds: [input.applicationId],
        refs: [dup.ref],
        detail: `家庭 ${input.familyKey} 在本政策周期内重复申报，有效申请为 ${dup.ref}`,
      }, now);
      await this._emit("REJECTION_RECORDED", {
        applicationId: input.applicationId,
        source: "SYSTEM",
        at: now.toISOString(),
        reasons: [{ code: "DUPLICATE_FAMILY_APPLICATION", message: dup.message, source: "SYSTEM", ref: dup.ref }],
      }, { at: now });
      return { applicationId: input.applicationId, accepted: false, reason: "DUPLICATE_FAMILY_APPLICATION", evaluation };
    }
    return { applicationId: input.applicationId, accepted: true, evaluation };
  }

  /** 家庭成员版本：按生效日参与判断，旧版本保留不断链。 */
  async recordMemberVersion(applicationId, member, { at, effectiveFrom, effectiveUntil } = {}) {
    const app = this._app(applicationId);
    const now = at ?? this.now();
    const existing = app.members.filter((m) => m.personId === member.personId);
    const version = existing.length + 1;
    await this._emit("MEMBER_VERSION_RECORDED", {
      applicationId,
      personId: member.personId,
      version,
      effectiveFrom: effectiveFrom ?? dayKey(member.effectiveFrom ?? now),
      effectiveUntil: effectiveUntil ?? member.effectiveUntil ?? null,
      relation: member.relation ?? null,
      member: {
        name: member.name,
        idCard: member.idCard,
        mobile: member.mobile ?? null,
        bankAccount: member.bankAccount ?? null,
        address: member.address ?? null,
        monthlyIncome: member.monthlyIncome ?? 0,
        disabled: member.disabled ?? false,
      },
    }, { at: now });
    return { personId: member.personId, version };
  }

  /** 材料提交/补交：形成连续版本，supplementRoundId 关联补正轮次。 */
  async submitMaterial(applicationId, materialCode, doc, { at, supplementRoundId } = {}) {
    const app = this._app(applicationId);
    if (!this.config.dictionary.materials[materialCode]) {
      throw new Error(`未知材料类型：${materialCode}`);
    }
    const now = at ?? this.now();
    const bucket = app.materials[materialCode];
    const version = (bucket?.versions.length ?? 0) + 1;
    await this._emit("MATERIAL_VERSION_RECORDED", {
      applicationId,
      materialCode,
      version,
      doc,
      supplementRoundId: supplementRoundId ?? null,
    }, { at: now });
    return { materialCode, version };
  }

  // ---------- 补正 ----------

  /** 发起补正：明确列出缺件与指引，申请人不再只看到“材料不全”。 */
  async requestSupplement(applicationId, items, { at, source = "STAFF", roundId } = {}) {
    const app = this._app(applicationId);
    const now = at ?? this.now();
    const open = app.supplementRounds.find((r) => r.status === "open");
    const id = roundId ?? open?.roundId ?? `SR-${applicationId}-${app.supplementRounds.length + 1}`;
    await this._emit("SUPPLEMENT_REQUESTED", {
      applicationId,
      roundId: id,
      items: items.map((i) => ({
        materialCode: i.materialCode,
        reason: i.reason,
        advice: i.advice ?? `请补交${this.config.dictionary.materials[i.materialCode]?.label ?? i.materialCode}`,
      })),
      source,
      at: now.toISOString(),
    }, { at: now });
    return { roundId: id };
  }

  /** 申请人按补正清单交件；材料齐了自动关闭补正轮次并回到审核。 */
  async submitSupplement(applicationId, roundId, materials, { at } = {}) {
    const app = this._app(applicationId);
    const round = app.supplementRounds.find((r) => r.roundId === roundId && r.status === "open");
    if (!round) throw new Error(`补正轮次不存在或已关闭：${roundId}`);
    const now = at ?? this.now();
    for (const m of materials) {
      await this.submitMaterial(applicationId, m.materialCode, m.doc, { at: now, supplementRoundId: roundId });
    }
    const evaluation = await this.evaluate(applicationId, { at: now });
    const stillMissing = evaluation.issues.filter((i) => i.severity === "supplement");
    if (stillMissing.length === 0) {
      await this._emit("SUPPLEMENT_ROUND_CLOSED", {
        applicationId, roundId, at: now.toISOString(),
      }, { at: now });
      await this._emit("STAGE_CHANGED", {
        applicationId,
        stageCode: "STREET_REVIEW",
        role: "staff",
        status: "UNDER_REVIEW",
        note: "补正完成，回到街道审核",
        at: now.toISOString(),
      }, { at: now });
    }
    return { closed: stillMissing.length === 0, remaining: stillMissing, evaluation };
  }

  // ---------- 核验回执（允许乱序） ----------

  /**
   * 登记外部核验回执。按 receiptId 幂等：乱序、重复投递都只生效一次；
   * 申请尚未建立时先挂起，申请受理后自动挂接。
   */
  async recordVerificationReceipt(receipt, { at } = {}) {
    const now = at ?? this.now();
    if (this.state.receipts.has(receipt.receiptId)) {
      return { receiptId: receipt.receiptId, recorded: false, reason: "DUPLICATE_RECEIPT" };
    }
    await this._emit("VERIFICATION_RECEIPT_RECORDED", {
      receiptId: receipt.receiptId,
      applicationId: receipt.applicationId,
      kind: receipt.kind, // MATERIAL | CRITERIA | IDENTITY
      subject: receipt.subject,
      verdict: receipt.verdict, // PASS | FAIL | EXPIRED
      message: receipt.message ?? null,
      issuedAt: receipt.issuedAt ?? null,
    }, { at: now });

    // 驳回类回执：原因进入不可覆盖的驳回清单。
    if (receipt.verdict === "FAIL" || receipt.verdict === "EXPIRED") {
      const app = this.state.apps.get(receipt.applicationId);
      if (app) {
        if (receipt.kind === "CRITERIA" || receipt.kind === "IDENTITY") {
          await this._emit("REJECTION_RECORDED", {
            applicationId: receipt.applicationId,
            source: "VERIFICATION",
            at: now.toISOString(),
            reasons: [{
              code: `${receipt.kind}_${receipt.verdict}`,
              message: receipt.message ?? `核验${receipt.verdict === "FAIL" ? "未通过" : "失效"}`,
              source: "VERIFICATION",
              ref: receipt.receiptId,
            }],
          }, { at: now });
        } else {
          // 材料类驳回：仅当该材料当前确实构成缺件时才开补正，
          // 乱序到达的旧结论（如已补交新证明后的过期回执）不再触发新轮次。
          const evaluation = await this.evaluate(receipt.applicationId, { at: now });
          const blocking = evaluation.issues.find(
            (i) => i.severity === "supplement" && i.materialCode === receipt.subject,
          );
          if (blocking) {
            await this.requestSupplement(receipt.applicationId, [{
              materialCode: receipt.subject,
              reason: receipt.message ?? blocking.message,
            }], { at: now, source: "VERIFICATION" });
          }
        }
      }
    }
    return { receiptId: receipt.receiptId, recorded: true };
  }

  // ---------- 审核流转 ----------

  async evaluate(applicationId, { at } = {}) {
    const app = this._app(applicationId);
    const evaluation = evaluateApplication(app, this.state, this.config, at ?? this.now());
    app.evaluations.push({ at: (at ?? this.now()).toISOString?.() ?? null, eligible: evaluation.eligible, issueCount: evaluation.issues.length });
    return evaluation;
  }

  /** 推进到下一办理环节；返回“下一位办理人”。 */
  async advanceStage(applicationId, { at, assignee, note } = {}) {
    const app = this._app(applicationId);
    const now = at ?? this.now();
    const flow = this.config.policies.workflow;
    const idx = flow.findIndex((s) => s.code === app.stage.code);
    if (idx < 0 || idx === flow.length - 1) throw new Error(`当前环节 ${app.stage.code} 不可推进`);
    const evaluation = await this.evaluate(applicationId, { at: now });
    if (!evaluation.eligible) {
      const supplements = evaluation.issues.filter((i) => i.severity === "supplement");
      if (supplements.length) {
        await this.requestSupplement(applicationId, supplements.map((s) => ({
          materialCode: s.materialCode, reason: s.message,
        })), { at: now, source: "SYSTEM" });
      }
      return { advanced: false, evaluation };
    }
    const next = flow[idx + 1];
    const statusByStage = { STREET_REVIEW: "UNDER_REVIEW", DISTRICT_APPROVAL: "PENDING_APPROVAL", DISBURSEMENT: "APPROVED" };
    await this._emit("STAGE_CHANGED", {
      applicationId,
      stageCode: next.code,
      role: next.role,
      assignee: assignee ?? null,
      status: statusByStage[next.code] ?? app.status,
      note: note ?? null,
      at: now.toISOString(),
    }, { at: now });
    return { advanced: true, next: { stageCode: next.code, role: next.role, assignee: assignee ?? null } };
  }

  /** 核准/驳回决定（区级确认环节）。 */
  async decide(applicationId, decision, { at, reasons = [], operator } = {}) {
    const app = this._app(applicationId);
    const now = at ?? this.now();
    if (decision === "APPROVE") {
      const evaluation = await this.evaluate(applicationId, { at: now });
      if (!evaluation.eligible) {
        return { decided: false, evaluation };
      }
      // 同周期低优先级申请被本申请替代。
      await this._supersedeLowerPriority(app, now);
      await this._emit("STAGE_CHANGED", {
        applicationId, stageCode: "DISBURSEMENT", role: "finance",
        status: "APPROVED", note: `核准人：${operator ?? "系统"}`, at: now.toISOString(),
      }, { at: now });
      return { decided: true, status: "APPROVED" };
    }
    await this._emit("REJECTION_RECORDED", {
      applicationId,
      source: "DECISION",
      at: now.toISOString(),
      reasons: reasons.map((r) => ({ ...r, source: "DECISION" })),
    }, { at: now });
    return { decided: true, status: "REJECTED" };
  }

  async _supersedeLowerPriority(app, now) {
    const program = this.config.policies.programs[app.programCode];
    for (const other of this.state.apps.values()) {
      if (other.applicationId === app.applicationId || !isActive(other)) continue;
      if (other.familyKey !== app.familyKey || other.district !== app.district) continue;
      const group = findExclusivityGroup(this.config, other.programCode, app.programCode);
      if (!group && other.programCode !== app.programCode) continue;
      if (!overlaps(other.period.periodStart, other.period.periodEnd, app.period.periodStart, app.period.periodEnd)) continue;
      const otherProgram = this.config.policies.programs[other.programCode];
      if (otherProgram.priority >= program.priority) continue;
      await this._emit("APPLICATION_SUPERSEDED", {
        applicationId: other.applicationId,
        byApplicationId: app.applicationId,
        reason: `被同周期高优先级申请 ${app.applicationId}（${program.name}）替代；${group?.reason ?? "同项目重复"}`,
        at: now.toISOString(),
      }, { at: now });
      if (other.status === "PAID") {
        await this._raiseConflict(other.applicationId, "PRIORITY_PAYMENT_CONFLICT", {
          applicationIds: [other.applicationId, app.applicationId],
          detail: "低优先级救助已发放后被高优先级申请替代，需人工核查追回",
        }, now);
      }
    }
  }

  // ---------- 发放 ----------

  /** 发起发放：paymentKey = 家庭+项目+周期，天然防重复发放。 */
  async initiatePayment(applicationId, { at, paymentId } = {}) {
    const app = this._app(applicationId);
    const now = at ?? this.now();
    if (app.status !== "APPROVED") throw new Error(`当前状态 ${app.status} 不可发放`);
    const paymentKey = `${app.familyKey}|${app.programCode}|${app.period.cycleKey}`;
    if (this.state.paymentIndex.has(paymentKey)) {
      const existing = this.state.paymentIndex.get(paymentKey);
      return { paymentId: existing.paymentId, paymentKey, duplicated: true };
    }
    const id = paymentId ?? `PAY-${randomUUID().slice(0, 8)}`;
    await this._emit("PAYMENT_INITIATED", {
      paymentId: id,
      paymentKey,
      applicationId,
      amount: this.config.policies.programs[app.programCode].amount,
      at: now.toISOString(),
    }, { at: now });
    return { paymentId: id, paymentKey, duplicated: false };
  }

  /** 发放回执（允许乱序/重复）：找不到支付单的迟到回执只留痕并挂冲突，绝不二次发放。 */
  async recordPaymentReceipt(receipt, { at } = {}) {
    const now = at ?? this.now();
    if (this.state.receipts.has(receipt.receiptId)) {
      return { receiptId: receipt.receiptId, recorded: false, reason: "DUPLICATE_RECEIPT" };
    }
    await this._emit("PAYMENT_RECEIPT_RECORDED", {
      receiptId: receipt.receiptId,
      applicationId: receipt.applicationId,
      paymentId: receipt.paymentId ?? null,
      paymentKey: receipt.paymentKey ?? null,
      result: receipt.result, // PAID | FAILED
      at: now.toISOString(),
    }, { at: now });

    const app = this.state.apps.get(receipt.applicationId);
    if (!app) return { receiptId: receipt.receiptId, recorded: true, matched: false };
    const late = latePaymentReceipts(app, this.state);
    if (late.length) {
      await this._raiseConflict(app.applicationId, "LATE_PAYMENT_RECEIPT", {
        applicationIds: [app.applicationId],
        discriminator: late.map((r) => r.receiptId).join(","),
        detail: `回执 ${late.map((r) => r.receiptId).join("、")} 无对应支付单`,
      }, now);
    }
    return { receiptId: receipt.receiptId, recorded: true, matched: !late.length };
  }

  // ---------- 冲突 ----------

  async _raiseConflict(applicationId, code, { applicationIds, refs, detail, discriminator }, now) {
    const rule = getConflictRule(this.config, code);
    await this._emit("CONFLICT_DETECTED", {
      code,
      severity: rule?.severity ?? "review",
      message: rule?.message ?? code,
      advice: rule?.advice ?? "请转人工核实",
      applicationIds,
      refs: refs ?? [],
      detail,
      discriminator,
    }, { at: now });
  }

  async resolveConflict(applicationId, conflictKey, resolution, { at } = {}) {
    this._app(applicationId);
    await this._emit("CONFLICT_RESOLVED", {
      key: conflictKey,
      resolution,
      at: (at ?? this.now()).toISOString(),
    }, { at: at ?? this.now() });
  }

  // ---------- 查询视图（街道隔离 + 角色脱敏） ----------

  _assertDistrict(app, actor) {
    if (actor.role === "auditor") return; // 审计跨街道只读
    if (actor.district && app.district !== actor.district) {
      throw new Error(`无权访问 ${app.district} 的申请（当前身份属于 ${actor.district}）`);
    }
  }

  /**
   * 打开一笔申请：资格依据、具体缺件、下一位办理人一屏呈现。
   * actor = { role, district }；身份证号等按角色脱敏。
   */
  async getApplicationView(applicationId, actor) {
    const app = this._app(applicationId);
    this._assertDistrict(app, actor);
    // 观察时点不早于该申请的最近活动时间，避免用时钟偏差评估未来才生效的版本。
    const asOf = latestActivityAt(app, this.now());
    const evaluation = evaluateApplication(app, this.state, this.config, asOf);
    const program = this.config.policies.programs[app.programCode];
    const members = membersAt(app, asOf).map((m) => ({
      personId: m.personId,
      version: m.version,
      relation: m.relation,
      ...maskMember(this.config.dictionary, m.fields, actor.role),
    }));
    const openRound = app.supplementRounds.find((r) => r.status === "open");
    const missing = evaluation.issues.filter((i) => i.severity === "supplement");
    const nextHandler = this._nextHandler(app, evaluation);
    return {
      applicationId: app.applicationId,
      familyKey: app.familyKey,
      district: app.district,
      community: app.community,
      program: { code: program.code, name: program.name, priority: program.priority },
      status: app.status,
      period: app.period,
      members,
      materials: Object.fromEntries(Object.entries(app.materials).map(([code, b]) => [
        code,
        b.versions.map((v) => ({
          version: v.version,
          docRef: v.docRef,
          effectiveFrom: v.effectiveFrom,
          effectiveUntil: v.effectiveUntil,
          active: v.active,
          supplementRoundId: v.supplementRoundId,
        })),
      ])),
      eligibilityBasis: evaluation.basis,
      missingItems: missing.map((m) => ({
        materialCode: m.materialCode ?? null,
        message: m.message,
        advice: m.advice,
      })),
      rejectionReasons: app.explicitRejections.map(({ _key, ...r }) => r),
      supplementRounds: app.supplementRounds,
      conflicts: app.conflicts,
      payments: app.payments.map((p) => ({ paymentId: p.paymentId, amount: p.amount, status: p.status })),
      nextHandler,
      currentSupplementRound: openRound ?? null,
      history: app.history,
    };
  }

  _nextHandler(app, evaluation) {
    if (["REJECTED", "SUPERSEDED", "WITHDRAWN"].includes(app.status)) {
      return { role: null, note: "流程已终止", reasons: app.explicitRejections.map((r) => r.message) };
    }
    if (app.status === "SUPPLEMENTING") {
      const round = app.supplementRounds.find((r) => r.status === "open");
      return {
        role: "applicant",
        note: "等待申请人补正",
        items: round?.items ?? [],
      };
    }
    if (app.status === "PAYMENT_SUSPENDED") {
      return { role: "staff", note: "存在待处理冲突，需街道人工核查" };
    }
    if (!evaluation.eligible && evaluation.blocking.some((i) => i.severity === "review")) {
      return { role: "staff", note: "存在待核实冲突", conflicts: evaluation.blocking.map((b) => b.code) };
    }
    return { role: app.stage.role, stageCode: app.stage.code, assignee: app.stage.assignee };
  }

  /** 待办队列：按街道隔离，工作人员只看到本街道、自己环节的件。 */
  async listQueue(actor, { stageCode } = {}) {
    const rows = [];
    for (const app of this.state.apps.values()) {
      if (actor.role !== "auditor" && actor.district && app.district !== actor.district) continue;
      if (!isActive(app)) continue;
      const evaluation = evaluateApplication(app, this.state, this.config, latestActivityAt(app, this.now()));
      const handler = this._nextHandler(app, evaluation);
      if (stageCode && handler.stageCode !== stageCode) continue;
      if (actor.role !== "auditor" && handler.role && handler.role !== actor.role && handler.role !== "applicant") continue;
      rows.push({
        applicationId: app.applicationId,
        familyKey: app.familyKey,
        programCode: app.programCode,
        status: app.status,
        nextHandler: handler,
        missingCount: evaluation.issues.filter((i) => i.severity === "supplement").length,
        conflictCount: app.conflicts.filter((c) => c.status === "open").length,
      });
    }
    return rows;
  }
}
