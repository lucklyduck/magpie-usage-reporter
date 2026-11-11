import assert from "node:assert/strict";

// Exercise the persisted job shape, which differs from a report preview:
// parts belong to the job; receipts identify the channel that confirmed them.
export function deliveryCases(f) {
  const cases = [
    {
      name: "详情验收：报告生成失败",
      status: "failed",
      lastError: "用量明细不完整，本次报告未发送",
      events: [
        { at: f.clock.now(), message: "报告生成失败：部分记录字段无效" },
      ],
      expectedText: "报告尚未生成",
      expectedChannels: [
        "主渠道：主渠道 · 0 条消息已确认",
        "备用渠道：备用渠道 · 0 条消息已确认",
      ],
    },
    {
      name: "详情验收：主渠道已发送",
      status: "sent",
      text: "已发送的日报 <script>throw new Error('unsafe')</script>",
      parts: [{ text: "第一段" }, { text: "第二段" }],
      receipts: [
        { channelId: f.p.id, part: 0, receipt: "primary-1" },
        { channelId: f.p.id, part: 1, receipt: "primary-2" },
      ],
      events: [],
      expectedChannels: [
        "主渠道：主渠道 · 2 条消息已确认 / 共 2 条",
        "备用渠道：备用渠道 · 0 条消息已确认",
      ],
    },
    {
      name: "详情验收：备用渠道部分成功",
      status: "partial",
      stage: 1,
      part: 1,
      text: "已冻结的日报内容",
      parts: [{ text: "第一段" }, { text: "第二段" }],
      receipts: [{ channelId: f.b.id, part: 0, receipt: "backup-1" }],
      lastError: "平台返回 HTTP 429",
      events: [{ at: f.clock.now(), message: "备用渠道第二段等待重试" }],
      expectedChannels: [
        "主渠道：主渠道 · 0 条消息已确认",
        "备用渠道：备用渠道 · 1 条消息已确认 / 共 2 条",
      ],
    },
  ];
  return cases.map((c) => {
    const { name, expectedText, expectedChannels, ...values } = c;
    const job = f.app.enqueue({ ...f.spec, name });
    Object.assign(job, values);
    if (job.text) job.report = { id: job.id, title: name };
    f.repo.saveJob(job);
    return {
      ...job,
      expectedText: expectedText || job.text,
      expectedChannels,
    };
  });
}

export async function checkDeliveryDetails(view, cases) {
  await view.getByRole("button", { name: "发送记录", exact: true }).click();
  for (const c of cases) {
    await view
      .locator('[data-action="detail-job"][data-id="' + c.id + '"]')
      .click();
    const dialog = view.locator("#preview[open]");
    await dialog.waitFor();
    assert.equal(
      await dialog.locator(".preview-text").innerText(),
      c.expectedText,
    );
    assert.deepEqual(
      await dialog.locator(".preview-channels .badge").allTextContents(),
      c.expectedChannels,
    );
    if (c.lastError)
      assert.match(await dialog.innerText(), new RegExp(c.lastError));
    for (const event of c.events)
      assert.ok((await dialog.innerText()).includes(event.message));
    assert.equal(await dialog.locator("script").count(), 0);
    assert.equal(await view.locator("#notice").isVisible(), false);
    await dialog.locator('.dialog-footer [data-close="preview"]').click();
  }
}
