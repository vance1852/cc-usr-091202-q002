import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function makeEngine() {
  const dir = await mkdtemp(path.join(tmpdir(), "subsidy-test-"));
  const config = await loadConfig(root);
  const state = { now: "2026-10-03T10:00:00+08:00" };
  const engine = await Engine.open({ dir, config, clock: () => state.now });
  return { engine, dir, state, config };
}

export async function reopenEngine(dir, config, state) {
  return Engine.open({ dir, config, clock: () => state.now });
}

export const CASEWORKER = { actor: "cw-01", role: "caseworker", street: "新河街道" };

/** 一份材料齐备、资格满足的低保申请 */
export function livingAidApp(overrides = {}) {
  return {
    familyKey: "F-100",
    community: "滨江社区",
    policyCode: "LIVING-AID",
    applicant: {
      name: "张三",
      idCardNo: "110101199001011234",
      phone: "13800001111",
      residenceType: "LOCAL",
      address: "新河街道滨江社区1栋101",
      monthlyIncome: 800,
    },
    members: [
      { name: "张三", idCardNo: "110101199001011234", relation: "本人", monthlyIncome: 800 },
      { name: "李四", relation: "配偶", monthlyIncome: 500 },
    ],
    materials: [
      { docType: "ID_CARD", docId: "M-ID", issuedAt: "2026-09-01" },
      { docType: "HOUSEHOLD_REGISTER", docId: "M-HR", issuedAt: "2026-09-01" },
      {
        docType: "INCOME_PROOF", docId: "M-INC", issuedAt: "2026-10-01",
        effectiveFrom: "2026-10-01", effectiveTo: "2026-10-31",
        fields: { monthlyAmount: 1300 },
      },
    ],
    submittedAt: "2026-10-03T09:00:00+08:00",
    ...overrides,
  };
}

export function tempAidApp(overrides = {}) {
  return {
    familyKey: "F-100",
    community: "滨江社区",
    policyCode: "TEMP-AID",
    applicant: {
      name: "张三",
      idCardNo: "110101199001011234",
      residenceType: "LOCAL",
      address: "新河街道滨江社区1栋101",
    },
    members: [{ name: "张三", relation: "本人", monthlyIncome: 800 }],
    materials: [
      { docType: "ID_CARD", docId: "M-ID", issuedAt: "2026-09-01" },
      { docType: "EMERGENCY_PROOF", docId: "M-EMG", issuedAt: "2026-10-01", effectiveFrom: "2026-10-01", effectiveTo: "2026-11-30" },
    ],
    submittedAt: "2026-10-03T09:30:00+08:00",
    ...overrides,
  };
}

export async function passAllReceipts(engine, applicationId, ctx = CASEWORKER) {
  const app = engine.getApplication(applicationId);
  for (const check of app.expectedChecks) {
    await engine.recordReceipt(applicationId, {
      receiptId: `R-${applicationId}-${check.checkType}`,
      checkType: check.checkType,
      result: "PASS",
      issuedAt: engine.now(),
    }, ctx);
  }
}
