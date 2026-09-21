import http from "node:http";
import { BizError } from "./engine.js";
import { buildDetailView, buildListItemView } from "./views.js";
import { maskApplicationParties } from "./masking.js";

const MAX_BODY = 1024 * 1024;

/**
 * HTTP 受理服务。身份来自网关注入的请求头（生产环境前置 SSO）：
 *   X-Actor-Id  工号          X-Role  角色          X-Street  所属街道
 * 街道隔离：非 district-admin 只能访问本街道路由；跨街道按 404/403 处理。
 */
export function createServer({ engine }) {
  const config = engine.config;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const ctx = {
        actor: decodeHeader(req.headers["x-actor-id"]) ?? "anonymous",
        role: req.headers["x-role"] ?? "anonymous",
        street: decodeHeader(req.headers["x-street"]) ?? null,
        idempotencyKey: req.headers["idempotency-key"] ?? null,
      };
      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJson(req) : {};
      const result = await route(req.method, url, body, ctx, engine, config);
      send(res, result.status ?? 200, result.payload, result.headers);
    } catch (err) {
      if (err instanceof BizError) {
        send(res, err.status, { error: err.code, message: err.message, details: err.details });
      } else if (err?.code === "BAD_JSON") {
        send(res, 400, { error: "BAD_JSON", message: "请求体不是合法 JSON" });
      } else {
        console.error(err);
        send(res, 500, { error: "INTERNAL", message: "服务内部错误" });
      }
    }
  });
}

async function route(method, url, body, ctx, engine, config) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const seg = path.split("/").filter(Boolean);

  if (method === "GET" && path === "/health") {
    return { payload: { ok: true, domain: config.domain } };
  }
  if (method === "GET" && path === "/meta") {
    return {
      payload: {
        domain: config.domain,
        policies: config.policies.map((p) => ({
          code: p.code, name: p.name, priority: p.priority,
          effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo ?? null,
          period: p.period, amount: p.amount,
          requiredDocuments: p.requiredDocuments, verifications: p.verifications,
        })),
        priorityStrategy: config.settings.priorityStrategy,
        roles: config.dictionary.roles,
        conflictRules: config.conflictRules.map((r) => ({ code: r.code, desc: r.desc })),
      },
    };
  }

  // /streets/:street/... 以下全部要求街道匹配（district-admin 除外）
  if (seg[0] === "streets" && seg[1]) {
    const street = decodeURIComponent(seg[1]);
    requireStreet(ctx, street);

    if (method === "POST" && seg.length === 3 && seg[2] === "applications") {
      requireRole(ctx, ["caseworker"]);
      const r = await engine.submitApplication(
        { ...body, idempotencyKey: body.idempotencyKey ?? ctx.idempotencyKey },
        { ...ctx, street }
      );
      return {
        status: r.replayed ? 200 : 201,
        payload: present(engine, r.applicationId, ctx),
      };
    }

    if (method === "GET" && seg.length === 3 && seg[2] === "applications") {
      requireRole(ctx, ["caseworker", "auditor", "disburser", "district-admin"]);
      const list = engine.listApplications({
        street,
        status: url.searchParams.get("status") ?? undefined,
        familyKey: url.searchParams.get("familyKey") ?? undefined,
      });
      return { payload: { items: list.map(buildListItemView) } };
    }

    if (seg.length >= 4 && seg[2] === "applications") {
      const applicationId = decodeURIComponent(seg[3]);

      if (method === "GET" && seg.length === 4) {
        requireRole(ctx, ["caseworker", "auditor", "disburser", "district-admin"]);
        return { payload: present(engine, applicationId, ctx, street) };
      }
      if (method === "POST" && seg.length === 5 && seg[4] === "supplements") {
        requireRole(ctx, ["caseworker"]);
        const r = await engine.submitSupplement(
          applicationId,
          { ...body, idempotencyKey: body.idempotencyKey ?? ctx.idempotencyKey },
          { ...ctx, street }
        );
        return { status: r.replayed ? 200 : 201, payload: present(engine, applicationId, ctx, street) };
      }
      if (method === "POST" && seg.length === 5 && seg[4] === "receipts") {
        requireRole(ctx, ["verification-agent", "caseworker"]);
        const r = await engine.recordReceipt(applicationId, body, { ...ctx, street });
        return { status: r.replayed ? 200 : 201, payload: present(engine, applicationId, ctx, street) };
      }
      if (method === "POST" && seg.length === 5 && seg[4] === "disburse") {
        requireRole(ctx, ["disburser"]);
        const r = await engine.disburse(applicationId, { ...ctx, street });
        return { status: r.replayed ? 200 : 201, payload: { disbursement: r.disbursement } };
      }
      if (method === "POST" && seg.length === 5 && seg[4] === "reject") {
        requireRole(ctx, ["caseworker"]);
        await engine.rejectApplication(applicationId, body, { ...ctx, street });
        return { payload: present(engine, applicationId, ctx, street) };
      }
    }
  }

  throw new BizError(404, "ROUTE_NOT_FOUND", `${method} ${path} 不存在`);
}

/** 组装响应：工作视图 + 按角色脱敏；跨街道的申请一律 404，不泄露存在性 */
function present(engine, applicationId, ctx, street) {
  const app = engine.getApplication(applicationId);
  if (!app || (street && app.street !== street)) throw new BizError(404, "NOT_FOUND", "申请不存在");
  const view = buildDetailView(engine, app, engine.now());
  return maskApplicationParties(view, engine.config.dictionary, ctx.role);
}

function requireStreet(ctx, street) {
  if (ctx.role === "district-admin") return;
  if (!ctx.street || ctx.street !== street) {
    throw new BizError(403, "STREET_ISOLATION", "仅可访问本街道数据");
  }
}

function requireRole(ctx, roles) {
  if (!roles.includes(ctx.role)) {
    throw new BizError(403, "FORBIDDEN_ROLE", `角色 ${ctx.role} 无权执行该操作`);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BizError(413, "TOO_LARGE", "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("bad json"), { code: "BAD_JSON" }));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, payload, headers) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

/** 请求头只能携带 latin1：中文街道名等按 percent-encoding 传输，这里解码（兼容未编码的纯 ASCII） */
function decodeHeader(value) {
  if (value == null) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
