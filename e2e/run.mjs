import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { startServer } from "../lib/server.mjs";
import { notificationAdapters } from "../lib/channels/index.mjs";
import { makeFixture, settled } from "../test/helpers.mjs";
import { checkSandbox } from "./sandbox.mjs";
import { checkUntrustedSandbox, checkReconnect } from "./security.mjs";
import { checkOriginal } from "./original.mjs";
import { deliveryCases, checkDeliveryDetails } from "./deliveries.mjs";
const f = makeFixture({ adapters: notificationAdapters() }),
  deliveries = deliveryCases(f),
  service = await startServer({ port: 0, app: f.app });
const base = "http://127.0.0.1:" + service.port,
  received = [];
const receiver = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    received.push(await request.json());
    return new Response(null, { status: 204 });
  },
});
const errors = [];
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  await checkUntrustedSandbox(browser, base);
  await checkSandbox(browser, base, deliveries);
  await checkReconnect(browser, base);
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("heading", { name: "当前账号额度与余额" }).waitFor();
  await checkOriginal(page, page);
  await page.getByRole("button", { name: "按模型", exact: true }).click();
  await page.getByRole("heading", { name: /供应商 → 模型 → 账号/ }).waitFor();
  mkdirSync("outputs", { recursive: true });
  await page.screenshot({ path: "outputs/usage-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "订阅", exact: true }).click();
  await page.getByRole("button", { name: "新建订阅", exact: true }).click();
  await page
    .locator('#subscription-form input[name="name"]')
    .fill("浏览器综合日报");
  await page
    .locator('#subscription-form select[name="primary"]')
    .selectOption(f.p.id);
  await page
    .locator('#subscription-form select[name="blockPeriod"]')
    .first()
    .selectOption("this-week");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.locator("#preview[open] .preview-text").waitFor();
  assert.match(
    await page.locator("#preview-content").innerText(),
    /浏览器综合日报/,
  );
  assert.equal(f.calls.length, 0);
  await page.locator('#preview .dialog-footer [data-close="preview"]').click();
  await page.getByRole("button", { name: "保存订阅", exact: true }).click();
  await page
    .getByRole("strong")
    .filter({ hasText: "浏览器综合日报" })
    .waitFor();
  await page.reload();
  await page.getByRole("button", { name: "订阅", exact: true }).click();
  await page
    .getByRole("strong")
    .filter({ hasText: "浏览器综合日报" })
    .waitFor();
  await page.getByRole("button", { name: "通知渠道", exact: true }).click();
  await page.getByRole("button", { name: "添加渠道", exact: true }).click();
  await page
    .locator('#channel-form select[name="type"]')
    .selectOption("webhook");
  await page
    .locator('#channel-form input[name="name"]')
    .fill("本地 Webhook 验证");
  await page
    .locator('#channel-form input[name="config.url"]')
    .fill("http://127.0.0.1:" + receiver.port);
  await page.getByRole("button", { name: "保存渠道", exact: true }).click();
  const card = page
    .locator(".list-card")
    .filter({ hasText: "本地 Webhook 验证" });
  await card.waitFor();
  await card.getByRole("button", { name: "发送测试", exact: true }).click();
  await page.locator("#confirm-yes").click();
  await settled(f.app);
  assert.equal(received.length, 1);
  assert.match(received[0].text, /连接测试/);
  await checkDeliveryDetails(page, deliveries);
  await page.getByRole("button", { name: "用量", exact: true }).click();
  await page.getByRole("heading", { name: "当前账号额度与余额" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "outputs/usage-mobile.png", fullPage: true });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    true,
  );
  // A saved subscription continues to execute after its page has closed.
  const saved = f.repo
    .list("subscriptions")
    .find((s) => s.name === "浏览器综合日报");
  f.app.saveSubscription(
    { ...saved, enabled: true, schedule: { type: "interval", minutes: 1 } },
    saved.id,
  );
  await page.close();
  f.advance(60000);
  await f.app.tick();
  assert.ok(
    f.repo
      .jobs()
      .some((j) => j.subscriptionId === saved.id && j.status === "sent"),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      scenarios: [
        "Magpie sandbox with direct and proxied service URLs",
        "external opaque origins cannot read tokens",
        "integrated original view and legacy redirects",
        "expired sessions reconnect once and preserve unsaved edits",
        "sandbox saves for all four channels, subscriptions and settings",
        "form validation, Enter key, credential retention and reload",
        "account/model views",
        "subscription preview/save/reload",
        "webhook channel test",
        "failed, sent and partial delivery details with per-channel confirmations",
        "mobile layout",
        "closed-page scheduling",
      ],
      screenshots: ["outputs/usage-desktop.png", "outputs/usage-mobile.png"],
    }),
  );
} finally {
  await browser?.close();
  receiver.stop(true);
  await service.close();
  f.repo.close();
}
