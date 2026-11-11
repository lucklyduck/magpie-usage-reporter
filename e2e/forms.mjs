import assert from "node:assert/strict";

// Use fixture values only. Saving these channels must never contact a provider.
export async function checkSaveForms(page, view, label) {
  const errors = [];
  const onConsole = (message) => {
    if (message.type() === "error") errors.push(message.text());
  };
  page.on("console", onConsole);
  const writes = [];
  const onRequest = (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/api/v1/channels")
    )
      writes.push(request.url());
  };
  page.on("request", onRequest);
  async function save(action, path, method = "POST", status = 201) {
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === method &&
        new URL(r.url()).pathname.endsWith("/api/v1/" + path),
      { timeout: 4000 },
    );
    try {
      const [result] = await Promise.all([response, action()]);
      assert.equal(result.status(), status, label + " " + path + " save");
      return await result.json();
    } catch (error) {
      throw new Error(label + " save failed: " + errors.join("\n"), {
        cause: error,
      });
    }
  }
  try {
    const cases = [
      {
        type: "telegram",
        config: { chatId: "123456789" },
        secret: { token: "fixture-bot-token" },
      },
      {
        type: "onebot11",
        config: { endpoint: "http://127.0.0.1:9", targetId: "123456789" },
        secret: { token: "fixture-access-token" },
      },
      {
        type: "smtp",
        config: {
          host: "smtp.example.test",
          port: "465",
          user: "fixture@example.test",
          from: "fixture@example.test",
          to: "receiver@example.test",
        },
        secret: { password: "fixture-password" },
      },
      { type: "webhook", config: { url: "http://127.0.0.1:9" }, secret: {} },
    ];
    const channels = [];
    await view.getByRole("button", { name: "通知渠道", exact: true }).click();
    for (const c of cases) {
      await view.getByRole("button", { name: "添加渠道", exact: true }).click();
      const form = view.locator("#channel-form");
      await form.locator('[name="type"]').selectOption(c.type);
      const before = writes.length;
      await form.getByRole("button", { name: "保存渠道", exact: true }).click();
      assert.equal(await form.evaluate((f) => f.checkValidity()), false);
      assert.equal(
        writes.length,
        before,
        "invalid form must not reach the API",
      );
      const name = label + " " + c.type;
      await form.locator('[name="name"]').fill(name);
      for (const [key, value] of Object.entries(c.config))
        await form.locator('[name="config.' + key + '"]').fill(value);
      for (const [key, value] of Object.entries(c.secret))
        await form.locator('[name="secret.' + key + '"]').fill(value);
      const saved = await save(
        () =>
          form.getByRole("button", { name: "保存渠道", exact: true }).click(),
        "channels",
      );
      assert.equal(saved.type, c.type);
      channels.push(saved);
      await view.locator(".list-card").filter({ hasText: name }).waitFor();
      assert.equal(
        writes.length,
        before + 1,
        "save must create exactly one channel",
      );
    }
    const telegram = channels[0];
    await view
      .locator(".list-card")
      .filter({ hasText: telegram.name })
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    const channelForm = view.locator("#channel-form");
    assert.equal(
      await channelForm.locator('[name="secret.token"]').inputValue(),
      "",
    );
    const renamed = telegram.name + " edited";
    await channelForm.locator('[name="name"]').fill(renamed);
    const edited = await save(
      () => channelForm.locator('[name="name"]').press("Enter"),
      "channels/" + telegram.id,
      "PATCH",
      200,
    );
    assert.equal(
      edited.configured,
      true,
      "empty secret must retain saved credentials",
    );
    await view.locator(".list-card").filter({ hasText: renamed }).waitFor();

    await view.getByRole("button", { name: "订阅", exact: true }).click();
    await view.getByRole("button", { name: "新建订阅", exact: true }).click();
    const subForm = view.locator("#subscription-form");
    const subName = label + " subscription";
    await subForm.locator('[name="name"]').fill(subName);
    await subForm.locator('[name="enabled"]').uncheck();
    const subscription = await save(
      () =>
        subForm.getByRole("button", { name: "保存订阅", exact: true }).click(),
      "subscriptions",
    );
    assert.equal(subscription.enabled, false);
    await view.locator(".list-card").filter({ hasText: subName }).waitFor();

    await view.getByRole("button", { name: "设置", exact: true }).click();
    const settingsForm = view.locator("#settings-form");
    const refresh = settingsForm.locator('[name="refreshSeconds"]');
    const oldRefresh = await refresh.inputValue();
    await refresh.fill("60");
    const settings = await save(
      () =>
        settingsForm
          .getByRole("button", { name: "保存设置", exact: true })
          .click(),
      "settings",
      "PATCH",
      200,
    );
    assert.equal(settings.refreshSeconds, 60);
    await settingsForm
      .locator('button[type="submit"]:not(:disabled)')
      .waitFor();
    await refresh.fill(oldRefresh);
    await save(() => refresh.press("Enter"), "settings", "PATCH", 200);

    await page.reload();
    await view.getByRole("heading", { name: "当前账号额度与余额" }).waitFor();
    await view.getByRole("button", { name: "通知渠道", exact: true }).click();
    await view.locator(".list-card").filter({ hasText: renamed }).waitFor();
    await view.getByRole("button", { name: "订阅", exact: true }).click();
    await view.locator(".list-card").filter({ hasText: subName }).waitFor();
    assert.deepEqual(errors, [], label + " form console errors");
    return { channels, subscription };
  } finally {
    page.off("console", onConsole);
    page.off("request", onRequest);
  }
}
