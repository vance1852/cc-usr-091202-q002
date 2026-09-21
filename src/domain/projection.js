import { dayKey, materialValidity } from "./time.js";

// 事件溯源投影：把只追加事件重放成内存状态。
// 重启后只需重新 replay 全部事件，不依赖任何旁路状态，
// 因此“中途重启”不会改变任何受理结论。

export const ACTIVE_STATUSES = new Set([
  "RECEIVED",
  "SUPPLEMENTING",
  "UNDER_REVIEW",
  "PENDING_APPROVAL",
  "APPROVED",
  "PAID",
  "PAYMENT_SUSPENDED",
]);

export const TERMINAL_STATUSES = new Set(["REJECTED", "SUPERSEDED", "WITHDRAWN"]);

export function isActive(app) {
  return app && ACTIVE_STATUSES.has(app.status);
}

export function replay(events, config) {
  const state = createState();
  for (const event of events) applyEvent(state, event, config);
  return state;
}

export function createState() {
  return {
    apps: new Map(),
    receipts: new Map(), // receiptId -> receipt
    receiptsByApp: new Map(), // applicationId -> [receiptId]
    pendingReceipts: new Map(), // applicationId 尚未出现 -> [receipt]
    paymentIndex: new Map(), // paymentKey -> payment
    conflictIndex: new Set(), // 去重键
  };
}

function createApp(p, period) {
  return {
    applicationId: p.applicationId,
    familyKey: p.familyKey,
    district: p.district,
    community: p.community ?? null,
    programCode: p.programCode,
    submittedAt: p.submittedAt,
    period,
    status: "RECEIVED",
    members: [], // 连续成员版本，旧版本保留，active=false
    materials: {}, // materialCode -> { versions: [] }
    supplementRounds: [],
    conflicts: [],
    explicitRejections: [], // 人工/系统驳回事件，永不覆盖
    stage: { code: "COMMUNITY_INTAKE", role: "coordinator", assignee: null, since: p.submittedAt },
    history: [{ at: p.submittedAt, action: "APPLICATION_SUBMITTED" }],
    payments: [],
    supersededBy: null,
    evaluations: [],
  };
}

export function applyEvent(state, event, config) {
  const { type, payload: p, at } = event;
  switch (type) {
    case "APPLICATION_SUBMITTED": {
      if (state.apps.has(p.applicationId)) return state;
      const app = createApp(p, p.period);
      state.apps.set(p.applicationId, app);
      // 乱序：申请建立前先到的核验回执此刻挂接。
      const early = state.pendingReceipts.get(p.applicationId) ?? [];
      if (early.length) {
        state.receiptsByApp.set(p.applicationId, [
          ...(state.receiptsByApp.get(p.applicationId) ?? []),
          ...early.map((r) => r.receiptId),
        ]);
        state.pendingReceipts.delete(p.applicationId);
      }
      return state;
    }

    case "MEMBER_VERSION_RECORDED": {
      const app = state.apps.get(p.applicationId);
      if (!app) return state;
      // 同一人员的新版本生效后，旧版本封口，但链路保留不断开。
      for (const v of app.members) {
        if (v.personId === p.personId && v.active) v.active = false;
      }
      app.members.push({
        personId: p.personId,
        version: p.version,
        effectiveFrom: p.effectiveFrom,
        effectiveUntil: p.effectiveUntil ?? null,
        relation: p.relation ?? null,
        active: true,
        recordedAt: at,
        fields: p.member,
      });
      app.history.push({ at, action: "MEMBER_VERSION_RECORDED", personId: p.personId, version: p.version });
      return state;
    }

    case "MATERIAL_VERSION_RECORDED": {
      const app = state.apps.get(p.applicationId);
      if (!app) return state;
      const bucket = app.materials[p.materialCode] ?? { versions: [] };
      for (const v of bucket.versions) if (v.active) v.active = false;
      const materialCfg = config.dictionary.materials[p.materialCode];
      const validity = materialValidity(materialCfg, p.doc);
      bucket.versions.push({
        materialCode: p.materialCode,
        docRef: p.doc.docRef,
        version: p.version,
        issuedAt: p.doc.issuedAt ?? null,
        effectiveFrom: validity.effectiveFrom,
        effectiveUntil: validity.effectiveUntil,
        supplementRoundId: p.supplementRoundId ?? null,
        active: true,
        submittedAt: at,
      });
      app.materials[p.materialCode] = bucket;
      app.history.push({ at, action: "MATERIAL_VERSION_RECORDED", materialCode: p.materialCode, version: p.version, docRef: p.doc.docRef });
      return state;
    }

    case "VERIFICATION_RECEIPT_RECORDED": {
      if (state.receipts.has(p.receiptId)) return state; // 回执幂等
      const receipt = { ...p, recordedAt: at, seq: event.seq };
      state.receipts.set(p.receiptId, receipt);
      if (state.apps.has(p.applicationId)) {
        const list = state.receiptsByApp.get(p.applicationId) ?? [];
        state.receiptsByApp.set(p.applicationId, [...list, p.receiptId]);
        state.apps.get(p.applicationId).history.push({
          at, action: "VERIFICATION_RECEIPT_RECORDED", receiptId: p.receiptId, verdict: p.verdict,
        });
      } else {
        const list = state.pendingReceipts.get(p.applicationId) ?? [];
        state.pendingReceipts.set(p.applicationId, [...list, receipt]);
      }
      return state;
    }

    case "SUPPLEMENT_REQUESTED": {
      const app = state.apps.get(p.applicationId);
      if (!app) return state;
      const existing = app.supplementRounds.find((r) => r.roundId === p.roundId);
      if (existing) return state;
      const open = app.supplementRounds.find((r) => r.status === "open");
      app.supplementRounds.push({
        roundId: p.roundId,
        status: "open",
        requestedAt: p.at,
        source: p.source ?? "SYSTEM",
        items: p.items, // [{materialCode, reason, advice}]
      });
      app.status = "SUPPLEMENTING";
      app.history.push({ at: p.at, action: "SUPPLEMENT_REQUESTED", roundId: p.roundId, note: open ? "并入未结补正轮次" : null });
      return state;
    }

    case "SUPPLEMENT_ROUND_CLOSED": {
      const app = state.apps.get(p.applicationId);
      if (!app) return state;
      const round = app.supplementRounds.find((r) => r.roundId === p.roundId);
      if (round) {
        round.status = "closed";
        round.closedAt = p.at;
        app.history.push({ at: p.at, action: "SUPPLEMENT_ROUND_CLOSED", roundId: p.roundId });
      }
      return state;
    }

    case "STAGE_CHANGED": {
      const app = state.apps.get(p.applicationId);
      if (!app) return state;
      app.stage = {
        code: p.stageCode,
        role: p.role,
        assignee: p.assignee ?? null,
        since: p.at,
      };
      if (p.status) app.status = p.status;
      app.history.push({ at: p.at, action: "STAGE_CHANGED", to: p.stageCode, note: p.note ?? null });
      return state;
    }

    case "REJECTION_RECORDED": {
      const app = state.apps.get(p.applicationId);
      if (!app) return state;
      for (const reason of p.reasons) {
        // 同一来源（回执/冲突）去重，不同原因逐条保留，绝不覆盖旧原因。
        const key = reason.code + "|" + (reason.source ?? p.source ?? "") + "|" + (reason.ref ?? "");
        if (!app.explicitRejections.some((r) => r._key === key)) {
          app.explicitRejections.push({ ...reason, _key: key, at: p.at });
        }
      }
      if (app.status !== "PAID") {
        app.status = "REJECTED";
      }
      app.history.push({ at: p.at, action: "REJECTION_RECORDED", codes: p.reasons.map((r) => r.code) });
      return state;
    }

    case "APPLICATION_SUPERSEDED": {
      const app = state.apps.get(p.applicationId);
      if (!app) return state;
      app.supersededBy = p.byApplicationId;
      app.explicitRejections.push({
        code: "SUPERSEDED_BY_PRIORITY",
        message: p.reason,
        source: "SYSTEM",
        ref: p.byApplicationId,
        at: p.at,
        _key: "SUPERSEDED_BY_PRIORITY|" + p.byApplicationId,
      });
      // 已发放的低优先级申请不抹掉 PAID 状态（资金需人工追回），仅挂冲突。
      if (app.status !== "PAID") app.status = "SUPERSEDED";
      app.history.push({ at: p.at, action: "APPLICATION_SUPERSEDED", by: p.byApplicationId });
      return state;
    }

    case "CONFLICT_DETECTED": {
      const key = conflictKey(p);
      if (state.conflictIndex.has(key)) return state;
      state.conflictIndex.add(key);
      for (const appId of p.applicationIds) {
        const app = state.apps.get(appId);
        if (!app) continue;
        app.conflicts.push({
          key,
          code: p.code,
          severity: p.severity,
          message: p.message,
          advice: p.advice,
          detail: p.detail,
          refs: p.refs ?? [],
          status: "open",
          at,
        });
      }
      return state;
    }

    case "CONFLICT_RESOLVED": {
      for (const app of state.apps.values()) {
        for (const c of app.conflicts) {
          if (c.key === p.key && c.status === "open") {
            c.status = "resolved";
            c.resolution = p.resolution;
            c.resolvedAt = p.at;
          }
        }
      }
      return state;
    }

    case "PAYMENT_INITIATED": {
      if (state.paymentIndex.has(p.paymentKey)) return state;
      const payment = {
        paymentId: p.paymentId,
        paymentKey: p.paymentKey,
        applicationId: p.applicationId,
        amount: p.amount,
        status: "PENDING",
        initiatedAt: p.at,
      };
      // 乱序：发放回执可能先于支付单到达，支付单建立时回挂。
      for (const r of state.receipts.values()) {
        if (r.kind !== "PAYMENT") continue;
        if (r.paymentId === p.paymentId || (r.paymentKey && r.paymentKey === p.paymentKey)) {
          payment.status = r.result === "PAID" ? "PAID" : "FAILED";
          payment.receiptId = r.receiptId;
          payment.receiptAt = r.at;
        }
      }
      state.paymentIndex.set(p.paymentKey, payment);
      const app = state.apps.get(p.applicationId);
      if (app) {
        app.payments.push(payment);
        if (payment.status === "PAID") {
          app.status = "PAID";
          app.paidAt = payment.receiptAt;
        }
        app.history.push({ at: p.at, action: "PAYMENT_INITIATED", paymentId: p.paymentId });
      }
      return state;
    }

    case "PAYMENT_RECEIPT_RECORDED": {
      if (state.receipts.has(p.receiptId)) return state; // 回执乱序/重复都只入一次
      const receipt = { ...p, kind: "PAYMENT", recordedAt: at, seq: event.seq };
      state.receipts.set(p.receiptId, receipt);
      if (state.apps.has(p.applicationId)) {
        const list = state.receiptsByApp.get(p.applicationId) ?? [];
        state.receiptsByApp.set(p.applicationId, [...list, p.receiptId]);
      } else {
        const list = state.pendingReceipts.get(p.applicationId) ?? [];
        state.pendingReceipts.set(p.applicationId, [...list, receipt]);
      }
      const payment = p.paymentId
        ? [...state.paymentIndex.values()].find((x) => x.paymentId === p.paymentId)
        : state.paymentIndex.get(p.paymentKey);
      const app = state.apps.get(p.applicationId);
      if (payment) {
        payment.status = p.result === "PAID" ? "PAID" : "FAILED";
        payment.receiptId = p.receiptId;
        payment.receiptAt = p.at;
      }
      if (app) {
        if (payment && p.result === "PAID") {
          app.status = "PAID";
          app.paidAt = p.at;
          app.history.push({ at: p.at, action: "PAYMENT_PAID", paymentId: payment.paymentId });
        } else if (payment) {
          app.history.push({ at: p.at, action: "PAYMENT_FAILED", paymentId: payment.paymentId });
        }
        // 无对应支付单：迟到回执，仅留痕，由视图派生 LATE_PAYMENT_RECEIPT 冲突。
      }
      return state;
    }

    case "WITHDRAWAL_RECORDED": {
      const app = state.apps.get(p.applicationId);
      if (app && app.status !== "PAID") app.status = "WITHDRAWN";
      return state;
    }

    default:
      return state;
  }
}

function conflictKey(p) {
  return p.key ?? [p.code, [...(p.applicationIds ?? [])].sort().join("&"), p.discriminator ?? ""].join("|");
}

// ---------- 派生查询（纯函数，重启后结论一致） ----------

/** 取申请在 asOf 时点有效的成员版本（按生效日判断）。 */
export function membersAt(app, asOf) {
  const d = dayKey(asOf);
  const chosen = new Map();
  for (const v of app.members) {
    if (v.effectiveFrom > d) continue;
    if (v.effectiveUntil && v.effectiveUntil < d) continue;
    const prev = chosen.get(v.personId);
    if (!prev || v.effectiveFrom >= prev.effectiveFrom) chosen.set(v.personId, v);
  }
  return [...chosen.values()];
}

/** 取某材料在 asOf 时点有效且核验未失效的版本。 */
export function materialVersionAt(app, materialCode, asOf, state) {
  const bucket = app.materials[materialCode];
  if (!bucket || !bucket.versions.length) return null;
  const d = dayKey(asOf);
  const valid = bucket.versions
    .filter((v) => (!v.effectiveFrom || v.effectiveFrom <= d) && (!v.effectiveUntil || v.effectiveUntil >= d))
    .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))[0];
  if (!valid) return null;
  const verdict = latestVerification(app, state, "MATERIAL", materialCode);
  if (verdict && (verdict.verdict === "FAIL" || verdict.verdict === "EXPIRED")) {
    return { ...valid, verification: verdict };
  }
  return valid;
}

export function latestVerification(app, state, kind, subject) {
  const ids = state.receiptsByApp.get(app.applicationId) ?? [];
  const matched = ids
    .map((id) => state.receipts.get(id))
    .filter((r) => r && r.kind === kind && r.subject === subject);
  if (!matched.length) return null;
  return matched.sort((a, b) => {
    const ta = a.issuedAt ?? a.recordedAt;
    const tb = b.issuedAt ?? b.recordedAt;
    return ta < tb ? 1 : ta > tb ? -1 : b.seq - a.seq;
  })[0];
}
