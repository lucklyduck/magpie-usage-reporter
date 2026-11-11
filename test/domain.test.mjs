import { test, expect } from "bun:test";
import { resolvePeriod, dateInZone } from "../lib/domain/periods.mjs";
import { groupRows } from "../lib/domain/grouping.mjs";
import { stats, sum, accountKey, modelKey } from "../lib/domain/stats.mjs";
import { nextRun } from "../lib/domain/schedule.mjs";
import {
  validateSubscription,
  validateSettings,
} from "../lib/domain/config.mjs";
import { ReportBuilder } from "../lib/domain/report.mjs";
import { createRegistries } from "../lib/registry.mjs";
import { renderText, splitText } from "../lib/render/text.mjs";
import { fixtureRows, makeFixture } from "./helpers.mjs";

test("current balance uses provider windows without losing their units", async () => {
  const f = makeFixture();
  const old = f.source.quotas;
  f.source.quotas = async () => {
    const q = await old();
    q.cards[0].balance = null;
    q.cards[0].windows[0].balance = 0;
    q.cards[0].windows[0].unit = "credits";
    return q;
  };
  const spec = structuredClone(f.spec);
  spec.content.blocks = [
    { id: "wallet", type: "balance", period: "today", fields: [] },
  ];
  const report = await f.app.builder.build(spec);
  expect(report.blocks[0].lines.join(" ")).toContain("0 credits");
  await f.close();
});

test("natural week/month and previous periods use calendar boundaries", () => {
  const at = Date.parse("2026-01-01T03:00:00Z");
  expect(resolvePeriod("this-week", at).from).toBe("2025-12-29");
  expect(resolvePeriod("previous-week", at).to).toBe("2025-12-28");
  expect(resolvePeriod("previous-month", at).from).toBe("2025-12-01");
  expect(resolvePeriod("previous-month", at).to).toBe("2025-12-31");
  expect(resolvePeriod("7d", at).from).toBe("2025-12-26");
  expect(() => resolvePeriod("week", at)).toThrow();
  expect(() =>
    resolvePeriod("custom", at, "Asia/Shanghai", {
      from: "2025-02-30",
      to: "2025-03-01",
    }),
  ).toThrow();
});
test("calendar schedule clamps monthly days and handles timezone/DST", () => {
  const at = Date.parse("2026-02-01T00:00:00Z");
  expect(
    new Date(
      nextRun({ type: "monthly", day: 31, time: "09:00" }, at, "Asia/Shanghai"),
    ).toISOString(),
  ).toBe("2026-02-28T01:00:00.000Z");
  expect(
    new Date(
      nextRun(
        { type: "weekly", weekday: 1, time: "09:00" },
        at,
        "Asia/Shanghai",
      ),
    ).toISOString(),
  ).toBe("2026-02-02T01:00:00.000Z");
  const dst = nextRun(
    { type: "daily", time: "02:30" },
    Date.parse("2026-03-08T05:00:00Z"),
    "America/New_York",
  );
  expect(dateInZone(dst, "America/New_York")).toBe("2026-03-09");
});
test("both groupings preserve totals and provider model identity", () => {
  const rows = fixtureRows(),
    a = groupRows(rows, "account"),
    m = groupRows(rows, "model");
  expect(sum(a)).toEqual(sum(m));
  expect(sum(a).calls).toBe(10);
  expect(m[0].children.find((c) => c.id === "shared-model").calls).toBe(5);
  expect(m.find((g) => g.id === "p2").children[0].calls).toBe(4);
  expect(
    stats({
      input: 100,
      output: 20,
      reasoning: 15,
      cacheRead: 30,
      cacheWrite: 10,
    }).tokens,
  ).toBe(160);
});
test("configuration rejects duplicate route, empty fields and invalid cron", () => {
  const f = makeFixture();
  expect(() =>
    validateSubscription(
      {
        ...f.spec,
        route: { primaryChannelId: "same", backupChannelId: "same" },
      },
      f.reg,
    ),
  ).toThrow();
  const bad = structuredClone(f.spec);
  bad.content.blocks[0].fields = [];
  expect(() => validateSubscription(bad, f.reg)).toThrow();
  expect(() =>
    validateSubscription(
      { ...f.spec, schedule: { type: "cron", expression: "* * * * * *" } },
      f.reg,
    ),
  ).toThrow();
  expect(() =>
    validateSettings({ displayMode: "custom", currency: "CNY", usdCny: 0 }),
  ).toThrow();
  return f.close();
});
test("report filters, top-N totals, unknown price and quota timestamps", async () => {
  const f = makeFixture(),
    spec = structuredClone(f.spec);
  spec.filters.models = [modelKey("p1", "shared-model")];
  spec.content.blocks[0].limit = 1;
  const report = await f.app.builder.build(spec);
  expect(report.blocks[0].totals.calls).toBe(5);
  expect(report.blocks[0].omitted).toBe(1);
  expect(report.blocks[0].rest.calls).toBe(2);
  const text = renderText(report, "table", f.reg);
  expect(text).toContain("范围合计");
  expect(text).toContain("2026-11-10T05:00:00Z");
  expect(text).toContain("其余");
  const all = await f.app.builder.build(f.spec);
  expect(renderText(all, "table", f.reg)).toContain("未定价");
  await f.close();
});
test("selected quota-only report is not skipped and missing quotas never become zero", async () => {
  const f = makeFixture();
  const spec = structuredClone(f.spec);
  spec.content.blocks = [
    {
      id: "balance",
      type: "balance",
      period: "today",
      fields: [],
      sort: "tokens",
      limit: null,
    },
  ];
  const report = await f.app.builder.build(spec);
  expect(report.empty).toBe(false);
  expect(report.blocks[0].lines.join(" ")).toContain("未提供");
  expect(report.blocks[0].lines.join(" ")).toContain("USD 12.00");
  await f.close();
});
test("report refuses incomplete usage but keeps separate quota failure state", async () => {
  const f = makeFixture();
  f.source.load = async () => ({
    state: "partial",
    warnings: [{ message: "missing" }],
  });
  await expect(f.app.builder.build(f.spec)).rejects.toThrow("不完整");
  await f.close();
});
test("new metric and grouping register without changing delivery code", async () => {
  const f = makeFixture();
  f.reg.metrics.add({
    id: "customScore",
    label: "自定义指标",
    type: "number",
    value: (row) => row.calls * 7,
  });
  const s = structuredClone(f.spec);
  s.content.blocks[0].fields = ["customScore"];
  const r = await f.app.builder.build(validateSubscription(s, f.reg));
  expect(renderText(r, "list", f.reg)).toContain("自定义指标：28");
  await f.close();
});
test("text splitting preserves Unicode and enforces channel length", () => {
  const text = ("中文<&> 🐦 " + "x".repeat(200) + "\n").repeat(10),
    parts = splitText(text, 130);
  expect(parts.length).toBeGreaterThan(10);
  expect(parts.every((p) => p.length <= 130)).toBe(true);
  expect(parts.join("")).not.toContain("�");
});
