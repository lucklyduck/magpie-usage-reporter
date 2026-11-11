import assert from "node:assert/strict";
import { makeFixture } from "../test/helpers.mjs";
import { startServer } from "../lib/server.mjs";

// A draining old process reads the new HTML/app.js from the same package
// folder, but its route table and token still belong to the previous build.
export async function checkUpgradeStartup(browser) {
  const f = makeFixture();
  const service = await startServer({ port: 0, app: f.app });
  const base = `http://127.0.0.1:${service.port}`;
  let upgraded = false,
    oldStatus = 404,
    earlyModules = 0,
    writes = 0;
  const owner = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/host")
        return new Response(
          '<!doctype html><iframe title="Magpie plugin" sandbox="allow-scripts" style="width:1400px;height:1000px" src="/"></iframe>',
          { headers: { "content-type": "text/html" } },
        );
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) writes++;
      if (
        !upgraded &&
        request.method === "OPTIONS" &&
        url.pathname.startsWith("/api/")
      )
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "null",
            "Access-Control-Allow-Methods": "GET,OPTIONS",
            "Access-Control-Allow-Headers": "X-Usage-Token",
          },
        });
      if (!upgraded && url.pathname === "/api/v1/capabilities")
        return Response.json(
          oldStatus === 404
            ? { error: { message: "接口不存在" } }
            : { schemaVersion: 1 },
          {
            status: oldStatus,
            headers: { "Access-Control-Allow-Origin": "null" },
          },
        );
      if (
        !upgraded &&
        ["/host.js", "/display-format.js", "/main.js"].includes(url.pathname)
      ) {
        earlyModules++;
        return new Response("not found", { status: 404 });
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      const response = await fetch(base + url.pathname + url.search, {
        method: request.method,
        headers,
        redirect: "manual",
      });
      const outgoing = new Headers(response.headers);
      outgoing.delete("content-length");
      const policy = outgoing.get("content-security-policy");
      if (policy)
        outgoing.set(
          "content-security-policy",
          policy.replaceAll("'self'", "'self' " + url.origin + "/"),
        );
      let body = await response.text();
      if (!upgraded && url.pathname === "/")
        body = body.replace(service.token, "retired-token");
      return new Response(
        response.status === 204 || request.method === "HEAD" ? null : body,
        { status: response.status, headers: outgoing },
      );
    },
  });
  const page = await browser.newPage();
  try {
    for (const status of [404, 200]) {
      upgraded = false;
      oldStatus = status;
      earlyModules = 0;
      await page.goto(`http://127.0.0.1:${owner.port}/host`);
      const view = page.frameLocator("iframe");
      await view
        .locator("[data-startup-status]")
        .filter({ hasText: "后台正在更新" })
        .waitFor({ timeout: 2000 });
      assert.equal(
        earlyModules,
        0,
        "old route tables must not be asked to load new modules",
      );
      upgraded = true;
      await view
        .getByRole("heading", { name: "当前账号额度与余额" })
        .waitFor({ timeout: 10000 });
      assert.equal(
        new URL(
          page
            .frames()
            .find((frame) => frame !== page.mainFrame())
            .url(),
        ).searchParams.get("bootReconnect"),
        "1",
      );
      assert.equal(writes, 0, "startup recovery must never replay writes");
    }
  } finally {
    await page.close();
    owner.stop(true);
    await service.close();
    f.repo.close();
  }
}
