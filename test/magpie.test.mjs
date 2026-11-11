import { test, expect } from "bun:test";
import { MagpieSource } from "../lib/adapters/magpie.mjs";
import { accountKey, modelKey } from "../lib/domain/stats.mjs";
import { makeFixture } from "./helpers.mjs";
import { presets } from "../lib/domain/config.mjs";
function ledger(n = 605) {
  return Array.from({ length: n }, (_, i) => ({
    t: new Date(Date.parse("2026-11-10T02:00:00Z") + i * 1000).toISOString(),
    route_id: i + 1,
    agent: i % 2 ? "codex" : "claude",
    provider: i % 3 ? "p1" : "p2",
    providerName: "Provider",
    providerAccount: i % 2 ? "alice" : "bob",
    model: i % 3 ? "model" : "other",
    in: 100,
    out: 20,
    cache_read: 30,
    cache_write: 10,
    cache_write_1h: 5,
    reasoning: 15,
    status: 200,
    priced: true,
    cost: 0.01,
    ttft_ms: 100,
  }));
}
function makeSource(rows, options = {}) {
  let requests = 0;
  const fetcher = async (target) => {
    const u = new URL(target);
    if (u.pathname.endsWith("/quotas/cards"))
      return Response.json({ data: options.cards || [] });
    if (u.pathname.endsWith("/usage"))
      return Response.json({ accounts: [], models: [], calls: rows.length });
    requests++;
    let data = rows;
    if (options.dynamic && requests > 1)
      data = [
        { ...rows[0], route_id: 99999, t: "2026-11-10T09:00:00Z" },
        ...rows,
      ];
    const offset = Number(u.searchParams.get("offset")),
      limit = Number(u.searchParams.get("limit"));
    if (options.badPage && offset > 0)
      return Response.json({ rows: "bad", total: data.length });
    return Response.json({
      rows: data.slice(offset, offset + limit),
      total: data.length,
      by: { modelAt: [{ id: "unselected/wrong", calls: 99999, cost: 999 }] },
    });
  };
  return new MagpieSource({
    fetcher,
    gateway: "http://fixture.test",
    clock: { now: () => Date.parse("2026-11-10T06:00:00Z") },
  });
}
test("paginates >500 records, ignores facet exemptions and avoids newly inserted duplicates", async () => {
  const rows = ledger(),
    s = makeSource(rows, { dynamic: true });
  const data = await s.load({ period: "today", fresh: true });
  expect(data.totals.calls).toBe(605);
  expect(data.totals.tokens).toBe(605 * 160);
  expect(data.totals.costUsd).toBeCloseTo(6.05, 8);
  expect(data.totals.reasoning).toBe(605 * 15);
  const selected = await s.load({
    period: "today",
    filters: {
      models: [modelKey("p1", "model")],
      accounts: [accountKey("p1", "alice")],
    },
    fresh: true,
  });
  expect(
    selected.rows.every(
      (r) =>
        r.provider === "p1" && r.account === "alice" && r.model === "model",
    ),
  ).toBe(true);
  expect(selected.totals.calls).toBeGreaterThan(0);
});
test("rejected, handed-on, retries and canceled calls use gateway accounting", async () => {
  const base = ledger(1)[0],
    rows = [
      { ...base, route_id: 1, rejected: true },
      {
        ...base,
        route_id: 2,
        handed_on: true,
        status: 500,
        err: "failed",
        in: 10,
        out: 0,
      },
      { ...base, route_id: 3, tries: 2 },
      {
        ...base,
        route_id: 4,
        status: 499,
        err: "the agent canceled the request",
      },
      { ...base, route_id: 5, status: 500, err: "error", priced: false },
    ];
  const d = await makeSource(rows).load({ period: "today" });
  expect(d.totals.calls).toBe(3);
  expect(d.totals.retried).toBe(1);
  expect(d.totals.canceled).toBe(1);
  expect(d.totals.errors).toBe(1);
  expect(d.totals.unpriced).toBe(1);
  expect(d.totals.input).toBe(310);
});
test("non-usage activities preserve completeness and pagination without entering totals or filters", async () => {
  const base = ledger(1)[0],
    sources = ["probe", "mcp", "search"],
    activities = Array.from({ length: 501 }, (_, i) => ({
      source: sources[i % sources.length],
      kind: "model_list",
      t: i % 2 ? base.t : "invalid",
      provider: "activity-only",
      model: "",
      in: 0,
      out: 0,
      cache_read: 0,
      cache_write: 0,
    })),
    namedActivities = sources.map((source, i) => ({
      ...base,
      route_id: 1000 + i,
      source,
      provider: "activity-only",
      providerAccount: "activity-account",
      model: "activity-model",
      agent: "activity-agent",
    })),
    rows = [...activities, ...namedActivities, ...ledger(2)],
    data = await makeSource(rows).load({ period: "today", fresh: true });
  expect(data.state).toBe("complete");
  expect(data.warnings).toEqual([]);
  expect(data.scanned).toBe(rows.length);
  expect(data.totals.calls).toBe(2);
  expect(data.totals.tokens).toBe(320);
  expect(data.totals.costUsd).toBeCloseTo(0.02, 8);
  expect(data.options.providers.some((p) => p.id === "activity-only")).toBe(
    false,
  );
  expect(
    data.options.accounts.some((a) => a.account === "activity-account"),
  ).toBe(false);
  expect(data.options.models.some((m) => m.id.includes("activity-model"))).toBe(
    false,
  );
  expect(data.options.agents.some((a) => a.id === "activity-agent")).toBe(
    false,
  );
});

test("daily reports containing week and month blocks reach the primary despite model-list probes", async () => {
  const rows = ledger(2);
  rows.unshift({
    ...rows[0],
    source: "probe",
    kind: "model_list",
    model: "",
    in: 0,
    out: 0,
    cache_read: 0,
    cache_write: 0,
    status: 0,
  });
  const f = makeFixture({ sourceOverride: makeSource(rows) });
  try {
    const s = f.app.saveSubscription({ ...presets()[1], route: f.spec.route }),
      job = f.app.enqueue(s);
    await f.app.tick();
    const result = f.repo.getJob(job.id);
    expect(result.status).toBe("sent");
    expect(result.buildAttempts).toBe(0);
    expect(result.report.warnings).toEqual([]);
    for (const period of ["today", "this-week", "this-month"])
      expect(result.report.blocks.some((b) => b.period?.id === period)).toBe(
        true,
      );
    expect(f.calls.map((c) => c.id)).toEqual(["primary"]);
    expect(result.receipts.length).toBe(1);
  } finally {
    await f.close();
  }
});

test("malformed model requests still block reports instead of silently dropping usage", async () => {
  const rows = ledger(2);
  rows[0].model = "";
  const f = makeFixture({ sourceOverride: makeSource(rows) });
  try {
    const data = await f.source.load({ period: "today" });
    expect(data.state).toBe("partial");
    expect(data.warnings.map((w) => w.code)).toEqual(["invalid_record"]);
    const s = f.app.saveSubscription(f.spec),
      job = f.app.enqueue(s);
    await f.app.tick();
    expect(f.repo.getJob(job.id).lastError).toBe(
      "用量明细不完整，本次报告未发送",
    );
    expect(f.calls).toEqual([]);
  } finally {
    await f.close();
  }
});

test("partial pagination errors fail instead of returning zero usage", async () => {
  await expect(
    makeSource(ledger(), { badPage: true }).load({ period: "today" }),
  ).rejects.toThrow("结构无效");
  const s = new MagpieSource({
    fetcher: async () => new Response("denied", { status: 403 }),
  });
  await expect(s.load()).rejects.toThrow("403");
});
test("time ranges honor report timezone and reject malformed record timestamps", async () => {
  const rows = ledger(1);
  rows.push({ ...rows[0], route_id: 2, t: "bad" });
  const d = await makeSource(rows).load({ period: "today" });
  expect(d.state).toBe("partial");
  expect(d.totals.calls).toBe(1);
});
test("quota source preserves zeros, currencies and shared metadata", async () => {
  const s = makeSource([], {
    cards: [
      {
        provider: "p",
        user: "u",
        windows: [{ name: "5h", used: 0, balance: 0, pool: "same" }],
        balance: "CNY 0.00",
        readAt: "2026-11-10T01:00:00Z",
        sharedBalance: "wallet",
      },
    ],
  });
  const q = await s.quotas();
  expect(q.cards[0].windows[0].used).toBe(0);
  expect(q.cards[0].windows[0].balance).toBe(0);
  expect(q.cards[0].balance).toBe("CNY 0.00");
  expect(q.cards[0].sharedBalance).toBe("wallet");
});
