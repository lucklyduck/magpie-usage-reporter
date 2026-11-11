import { test, expect } from "bun:test";
import { makeFixture, settled } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { formatMetric } from "../lib/render/text.mjs";

test("new settings follow Magpie and the effective display API is authenticated", async () => {
  const f = makeFixture();
  const server = await startServer({ port: 0, app: f.app });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect(f.app.settings().displayMode).toBe("magpie");
    expect(f.app.metadata().uiProtocol).toBe(1);
    expect((await fetch(base + "/api/v1/display")).status).toBe(401);
    const response = await fetch(base + "/api/v1/display", {
      headers: { "X-Usage-Token": server.token, Origin: "null" },
    });
    expect(response.status).toBe(200);
    const display = await response.json();
    expect(display.mode).toBe("magpie");
    expect(display.effective.currency).toBe("USD");
    expect(f.app.settings().revision).toBe(0);
  } finally {
    await server.close();
    f.repo.close();
  }
});

test("legacy page settings remain custom and mode changes retain custom values", async () => {
  const f = makeFixture();
  try {
    const legacy = f.repo.put("settings", {
      id: "app",
      currency: "CNY",
      usdCny: 7.5,
      timezone: "Asia/Shanghai",
    });
    const migrated = f.app.settings();
    expect(migrated.displayMode).toBe("custom");
    expect(migrated.chineseUnits).toBe(false);
    expect(migrated.usdCny).toBe(7.5);
    expect(f.repo.get("settings", "app")).toEqual(legacy);
    const follow = f.app.saveSettings({ ...migrated, displayMode: "magpie" });
    expect(follow.currency).toBe("CNY");
    expect(follow.usdCny).toBe(7.5);
    const custom = f.app.saveSettings({
      ...follow,
      displayMode: "custom",
      chineseUnits: true,
    });
    expect(custom.chineseUnits).toBe(true);
    expect(() =>
      f.app.saveSettings({ ...custom, revision: follow.revision }),
    ).toThrow("设置已被修改");
    expect(() => f.app.saveSettings({ ...custom, usdCny: 0 })).toThrow("汇率");
  } finally {
    await f.close();
  }
});

test("new report units are explicit while legacy numeric formatting stays unchanged", async () => {
  const f = makeFixture();
  try {
    const draft = structuredClone(f.spec);
    draft.content.chineseUnits = true;
    const saved = f.app.saveSubscription(draft);
    expect(saved.content.chineseUnits).toBe(true);
    const report = await f.app.builder.build(saved);
    expect(report.chineseUnits).toBe(true);
    expect(formatMetric(12000, { type: "number" }, {}, report)).toBe("1.2万");
    expect(
      formatMetric(12000, { type: "number" }, {}, { chineseUnits: false }),
    ).toBe("12K");
    expect(formatMetric(12000, { type: "number" }, {}, {})).toBe("12,000");
    expect(formatMetric(25, { type: "percent" }, {}, report)).toBe("25.0%");
    const old = f.app.saveSubscription(f.spec);
    expect(old.content.chineseUnits).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("changing page display settings never rebuilds a frozen delivery on retry", async () => {
  const f = makeFixture({
    outcomes: { primary: [{ outcome: "unknown", message: "timeout" }] },
  });
  try {
    const sub = f.app.saveSubscription(f.spec);
    f.app.enqueue(sub);
    await f.app.tick();
    const before = f.repo.jobs()[0];
    expect(before.status).toBe("unknown");
    const frozen = JSON.stringify(before.report);
    f.app.saveSettings({
      displayMode: "custom",
      currency: "CNY",
      usdCny: 9,
      chineseUnits: true,
    });
    expect(f.repo.get("subscriptions", sub.id)).toEqual(sub);
    f.app.retry(before.id);
    await settled(f.app);
    const after = f.repo.getJob(before.id);
    expect(after.status).toBe("sent");
    expect(after.text).toBe(before.text);
    expect(JSON.stringify(after.report)).toBe(frozen);
    expect(f.calls[1].message.text).toBe(f.calls[0].message.text);
  } finally {
    await f.close();
  }
});
