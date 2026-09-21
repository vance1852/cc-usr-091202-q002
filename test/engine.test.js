import test from "node:test";
import assert from "node:assert/strict";
import { makeEngine, livingAidApp, tempAidApp, passAllReceipts, CASEWORKER } from "./helpers.js";
import { buildDetailView } from "../src/views.js";

test("缺件受理：直接给出具体缺件与下一位办理人", async () => {
  const { engine } = await makeEngine();
  const payload = livingAidApp();
  payload.materials = payload.materials.filter((m) => m.docType !== "INCOME_PROOF");

  const { applicationId } = await engine.submitApplication(payload, CASEWORKER);
  const app = engine.getApplication(applicationId);
  assert.equal(app.status, "PENDING_SUPPLEMENT");

  const view = buildDetailView(engine, app, engine.now());
  assert.deepEqual(
    view.missingItems.map((m) => [m.docType, m.reason]),
    [["INCOME_PROOF", "未提交"]]
  );
  assert.equal(view.nextHandler.queue, "申请人");
  assert.ok(view.nextHandler.items[0].includes("收入证明"));
});

test("补正形成连续版本，回执乱序到达也能正确批准", async () => {
  const { engine } = await makeEngine();
  const payload = livingAidApp();
  payload.materials = payload.materials.filter((m) => m.docType !== "INCOME_PROOF");
  const { applicationId } = await engine.submitApplication(payload, CASEWORKER);

  // 补交收入证明 → v2，链回 v1 与补正通知
  const r = await engine.submitSupplement(applicationId, {
    materials: [{
      docType: "INCOME_PROOF", docId: "M-INC-2", issuedAt: "2026-10-03",
      effectiveFrom: "2026-10-01", effectiveTo: "2026-11-30", fields: { monthlyAmount: 1300 },
    }],
  }, CASEWORKER);
  assert.equal(r.versionNo, 2);

  const app = engine.getApplication(applicationId);
  assert.equal(app.status, "VERIFYING");
  assert.equal(app.versions.length, 2);
  assert.equal(app.versions[1].parentVersionNo, 1);
  assert.equal(app.versions[1].noticeId, "N-" + applicationId + "-1");

  // 回执乱序：PROPERTY 先于 INCOME 到达
  await engine.recordReceipt(applicationId, {
    receiptId: "R-2", checkType: "PROPERTY", result: "PASS", issuedAt: "2026-10-04T10:00:00+08:00",
  }, CASEWORKER);
  assert.equal(engine.getApplication(applicationId).status, "VERIFYING"); // 未齐，继续等
  await engine.recordReceipt(applicationId, {
    receiptId: "R-1", checkType: "INCOME", result: "PASS", issuedAt: "2026-10-04T09:00:00+08:00",
  }, CASEWORKER);

  const decided = engine.getApplication(applicationId);
  assert.equal(decided.status, "APPROVED");
  const view = buildDetailView(engine, decided, engine.now());
  assert.equal(view.eligibilityBasis.verdict, "APPROVED");
  assert.ok(view.eligibilityBasis.rules.every((r) => r.pass));
  assert.equal(view.nextHandler.queue, "街道发放岗");
});

test("同一政策周期内同一家庭只允许一个有效申请", async () => {
  const { engine } = await makeEngine();
  const first = await engine.submitApplication(livingAidApp(), CASEWORKER);

  // 同家庭同政策同周期（即使换个社区）→ 查重拦截
  await assert.rejects(
    engine.submitApplication(livingAidApp({ community: "兴华社区" }), CASEWORKER),
    (err) => {
      assert.equal(err.code, "DUPLICATE_APPLICATION");
      assert.equal(err.details.existingApplicationId, first.applicationId);
      return true;
    }
  );

  // 跨街道同样拦截，但不回显对方申请号
  await assert.rejects(
    engine.submitApplication(livingAidApp(), { ...CASEWORKER, street: "城西街道" }),
    (err) => {
      assert.equal(err.code, "DUPLICATE_APPLICATION");
      assert.equal(err.details, undefined);
      return true;
    }
  );

  // 不同政策不视为重复
  const other = await engine.submitApplication(tempAidApp(), CASEWORKER);
  assert.ok(other.applicationId);
});

test("优先级可配置：低保批准后，同周期临时救助被覆盖", async () => {
  const { engine } = await makeEngine();
  const living = await engine.submitApplication(livingAidApp(), CASEWORKER);
  const temp = await engine.submitApplication(tempAidApp(), CASEWORKER);

  await passAllReceipts(engine, living.applicationId);
  assert.equal(engine.getApplication(living.applicationId).status, "APPROVED");
  // 低保(priority=30)获批 → 临时救助(priority=10)在办申请被覆盖
  assert.equal(engine.getApplication(temp.applicationId).status, "SUPERSEDED");
});

test("优先级反向：临时救助先获批，低保仍可批准，临时救助随后被覆盖", async () => {
  const { engine } = await makeEngine();
  const temp = await engine.submitApplication(tempAidApp(), CASEWORKER);
  await passAllReceipts(engine, temp.applicationId);
  assert.equal(engine.getApplication(temp.applicationId).status, "APPROVED");

  const living = await engine.submitApplication(livingAidApp(), CASEWORKER);
  await passAllReceipts(engine, living.applicationId);
  assert.equal(engine.getApplication(living.applicationId).status, "APPROVED");
  assert.equal(engine.getApplication(temp.applicationId).status, "SUPERSEDED");
});

test("收入证明审核跨月失效：退回待补正并说明失效日，补交后继续", async () => {
  const { engine, state } = await makeEngine();
  const payload = livingAidApp({ submittedAt: "2026-10-28T09:00:00+08:00" });
  const { applicationId } = await engine.submitApplication(payload, CASEWORKER);
  assert.equal(engine.getApplication(applicationId).status, "VERIFYING");

  await engine.recordReceipt(applicationId, {
    receiptId: "R-INC", checkType: "INCOME", result: "PASS", issuedAt: "2026-10-29T10:00:00+08:00",
  }, CASEWORKER);

  // 时间跨月：收入证明 10-31 到期，11-02 才收到最后一份回执
  state.now = "2026-11-02T09:00:00+08:00";
  await engine.recordReceipt(applicationId, {
    receiptId: "R-PROP", checkType: "PROPERTY", result: "PASS", issuedAt: "2026-11-02T08:30:00+08:00",
  }, CASEWORKER);

  const app = engine.getApplication(applicationId);
  assert.equal(app.status, "PENDING_SUPPLEMENT");
  const notice = app.notices.at(-1);
  assert.deepEqual(
    notice.missing.map((m) => [m.docType, m.reason]),
    [["INCOME_PROOF", "已于 2026-10-31 失效"]]
  );

  // 补交新收入证明：此前已到的回执仍然有效，直接批准
  await engine.submitSupplement(applicationId, {
    materials: [{
      docType: "INCOME_PROOF", docId: "M-INC-NEW", issuedAt: "2026-11-02",
      effectiveFrom: "2026-11-01", effectiveTo: "2026-11-30", fields: { monthlyAmount: 1300 },
    }],
  }, CASEWORKER);
  assert.equal(engine.getApplication(applicationId).status, "APPROVED");
  assert.equal(engine.getApplication(applicationId).versions.length, 2); // 补正链未断
});

test("驳回原因一条不丢：多部门 FAIL 全部进入驳回决定", async () => {
  const { engine } = await makeEngine();
  const { applicationId } = await engine.submitApplication(livingAidApp(), CASEWORKER);
  await engine.recordReceipt(applicationId, {
    receiptId: "R-INC", checkType: "INCOME", result: "FAIL", reason: "月收入超标",
    issuedAt: "2026-10-04T09:00:00+08:00",
  }, CASEWORKER);
  await engine.recordReceipt(applicationId, {
    receiptId: "R-PROP", checkType: "PROPERTY", result: "FAIL", reason: "名下有商铺",
    issuedAt: "2026-10-04T10:00:00+08:00",
  }, CASEWORKER);

  const app = engine.getApplication(applicationId);
  assert.equal(app.status, "REJECTED");
  const reasons = app.decisions.at(-1).reasons;
  assert.equal(reasons.length, 2);
  assert.ok(reasons.some((r) => r.desc.includes("月收入超标")));
  assert.ok(reasons.some((r) => r.desc.includes("名下有商铺")));
});

test("回执幂等：同一 receiptId 重复到达只记一次", async () => {
  const { engine } = await makeEngine();
  const { applicationId } = await engine.submitApplication(livingAidApp(), CASEWORKER);
  const receipt = { receiptId: "R-1", checkType: "INCOME", result: "PASS", issuedAt: "2026-10-04T09:00:00+08:00" };
  await engine.recordReceipt(applicationId, receipt, CASEWORKER);
  const again = await engine.recordReceipt(applicationId, receipt, CASEWORKER);
  assert.equal(again.replayed, true);
  assert.equal(engine.getApplication(applicationId).receipts.length, 1);
});

test("发放幂等：重复发放请求返回同一笔记录", async () => {
  const { engine } = await makeEngine();
  const { applicationId } = await engine.submitApplication(livingAidApp(), CASEWORKER);
  await passAllReceipts(engine, applicationId);

  const first = await engine.disburse(applicationId, CASEWORKER);
  const second = await engine.disburse(applicationId, CASEWORKER);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(first.disbursement.disbursementId, second.disbursement.disbursementId);
  assert.equal(engine.getApplication(applicationId).status, "DISBURSED");
});

test("批准后迟到的 FAIL 回执：撤销批准并按最新回执驳回，原因留痕", async () => {
  const { engine } = await makeEngine();
  const { applicationId } = await engine.submitApplication(livingAidApp(), CASEWORKER);
  await passAllReceipts(engine, applicationId);
  assert.equal(engine.getApplication(applicationId).status, "APPROVED");

  // 乱序：一份更晚签发的 FAIL 回执在批准后才到
  await engine.recordReceipt(applicationId, {
    receiptId: "R-LATE", checkType: "PROPERTY", result: "FAIL", reason: "复查发现名下有房产",
    issuedAt: "2026-10-05T09:00:00+08:00",
  }, CASEWORKER);

  const app = engine.getApplication(applicationId);
  assert.equal(app.status, "REJECTED");
  assert.ok(app.revocations.length >= 1);
  assert.ok(app.decisions.at(-1).reasons.some((r) => r.desc.includes("复查发现名下有房产")));
  // 不可再发放
  await assert.rejects(engine.disburse(applicationId, CASEWORKER), (err) => {
    assert.equal(err.code, "NOT_APPROVED");
    return true;
  });
});

test("提交幂等：同一 Idempotency-Key 重放不产生第二笔申请", async () => {
  const { engine } = await makeEngine();
  const key = "idem-2026-10-03-001";
  const a = await engine.submitApplication(livingAidApp({ idempotencyKey: key }), CASEWORKER);
  const b = await engine.submitApplication(livingAidApp({ idempotencyKey: key }), CASEWORKER);
  assert.equal(b.replayed, true);
  assert.equal(a.applicationId, b.applicationId);
  assert.equal(engine.listApplications({ street: "新河街道" }).length, 1);
});

test("字段字典校验：身份证号格式不合法被 422 拦截", async () => {
  const { engine } = await makeEngine();
  const payload = livingAidApp();
  payload.applicant.idCardNo = "123";
  await assert.rejects(engine.submitApplication(payload, CASEWORKER), (err) => {
    assert.equal(err.status, 422);
    assert.ok(err.details.some((d) => d.field === "applicant.idCardNo"));
    return true;
  });
});
