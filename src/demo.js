import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { IntakeService } from "./domain/service.js";

// 端到端演示：重复申报拦截 → 跨月失效补正 → 乱序回执 → 重启恢复 → 优先级拦截 → 发放幂等。

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEMO_STORE = path.join(root, "data", "demo-events.jsonl");

function line(title) {
  console.log("\n=== " + title + " ===");
}

export async function runDemo() {
  await fs.rm(DEMO_STORE, { force: true });
  const staff = { role: "staff", district: "新河街道" };

  // 固定时钟，让“跨月失效”可复现：收入证明 9 月开具，受理已进入 10 月。
  let clock = new Date("2026-10-03T09:20:00+08:00");
  const now = () => clock;
  let service = await IntakeService.open(DEMO_STORE, { now });

  line("1. 受理低保申请（收入证明 9 月开具，受理时已跨月）");
  const accepted = await service.submitApplication({
    applicationId: "A-1001",
    familyKey: "F-021",
    district: "新河街道",
    community: "幸福社区",
    programCode: "LIVING-AID",
    submittedAt: new Date("2026-10-03T09:20:00+08:00"),
    members: [
      { personId: "P-01", relation: "户主", name: "王建国", idCard: "320102196505123318", mobile: "13805170001", bankAccount: "6222020200112233445", address: "新河街道幸福社区花园路 12 号", monthlyIncome: 900 },
      { personId: "P-02", relation: "配偶", name: "李秀兰", idCard: "320102196711203326", mobile: "13805170002", address: "新河街道幸福社区花园路 12 号", monthlyIncome: 0 },
    ],
    materials: [
      { materialCode: "ID_CARD", doc: { docRef: "DOC-ID-01", issuedAt: "2020-05-01" } },
      { materialCode: "HOUSEHOLD_REGISTER", doc: { docRef: "DOC-HK-01", issuedAt: "2019-03-11" } },
      { materialCode: "INCOME_PROOF", doc: { docRef: "DOC-INCOME-7788", issuedAt: "2026-09-05", amount: 900 } },
      { materialCode: "PROPERTY_PROOF", doc: { docRef: "DOC-PROP-01", issuedAt: "2026-09-05" } },
    ],
  }, { at: clock });
  console.log("受理结果：", accepted.accepted ? "已受理" : `被拒（${accepted.reason}）`);

  line("2. 同一家庭在长桥社区重复申报（冲突材料 C-01 场景）");
  const dup = await service.submitApplication({
    applicationId: "A-1002",
    familyKey: "F-021",
    district: "新河街道",
    community: "长桥社区",
    programCode: "LIVING-AID",
    submittedAt: new Date("2026-10-03T09:25:00+08:00"),
    members: [
      { personId: "P-01", relation: "户主", name: "王建国", idCard: "320102196505123318", monthlyIncome: 900 },
    ],
    materials: [
      { materialCode: "ID_CARD", doc: { docRef: "DOC-ID-01", issuedAt: "2020-05-01" } },
    ],
  }, { at: clock });
  console.log("受理结果：", dup.accepted ? "已受理" : `已拦截（${dup.reason}）`);
  const dupView = await service.getApplicationView("A-1002", staff);
  console.log("驳回原因：", dupView.rejectionReasons.map((r) => r.message));

  line("3. 打开 A-1001：资格依据、具体缺件、下一位办理人");
  clock = new Date("2026-10-08T09:00:00+08:00");
  const eval1 = await service.evaluate("A-1001", { at: clock });
  for (const issue of eval1.issues) console.log(`- [${issue.code}] ${issue.message} → ${issue.advice}`);
  await service.requestSupplement("A-1001",
    eval1.issues.filter((i) => i.severity === "supplement").map((i) => ({ materialCode: i.materialCode, reason: i.message })),
    { at: clock });
  let view = await service.getApplicationView("A-1001", staff);
  console.log("下一位办理人：", view.nextHandler.role, "—", view.nextHandler.note);
  console.log("待补材料：", view.missingItems.map((m) => m.message));

  line("4. 申请人补交 10 月证明（材料形成连续版本）");
  clock = new Date("2026-10-10T14:00:00+08:00");
  const sup = await service.submitSupplement("A-1001", view.currentSupplementRound.roundId, [
    { materialCode: "INCOME_PROOF", doc: { docRef: "DOC-INCOME-9012", issuedAt: "2026-10-09", amount: 900 } },
    { materialCode: "PROPERTY_PROOF", doc: { docRef: "DOC-PROP-02", issuedAt: "2026-10-09" } },
  ], { at: clock });
  console.log("补正轮次已关闭：", sup.closed, "｜收入证明版本数：",
    (await service.getApplicationView("A-1001", staff)).materials.INCOME_PROOF.length);

  line("5. 核验回执乱序到达（先 PASS 后 EXPIRED，再重复投递）");
  await service.recordVerificationReceipt({
    receiptId: "VR-002", applicationId: "A-1001", kind: "MATERIAL",
    subject: "INCOME_PROOF", verdict: "PASS", message: "10 月证明核验通过",
    issuedAt: "2026-10-11T09:30:00+08:00",
  }, { at: new Date("2026-10-11T09:31:00+08:00") });
  await service.recordVerificationReceipt({
    receiptId: "VR-001", applicationId: "A-1001", kind: "MATERIAL",
    subject: "INCOME_PROOF", verdict: "EXPIRED", message: "9 月证明已跨月失效",
    issuedAt: "2026-10-08T09:05:00+08:00",
  }, { at: new Date("2026-10-11T09:32:00+08:00") });
  await service.recordVerificationReceipt({ // 重复投递同一回执
    receiptId: "VR-002", applicationId: "A-1001", kind: "MATERIAL",
    subject: "INCOME_PROOF", verdict: "PASS",
  }, { at: new Date("2026-10-11T09:33:00+08:00") });
  console.log("回执去重后数量：", service.state.receipts.size, "（3 次投递 → 2 条生效）");

  line("6. 服务重启：状态从事件日志完整恢复");
  service = await IntakeService.open(DEMO_STORE, { now });
  view = await service.getApplicationView("A-1001", staff);
  console.log("重启后状态：", view.status, "｜补正记录：", view.supplementRounds.length, "轮（未断开）");

  line("7. 逐级推进并核准");
  clock = new Date("2026-10-12T10:00:00+08:00");
  await service.advanceStage("A-1001", { at: clock, assignee: "街道民政专干-张敏" });
  await service.advanceStage("A-1001", { at: clock, assignee: "区民政局-李工" });
  const decided = await service.decide("A-1001", "APPROVE", { at: clock, operator: "李工" });
  console.log("核准结果：", decided.decided ? "通过" : "未通过");

  line("8. 同一家庭再申临时救助：同周期已有高优先级低保，被拦截");
  const temp = await service.submitApplication({
    applicationId: "A-1003",
    familyKey: "F-021",
    district: "新河街道",
    community: "幸福社区",
    programCode: "TEMP-AID",
    submittedAt: new Date("2026-10-12T11:00:00+08:00"),
    members: [
      { personId: "P-01", relation: "户主", name: "王建国", idCard: "320102196505123318", monthlyIncome: 900 },
    ],
    materials: [
      { materialCode: "ID_CARD", doc: { docRef: "DOC-ID-01", issuedAt: "2020-05-01" } },
      { materialCode: "INCOME_PROOF", doc: { docRef: "DOC-INCOME-9012", issuedAt: "2026-10-09", amount: 900 } },
      { materialCode: "HARDSHIP_PROOF", doc: { docRef: "DOC-HARD-01", issuedAt: "2026-10-11" } },
    ],
  }, { at: clock });
  console.log("临时救助受理：", temp.accepted ? "已受理" : `已拦截（${temp.reason}）`);

  line("9. 发放与回执：重复发起不重复发放，重复回执只入一次");
  const pay1 = await service.initiatePayment("A-1001", { at: clock });
  const pay2 = await service.initiatePayment("A-1001", { at: clock });
  console.log("两次发起同一支付单：", pay1.paymentId === pay2.paymentId, "（paymentKey 去重）");
  await service.recordPaymentReceipt({
    receiptId: "PR-001", applicationId: "A-1001", paymentId: pay1.paymentId, result: "PAID",
  }, { at: new Date("2026-10-13T09:00:00+08:00") });
  await service.recordPaymentReceipt({
    receiptId: "PR-001", applicationId: "A-1001", paymentId: pay1.paymentId, result: "PAID",
  }, { at: new Date("2026-10-13T09:01:00+08:00") });
  view = await service.getApplicationView("A-1001", staff);
  console.log("发放状态：", view.status, "｜金额：", view.payments[0]?.amount, "元/月");

  line("10. 角色视图：同一申请，不同角色看到不同脱敏粒度");
  for (const role of ["coordinator", "finance", "auditor"]) {
    const v = await service.getApplicationView("A-1001", { role, district: "新河街道" });
    const m = v.members[0];
    console.log(`[${role}] 姓名=${m.name} 身份证=${m.idCard} 银行账号=${m.bankAccount ?? "***"}`);
  }

  line("11. 街道隔离：邻街道工作人员无法打开本街道申请");
  try {
    await service.getApplicationView("A-1001", { role: "staff", district: "望江街道" });
    console.log("隔离失败！");
  } catch (err) {
    console.log("已拦截：", err.message);
  }

  line("演示完成");
  console.log("事件日志：", path.relative(root, DEMO_STORE));
}
