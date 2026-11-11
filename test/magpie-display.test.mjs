import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MagpieDisplaySource,
  magpieDisplayPaths,
} from "../lib/adapters/magpie-display.mjs";
import { createApplication } from "../lib/bootstrap.mjs";
import { makeFixture } from "./helpers.mjs";

test("Magpie display paths follow installed, XDG and portable host directories independently of plugin state", () => {
  const home = join(tmpdir(), "magpie-display-home");
  expect(magpieDisplayPaths({ home, environment: {} })).toEqual({
    settings: join(home, ".config", "magpie", "settings.json"),
    rate: join(home, ".cache", "magpie", "fxrate.json"),
  });
  const environment = {
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cached"),
  };
  expect(magpieDisplayPaths({ home, environment }).rate).toBe(
    join(home, "cached", "magpie", "fxrate.json"),
  );
  expect(
    magpieDisplayPaths({
      home,
      environment,
      directory: join(home, "portable", "data"),
    }).rate,
  ).toBe(join(home, "portable", "data", "cache", "fxrate.json"));
  expect(
    magpieDisplayPaths({
      home,
      environment: { XDG_CONFIG_HOME: "relative", XDG_CACHE_HOME: "relative" },
    }).settings,
  ).toBe(join(home, ".config", "magpie", "settings.json"));
});

test("host display reads only allowed fields and survives missing, corrupt, stale and updated files", async () => {
  const root = mkdtempSync(join(tmpdir(), "magpie-display-"));
  const clock = { now: () => Date.parse("2026-11-12T06:00:00Z") };
  const paths = magpieDisplayPaths({ directory: root });
  const source = new MagpieDisplaySource({ directory: root, clock });
  try {
    const missing = await source.load();
    expect(missing.source).toBe("fallback");
    expect(missing.effective).toEqual({
      currency: "USD",
      chineseUnits: false,
      usdCny: 7.2,
    });
    mkdirSync(join(root, "cache"));
    const original = JSON.stringify({
      currency: "cny",
      chineseUnits: true,
      secret: "must-not-leak",
      account: "private",
    });
    writeFileSync(paths.settings, original);
    writeFileSync(
      paths.rate,
      JSON.stringify({ rate: 7.4, at: "2026-11-12T05:00:00Z" }),
    );
    const first = await source.load();
    expect(first.effective).toEqual({
      currency: "CNY",
      chineseUnits: true,
      usdCny: 7.4,
    });
    expect(first.rate.stale).toBe(false);
    expect(JSON.stringify(first)).not.toContain("must-not-leak");
    expect(JSON.stringify(first)).not.toContain(root);
    expect(readFileSync(paths.settings, "utf8")).toBe(original);
    writeFileSync(paths.settings, "broken");
    writeFileSync(paths.rate, '{"rate":0}');
    const corrupt = await source.load();
    expect(corrupt.effective).toEqual(first.effective);
    expect(corrupt.stale).toBe(true);
    writeFileSync(
      paths.settings,
      JSON.stringify({ currency: "usd", chineseUnits: false }),
    );
    writeFileSync(
      paths.rate,
      JSON.stringify({ rate: 7.6, at: "2026-11-10T05:00:00Z" }),
    );
    const updated = await source.load();
    expect(updated.effective.currency).toBe("USD");
    expect(updated.effective.usdCny).toBe(7.6);
    expect(updated.rate.stale).toBe(true);
    expect(updated.warnings.some((w) => w.code === "magpie_rate_stale")).toBe(
      true,
    );
    writeFileSync(paths.settings, '{"currency":""}');
    const defaults = await source.load();
    expect(defaults.effective.currency).toBe("USD");
    expect(defaults.source).toBe("magpie");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saved display modes survive restart without host refresh revising settings or old subscriptions", async () => {
  const root = mkdtempSync(join(tmpdir(), "magpie-display-persist-"));
  const f = makeFixture();
  const host = {
    effective: { currency: "CNY", usdCny: 7.35, chineseUnits: true },
    source: "magpie",
    stale: false,
    rate: { source: "magpie-cache", at: "2026-11-12T05:00:00Z", stale: false },
    warnings: [],
  };
  let app;
  try {
    app = createApplication({
      stateDir: root,
      start: false,
      source: f.source,
      displaySource: { load: async () => structuredClone(host) },
    });
    expect((await app.display()).effective.currency).toBe("CNY");
    const saved = app.saveSettings({
      displayMode: "custom",
      currency: "USD",
      usdCny: 8,
      chineseUnits: false,
    });
    expect((await app.display()).effective.currency).toBe("USD");
    const follow = app.saveSettings({
      revision: saved.revision,
      displayMode: "magpie",
    });
    await app.stop();
    app.repository.close();
    app = null;
    app = createApplication({
      stateDir: root,
      start: false,
      source: f.source,
      displaySource: { load: async () => structuredClone(host) },
    });
    expect(app.settings().displayMode).toBe("magpie");
    host.effective.usdCny = 7.8;
    expect((await app.display()).effective.usdCny).toBe(7.8);
    expect(app.settings().revision).toBe(follow.revision);
    app.saveSettings({ revision: follow.revision, displayMode: "custom" });
    expect((await app.display()).effective.usdCny).toBe(8);
  } finally {
    await app?.stop();
    app?.repository.close();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
