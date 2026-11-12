import assert from "node:assert/strict";

async function waitUsage(page, key, value, action) {
  const response = page.waitForResponse((r) => {
    const url = new URL(r.url());
    return (
      url.pathname.endsWith("/api/v1/usage") &&
      r.status() === 200 &&
      (!key || url.searchParams.get(key) === value)
    );
  });
  await action();
  await response;
}
const group = (page, name) =>
  page.locator(".usage-group").filter({ hasText: name });
const summary = (page, name) => group(page, name).locator(":scope > summary");

export async function checkEnhanced(page) {
  await page.locator(".usage-detail-panel").waitFor();
  assert.equal(await page.locator(".usage-provider[open]").count(), 2);
  assert.equal(await page.locator(".usage-group[open]").count(), 0);
  assert.equal(
    await summary(page, "工作账号").locator(".usage-share-label").innerText(),
    "71%",
  );
  assert.equal(
    await summary(page, "工作账号").locator(".usage-status").innerText(),
    "正常",
  );
  assert.match(
    await summary(page, "备用账号").locator(".usage-status").innerText(),
    /1 失败/,
  );
  assert.match(
    await summary(page, "备用账号").locator(".usage-status").innerText(),
    /50%/,
  );
  assert.equal(
    await summary(page, "无调用账号").locator(".usage-status").innerText(),
    "无调用",
  );

  const search = page.getByRole("searchbox", {
    name: "搜索账号、供应商或模型",
  });
  let requests = 0;
  const onRequest = (request) => {
    if (new URL(request.url()).pathname.endsWith("/api/v1/usage")) requests++;
  };
  page.on("request", onRequest);
  try {
    await search.fill("工作账号");
    assert.equal(await page.locator(".usage-group").count(), 1);
    await search.fill("alice");
    assert.equal(await page.locator(".usage-group").count(), 2);
    await search.fill("other-model");
    assert.equal(await page.locator(".usage-group").count(), 1);
    assert.equal(await page.locator(".usage-leaf-row").count(), 1);
    await search.fill("供应商二");
    assert.equal(await page.locator(".usage-provider").count(), 1);
    assert.equal(await page.locator(".usage-group").count(), 1);
    await search.fill("不存在的记录");
    await page
      .getByText("没有匹配的账号、供应商或模型", { exact: true })
      .waitFor();
    assert.equal(requests, 0);
  } finally {
    page.off("request", onRequest);
  }

  await search.fill("工作账号");
  await page.getByRole("button", { name: "展开全部", exact: true }).click();
  assert.equal(await page.locator(".usage-group[open]").count(), 1);
  await search.fill("");
  assert.equal(await group(page, "工作账号").getAttribute("open"), "");
  assert.equal(await group(page, "备用账号").getAttribute("open"), null);
  await page.getByRole("button", { name: "展开全部", exact: true }).click();
  assert.equal(await page.locator(".usage-group[open]").count(), 4);
  assert.equal(
    await group(page, "工作账号").locator(".usage-leaf-row").count(),
    2,
  );
  assert.deepEqual(
    await group(page, "工作账号")
      .locator(".usage-leaf-row .usage-share-label")
      .allTextContents(),
    ["98%", "1.9%"],
  );
  await group(page, "无调用账号")
    .getByText("当前没有明细记录", { exact: true })
    .waitFor();

  await search.fill("工作账号");
  await waitUsage(page, "fresh", "1", () => page.locator("#refresh").click());
  await page.waitForLoadState("networkidle");
  assert.equal(await search.inputValue(), "工作账号");
  assert.equal(await group(page, "工作账号").getAttribute("open"), "");
  await search.fill("");

  await waitUsage(page, "sort", "calls", () =>
    page.locator("#sort").selectOption("calls"),
  );
  await page.locator('.usage-share-label[title="调用占比"]').first().waitFor();
  assert.equal(
    await summary(page, "工作账号").locator(".usage-share-label").innerText(),
    "67%",
  );
  await waitUsage(page, "sort", "costUsd", () =>
    page.locator("#sort").selectOption("costUsd"),
  );
  await page.locator('.usage-share-label[title="费用占比"]').first().waitFor();
  assert.equal(
    await summary(page, "工作账号").locator(".usage-share-label").innerText(),
    "67%",
  );
  await waitUsage(page, "sort", "name", () =>
    page.locator("#sort").selectOption("name"),
  );
  await page
    .locator('.usage-share-label[title="Token 占比"]')
    .first()
    .waitFor();
  assert.equal(
    await summary(page, "工作账号").locator(".usage-share-label").innerText(),
    "71%",
  );

  await waitUsage(page, "includeCache", "false", () =>
    page.locator("#cache-toggle").uncheck(),
  );
  await summary(page, "工作账号").filter({ hasText: "1.13K" }).waitFor();
  assert.equal(
    await summary(page, "工作账号").locator(".usage-share-label").innerText(),
    "67%",
  );
  await waitUsage(page, "includeCache", "true", () =>
    page.locator("#cache-toggle").check(),
  );
  await summary(page, "工作账号").filter({ hasText: "1.33K" }).waitFor();
  await waitUsage(page, "sort", "tokens", () =>
    page.locator("#sort").selectOption("tokens"),
  );
  await summary(page, "工作账号").filter({ hasText: "71%" }).waitFor();

  await page.getByRole("button", { name: "自定义表格", exact: true }).click();
  await page.locator(".table-wrap").waitFor();
  assert.equal(await page.locator("#usage-detail-tools").isHidden(), true);
  await page.locator("#usage-filters > summary").click();
  await page.locator('[data-column="input"]').check();
  await page.locator('[data-column="errors"]').uncheck();
  await waitUsage(page, null, null, () =>
    page.getByRole("button", { name: "应用筛选", exact: true }).click(),
  );
  await page.getByRole("columnheader", { name: "输入", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("columnheader", { name: "失败", exact: true }).count(),
    0,
  );
  await page.locator('[data-column="input"]').uncheck();
  await page.locator('[data-column="errors"]').check();
  await waitUsage(page, null, null, () =>
    page.getByRole("button", { name: "应用筛选", exact: true }).click(),
  );
  await page.getByRole("columnheader", { name: "失败", exact: true }).waitFor();
  await page.getByRole("button", { name: "账号明细", exact: true }).click();
  await page.locator(".usage-detail-panel").waitFor();

  await waitUsage(page, "grouping", "model", () =>
    page.getByRole("button", { name: "按模型", exact: true }).click(),
  );
  await page.getByRole("heading", { name: /供应商 → 模型 → 账号/ }).waitFor();
  assert.equal(await page.locator(".usage-group").count(), 3);
  await search.fill("工作账号");
  assert.equal(await page.locator(".usage-group").count(), 1);
  assert.equal(await page.locator(".usage-leaf-row").count(), 1);
  await page.getByRole("button", { name: "展开全部", exact: true }).click();
  assert.equal(await page.locator(".usage-group[open]").count(), 1);
  await search.fill("");
  await page.getByRole("button", { name: "展开全部", exact: true }).click();
  assert.equal(await page.locator(".usage-group[open]").count(), 3);
  assert.equal(await page.locator(".usage-leaf-row").count(), 4);

  await waitUsage(page, "grouping", "account", () =>
    page.getByRole("button", { name: "按账号", exact: true }).click(),
  );
  await page.getByRole("heading", { name: /供应商 → 账号 → 模型/ }).waitFor();
}
