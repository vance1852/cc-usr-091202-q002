import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeEngine, reopenEngine, livingAidApp, CASEWORKER } from "./helpers.js";

test("服务中途重启：补正链、回执、驳回原因完整恢复，发放不重复", async () => {
  const { engine, dir, config, state } = await makeEngine();

  // 第一笔：缺件 → 补正 → 部分回执，此时“宕机”
  const payload = livingAidApp({ familyKey: "F-RECOVER" });
  payload.materials = payload.materials.filter((m) => m.docType !== "INCOME_PROOF");
  const { applicationId } = await engine.submitApplication(payload, CASEWORKER);
  await engine.submitSupplement(applicationId, {
    materials: [{
      docType: "INCOME_PROOF", docId: "M-INC-R", issuedAt: "2026-10-03",
      effectiveFrom: "2026-10-01", effectiveTo: "2026-11-30", fields: { monthlyAmount: 1300 },
    }],
  }, CASEWORKER);
  await engine.recordReceipt(applicationId, {
    receiptId: "R-REC-1", checkType: "INCOME", result: "PASS", issuedAt: "2026-10-04T09:00:00+08:00",
  }, CASEWORKER);

  // 重启：同一数据目录重新打开
  const engine2 = await reopenEngine(dir, config, state);
  const restored = engine2.getApplication(applicationId);
  assert.equal(restored.status, "VERIFYING");
  assert.equal(restored.versions.length, 2);
  assert.equal(restored.versions[1].parentVersionNo, 1); // 补正链未断
  assert.equal(restored.receipts.length, 1); // 已到的回执未丢
  assert.equal(restored.notices.length, 1); // 补正通知未丢

  // 剩余回执到达 → 批准 → 发放
  await engine2.recordReceipt(applicationId, {
    receiptId: "R-REC-2", checkType: "PROPERTY", result: "PASS", issuedAt: "2026-10-04T10:00:00+08:00",
  }, CASEWORKER);
  assert.equal(engine2.getApplication(applicationId).status, "APPROVED");
  const d1 = await engine2.disburse(applicationId, CASEWORKER);

  // 再次重启后重复发放仍是幂等的
  const engine3 = await reopenEngine(dir, config, state);
  const d2 = await engine3.disburse(applicationId, CASEWORKER);
  assert.equal(d2.replayed, true);
  assert.equal(d2.disbursement.disbursementId, d1.disbursement.disbursementId);

  const log = await readFile(`${dir}/events.jsonl`, "utf8");
  const disburseEvents = log.trim().split("\n").filter((l) => l.includes("DisbursementRecorded"));
  assert.equal(disburseEvents.length, 1); // 账上只有一笔发放
});

test("驳回记录在重启后完整保留", async () => {
  const { engine, dir, config, state } = await makeEngine();
  const { applicationId } = await engine.submitApplication(livingAidApp({ familyKey: "F-REJ" }), CASEWORKER);
  await engine.recordReceipt(applicationId, {
    receiptId: "R-REJ-1", checkType: "INCOME", result: "FAIL", reason: "月收入超标",
    issuedAt: "2026-10-04T09:00:00+08:00",
  }, CASEWORKER);
  await engine.recordReceipt(applicationId, {
    receiptId: "R-REJ-2", checkType: "PROPERTY", result: "FAIL", reason: "名下有商铺",
    issuedAt: "2026-10-04T10:00:00+08:00",
  }, CASEWORKER);
  assert.equal(engine.getApplication(applicationId).status, "REJECTED");

  const engine2 = await reopenEngine(dir, config, state);
  const restored = engine2.getApplication(applicationId);
  assert.equal(restored.status, "REJECTED");
  const reasons = restored.decisions.at(-1).reasons;
  assert.equal(reasons.length, 2);
  assert.ok(reasons.some((r) => r.desc.includes("月收入超标")));
  assert.ok(reasons.some((r) => r.desc.includes("名下有商铺")));
});
