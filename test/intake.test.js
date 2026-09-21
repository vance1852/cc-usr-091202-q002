import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import { IntakeService } from "../src/domain/service.js";

let dir;
let file;
let clock;

const now = () => clock;
const at = (iso) => new Date(iso);

async function freshService() {
  return IntakeService.open(file, { now });
}

function baseApplication(overrides = {}) {
  return {
    applicationId: "A-1001",
    familyKey: "F-021",
    district: "新河街道",
    community: "幸福社区",
    programCode: "LIVING-AID",
    submittedAt: at("2026-10-03T09:20:00+08:00"),
    members: [
      { personId: "P-01", relation: "户主", name: "王建国", idCard: "320102196505123318", mobile: "13805170001", bankAccount: "6222020200112233445", address: "新河街道幸福社区花园路12号", monthlyIncome: 900 },
      { personId: "P-02", relation: "配偶", name: "李秀兰", idCard: "320102196711203326", monthlyIncome: 0 },
    ],
    materials: [
      { materialCode: "ID_CARD", doc: { docRef: "DOC-ID-01", issuedAt: "2020-05-01" } },
      { materialCode: "HOUSEHOLD_REGISTER", doc: { docRef: "DOC-HK-01", issuedAt: "2019-03-11" } },
      { materialCode: "INCOME_PROOF", doc: { docRef: "DOC-INCOME-7788", issuedAt: "2026-10-02", amount: 900 } },
      { materialCode: "PROPERTY_PROOF", doc: { docRef: "DOC-PROP-01", issuedAt: "2026-10-02" } },
    ],
    ...overrides,
  };
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "intake-test-"));
});

async function reset() {
  file = path.join(dir, `events-${Math.random().toString(36).slice(2)}.jsonl`);
  clock = at("2026-10-03T09:00:00+08:00");
}

test("同一政策周期内同一家庭只允许一笔有效申请", async () => {
  await reset();
  const service = await freshService();
  const first = await service.submitApplication(baseApplication());
  assert.equal(first.accepted, true);

  const dup = await service.submitApplication(baseApplication({
    applicationId: "A-1002",
    community: "长桥社区",
    submittedAt: at("2026-10-03T09:25:00+08:00"),
  }));
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, "DUPLICATE_FAMILY_APPLICATION");

  const view = await service.getApplicationView("A-1002", { role: "staff", district: "新河街道" });
  assert.equal(view.status, "REJECTED");
  assert.ok(view.rejectionReasons.some((r) => r.code === "DUPLICATE_FAMILY_APPLICATION"));
});

test("收入证明跨月失效后进入补正，补交后形成连续版本", async () => {
  await reset();
  const service = await freshService();
  // 9 月开具的收入证明，10 月审核时已失效。
  await service.submitApplication(baseApplication({
    materials: [
      { materialCode: "ID_CARD", doc: { docRef: "DOC-ID-01", issuedAt: "2020-05-01" } },
      { materialCode: "HOUSEHOLD_REGISTER", doc: { docRef: "DOC-HK-01", issuedAt: "2019-03-11" } },
      { materialCode: "INCOME_PROOF", doc: { docRef: "DOC-INCOME-7788", issuedAt: "2026-09-05", amount: 900 } },
      { materialCode: "PROPERTY_PROOF", doc: { docRef: "DOC-PROP-01", issuedAt: "2026-09-05" } },
    ],
  }));

  const evaluation = await service.evaluate("A-1001", { at: at("2026-10-08T09:00:00+08:00") });
  const expired = evaluation.issues.find((i) => i.code === "CROSS_MONTH_PROOF_EXPIRED");
  assert.ok(expired, "应识别跨月失效");
  assert.match(expired.message, /2026-09-30/);

  await service.requestSupplement("A-1001", [{ materialCode: "INCOME_PROOF", reason: expired.message }], { at: clock });
  const before = await service.getApplicationView("A-1001", { role: "staff", district: "新河街道" });
  assert.equal(before.status, "SUPPLEMENTING");
  assert.equal(before.nextHandler.role, "applicant");
  assert.ok(before.missingItems.length > 0);

  const result = await service.submitSupplement("A-1001", before.currentSupplementRound.roundId, [
    { materialCode: "INCOME_PROOF", doc: { docRef: "DOC-INCOME-9012", issuedAt: "2026-10-09", amount: 900 } },
    { materialCode: "PROPERTY_PROOF", doc: { docRef: "DOC-PROP-02", issuedAt: "2026-10-09" } },
  ], { at: at("2026-10-10T10:00:00+08:00") });
  assert.equal(result.closed, true);

  const after = await service.getApplicationView("A-1001", { role: "staff", district: "新河街道" });
  const versions = after.materials.INCOME_PROOF;
  assert.equal(versions.length, 2, "材料应形成连续版本");
  assert.equal(versions[0].effectiveUntil, "2026-09-30");
  assert.equal(versions[1].effectiveFrom, "2026-10-09");
  assert.equal(after.supplementRounds[0].status, "closed");
});

test("核验回执乱序到达且重复投递：幂等且不重复生效", async () => {
  await reset();
  const service = await freshService();
  await service.submitApplication(baseApplication());

  // 后签发的 PASS 先到，先签发的 EXPIRED 后到，再重复投递一次。
  await service.recordVerificationReceipt({
    receiptId: "VR-002", applicationId: "A-1001", kind: "MATERIAL",
    subject: "INCOME_PROOF", verdict: "PASS", issuedAt: "2026-10-05T10:00:00+08:00",
  });
  await service.recordVerificationReceipt({
    receiptId: "VR-001", applicationId: "A-1001", kind: "MATERIAL",
    subject: "INCOME_PROOF", verdict: "EXPIRED", message: "证明已失效",
    issuedAt: "2026-10-04T10:00:00+08:00",
  });
  const again = await service.recordVerificationReceipt({
    receiptId: "VR-002", applicationId: "A-1001", kind: "MATERIAL",
    subject: "INCOME_PROOF", verdict: "PASS",
  });
  assert.equal(again.recorded, false);
  assert.equal(service.state.receipts.size, 2, "重复回执只入一次");

  // 最新（按签发时间）结论为 PASS，材料不应再被判失效。
  const evaluation = await service.evaluate("A-1001");
  assert.ok(!evaluation.issues.some((i) => i.code === "MATERIAL_VERIFICATION_FAILED"));
});

test("回执先于申请到达：申请受理后自动挂接，不丢失", async () => {
  await reset();
  const service = await freshService();
  await service.recordVerificationReceipt({
    receiptId: "VR-900", applicationId: "A-1001", kind: "IDENTITY",
    subject: "P-01", verdict: "PASS", message: "身份核验通过",
  });
  assert.equal(service.state.pendingReceipts.get("A-1001").length, 1);

  await service.submitApplication(baseApplication());
  assert.equal(service.state.pendingReceipts.has("A-1001"), false);
  assert.deepEqual(service.state.receiptsByApp.get("A-1001"), ["VR-900"]);
});

test("服务重启后状态完整恢复：补正记录、驳回原因、回执均不丢", async () => {
  await reset();
  let service = await freshService();
  await service.submitApplication(baseApplication());
  await service.requestSupplement("A-1001", [{ materialCode: "INCOME_PROOF", reason: "证明模糊" }]);
  await service.recordVerificationReceipt({
    receiptId: "VR-100", applicationId: "A-1001", kind: "CRITERIA",
    subject: "INCOME_BELOW_LINE", verdict: "FAIL", message: "收入超标（外部数据）",
  });

  // 模拟中途重启：重新打开同一日志文件。
  service = await freshService();
  const view = await service.getApplicationView("A-1001", { role: "staff", district: "新河街道" });
  assert.equal(view.supplementRounds.length, 1, "补正记录不断开");
  assert.ok(view.rejectionReasons.some((r) => r.message.includes("收入超标")), "驳回原因不遗漏");
  assert.equal(service.state.receipts.size, 1);
});

test("发放幂等：同一家庭同一项目同一周期只发一笔，重启后仍不重复", async () => {
  await reset();
  let service = await freshService();
  await service.submitApplication(baseApplication());
  await service.advanceStage("A-1001", { at: at("2026-10-04T09:00:00+08:00") });
  await service.advanceStage("A-1001", { at: at("2026-10-04T10:00:00+08:00") });
  await service.decide("A-1001", "APPROVE", { at: at("2026-10-05T09:00:00+08:00") });

  const p1 = await service.initiatePayment("A-1001");
  const p2 = await service.initiatePayment("A-1001");
  assert.equal(p1.paymentId, p2.paymentId);
  assert.equal(p2.duplicated, true);

  await service.recordPaymentReceipt({ receiptId: "PR-1", applicationId: "A-1001", paymentId: p1.paymentId, result: "PAID" });
  await service.recordPaymentReceipt({ receiptId: "PR-1", applicationId: "A-1001", paymentId: p1.paymentId, result: "PAID" });

  // 重启后支付索引仍在，重复发起仍被去重。
  service = await freshService();
  const p3 = await service.initiatePayment("A-1001").catch((e) => e);
  // 已 PAID 的申请不再是 APPROVED，直接拒绝发起；即便状态允许，paymentKey 也会去重。
  assert.ok(p3 instanceof Error || p3.duplicated === true);
  const paid = [...service.state.paymentIndex.values()].filter((p) => p.status === "PAID");
  assert.equal(paid.length, 1, "全周期只发放一笔");
});

test("迟到支付回执只留痕挂冲突，不二次发放", async () => {
  await reset();
  const service = await freshService();
  await service.submitApplication(baseApplication());
  const result = await service.recordPaymentReceipt({
    receiptId: "PR-LATE", applicationId: "A-1001", paymentId: "PAY-GHOST", result: "PAID",
  });
  assert.equal(result.matched, false);
  const view = await service.getApplicationView("A-1001", { role: "staff", district: "新河街道" });
  assert.ok(view.conflicts.some((c) => c.code === "LATE_PAYMENT_RECEIPT"));
  assert.equal(view.payments.length, 0, "不得因迟到回执生成支付单");
});

test("低保优先于临时救助：同周期核准低保后临时救助被替代", async () => {
  await reset();
  const service = await freshService();
  await service.submitApplication(baseApplication());
  // 同家庭同月再申临时救助：排他分组内直接拦截。
  const temp = await service.submitApplication(baseApplication({
    applicationId: "A-1003",
    programCode: "TEMP-AID",
    materials: [
      { materialCode: "ID_CARD", doc: { docRef: "DOC-ID-01", issuedAt: "2020-05-01" } },
      { materialCode: "INCOME_PROOF", doc: { docRef: "DOC-INCOME-7788", issuedAt: "2026-10-02", amount: 900 } },
      { materialCode: "HARDSHIP_PROOF", doc: { docRef: "DOC-HARD-01", issuedAt: "2026-10-02" } },
    ],
  }));
  assert.equal(temp.accepted, false, "排他分组内同周期只留一笔有效申请");

  // 跨月后临时救助可受理；若低保随后核准，临时救助被替代。
  clock = at("2026-11-02T09:00:00+08:00");
  const temp2 = await service.submitApplication(baseApplication({
    applicationId: "A-1004",
    programCode: "TEMP-AID",
    submittedAt: at("2026-11-02T09:00:00+08:00"),
    materials: [
      { materialCode: "ID_CARD", doc: { docRef: "DOC-ID-01", issuedAt: "2020-05-01" } },
      { materialCode: "INCOME_PROOF", doc: { docRef: "DOC-INCOME-1126", issuedAt: "2026-11-01", amount: 900 } },
      { materialCode: "HARDSHIP_PROOF", doc: { docRef: "DOC-HARD-02", issuedAt: "2026-11-01" } },
    ],
  }));
  assert.equal(temp2.accepted, true);

  // 低保 10 月周期核准（仍处有效流程），不影响 11 月临时救助；
  // 反向验证：核准 11 月低保会替代 11 月临时救助。
  await service.submitApplication(baseApplication({
    applicationId: "A-1005",
    submittedAt: at("2026-11-03T09:00:00+08:00"),
    materials: [
      { materialCode: "ID_CARD", doc: { docRef: "DOC-ID-01", issuedAt: "2020-05-01" } },
      { materialCode: "HOUSEHOLD_REGISTER", doc: { docRef: "DOC-HK-01", issuedAt: "2019-03-11" } },
      { materialCode: "INCOME_PROOF", doc: { docRef: "DOC-INCOME-1126", issuedAt: "2026-11-01", amount: 900 } },
      { materialCode: "PROPERTY_PROOF", doc: { docRef: "DOC-PROP-11", issuedAt: "2026-11-01" } },
    ],
  }));
  await service.advanceStage("A-1005", { at: at("2026-11-04T09:00:00+08:00") });
  await service.advanceStage("A-1005", { at: at("2026-11-04T10:00:00+08:00") });
  await service.decide("A-1005", "APPROVE", { at: at("2026-11-05T09:00:00+08:00") });

  const tempView = await service.getApplicationView("A-1004", { role: "staff", district: "新河街道" });
  assert.equal(tempView.status, "SUPERSEDED");
  assert.ok(tempView.rejectionReasons.some((r) => r.code === "SUPERSEDED_BY_PRIORITY"));
});

test("街道数据隔离：跨街道访问被拒绝，队列互不可见", async () => {
  await reset();
  const service = await freshService();
  await service.submitApplication(baseApplication());
  await service.submitApplication(baseApplication({
    applicationId: "B-2001",
    familyKey: "F-088",
    district: "望江街道",
    community: "滨江社区",
  }));

  await assert.rejects(
    service.getApplicationView("A-1001", { role: "staff", district: "望江街道" }),
    /无权访问/,
  );
  const queueA = await service.listQueue({ role: "staff", district: "新河街道" });
  assert.ok(queueA.every((r) => r.applicationId !== "B-2001"));
  const queueB = await service.listQueue({ role: "staff", district: "望江街道" });
  assert.ok(queueB.every((r) => r.applicationId === "B-2001"));
});

test("身份证号等敏感字段按角色脱敏", async () => {
  await reset();
  const service = await freshService();
  await service.submitApplication(baseApplication());

  const coordinator = await service.getApplicationView("A-1001", { role: "coordinator", district: "新河街道" });
  assert.match(coordinator.members[0].idCard, /^320102\*+3318$/);
  assert.match(coordinator.members[0].name, /^王\*+$/);

  const finance = await service.getApplicationView("A-1001", { role: "finance", district: "新河街道" });
  assert.match(finance.members[0].bankAccount, /3445$/);
  assert.equal(finance.members[0].mobile, "***");

  const applicant = await service.getApplicationView("A-1001", { role: "applicant", district: "新河街道" });
  assert.equal(applicant.members[0].idCard, "320102196505123318");

  const auditor = await service.getApplicationView("A-1001", { role: "auditor", district: "望江街道" });
  assert.match(auditor.members[0].idCard, /^3\*+8$/);
});

test("打开申请即见资格依据、具体缺件与下一位办理人", async () => {
  await reset();
  const service = await freshService();
  await service.submitApplication(baseApplication({
    materials: [
      { materialCode: "ID_CARD", doc: { docRef: "DOC-ID-01", issuedAt: "2020-05-01" } },
      { materialCode: "HOUSEHOLD_REGISTER", doc: { docRef: "DOC-HK-01", issuedAt: "2019-03-11" } },
      { materialCode: "INCOME_PROOF", doc: { docRef: "DOC-INCOME-7788", issuedAt: "2026-10-02", amount: 900 } },
      // 缺 PROPERTY_PROOF
    ],
  }));
  const view = await service.getApplicationView("A-1001", { role: "staff", district: "新河街道" });
  assert.equal(view.eligibilityBasis.programName, "最低生活保障");
  assert.ok(view.eligibilityBasis.criteriaChecks.every((c) => "actual" in c && "ok" in c));
  assert.ok(view.missingItems.some((m) => m.message.includes("家庭财产状况证明")));
  assert.equal(view.nextHandler.role, "coordinator");
});

test("驳回原因逐条保留不覆盖", async () => {
  await reset();
  const service = await freshService();
  await service.submitApplication(baseApplication());
  await service.recordVerificationReceipt({
    receiptId: "VR-1", applicationId: "A-1001", kind: "IDENTITY", subject: "P-01",
    verdict: "FAIL", message: "身份信息存疑",
  });
  await service.decide("A-1001", "REJECT", {
    reasons: [{ code: "MANUAL_RECHECK", message: "入户核查不通过" }],
  });
  const view = await service.getApplicationView("A-1001", { role: "staff", district: "新河街道" });
  const messages = view.rejectionReasons.map((r) => r.message);
  assert.ok(messages.some((m) => m.includes("身份信息存疑")));
  assert.ok(messages.some((m) => m.includes("入户核查不通过")));
});

test("家庭成员形成连续版本，按生效日参与资格判断", async () => {
  await reset();
  const service = await freshService();
  await service.submitApplication(baseApplication());

  // 户主收入自 10 月 20 日起变更为 4000 元/月（新版本，旧版本保留）。
  await service.recordMemberVersion("A-1001", {
    personId: "P-01", relation: "户主", name: "王建国",
    idCard: "320102196505123318", monthlyIncome: 4000,
  }, { effectiveFrom: "2026-10-20" });

  const versions = service.state.apps.get("A-1001").members.filter((m) => m.personId === "P-01");
  assert.equal(versions.length, 2, "成员应形成连续版本");

  // 10 月 10 日评估：旧版本生效，人均 450 元，符合低保线。
  const before = await service.evaluate("A-1001", { at: at("2026-10-10T09:00:00+08:00") });
  assert.ok(!before.issues.some((i) => i.code === "CRITERION_NOT_MET"));
  assert.equal(before.facts.incomePerMember, 450);

  // 10 月 21 日评估：新版本生效，人均 2000 元，超出低保线。
  const after = await service.evaluate("A-1001", { at: at("2026-10-21T09:00:00+08:00") });
  assert.ok(after.issues.some((i) => i.code === "CRITERION_NOT_MET"));
  assert.equal(after.facts.incomePerMember, 2000);
});

test("支付回执先于支付单到达：支付单建立时自动回挂，不重复发放", async () => {
  await reset();
  const service = await freshService();
  await service.submitApplication(baseApplication());
  await service.advanceStage("A-1001", { at: at("2026-10-04T09:00:00+08:00") });
  await service.advanceStage("A-1001", { at: at("2026-10-04T10:00:00+08:00") });
  await service.decide("A-1001", "APPROVE", { at: at("2026-10-05T09:00:00+08:00") });

  // 银行回执比支付单先到达（乱序）。
  await service.recordPaymentReceipt({
    receiptId: "PR-EARLY", applicationId: "A-1001",
    paymentId: "PAY-X", paymentKey: "F-021|LIVING-AID|2026-10", result: "PAID",
  });
  const { paymentId } = await service.initiatePayment("A-1001", { paymentId: "PAY-X" });
  assert.equal(paymentId, "PAY-X");

  const payment = service.state.paymentIndex.get("F-021|LIVING-AID|2026-10");
  assert.equal(payment.status, "PAID", "支付单建立时应回挂先到的回执");
  assert.equal(payment.receiptId, "PR-EARLY");
  const view = await service.getApplicationView("A-1001", { role: "staff", district: "新河街道" });
  assert.equal(view.status, "PAID");
  assert.equal(view.payments.length, 1, "只有一笔支付单");
});
