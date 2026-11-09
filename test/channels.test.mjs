import { test, expect } from "bun:test";
import { notificationAdapters } from "../lib/channels/index.mjs";
const message = {
  title: "测试",
  text: "中文 <>& 🐦",
  reportId: "r1",
  index: 0,
  total: 1,
};
test("Telegram checks protocol result and respects retry-after", async () => {
  const sent = [];
  const adapter = notificationAdapters({
    fetcher: async (u, o) => {
      sent.push(JSON.parse(o.body));
      return Response.json({
        ok: false,
        error_code: 429,
        parameters: { retry_after: 12 },
      });
    },
  }).find((a) => a.id === "telegram");
  const r = await adapter.send(
    { apiBase: "https://example.test", chatId: "123" },
    { token: "fake" },
    message,
    {},
  );
  expect(r.outcome).toBe("retryable");
  expect(r.retryAfter).toBe(12000);
  expect(sent[0].text).toBe(message.text);
});
test("OneBot does not mistake HTTP 200 with retcode failure for success", async () => {
  const a = notificationAdapters({
    fetcher: async () => Response.json({ status: "failed", retcode: 100 }),
  }).find((a) => a.id === "onebot11");
  const r = await a.send(
    { endpoint: "http://localhost:3000", targetType: "group", targetId: "42" },
    {},
    message,
    {},
  );
  expect(r.outcome).toBe("permanent");
});
test("all HTTP channels send actual text to a local receiver", async () => {
  const received = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json();
      received.push({ path: new URL(req.url).pathname, body });
      if (req.url.includes("sendMessage"))
        return Response.json({ ok: true, result: { message_id: 11 } });
      if (req.url.includes("send_group_msg"))
        return Response.json({
          status: "ok",
          retcode: 0,
          data: { message_id: 12 },
        });
      return new Response(null, { status: 204 });
    },
  });
  try {
    const base = "http://127.0.0.1:" + server.port,
      adapters = notificationAdapters();
    expect(
      (
        await adapters[0].send(
          { apiBase: base, chatId: "1" },
          { token: "fake" },
          message,
          {},
        )
      ).outcome,
    ).toBe("success");
    expect(
      (
        await adapters[1].send(
          { endpoint: base, targetType: "group", targetId: "1" },
          {},
          message,
          {},
        )
      ).outcome,
    ).toBe("success");
    expect(
      (await adapters[3].send({ url: base }, {}, message, {})).outcome,
    ).toBe("success");
    expect(received.length).toBe(3);
    expect(received[1].body.message[0].data.text).toBe(message.text);
  } finally {
    server.stop(true);
  }
});
test("SMTP supports implicit TLS and STARTTLS as separate configurations", async () => {
  const settings = [],
    mails = [];
  const a = notificationAdapters({
    createTransport: (config) => {
      settings.push(config);
      return {
        sendMail: async (m) => {
          mails.push(m);
          return { accepted: ["x"], rejected: [], messageId: "id" };
        },
        close() {},
      };
    },
  }).find((a) => a.id === "smtp");
  for (const security of ["tls", "starttls"])
    expect(
      (
        await a.send(
          {
            host: "smtp.test",
            port: security === "tls" ? 465 : 587,
            security,
            user: "user",
            from: "x@example.test",
            to: "y@example.test",
          },
          { password: "fake" },
          message,
          {},
        )
      ).outcome,
    ).toBe("success");
  expect(settings[0].secure).toBe(true);
  expect(settings[1].secure).toBe(false);
  expect(settings[1].requireTLS).toBe(true);
  expect(mails[0].text).toBe(message.text);
  expect(mails[0].html).toBeUndefined();
});
test("credentials are required only for authenticated channels", async () => {
  const a = notificationAdapters().find((a) => a.id === "telegram");
  expect((await a.send({}, {}, message, {})).outcome).toBe("permanent");
  const smtp = notificationAdapters().find((a) => a.id === "smtp");
  expect(() =>
    smtp.validate({
      host: "remote.test",
      port: 25,
      security: "local",
      user: "",
      from: "a@example.test",
      to: "b@example.test",
    }),
  ).toThrow();
});
