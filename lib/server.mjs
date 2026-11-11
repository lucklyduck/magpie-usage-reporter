import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApplication } from "./bootstrap.mjs";
import { failure, AppError } from "./domain/errors.mjs";
import { resolveStateDirectory, stateIdentity } from "./state-directory.mjs";
import { aggregateGatewayUsage } from "../vendor/page-usage-tree/lib/usage.mjs";
import { accountKey, sum } from "./domain/stats.mjs";
export const NAME = "magpie-usage-subscriptions";
export const SERVICE_PROTOCOL = 1;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
let hash;
export function buildId() {
  if (hash) return hash;
  const h = createHash("sha256");
  const visit = (dir) => {
    for (const name of readdirSync(join(ROOT, dir)).sort()) {
      const path = join(dir, name),
        full = join(ROOT, path);
      if (statSync(full).isDirectory()) visit(path);
      else {
        h.update(path);
        h.update(readFileSync(full));
      }
    }
  };
  for (const dir of ["lib", "ui", "page", "types"]) visit(dir);
  for (const f of ["package.json", "index.mjs", "serve.mjs"])
    h.update(readFileSync(join(ROOT, f)));
  for (const f of ["lib/usage.mjs", "ui/view.js", "ui/i18n.js"])
    h.update(readFileSync(join(ROOT, "vendor/page-usage-tree", f)));
  return (hash = h.digest("hex").slice(0, 20));
}
function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}
function tokenEqual(value, expected) {
  if (!value || value.length !== expected.length) return false;
  const supplied = Buffer.from(value),
    actual = Buffer.from(expected);
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}
function originAllowed(origin, port) {
  if (!origin || origin === "null") return true;
  try {
    const u = new URL(origin);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
      Number(u.port) === port
    );
  } catch {
    return false;
  }
}
function hostAllowed(host, port) {
  return ["127.0.0.1:" + port, "localhost:" + port, "[::1]:" + port].includes(
    host,
  );
}
function apiQuery(url) {
  const q = url.searchParams,
    filters = {};
  for (const k of ["providers", "accounts", "models", "agents", "sources"]) {
    const s = q.get(k);
    if (s)
      try {
        filters[k] = JSON.parse(s);
      } catch {
        throw new AppError("筛选格式错误");
      }
    if (filters[k] && !Array.isArray(filters[k]))
      throw new AppError("筛选需要数组");
  }
  return {
    period: q.get("period") || "today",
    from: q.get("from"),
    to: q.get("to"),
    grouping: q.get("grouping") || "account",
    sort: q.get("sort") || "tokens",
    includeCache: q.get("includeCache") !== "false",
    showZeroAccounts: q.get("showZeroAccounts") !== "false",
    filters,
    fresh: q.get("fresh") === "1",
  };
}
function legacyTree(snapshot) {
  const groups = new Map();
  for (const row of snapshot.rows) {
    const id = accountKey(row.provider, row.account);
    const g = groups.get(id) || {
      provider: row.provider,
      account: row.account || (row.kind === "api-key" ? "API key" : "unknown"),
      name: row.accountName,
      sub: row.providerName,
      rows: [],
    };
    g.rows.push(row);
    groups.set(id, g);
  }
  const wire = (s) => ({
    ...s,
    cost: s.costUsd,
    cache_read: s.cacheRead,
    cache_write: s.cacheWrite,
    ttft_ms: s.ttftMs,
  });
  const accounts = [...groups.values()].map((g) => ({
    id: accountKey(g.provider, g.account),
    ...g,
    ...wire(sum(g.rows)),
  }));
  const models = snapshot.rows.map((r) => ({
    id: r.provider + "/" + r.model,
    ...wire(r),
    host: r.accountName,
  }));
  const tree = aggregateGatewayUsage(
    { ...wire(snapshot.totals), accounts, models },
    {},
    {
      period: ["today", "7d", "30d", "all"].includes(snapshot.period.id)
        ? snapshot.period.id
        : "today",
    },
  );
  return {
    ...tree,
    generatedAt: snapshot.generatedAt,
    stale: snapshot.stale || false,
    warnings: [...(tree.warnings || []), ...(snapshot.warnings || [])],
  };
}
export async function startServer(options = {}) {
  const requested = Number.isInteger(Number(options.port))
    ? Number(options.port)
    : 3495;
  if (requested === 3425)
    throw new AppError("插件服务不能占用 Magpie 网关端口", 400, "invalid_port");
  if (requested < 0 || requested > 65535)
    throw new AppError("插件端口需要为 0 到 65535 的整数", 400, "invalid_port");
  options = { ...options, stateDir: resolveStateDirectory(options) };
  const instanceId = stateIdentity(options);
  const token = randomBytes(32).toString("base64url");
  let app = options.app,
    server;
  let ready = false;
  const cors = (request) =>
    request.headers.get("origin") === "null"
      ? { "Access-Control-Allow-Origin": "null", Vary: "Origin" }
      : {};
  const handler = async (request) => {
    const url = new URL(request.url),
      port = server?.port || requested;
    try {
      if (!hostAllowed(request.headers.get("host"), port))
        return json({ error: { message: "无效 Host" } }, 403);
      if (!originAllowed(request.headers.get("origin"), port))
        return json({ error: { message: "无效 Origin" } }, 403);
      if (url.pathname === "/healthz")
        return json({
          ok: true,
          name: NAME,
          version: pkg.version,
          build: buildId(),
          ready,
          serviceProtocol: SERVICE_PROTOCOL,
          instanceId,
        });
      if (!ready) return json({ error: { message: "服务正在启动" } }, 503);
      if (url.pathname.startsWith("/api/")) {
        const headers = cors(request);
        if (request.method === "OPTIONS")
          return new Response(null, {
            status: 204,
            headers: {
              ...headers,
              "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type,X-Usage-Token",
            },
          });
        if (!tokenEqual(request.headers.get("x-usage-token"), token))
          return json({ error: { message: "访问令牌无效" } }, 401, headers);
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts[1] !== "v1")
          return json({ error: { message: "API 版本不存在" } }, 404, headers);
        const resource = parts[2],
          id = parts[3],
          action = parts[4],
          method = request.method;
        let body = {};
        if (["POST", "PATCH"].includes(method)) {
          if (
            !request.headers.get("content-type")?.startsWith("application/json")
          )
            throw new AppError("需要 application/json", 415);
          const raw = await request.text();
          if (raw.length > 262144) throw new AppError("请求内容过大", 413);
          try {
            body = JSON.parse(raw);
          } catch {
            throw new AppError("JSON 无效");
          }
          if (!body || typeof body !== "object" || Array.isArray(body))
            throw new AppError("需要 JSON 对象");
        }
        let result,
          status = 200;
        if (resource === "capabilities" && method === "GET")
          result = app.metadata();
        else if (resource === "status" && method === "GET")
          result = app.status();
        else if (resource === "usage" && method === "GET")
          result = await app.usage(apiQuery(url));
        else if (
          resource === "original" &&
          id === "tree" &&
          !action &&
          method === "GET"
        ) {
          const period = url.searchParams.get("period") || "today";
          if (!["today", "7d", "30d", "all"].includes(period))
            throw new AppError("原版用量树周期需要为 today、7d、30d 或 all");
          result = legacyTree(
            await app.source.load({
              period,
              timezone: app.settings().timezone,
              fresh: url.searchParams.get("fresh") === "1",
            }),
          );
        } else if (resource === "quotas" && method === "GET")
          result = await app.quotaSource.load();
        else if (resource === "settings" && method === "GET")
          result = app.settings();
        else if (resource === "settings" && method === "PATCH")
          result = app.saveSettings(body);
        else if (resource === "subscriptions") {
          if (action === "send" && id && method === "POST") {
            result = { id: app.manual(id).id };
            status = 202;
          } else if (!id && method === "GET") result = app.subscriptions();
          else if (!id && method === "POST") {
            result = app.saveSubscription(body);
            status = 201;
          } else if (id && method === "PATCH")
            result = app.saveSubscription(body, id);
          else if (id && method === "DELETE") {
            app.deleteSubscription(id);
            result = { ok: true };
          } else throw new AppError("操作不支持", 405);
        } else if (resource === "channels") {
          if (action === "test" && id && method === "POST") {
            result = { id: app.testChannel(id).id };
            status = 202;
          } else if (!id && method === "GET") result = await app.channelList();
          else if (!id && method === "POST") {
            result = await app.saveChannel(body);
            status = 201;
          } else if (id && method === "PATCH")
            result = await app.saveChannel(body, id);
          else if (id && method === "DELETE") {
            await app.deleteChannel(id);
            result = { ok: true };
          } else throw new AppError("操作不支持", 405);
        } else if (
          resource === "reports" &&
          id === "preview" &&
          method === "POST"
        )
          result = await app.preview(body);
        else if (resource === "deliveries") {
          if (id && action === "retry" && method === "POST") {
            result = { id: app.retry(id).id };
            status = 202;
          } else if (id && action === "cancel" && method === "POST")
            result = app.cancel(id);
          else if (method === "GET")
            result = id
              ? app.repository.getJob(id)
              : app.repository.jobs({
                  subscriptionId: url.searchParams.get("subscriptionId"),
                  status: url.searchParams.get("status"),
                  limit: Number(url.searchParams.get("limit")) || 100,
                });
          else throw new AppError("操作不支持", 405);
        } else throw new AppError("接口不存在", 404);
        return json(result, status, headers);
      }
      if (
        url.pathname.startsWith("/original/") &&
        url.pathname !== "/original/"
      )
        return json(
          {
            error: {
              message: "原版视图已整合到用量页，请使用 /api/v1/original/tree",
              code: "original_proxy_removed",
            },
          },
          410,
        );
      if (request.method !== "GET" && request.method !== "HEAD")
        return json({ error: { message: "方法不支持" } }, 405);
      if (url.pathname === "/original" || url.pathname === "/original/")
        return new Response(null, {
          status: 302,
          headers: {
            Location:
              (url.pathname.endsWith("/") ? "../" : "./") +
              "?usageView=original",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      const staticFiles = {
        "/": ["ui/index.html", "text/html"],
        "/app.js": ["ui/app.js", "text/javascript"],
        "/original-view.js": ["ui/original-view.js", "text/javascript"],
        "/original-assets/i18n.js": [
          "vendor/page-usage-tree/ui/i18n.js",
          "text/javascript",
        ],
        "/original-assets/view.js": [
          "vendor/page-usage-tree/ui/view.js",
          "text/javascript",
        ],
        "/style.css": ["ui/style.css", "text/css"],
        "/icon.svg": ["page/icon.svg", "image/svg+xml"],
      };
      const file = staticFiles[url.pathname];
      if (!file) return json({ error: { message: "页面不存在" } }, 404);
      let content = readFileSync(join(ROOT, file[0]), "utf8");
      if (url.pathname === "/") content = content.replace("__TOKEN__", token);
      return new Response(request.method === "HEAD" ? null : content, {
        headers: {
          // Module scripts need null-origin CORS. A document carrying the
          // API token must only be readable through document navigation.
          ...(url.pathname === "/" ? {} : cors(request)),
          "Content-Type": file[1] + "; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": `default-src 'self'; script-src 'self' http://127.0.0.1:${port}; style-src 'self' 'unsafe-inline' http://127.0.0.1:${port}; img-src 'self' data: http://127.0.0.1:${port}; connect-src 'self' http://127.0.0.1:${port}; base-uri 'none'; form-action 'none'`,
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (e) {
      return json({ error: failure(e) }, e.status || 500, cors(request));
    }
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: requested,
    fetch: handler,
    idleTimeout: 120,
  });
  try {
    app ??= createApplication(options);
    ready = true;
  } catch (e) {
    server.stop(true);
    throw e;
  }
  let closing;
  return {
    port: server.port,
    token,
    app,
    reused: false,
    close() {
      return (closing ??= (async () => {
        ready = false;
        try {
          await app.stop();
        } finally {
          server.stop(true);
          if (!options.app) app.repository.close();
        }
      })());
    },
  };
}
