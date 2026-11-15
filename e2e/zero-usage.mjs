import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { stats } from "../lib/domain/stats.mjs";
import { fixtureRows, makeFixture } from "../test/helpers.mjs";

export async function checkZeroUsage(browser) {
  const rows = fixtureRows();
  rows.push({ ...rows[0], model: "unused-model", ...stats() });
  for (const [provider, usage] of [
    ["unused-provider", {}],
    ["cache-only", { cacheRead: 45 }],
    ["calls-only", { calls: 1 }],
    ["cost-only", { costUsd: 0.01 }],
    ["free-model", { input: 100 }],
    ["credits-only", { credits: 2 }],
  ])
    rows.push({
      ...rows[0],
      provider,
      providerName: provider,
      model: provider,
      ...stats(usage),
    });
  const f = makeFixture({ rows });
  const load = f.source.load.bind(f.source);
  f.source.load = async (query) => {
    const data = await load(query);
    data.options.providers = [
      ...new Map(
        rows.map((row) => [
          row.provider,
          { id: row.provider, label: row.providerName },
        ]),
      ).values(),
    ];
    return data;
  };
  const quotas = f.source.quotas.bind(f.source);
  f.source.quotas = async () => {
    const data = await quotas();
    data.cards.push({
      provider: "quota-only-provider",
      providerName: "quota-only-provider",
      account: "empty",
      accountName: "无调用账号",
      windows: [],
      readAt: null,
    });
    return data;
  };
  const service = await startServer({ port: 0, app: f.app });
  const base = `http://127.0.0.1:${service.port}`;
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        `<iframe title="Magpie plugin" sandbox="allow-scripts" src="${base}" style="width:100%;height:950px;border:0"></iframe>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      ),
  });
  try {
    for (const sandbox of [false, true]) {
      f.app.saveSettings({
        showZeroUsage: true,
        preferences: {
          columns: ["calls", "errors", "tokens", "costUsd"],
          grouping: "account",
          period: "today",
          sort: "tokens",
        },
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(sandbox ? `http://127.0.0.1:${host.port}` : base);
        const view = sandbox ? page.frameLocator("iframe") : page;
        const checkbox = () =>
          view.getByRole("checkbox", {
            name: "显示 0 用量模型和供应商",
            exact: true,
          });
        const enhancedProviders = view.locator(".usage-tree .provider-row");
        const unusedProvider = enhancedProviders.filter({
          hasText: "unused-provider",
        });
        const unusedModels = view.locator(".leaf-row").filter({
          hasText: "unused-model",
        });
        const providerCount = view.locator(
          ".stats-strip .stat:last-child .stat-value",
        );
        await expect(unusedProvider).toHaveCount(1);
        await expect(checkbox()).toBeChecked();
        await expect(providerCount).toHaveText("9");
        await view
          .getByRole("button", { name: "全部展开", exact: true })
          .click();
        await expect(unusedModels).toBeVisible();
        const totals = await view
          .locator(".stats-strip .stat")
          .allTextContents();
        await checkbox().uncheck();
        await expect(unusedModels).toHaveCount(0);
        await expect(unusedProvider).toHaveCount(0);
        await expect(
          enhancedProviders.filter({ hasText: "quota-only-provider" }),
        ).toHaveCount(0);
        await expect(
          view.locator(".group-row").filter({ hasText: "无调用账号" }),
        ).toHaveCount(1);
        assert.deepEqual(
          await view.locator(".stats-strip .stat").allTextContents(),
          totals,
        );
        for (const provider of [
          "cache-only",
          "calls-only",
          "cost-only",
          "free-model",
          "credits-only",
        ])
          await expect(
            enhancedProviders.filter({ hasText: provider }),
          ).toHaveCount(1);
        await view.locator("#cache-toggle").uncheck();
        await expect(
          enhancedProviders.filter({ hasText: "cache-only" }),
        ).toContainText("0.0%");
        if (!sandbox) {
          mkdirSync("outputs", { recursive: true });
          await page.screenshot({
            path: "outputs/zero-usage-desktop.png",
            fullPage: true,
          });
        }
        await view.getByRole("button", { name: "按模型", exact: true }).click();
        await expect(
          view.locator(".group-row").filter({ hasText: "unused-model" }),
        ).toHaveCount(0);
        await expect(unusedProvider).toHaveCount(0);
        await expect(providerCount).toHaveText("9");
        await checkbox().check();
        await expect(
          view.locator(".group-row").filter({ hasText: "unused-model" }),
        ).toHaveCount(1);
        await expect(unusedProvider).toHaveCount(1);
        await expect(providerCount).toHaveText("9");
        await checkbox().uncheck();
        await expect(providerCount).toHaveText("9");
        await view.getByRole("button", { name: "按账号", exact: true }).click();
        await expect(
          view.getByRole("heading", { name: /供应商 → 账号 → 模型/ }),
        ).toBeVisible();
        await expect(providerCount).toHaveText("9");
        await view.locator("#zero-toggle").uncheck();
        await expect(
          view.locator(".group-row").filter({ hasText: "无调用账号" }),
        ).toHaveCount(0);
        await expect(providerCount).toHaveText("9");

        await expect(checkbox()).not.toBeChecked();
        await view.locator("#usage-filters > summary").click();
        await view
          .getByRole("button", { name: "保存为默认显示", exact: true })
          .click();
        await expect(view.locator("#toast")).toHaveText("默认显示已保存");
        assert.equal(f.app.settings().showZeroUsage, false);
        await page.reload();
        await expect(checkbox()).not.toBeChecked();
        await expect(unusedProvider).toHaveCount(0);
        await expect(enhancedProviders).toHaveCount(7);
        await view.getByRole("button", { name: "设置", exact: true }).click();
        await view.getByLabel("默认显示 0 用量模型和供应商").check();
        await view
          .getByRole("button", { name: "保存设置", exact: true })
          .click();
        await expect(view.locator("#toast")).toHaveText("设置已保存");
        assert.equal(f.app.settings().showZeroUsage, true);
        assert.equal(f.app.settings().includeCache, true);
        assert.equal(f.app.settings().showZeroAccounts, true);
        await view.getByRole("button", { name: "用量", exact: true }).click();
        await expect(checkbox()).toBeChecked();
        await expect(unusedProvider).toHaveCount(1);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    }
  } finally {
    host.stop(true);
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
    await checkZeroUsage(browser);
    console.log("Zero-usage display, sandbox and saved-default checks passed");
  } finally {
    await browser.close();
  }
}
