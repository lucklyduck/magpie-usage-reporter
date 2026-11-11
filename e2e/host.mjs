import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../lib/server.mjs";
import { MagpieDisplaySource } from "../lib/adapters/magpie-display.mjs";
import { makeFixture, fixtureRows } from "../test/helpers.mjs";
import { stats } from "../lib/domain/stats.mjs";

export async function checkHostIntegration(browser) {
  const root = mkdtempSync(join(tmpdir(), "magpie-host-display-"));
  const rows = fixtureRows();
  rows[0] = {
    ...rows[0],
    ...stats({
      calls: 3,
      input: 12000,
      output: 100,
      cacheRead: 200,
      costUsd: 0.2,
    }),
  };
  const f = makeFixture({ rows });
  f.app.saveSubscription({
    ...f.spec,
    enabled: true,
    schedule: { type: "interval", minutes: 1 },
  });
  await f.app.tick();
  mkdirSync(join(root, "cache"));
  const hostSettings = (currency = "cny", chineseUnits = true) =>
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ currency, chineseUnits, secret: "host-private" }),
    );
  hostSettings();
  writeFileSync(
    join(root, "cache", "fxrate.json"),
    JSON.stringify({ rate: 7.4, at: new Date().toISOString() }),
  );
  f.app.displaySource = new MagpieDisplaySource({ directory: root });
  const service = await startServer({ port: 0, app: f.app });
  const base = `http://127.0.0.1:${service.port}`;
  const prefix = "/_magpie/plugin/fixture/_magpie/service/";
  const serveHost = async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith(prefix)) {
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("cookie");
      const response = await fetch(
        new URL(url.pathname.slice(prefix.length) + url.search, base + "/"),
        {
          method: request.method,
          headers,
          redirect: "manual",
          body: ["GET", "HEAD"].includes(request.method)
            ? undefined
            : request.body,
        },
      );
      const outgoing = new Headers(response.headers);
      const policy = outgoing.get("content-security-policy");
      if (policy)
        outgoing.set(
          "content-security-policy",
          policy.replaceAll("'self'", "'self' " + url.origin + prefix),
        );
      outgoing.append(
        "content-security-policy",
        "sandbox allow-scripts; frame-ancestors 'self'",
      );
      return new Response(response.body, {
        status: response.status,
        headers: outgoing,
      });
    }
    const src = url.pathname.startsWith("/direct") ? base + "/" : prefix;
    return new Response(
      `<!doctype html><style>body{margin:0}iframe{border:0;width:100vw;height:100vh}</style>
      <script>
      window.messages=[];
      window.hostTheme={dark:true,lang:'en',tokens:{bg:'#101820',fg:'#eeeeee',accent:'#abcdef',font:'"Segoe UI", sans-serif'}};
      window.sendHost=(event,data)=>document.querySelector('iframe').contentWindow.postMessage({magpie:1,event,data},'*');
      addEventListener('message', e=>{
        if(e.source!==document.querySelector('iframe').contentWindow||e.data?.magpie!==1)return;
        messages.push(e.data);
        if(e.data.method==='hello'&&!location.pathname.includes('silent'))e.source.postMessage({magpie:1,id:e.data.id,result:{...hostTheme,visible:true}},'*');
      });</script><iframe title="Magpie plugin" sandbox="allow-scripts" src="${src}"></iframe>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: serveHost });
  const https = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: serveHost,
    tls: {
      key: readFileSync("test/fixtures/smtp-key.pem"),
      cert: readFileSync("test/fixtures/smtp-cert.pem"),
    },
  });
  try {
    for (const mode of ["direct", "proxy", "https"]) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();
      const requests = [];
      page.on("request", (r) => {
        if (r.url().includes("/api/v1/"))
          requests.push(
            new URL(r.url()).pathname.split("/api/v1/")[1].split("?")[0],
          );
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.clock.install();
        await page.goto(
          mode === "https"
            ? `https://127.0.0.1:${https.port}/proxy`
            : `http://127.0.0.1:${http.port}/${mode}`,
        );
        const view = page.frameLocator("iframe");
        await view
          .getByRole("heading", { name: "当前账号额度与余额" })
          .waitFor();
        await view
          .locator('html[data-theme="dark"]')
          .waitFor({ timeout: 3000 });
        assert.equal(await view.locator("html").getAttribute("lang"), "zh-CN");
        assert.equal(
          await view
            .locator("html")
            .evaluate((el) =>
              getComputedStyle(el).getPropertyValue("--bg").trim(),
            ),
          "#101820",
        );
        assert.match(await view.locator("#usage-results").innerText(), /¥/);
        assert.match(await view.locator("#usage-results").innerText(), /万/);
        await view
          .getByRole("tab", { name: "原版用量树", exact: true })
          .click();
        await view.locator(".original-provider").first().waitFor();
        assert.match(await view.locator(".original-tiles").innerText(), /¥/);
        assert.match(await view.locator(".original-tiles").innerText(), /万/);
        await view.getByRole("button", { name: "设置", exact: true }).click();
        const form = view.locator("#settings-form");
        assert.equal(
          await form.locator('[name="displayMode"]').inputValue(),
          "magpie",
        );
        assert.equal(
          await form.locator('[name="currency"]').isDisabled(),
          true,
        );
        assert.equal(
          await form.locator('[name="currency"]').inputValue(),
          "CNY",
        );
        await form.locator('[name="displayMode"]').selectOption("custom");
        await form.locator('[name="currency"]').selectOption("USD");
        await form.locator('[name="usdCny"]').fill("8");
        await form.locator('[name="chineseUnits"]').uncheck();
        await page.evaluate(() =>
          sendHost("theme", {
            dark: false,
            lang: "ja",
            tokens: { bg: "#f0f1f2" },
          }),
        );
        await view.locator('html[data-theme="light"]').waitFor();
        assert.equal(await form.locator('[name="usdCny"]').inputValue(), "8");
        assert.equal(await view.locator("html").getAttribute("lang"), "zh-CN");
        await form
          .getByRole("button", { name: "保存设置", exact: true })
          .click();
        await view.getByText("设置已保存", { exact: true }).waitFor();
        await form.locator('[name="usdCny"]').fill("9.5");
        const refreshed = page.waitForResponse((r) =>
          r.url().endsWith("/api/v1/display"),
        );
        await page.clock.runFor(31000);
        await refreshed;
        assert.equal(
          await form.locator('[name="usdCny"]').inputValue(),
          "9.5",
          "polling preserves unsaved custom values",
        );
        await form.locator('[name="usdCny"]').fill("8");
        await form.locator('[name="displayMode"]').selectOption("magpie");
        assert.equal(
          await form.locator('[name="currency"]').inputValue(),
          "CNY",
        );
        await form.locator('[name="displayMode"]').selectOption("custom");
        assert.equal(await form.locator('[name="usdCny"]').inputValue(), "8");
        await form.locator('[name="displayMode"]').selectOption("magpie");
        const savedResponse = page.waitForResponse(
          (r) =>
            r.url().endsWith("/api/v1/settings") &&
            r.request().method() === "PATCH",
        );
        await form
          .getByRole("button", { name: "保存设置", exact: true })
          .click();
        assert.equal((await savedResponse).status(), 200);
        await form.locator('button[type="submit"]:not(:disabled)').waitFor();
        await form.locator('[name="timezone"]').fill("Asia/Tokyo");
        const beforeHide = requests.length;
        await page.evaluate(() => {
          sendHost("visibility", { visible: false });
          document.querySelector("iframe").style.display = "none";
        });
        await page.clock.runFor(65000);
        assert.equal(
          requests.length,
          beforeHide,
          "hidden plugin must stop frontend polling",
        );
        const callsBefore = f.calls.length;
        f.advance(60000);
        await f.app.tick();
        assert.equal(
          f.calls.length,
          callsBefore + 1,
          "host-hidden page must not stop backend scheduling",
        );
        hostSettings("usd", false);
        await page.evaluate(() => {
          document.querySelector("iframe").style.display = "";
          sendHost("visibility", { visible: true });
        });
        await view
          .locator("#display-effective")
          .filter({ hasText: "USD" })
          .waitFor();
        assert.equal(
          await form.locator('[name="timezone"]').inputValue(),
          "Asia/Tokyo",
        );
        assert.equal(
          requests.slice(beforeHide).filter((x) => x === "status").length,
          1,
        );
        assert.equal(
          requests.slice(beforeHide).filter((x) => x === "display").length,
          1,
        );
        const frame = page.frames().find((f) => f !== page.mainFrame());
        const beforeDocumentHide = requests.length;
        await frame.evaluate(() => {
          Object.defineProperty(document, "hidden", {
            configurable: true,
            get: () => true,
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await page.clock.runFor(65000);
        assert.equal(
          requests.length,
          beforeDocumentHide,
          "document-hidden event also stops polling",
        );
        const afterDocumentShow = page.waitForResponse((r) =>
          r.url().endsWith("/api/v1/display"),
        );
        await frame.evaluate(() => {
          delete document.hidden;
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await afterDocumentShow;
        await view
          .locator("#display-effective")
          .filter({ hasText: "USD" })
          .waitFor();
        assert.equal(
          requests.slice(beforeHide).filter((x) => x === "display").length,
          2,
        );
        hostSettings();
        await view.getByRole("button", { name: "订阅", exact: true }).click();
        await view
          .getByRole("button", { name: "新建订阅", exact: true })
          .click();
        assert.equal(
          await view
            .locator('#subscription-form [name="currency"]')
            .inputValue(),
          "CNY",
        );
        assert.equal(
          await view.locator('#subscription-form [name="usdCny"]').inputValue(),
          "7.4",
        );
        assert.equal(
          await view
            .locator('#subscription-form [name="chineseUnits"]')
            .inputValue(),
          "chinese",
        );
        await page.evaluate(() =>
          sendHost("theme", {
            dark: "invalid",
            tokens: { bg: "url(https://evil.test)" },
          }),
        );
        assert.equal(
          await view.locator("html").getAttribute("data-theme"),
          "light",
        );
        await frame.evaluate(() =>
          window.postMessage(
            { magpie: 1, event: "theme", data: { dark: true } },
            "*",
          ),
        );
        assert.equal(
          await view.locator("html").getAttribute("data-theme"),
          "light",
        );
        assert.deepEqual(errors, []);
        const messages = await page.evaluate(() => messages);
        assert.ok(messages.some((m) => m.method === "hello"));
        assert.ok(!JSON.stringify(messages).includes("usage-token"));
        await frame.evaluate(() => {
          window.dispatchEvent(
            new ErrorEvent("error", {
              message:
                "ResizeObserver loop completed with undelivered notifications",
            }),
          );
          window.dispatchEvent(
            new PromiseRejectionEvent("unhandledrejection", {
              promise: Promise.resolve(),
              reason: new DOMException("private-draft", "AbortError"),
            }),
          );
        });
        assert.equal(
          (await page.evaluate(() => messages)).filter(
            (m) => m.method === "error",
          ).length,
          0,
        );
        await frame.evaluate(() =>
          window.dispatchEvent(
            new ErrorEvent("error", {
              message: "private-draft https://private.invalid/?key=secret",
            }),
          ),
        );
        await page.waitForFunction(() =>
          messages.some((m) => m.method === "error"),
        );
        assert.ok(
          !JSON.stringify(await page.evaluate(() => messages)).includes(
            "private-draft",
          ),
        );
      } finally {
        await context.close();
      }
    }
    const context = await browser.newContext({ colorScheme: "dark" });
    try {
      const page = await context.newPage();
      await page.goto(base);
      await page.getByRole("heading", { name: "当前账号额度与余额" }).waitFor();
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "dark",
      );
      await page.clock.install();
      await page.goto(`http://127.0.0.1:${http.port}/direct-silent`);
      await page.clock.runFor(2100);
      await page
        .frameLocator("iframe")
        .getByRole("heading", { name: "当前账号额度与余额" })
        .waitFor();
      const pending = await context.newPage();
      await pending.goto(base);
      await pending
        .getByRole("heading", { name: "当前账号额度与余额" })
        .waitFor();
      let releaseRead, readStarted;
      const heldRead = new Promise((resolve) => {
        releaseRead = resolve;
      });
      const reading = new Promise((resolve) => {
        readStarted = resolve;
      });
      const originalLoad = f.source.load;
      f.source.load = async (query) => {
        readStarted();
        await heldRead;
        return originalLoad(query);
      };
      const cancelled = pending.waitForEvent(
        "requestfailed",
        (r) => new URL(r.url()).pathname === "/api/v1/usage",
      );
      await pending.locator("#refresh").click();
      await reading;
      await pending.evaluate(() => {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await cancelled;
      releaseRead();
      f.source.load = originalLoad;
      const shown = pending.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/v1/usage",
      );
      await pending.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await shown;
      await pending.getByRole("button", { name: "设置", exact: true }).click();
      let releaseWrite, writeStarted;
      const heldWrite = new Promise((resolve) => {
        releaseWrite = resolve;
      });
      const writing = new Promise((resolve) => {
        writeStarted = resolve;
      });
      await pending.route("**/api/v1/settings", async (route) => {
        if (route.request().method() === "PATCH") {
          writeStarted();
          await heldWrite;
        }
        await route.continue();
      });
      await pending
        .locator('#settings-form [name="refreshSeconds"]')
        .fill("45");
      const savedWhileHidden = pending.waitForResponse(
        (r) =>
          r.request().method() === "PATCH" &&
          new URL(r.url()).pathname === "/api/v1/settings",
      );
      await pending
        .getByRole("button", { name: "保存设置", exact: true })
        .click();
      await writing;
      await pending.evaluate(() => {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      releaseWrite();
      assert.equal(
        (await savedWhileHidden).status(),
        200,
        "hiding must not abort a submitted save",
      );
      assert.equal(f.app.settings().refreshSeconds, 45);
      await pending.close();
    } finally {
      await context.close();
    }
  } finally {
    http.stop(true);
    https.stop(true);
    await service.close();
    f.repo.close();
    rmSync(root, { recursive: true, force: true });
  }
}
