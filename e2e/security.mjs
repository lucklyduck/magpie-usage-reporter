import assert from "node:assert/strict";

export async function checkUntrustedSandbox(browser, base) {
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const body =
        path === "/frame"
          ? `<script>
      (async () => {
        let readable = false;
        try { readable = (await (await fetch(${JSON.stringify(base)} + '/')).text()).includes('usage-token'); } catch {}
        parent.postMessage({audit:true,readable},'*');
      })();</script>`
          : `<script>addEventListener('message',e=>{if(e.data?.audit)window.result=e.data})</script><iframe sandbox="allow-scripts" src="/frame"></iframe>`;
      return new Response(body, { headers: { "Content-Type": "text/html" } });
    },
  });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${host.port}`);
    await page.waitForFunction(() => Boolean(window.result));
    assert.equal(
      await page.evaluate(() => window.result.readable),
      false,
      "an external opaque origin must not read the service token",
    );
  } finally {
    await page.close();
    host.stop(true);
  }
}

export async function checkReconnect(browser, base) {
  const page = await browser.newPage();
  let deny = false,
    status = 0;
  await page.route("**/api/v1/status", (route) => {
    if (deny) {
      status++;
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: '{"error":{"message":"expired"}}',
      });
    }
    return route.continue();
  });
  try {
    await page.goto(base);
    await page.getByRole("heading", { name: "当前账号额度与余额" }).waitFor();
    deny = true;
    await page.locator("#refresh").click();
    await page.waitForURL((url) => url.searchParams.get("reconnected") === "1");
    await page.locator("#connection-expired").waitFor();
    // Persistent 401s must not cause another document reload or request loop.
    assert.ok(status <= 3);
  } finally {
    await page.close();
  }

  const editing = await browser.newPage();
  await editing.clock.install();
  deny = false;
  await editing.route("**/api/v1/status", (route) =>
    deny
      ? route.fulfill({
          status: 401,
          contentType: "application/json",
          body: '{"error":{"message":"expired"}}',
        })
      : route.continue(),
  );
  try {
    await editing.goto(base);
    await editing
      .getByRole("heading", { name: "当前账号额度与余额" })
      .waitFor();
    const settings = await editing.request.get(base + "/api/v1/settings", {
      headers: {
        "X-Usage-Token": await editing
          .locator('meta[name="usage-token"]')
          .getAttribute("content"),
      },
    });
    const seconds = (await settings.json()).refreshSeconds;
    await editing.getByRole("button", { name: "设置", exact: true }).click();
    await editing
      .locator('#settings-form input[name="timezone"]')
      .fill("Asia/Tokyo");
    deny = true;
    await editing.clock.runFor(seconds * 1000 + 10);
    await editing.locator("#connection-expired").waitFor();
    assert.equal(
      await editing
        .locator('#settings-form input[name="timezone"]')
        .inputValue(),
      "Asia/Tokyo",
    );
    assert.equal(new URL(editing.url()).searchParams.has("reconnected"), false);
  } finally {
    await editing.close();
  }
}
