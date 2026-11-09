import { test, expect } from "bun:test";
import { MagpieSource } from "../lib/adapters/magpie.mjs";
import { accountKey, modelKey } from "../lib/domain/stats.mjs";
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
