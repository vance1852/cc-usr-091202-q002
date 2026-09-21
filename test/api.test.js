import test from "node:test";
import assert from "node:assert/strict";
import { makeEngine, livingAidApp } from "./helpers.js";
import { createServer } from "../src/server.js";

async function makeApi() {
  const { engine, state } = await makeEngine();
  const server = createServer({ engine });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, { role = "caseworker", street = "新河街道", body, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-actor-id": "tester",
        "x-role": role,
        // 请求头只能携带 latin1，中文街道名按 percent-encoding 传输
        ...(street ? { "x-street": encodeURIComponent(street) } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
  return { call, state, close: () => new Promise((r) => server.close(r)) };
}

test("HTTP：提交申请并在工作视图中看到缺件与下一位办理人", async () => {
  const { call, close } = await makeApi();
  try {
    const payload = livingAidApp();
    payload.materials = payload.materials.filter((m) => m.docType !== "INCOME_PROOF");
    const created = await call("POST", "/streets/新河街道/applications", { body: payload });
    assert.equal(created.status, 201);
    const id = created.body.applicationId;

    const detail = await call("GET", `/streets/新河街道/applications/${id}`);
    assert.equal(detail.body.status, "PENDING_SUPPLEMENT");
    assert.equal(detail.body.missingItems[0].docType, "INCOME_PROOF");
    assert.equal(detail.body.nextHandler.queue, "申请人");
    assert.equal(detail.body.applicant.idCardNo, "110101199001011234"); // 专干可见完整身份证号
  } finally {
    await close();
  }
});

test("HTTP：街道隔离——他街道不可见、不可操作", async () => {
  const { call, close } = await makeApi();
  try {
    const created = await call("POST", "/streets/新河街道/applications", { body: livingAidApp() });
    const id = created.body.applicationId;

    // 他街道专干访问本街道路由 → 403
    const cross = await call("GET", `/streets/新河街道/applications/${id}`, { street: "城西街道" });
    assert.equal(cross.status, 403);
    // 他街道列表为空
    const list = await call("GET", "/streets/城西街道/applications", { street: "城西街道" });
    assert.equal(list.body.items.length, 0);
    // 区级角色可跨街道只读
    const admin = await call("GET", `/streets/新河街道/applications/${id}`, { role: "district-admin", street: null });
    assert.equal(admin.status, 200);
  } finally {
    await close();
  }
});

test("HTTP：按角色脱敏——审核岗看到掩码身份证号", async () => {
  const { call, close } = await makeApi();
  try {
    const created = await call("POST", "/streets/新河街道/applications", { body: livingAidApp() });
    const id = created.body.applicationId;

    const auditor = await call("GET", `/streets/新河街道/applications/${id}`, { role: "auditor" });
    assert.equal(auditor.body.applicant.idCardNo, "110101********1234");
    assert.equal(auditor.body.applicant.phone, "138******11");

    const agent = await call("GET", `/streets/新河街道/applications/${id}`, { role: "verification-agent" });
    assert.equal(agent.status, 403); // 核验岗只能回传回执，不能查阅卷宗
  } finally {
    await close();
  }
});

test("HTTP：角色权限——审核岗只读，发放岗才能发放", async () => {
  const { call, close } = await makeApi();
  try {
    const denied = await call("POST", "/streets/新河街道/applications", { role: "auditor", body: livingAidApp() });
    assert.equal(denied.status, 403);

    const created = await call("POST", "/streets/新河街道/applications", { body: livingAidApp() });
    const id = created.body.applicationId;
    const notDisburser = await call("POST", `/streets/新河街道/applications/${id}/disburse`);
    assert.equal(notDisburser.status, 403);
  } finally {
    await close();
  }
});

test("HTTP：Idempotency-Key 重放返回同一笔申请", async () => {
  const { call, close } = await makeApi();
  try {
    const headers = { "idempotency-key": "key-001" };
    const a = await call("POST", "/streets/新河街道/applications", { body: livingAidApp(), headers });
    const b = await call("POST", "/streets/新河街道/applications", { body: livingAidApp(), headers });
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(a.body.applicationId, b.body.applicationId);
  } finally {
    await close();
  }
});

test("HTTP：/health 与 /meta 暴露政策与优先策略", async () => {
  const { call, close } = await makeApi();
  try {
    const health = await call("GET", "/health", { street: null });
    assert.equal(health.body.ok, true);
    const meta = await call("GET", "/meta", { street: null });
    const codes = meta.body.policies.map((p) => p.code);
    assert.deepEqual(codes.sort(), ["DISABILITY-AID", "LIVING-AID", "TEMP-AID"]);
    assert.equal(meta.body.priorityStrategy, "EXCLUSIVE_BY_PRIORITY");
    const living = meta.body.policies.find((p) => p.code === "LIVING-AID");
    assert.equal(living.priority, 30); // 来自现有政策样例 context.json
  } finally {
    await close();
  }
});
