import { createHash } from "node:crypto";
import { aggregateGatewayUsage } from "../../vendor/page-usage-tree/lib/usage.mjs";
import { AppError } from "../domain/errors.mjs";
import {
  stats,
  sum,
  accountKey,
  modelKey,
  matches,
  finish,
  sameStats,
} from "../domain/stats.mjs";
import { resolvePeriod, dateInZone, shiftDay } from "../domain/periods.mjs";
function sourceOf(r) {
  return r.source === "log" || r.source === "direct"
    ? "direct"
    : r.source === "reported" || r.kind === "reported"
      ? "reported"
      : "through";
}
function accountOf(r) {
  if (r.providerAccount) return String(r.providerAccount);
  const host = String(r.host || "");
  if (host.includes(" as ")) return host.slice(host.lastIndexOf(" as ") + 4);
  if (r.source === "log") return String(r.session_account || "");
  return "";
}
function recordStats(r) {
  const canceled =
    r.canceled === true ||
    (r.status === 499 && r.err === "the agent canceled the request");
  const handed = r.handed_on === true,
    failed = !canceled && (Number(r.status) >= 400 || Boolean(r.err));
  return stats({
    calls: handed ? 0 : 1,
    errors: !handed && failed ? 1 : 0,
    retried: !handed && r.tries > 1 ? 1 : 0,
    canceled: !handed && canceled ? 1 : 0,
    input: r.in,
    output: r.out,
    cacheRead: r.cache_read,
    cacheWrite: r.cache_write,
    reasoning: r.reasoning,
    costUsd: r.priced ? r.cost : 0,
    unpriced:
      !r.priced && r.in + r.out + r.cache_read + r.cache_write > 0 ? 1 : 0,
    credits: r.credits,
    timed: !handed && !failed && !canceled && r.ttft_ms > 0 ? 1 : 0,
    ttftMs: !handed && !failed && !canceled ? r.ttft_ms : 0,
  });
}
export class MagpieSource {
  constructor({
    gateway = "",
    getGateway = () => gateway,
    fetcher = fetch,
    clock = { now: () => Date.now() },
    apiKey = "",
    timeout = 15000,
  } = {}) {
    this.getGateway = getGateway;
    this.fetcher = fetcher;
    this.clock = clock;
    this.apiKey = apiKey;
    this.timeout = timeout;
    this.cache = new Map();
  }
  base() {
    let base =
      this.getGateway() ||
      process.env.MAGPIE_USAGE_GATEWAY ||
      process.env.MAGPIE_ADDR ||
      "127.0.0.1:3425";
    base = String(base).replace(/^(0\.0\.0\.0|\[::\]):/, "127.0.0.1:");
    return (/^https?:\/\//.test(base) ? base : "http://" + base).replace(
      /\/+$/,
      "",
    );
  }
  async json(path) {
    const key =
      this.apiKey ||
      process.env.MAGPIE_API_KEY ||
      process.env.MAGPIE_GATEWAY_KEY;
    let response;
    try {
      response = await this.fetcher(this.base() + path, {
        headers: key ? { Authorization: "Bearer " + key } : {},
        signal: AbortSignal.any([
          AbortSignal.timeout(this.timeout),
          ...(this.signal ? [this.signal] : []),
        ]),
      });
    } catch {
      throw new AppError(
        "无法读取 Magpie 网关，请确认 Magpie 正在运行",
        502,
        "gateway_unavailable",
      );
    }
    if (!response.ok)
      throw new AppError(
        "Magpie 网关返回 HTTP " + response.status,
        response.status === 403 ? 403 : 502,
        "gateway_http_" + response.status,
      );
    let body;
    try {
      body = await response.json();
    } catch {
      throw new AppError("Magpie 网关 JSON 无效", 502, "gateway_invalid_json");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new AppError(
        "Magpie 网关响应结构无效",
        502,
        "gateway_invalid_shape",
      );
    return body;
  }
  async load(query = {}) {
    const at = query.at ?? this.clock.now(),
      period = resolvePeriod(
        query.period || "today",
        at,
        query.timezone || "Asia/Shanghai",
        query,
      );
    const filters = query.filters || {},
      cacheKey = JSON.stringify({
        base: this.base(),
        period: { ...period, at: query.at == null ? undefined : period.at },
        filters,
        includeCache: query.includeCache !== false,
      });
    const cached = this.cache.get(cacheKey);
    if (!query.fresh && cached && this.clock.now() - cached.time < 25000)
      return { ...cached.value, cached: true };
    // Use the gateway's matched, priced request ledger. Reading rows avoids by.modelAt's facet filter exemption.
    const range = shiftDay(period.from, -1) + ".." + shiftDay(period.to, 1);
    const summary = await this.json(
      "/v1/magpie/usage?" + new URLSearchParams({ period: range }),
    );
    if (!Array.isArray(summary.accounts) || !Array.isArray(summary.models))
      throw new AppError(
        "Magpie 用量接口缺少账号或模型字段",
        502,
        "gateway_invalid_shape",
      );
    const legacy = aggregateGatewayUsage(summary, {}, { period: "all" });
    const names = new Map(
      legacy.accounts.map((a) => [
        accountKey(a.provider, a.account),
        a.alias || a.account,
      ]),
    );
    const facets = {
      providers: new Map(),
      accounts: new Map(),
      models: new Map(),
      agents: new Map(),
    };
    const buckets = new Map(),
      seen = new Set(),
      warnings = [];
    let offset = 0,
      total = 0,
      scanned = 0,
      previousTotal = 0;
    const cutoff = Math.min(at, this.clock.now());
    do {
      const page = await this.json(
        "/v1/magpie/usage/requests?" +
          new URLSearchParams({
            period: range,
            offset: String(offset),
            limit: "500",
          }),
      );
      if (
        !Array.isArray(page.rows) ||
        !Number.isInteger(page.total) ||
        page.total < 0
      )
        throw new AppError(
          "Magpie 请求明细结构无效",
          502,
          "gateway_invalid_shape",
        );
      total = page.total;
      if (offset && total < previousTotal)
        throw new AppError(
          "读取时账本发生变化，请重试",
          502,
          "gateway_ledger_changed",
        );
      previousTotal = total;
      if (!page.rows.length) {
        if (offset < total)
          throw new AppError("Magpie 分页未完成", 502, "gateway_incomplete");
        break;
      }
      for (const r of page.rows) {
        const t = Date.parse(r.t);
        if (!Number.isFinite(t)) {
          warnings.push({
            code: "invalid_timestamp",
            message: "部分记录时间无效",
          });
          continue;
        }
        const day = dateInZone(t, period.timezone);
        if (day < period.from || day > period.to || t > cutoff || r.rejected)
          continue;
        if (
          !r.provider ||
          !r.model ||
          ["in", "out", "cache_read", "cache_write"].some(
            (k) => !Number.isFinite(r[k]) || r[k] < 0,
          ) ||
          (r.priced && !Number.isFinite(r.cost))
        ) {
          warnings.push({
            code: "invalid_record",
            message: "部分记录字段无效",
          });
          continue;
        }
        const identity = createHash("sha256")
          .update(
            JSON.stringify([
              r.route_id,
              r.t,
              r.agent,
              r.provider,
              r.providerAccount,
              r.host,
              r.model,
              r.kind,
              r.source,
              r.response_id,
              r.rid,
              r.session,
              r.native_session,
              r.handed_on,
              r.status,
            ]),
          )
          .digest("hex");
        if (seen.has(identity)) continue;
        seen.add(identity);
        const provider = String(r.provider),
          account = accountOf(r),
          model = String(r.model),
          source = sourceOf(r);
        const kind = !account
          ? r.access === "api"
            ? "api-key"
            : "unknown"
          : "account";
        const accountName =
          names.get(accountKey(provider, account)) ||
          account ||
          (kind === "api-key" ? "API 密钥统计组" : "未知账号");
        const row = {
          provider,
          providerName: String(r.providerName || provider),
          account,
          accountName,
          model,
          kind,
        };
        facets.providers.set(provider, {
          id: provider,
          label: row.providerName,
        });
        facets.accounts.set(accountKey(provider, account), {
          id: accountKey(provider, account),
          label: row.providerName + " · " + accountName,
          provider,
          account,
        });
        facets.models.set(modelKey(provider, model), {
          id: modelKey(provider, model),
          label: provider + " / " + model,
        });
        facets.agents.set(r.agent, {
          id: r.agent,
          label: r.agentName || r.agent,
        });
        if (
          !matches(row, filters) ||
          (filters.agents?.length && !filters.agents.includes(r.agent)) ||
          (filters.sources?.length && !filters.sources.includes(source))
        )
          continue;
        const id = JSON.stringify([provider, account, model]);
        let bucket = buckets.get(id);
        if (!bucket) {
          bucket = { ...row, ...stats() };
          buckets.set(id, bucket);
        }
        const rs = recordStats(r);
        for (const k of Object.keys(rs))
          if (k !== "tokens" && k !== "errorRate" && k !== "avgTtftMs")
            bucket[k] = (bucket[k] || 0) + (rs[k] || 0);
      }
      scanned += page.rows.length;
      offset += page.rows.length;
      if (offset > 1000000)
        throw new AppError(
          "本次查询超过 100 万条，请缩小统计周期",
          400,
          "query_too_large",
        );
    } while (offset < total);
    const rows = [...buckets.values()].map((r) =>
      finish(r, query.includeCache !== false),
    );
    const value = {
      rows,
      totals: sum(rows, query.includeCache !== false),
      state: warnings.length ? "partial" : "complete",
      warnings,
      period,
      generatedAt: new Date(this.clock.now()).toISOString(),
      source: "Magpie matched request ledger",
      scanned,
      options: Object.fromEntries(
        Object.entries(facets).map(([k, v]) => [k, [...v.values()]]),
      ),
    };
    this.cache.set(cacheKey, { time: this.clock.now(), value });
    if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value);
    return value;
  }
  async quotas() {
    try {
      const data = await this.json("/v1/magpie/quotas/cards");
      if (!Array.isArray(data.data)) throw new Error("额度接口缺少 data");
      return {
        state: "complete",
        generatedAt: new Date(this.clock.now()).toISOString(),
        cards: data.data.map((q) => ({
          provider: String(q.provider || ""),
          providerName: q.name || q.provider,
          account: String(q.user || ""),
          accountName: q.alias || q.user || "API 密钥统计组",
          kind: q.kind || "subscription",
          windows: Array.isArray(q.windows)
            ? q.windows.map((w) => ({
                name: String(w.name || ""),
                used: typeof w.used === "number" ? w.used : null,
                unlimited: w.unlimited === true,
                display: w.display || "",
                resetsAt: w.resetsAt || null,
                balance: w.balance ?? null,
                unit: w.unit || "",
                amount: w.amount ?? null,
                limit: w.limit ?? null,
                pool: w.pool || "",
                family: w.family || "",
              }))
            : [],
          balance: q.balance ?? null,
          balanceParts: q.balanceParts || [],
          sharedBalance: q.sharedBalance || "",
          seat: q.seat || "",
          readAt: q.readAt || q.asOf || null,
          stale: Boolean(q.asOf || q.readDeferred),
          error: q.error || "",
          plan: q.plan || "",
        })),
      };
    } catch (e) {
      return {
        state: "failed",
        generatedAt: new Date(this.clock.now()).toISOString(),
        cards: [],
        error: e.message,
      };
    }
  }
}
