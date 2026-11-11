import assert from "node:assert/strict";
import { checkSaveForms } from "./forms.mjs";
import { checkOriginal } from "./original.mjs";
import { checkDeliveryDetails } from "./deliveries.mjs";

// Magpie keeps allow-same-origin off even after the launcher navigates to
// the service. Module scripts and API requests therefore use Origin: null.
export async function checkSandbox(browser, base, deliveries) {
  const prefix = "/_magpie/plugin/fixture/_magpie/service/";
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith(prefix)) {
        const target = new URL(
          url.pathname.slice(prefix.length) + url.search,
          base + "/",
        );
        const headers = new Headers(request.headers);
        headers.delete("host");
        const response = await fetch(target, {
          redirect: "manual",
          method: request.method,
          headers,
          body: ["GET", "HEAD"].includes(request.method)
            ? undefined
            : request.body,
        });
        const outgoing = new Headers(response.headers);
        const policy = outgoing.get("Content-Security-Policy");
        if (policy)
          outgoing.set(
            "Content-Security-Policy",
            policy.replaceAll("'self'", "'self' " + url.origin + prefix),
          );
        outgoing.append(
          "Content-Security-Policy",
          "sandbox allow-scripts; frame-ancestors 'self'",
        );
        return new Response(response.body, {
          status: response.status,
          headers: outgoing,
        });
      }
      const proxy = url.pathname.startsWith("/proxy");
      const src =
        (proxy ? prefix : base + "/") +
        (url.pathname.endsWith("-original") ? "original/" : "");
      return new Response(
        '<!doctype html><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style><iframe title="Magpie plugin" sandbox="allow-scripts" src="' +
          src +
          '"></iframe>',
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    },
  });
  try {
    for (const mode of ["direct", "proxy"]) {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      try {
        await page.goto("http://127.0.0.1:" + host.port + "/" + mode);
        const frame = page.frameLocator("iframe");
        try {
          await frame
            .getByRole("heading", { name: "当前账号额度与余额" })
            .waitFor({ timeout: 8000 });
        } catch (error) {
          throw new Error(
            "Magpie " +
              mode +
              " sandbox failed to initialize: " +
              errors.join("\n"),
            { cause: error },
          );
        }
        await frame.getByRole("button", { name: "订阅", exact: true }).click();
        await frame
          .getByRole("button", { name: "新建订阅", exact: true })
          .click();
        await frame.getByRole("button", { name: "预览", exact: true }).click();
        await frame.locator("#preview[open] .preview-text").waitFor();
        await frame
          .locator('#preview .dialog-footer [data-close="preview"]')
          .click();
        await frame.locator('#editor [data-close="editor"]').first().click();
        await frame
          .getByRole("button", { name: "通知渠道", exact: true })
          .click();
        await frame
          .getByRole("button", { name: "添加渠道", exact: true })
          .waitFor();
        await frame
          .getByRole("button", { name: "发送记录", exact: true })
          .click();
        await frame
          .getByRole("heading", { name: "发送记录", exact: true })
          .waitFor();
        await checkDeliveryDetails(frame, deliveries);
        await frame.getByRole("button", { name: "设置", exact: true }).click();
        await frame.locator("#settings-form").waitFor();
        await checkSaveForms(page, frame, "sandbox-" + mode);
        await frame.getByRole("button", { name: "用量", exact: true }).click();
        await checkOriginal(page, frame);
        assert.deepEqual(errors, [], "sandbox console errors: " + mode);
        await page.goto(`http://127.0.0.1:${host.port}/${mode}-original`);
        await page
          .frameLocator("iframe")
          .getByRole("heading", { name: "账号用量树", exact: true })
          .waitFor();
        await page
          .frameLocator("iframe")
          .locator(".original-provider")
          .first()
          .waitFor();
      } finally {
        await page.close();
      }
    }
  } finally {
    host.stop(true);
  }
}
