import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { accountKey, stats, sum } from "../lib/domain/stats.mjs";
import { fixtureRows, makeFixture } from "../test/helpers.mjs";

const node = (view, mode, provider, group) => {
  const key = JSON.stringify(
    group === undefined ? [mode, provider] : [mode, provider, group],
  );
  return view.locator(`.usage-tree tr[data-tree-key=${JSON.stringify(key)}]`);
};
const usageResponse = (page) =>
  page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith("/api/v1/usage") && r.ok(),
  );

// Run the same interactions in a normal page and both Magpie sandbox paths.
// Each caller installs Playwright's clock before navigating.
export async function checkEnhanced(page, view) {
  const results = view.locator("#usage-results");
  await results.locator(".provider-row").first().waitFor();
  assert.equal(
    await results.locator(".leaf-row:visible").count(),
    0,
    "initial account view must hide model rows",
  );
  const provider = node(view, "account", "p1");
  const account = node(view, "account", "p1", accountKey("p1", "alice"));
  const toggle = account.locator("[data-tree-toggle]");
  await expect(provider.locator("[data-tree-toggle]")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  assert.equal(
    await results
      .locator(".group-row")
      .filter({ hasText: "无调用账号" })
      .locator("button")
      .count(),
    0,
  );
  const totals = await results.locator(".stats-strip").innerText();
  const requests = [];
  const onRequest = (r) => {
    if (new URL(r.url()).pathname.endsWith("/api/v1/usage"))
      requests.push(r.url());
  };
  page.on("request", onRequest);
  try {
    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(results.locator(".leaf-row:visible")).toHaveCount(2);
    await toggle.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await provider.locator("[data-tree-toggle]").click();
    await expect(account).toBeHidden();
    await expect(results.locator(".leaf-row:visible")).toHaveCount(0);
    await provider.locator("[data-tree-toggle]").click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(results.locator(".leaf-row:visible")).toHaveCount(2);
    await view.getByRole("button", { name: "全部收起", exact: true }).click();
    await expect(results.locator(".group-row:visible")).toHaveCount(0);
    await view.getByRole("button", { name: "全部展开", exact: true }).click();
    await expect(results.locator(".leaf-row:visible")).toHaveCount(4);
    await view.getByRole("button", { name: "展开到账号", exact: true }).click();
    await expect(results.locator(".leaf-row:visible")).toHaveCount(0);
    await toggle.click();
    assert.equal(await results.locator(".stats-strip").innerText(), totals);
    assert.equal(requests.length, 0, "folding must not fetch usage");
  } finally {
    page.off("request", onRequest);
  }
  await view.getByRole("button", { name: "按模型", exact: true }).click();
  const model = node(view, "model", "p1", "shared-model");
  await expect(model).toBeVisible();
  await expect(model.locator("[data-tree-toggle]")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await view.getByRole("button", { name: "全部展开", exact: true }).click();
  await expect(results.locator(".leaf-row:visible")).toHaveCount(4);
  await view.getByRole("button", { name: "展开到模型", exact: true }).click();
  await expect(results.locator(".leaf-row:visible")).toHaveCount(0);
  await model.locator("[data-tree-toggle]").click();
  await expect(results.locator(".leaf-row:visible")).toHaveCount(2);
  await expect(
    results.locator(".leaf-row:visible .usage-token-share").first(),
  ).toHaveAttribute("aria-label", /^占模型 /);
  await expect(
    node(view, "model", "p2", "shared-model").locator("[data-tree-toggle]"),
  ).toHaveAttribute("aria-expanded", "false");
  await view.getByRole("button", { name: "按账号", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await view.getByRole("button", { name: "订阅", exact: true }).click();
  await view.getByRole("button", { name: "用量", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await view.getByRole("tab", { name: "原版用量树", exact: true }).click();
  await view.locator(".original-provider").first().waitFor();
  await view.getByRole("tab", { name: "增强视图", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.focus();
  const refreshed = usageResponse(page);
  await page.clock.runFor(31000);
  await refreshed;
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toBeFocused();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(provider.locator("[data-tree-toggle]")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
}

export async function checkEnhancedData(browser) {
  const rows = fixtureRows();
  rows[3].accountName = rows[0].accountName;
  rows.push({ ...rows[0], model: "tiny-model", ...stats({ input: 1 }) });
  const longName =
    "很长的账号名称".repeat(12) + '<img src=x onerror="alert(1)">';
  rows.push({
    ...rows[0],
    provider: "p3",
    providerName: "零 Token 供应商",
    accountName: longName,
    model: "zero-model",
    ...stats({ calls: 1 }),
  });
  const f = makeFixture({ rows });
  const load = f.source.load.bind(f.source);
  f.source.load = async (q) => {
    const data = await load(q);
    data.rows = data.rows.map((r) => ({
      ...r,
      ...sum([r], q.includeCache !== false),
    }));
    data.options.providers = [
      ...new Map(
        rows.map((r) => [
          r.provider,
          { id: r.provider, label: r.providerName },
        ]),
      ).values(),
    ];
    return data;
  };
  const quotas = f.source.quotas.bind(f.source);
  f.source.quotas = async () => {
    const data = await quotas();
    data.cards.push({
      provider: "p0",
      providerName: "无调用供应商",
      account: "empty",
      accountName: "无调用账号",
      windows: [],
      readAt: null,
    });
    return data;
  };
  const service = await startServer({ port: 0, app: f.app });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${service.port}`);
    const provider = node(page, "account", "p1");
    const account = node(page, "account", "p1", accountKey("p1", "alice"));
    const providerCount = page.locator(
      ".stats-strip .stat:last-child .stat-value",
    );
    await page.locator("#usage-results .provider-row").first().waitFor();
    await expect(providerCount).toHaveText("4");
    assert.equal(
      await page.locator(".leaf-row:visible").count(),
      0,
      "initial account view must hide model rows",
    );
    const share = async (row, text, percentage) => {
      await expect(row.locator(".usage-token-share")).toHaveText(
        text.split(" ").at(-1),
      );
      await expect(row.locator(".usage-token-share")).toHaveAttribute(
        "aria-label",
        text,
      );
      const width = await row
        .locator(".usage-token-bar > span")
        .evaluate((el) => parseFloat(el.style.width));
      assert.ok(
        Math.abs(width - percentage) < 0.0001,
        `${width} != ${percentage}`,
      );
    };
    await share(provider, "占当前范围 76.4%", (1876 / 2456) * 100);
    await share(account, "占供应商 70.7%", (1326 / 1876) * 100);
    await page.getByRole("button", { name: "全部展开", exact: true }).click();
    const leaves = page.locator(".usage-tree .leaf-row");
    await share(
      leaves.filter({ hasText: "tiny-model" }),
      "占账号 <0.1%",
      (1 / 1326) * 100,
    );
    await share(leaves.filter({ hasText: "zero-model" }), "占账号 —", 0);
    assert.equal(await leaves.locator("button").count(), 0);
    await share(
      node(page, "account", "p1", accountKey("p1", "empty")),
      "占供应商 0.0%",
      0,
    );
    await share(
      node(page, "account", "p0", accountKey("p0", "empty")),
      "占供应商 —",
      0,
    );
    const longRow = node(page, "account", "p3", accountKey("p3", "alice"));
    await expect(longRow.locator(".name")).toHaveText(longName);
    assert.equal(await longRow.locator("img").count(), 0);
    await account.locator("[data-tree-toggle]").click();
    await expect(
      node(page, "account", "p2", accountKey("p2", "alice")).locator(
        "[data-tree-toggle]",
      ),
    ).toHaveAttribute("aria-expanded", "true");
    await account.locator("[data-tree-toggle]").click();

    const refresh = async (action) => {
      const response = usageResponse(page);
      await action();
      await response;
    };
    await refresh(() => page.locator("#cache-toggle").uncheck());
    await share(provider, "占当前范围 74.3%", (1676 / 2256) * 100);
    await share(account, "占供应商 67.2%", (1126 / 1676) * 100);
    for (const sort of ["costUsd", "calls", "name"]) {
      await refresh(() => page.locator("#sort").selectOption(sort));
      await share(provider, "占当前范围 74.3%", (1676 / 2256) * 100);
      await expect(account.locator("[data-tree-toggle]")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    }
    await refresh(() => page.locator("#period").selectOption("this-week"));
    await expect(account.locator("[data-tree-toggle]")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.locator("#usage-filters > summary").click();
    const providers = page.locator('[data-filter="providers"]');
    const apply = () =>
      page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await providers.selectOption("p2");
    await refresh(apply);
    await expect(provider).toHaveCount(0);
    await expect(providerCount).toHaveText("4");
    await page.getByRole("button", { name: "全部收起", exact: true }).click();
    await providers.selectOption([]);
    await refresh(apply);
    await expect(account.locator("[data-tree-toggle]")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(
      node(page, "account", "p2").locator("[data-tree-toggle]"),
    ).toHaveAttribute("aria-expanded", "false");
    await providers.selectOption("p0");
    await refresh(apply);
    await share(node(page, "account", "p0"), "占当前范围 —", 0);
    await expect(providerCount).toHaveText("4");
    await providers.selectOption([]);
    await refresh(apply);
    await page.locator('[data-column="tokens"]').uncheck();
    await refresh(apply);
    await expect(page.locator(".usage-tokens")).toHaveCount(0);
    await page.locator('[data-column="tokens"]').check();
    await refresh(apply);
    await share(provider, "占当前范围 74.3%", (1676 / 2256) * 100);

    await page.getByRole("button", { name: "全部收起", exact: true }).click();
    rows.push({ ...rows[0], provider: "p4", providerName: "新增供应商" });
    await refresh(() => page.locator("#refresh").click());
    await expect(providerCount).toHaveText("5");
    await expect(
      node(page, "account", "p4").locator("[data-tree-toggle]"),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      node(page, "account", "p4", accountKey("p4", "alice")).locator(
        "[data-tree-toggle]",
      ),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(provider.locator("[data-tree-toggle]")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await page.getByRole("button", { name: "全部展开", exact: true }).click();
    f.app.saveSettings({
      ...f.app.settings(),
      displayMode: "custom",
      currency: "CNY",
      usdCny: 8,
      chineseUnits: true,
    });
    const updated = page.waitForResponse((r) =>
      r.url().endsWith("/api/v1/display"),
    );
    await page.clock.runFor(31000);
    await updated;
    await expect(page.locator(".stats-strip")).toContainText("¥");
    await expect(account.locator("[data-tree-toggle]")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.locator("#usage-filters > summary").click();
    await page.getByRole("button", { name: "展开到账号", exact: true }).click();
    await account.locator("[data-tree-toggle]").click();
    mkdirSync("outputs", { recursive: true });
    await page.screenshot({
      path: "outputs/enhanced-desktop.png",
      fullPage: true,
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(provider.locator("[data-tree-toggle]")).toHaveCSS(
      "color",
      await provider.evaluate((el) => getComputedStyle(el).color),
    );
    await page.screenshot({
      path: "outputs/enhanced-dark.png",
      fullPage: true,
    });
    await account.locator("[data-tree-toggle]").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "outputs/enhanced-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
    );
    await account.locator("[data-tree-toggle]").click();
    await expect(account.locator("[data-tree-toggle]")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await service.close();
    f.repo.close();
  }
}

if (import.meta.main) {
  const browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  try {
    await checkEnhancedData(browser);
    console.log("Enhanced hierarchy and Token share checks passed");
  } finally {
    await browser.close();
  }
}
