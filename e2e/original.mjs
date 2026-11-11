import assert from "node:assert/strict";

export async function checkOriginal(page, view) {
  await view.getByRole("tab", { name: "原版用量树", exact: true }).click();
  await view.locator(".original-provider").first().waitFor();
  for (const period of ["7d", "30d", "all", "today"]) {
    const response = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/v1/original/tree?period=${period}`) &&
        r.status() === 200,
    );
    await view.getByLabel("原版统计周期").selectOption(period);
    await response;
    await view.locator(".original-provider").first().waitFor();
  }
  await view.getByRole("button", { name: "展开全部", exact: true }).click();
  await view.locator(".original-account[open]").first().waitFor();
  assert.ok(
    await view
      .locator(".original-models td")
      .filter({ hasText: "shared-model" })
      .count(),
  );
  await view.getByLabel("搜索原版账号或模型").fill("工作账号");
  assert.equal(await view.locator(".original-account").count(), 1);
  await view.getByLabel("原版排序").selectOption("calls");
  await view.locator('[data-original="cache"]').uncheck();
  await view.getByRole("tab", { name: "增强视图", exact: true }).click();
  await view.getByRole("heading", { name: "当前账号额度与余额" }).waitFor();
  await view.getByRole("tab", { name: "原版用量树", exact: true }).click();
  await view.locator(".original-account").first().waitFor();
  assert.equal(
    await view.getByLabel("搜索原版账号或模型").inputValue(),
    "工作账号",
  );
  assert.equal(await view.getByLabel("原版排序").inputValue(), "calls");
  assert.equal(
    await view.locator('[data-original="cache"]').isChecked(),
    false,
  );
  await view.getByLabel("搜索原版账号或模型").fill("");
  const refreshed = page.waitForResponse(
    (r) =>
      r.url().includes("/api/v1/original/tree?period=today&fresh=1") &&
      r.status() === 200,
  );
  await view.getByRole("button", { name: "刷新原版用量", exact: true }).click();
  await refreshed;
  await page.screenshot({
    path: "outputs/original-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "outputs/original-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await view
      .locator(".original-tree")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await view.getByRole("tab", { name: "增强视图", exact: true }).click();

  // A response from a disposed tab must never replace the active view.
  let intercepted;
  const waiting = new Promise((resolve) => {
    intercepted = resolve;
  });
  let pending;
  await page.route(
    "**/api/v1/original/tree?**",
    (route) => {
      pending = route;
      intercepted();
    },
    { times: 1 },
  );
  await view.getByRole("tab", { name: "原版用量树", exact: true }).click();
  await waiting;
  await view.getByRole("tab", { name: "增强视图", exact: true }).click();
  await pending.continue().catch(() => {});
  await view.getByRole("heading", { name: "当前账号额度与余额" }).waitFor();
  assert.equal(await view.locator(".original-tree").count(), 0);
}
