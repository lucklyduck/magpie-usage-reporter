import nodemailer from "nodemailer";
import { z } from "zod";
import { parse } from "../domain/config.mjs";
const url = z
  .string()
  .url()
  .refine((s) => {
    const u = new URL(s);
    return (
      ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
    );
  }, "需要 HTTP(S) 地址且不包含内嵌凭据");
const text = (id, label, extra = {}) => ({ id, label, type: "text", ...extra });
const outcomes = (outcome, message, extra = {}) => ({
  outcome,
  message,
  ...extra,
});
function networkFailure(e) {
  const code = e?.cause?.code || e?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code)
    ? outcomes("retryable", "连接未建立，可重试")
    : outcomes("unknown", "请求发出后未收到确认，投递结果未知");
}
async function post(fetcher, endpoint, body, headers, ctx) {
  try {
    const r = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        AbortSignal.timeout(ctx.timeout || 15000),
        ...(ctx.signal ? [ctx.signal] : []),
      ]),
    });
    if (!r.ok)
      return {
        result: outcomes(
          r.status === 429 || r.status >= 500 ? "retryable" : "permanent",
          "平台返回 HTTP " + r.status,
          {
            retryAfter:
              Math.max(0, Number(r.headers.get("retry-after")) || 0) * 1000,
          },
        ),
      };
    return { response: r };
  } catch (e) {
    return { result: networkFailure(e) };
  }
}
export function notificationAdapters({
  fetcher = fetch,
  createTransport = nodemailer.createTransport,
} = {}) {
  return [
    {
      id: "telegram",
      label: "Telegram",
      fields: [
        text("chatId", "Chat ID", { required: true }),
        text("threadId", "话题 ID"),
        text("apiBase", "API 地址", { default: "https://api.telegram.org" }),
      ],
      secretFields: [text("token", "Bot Token", { required: true })],
      capabilities: { formats: ["text"], maxTextLength: 4096 },
      validate: (c) =>
        parse(
          z.object({
            chatId: z.string().min(1),
            threadId: z.string().optional().default(""),
            apiBase: url.default("https://api.telegram.org"),
          }),
          c,
        ),
      async send(c, s, m, ctx) {
        if (!s.token) return outcomes("permanent", "未配置 Telegram Bot Token");
        const p = await post(
          fetcher,
          c.apiBase.replace(/\/$/, "") +
            "/bot" +
            encodeURIComponent(s.token).replace(/%3A/g, ":") +
            "/sendMessage",
          {
            chat_id: c.chatId,
            text: m.text,
            ...(c.threadId ? { message_thread_id: c.threadId } : {}),
          },
          {},
          ctx,
        );
        if (p.result) return p.result;
        try {
          const j = await p.response.json();
          if (j.ok === false)
            return outcomes(
              j.error_code === 429 ? "retryable" : "permanent",
              "Telegram 拒绝消息（" + j.error_code + "）",
              { retryAfter: (j.parameters?.retry_after || 0) * 1000 },
            );
          if (j.ok !== true || !j.result?.message_id)
            return outcomes("unknown", "Telegram 确认信息无效");
          return outcomes("success", "已发送", {
            receipt: String(j.result.message_id),
          });
        } catch {
          return outcomes("unknown", "Telegram 确认信息无效");
        }
      },
    },
    {
      id: "onebot11",
      label: "OneBot 11 HTTP",
      fields: [
        text("endpoint", "HTTP 地址", { required: true }),
        {
          id: "targetType",
          label: "目标类型",
          type: "select",
          options: [
            { id: "private", label: "私聊" },
            { id: "group", label: "群聊" },
          ],
          default: "private",
        },
        text("targetId", "用户／群 ID", { required: true }),
      ],
      secretFields: [text("token", "Access Token")],
      capabilities: { formats: ["text"], maxTextLength: 3000 },
      validate: (c) =>
        parse(
          z.object({
            endpoint: url,
            targetType: z.enum(["private", "group"]),
            targetId: z
              .string()
              .regex(/^\d+$/)
              .refine(
                (s) => Number.isSafeInteger(Number(s)),
                "ID 超出安全整数范围",
              ),
          }),
          c,
        ),
      async send(c, s, m, ctx) {
        const body = {
          message: [{ type: "text", data: { text: m.text } }],
          [c.targetType === "group" ? "group_id" : "user_id"]: Number(
            c.targetId,
          ),
        };
        const p = await post(
          fetcher,
          c.endpoint.replace(/\/$/, "") +
            (c.targetType === "group"
              ? "/send_group_msg"
              : "/send_private_msg"),
          body,
          s.token ? { Authorization: "Bearer " + s.token } : {},
          ctx,
        );
        if (p.result) return p.result;
        try {
          const j = await p.response.json();
          if (j.status !== "ok" || j.retcode !== 0)
            return outcomes(
              "permanent",
              "OneBot 返回业务失败（" + String(j.retcode ?? "未知") + "）",
            );
          if (j.data?.message_id == null)
            return outcomes("unknown", "OneBot 缺少消息确认");
          return outcomes("success", "已发送", {
            receipt: String(j.data.message_id),
          });
        } catch {
          return outcomes("unknown", "OneBot 确认信息无效");
        }
      },
    },
    {
      id: "smtp",
      label: "SMTP 邮件",
      fields: [
        text("host", "SMTP 主机", { required: true }),
        { id: "port", label: "端口", type: "number", default: 465 },
        {
          id: "security",
          label: "加密方式",
          type: "select",
          options: [
            { id: "tls", label: "隐式 TLS（465）" },
            { id: "starttls", label: "STARTTLS（587）" },
            { id: "local", label: "本机无认证中继" },
          ],
          default: "tls",
        },
        text("user", "登录用户名"),
        text("from", "发件地址", { required: true }),
        text("to", "收件地址", { required: true }),
      ],
      secretFields: [text("password", "密码／授权码")],
      capabilities: { formats: ["text"], maxTextLength: 200000 },
      validate: (c) =>
        parse(
          z
            .object({
              host: z
                .string()
                .min(1)
                .max(253)
                .regex(/^[\w.:-]+$/),
              port: z.coerce.number().int().min(1).max(65535).default(465),
              security: z.enum(["tls", "starttls", "local"]).default("tls"),
              user: z.string().default(""),
              from: z.string().email(),
              to: z.string().email(),
            })
            .refine(
              (c) =>
                c.security !== "local" ||
                (["localhost", "127.0.0.1", "::1"].includes(c.host) && !c.user),
              "明文中继仅允许本机且不带认证",
            ),
          c,
        ),
      async send(c, s, m, ctx) {
        if (c.user && !s.password)
          return outcomes("permanent", "未配置 SMTP 密码");
        const transport = createTransport({
          host: c.host,
          port: c.port,
          secure: c.security === "tls",
          requireTLS: c.security === "starttls",
          ignoreTLS: c.security === "local",
          ...(c.user ? { auth: { user: c.user, pass: s.password } } : {}),
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 15000,
        });
        try {
          const info = await transport.sendMail({
            from: c.from,
            to: c.to,
            subject: m.title,
            text: m.text,
            headers: { "X-Magpie-Report-ID": m.reportId },
          });
          if (info.rejected?.length || !info.accepted?.length)
            return outcomes("permanent", "SMTP 拒绝收件人");
          return outcomes("success", "已发送", { receipt: info.messageId });
        } catch (e) {
          if (e.responseCode)
            return outcomes(
              e.responseCode >= 500 ? "permanent" : "retryable",
              "SMTP 返回错误（" + String(e.responseCode) + "）",
            );
          if (e.command === "CONN")
            return outcomes("retryable", "SMTP 连接失败");
          return outcomes("unknown", "SMTP 未收到投递确认");
        } finally {
          transport.close?.();
        }
      },
    },
    {
      id: "webhook",
      label: "通用 Webhook",
      fields: [text("url", "POST 地址", { required: true })],
      secretFields: [text("token", "Bearer Token（可选）")],
      capabilities: { formats: ["text"], maxTextLength: 100000 },
      validate: (c) => parse(z.object({ url }), c),
      async send(c, s, m, ctx) {
        const p = await post(
          fetcher,
          c.url,
          {
            title: m.title,
            text: m.text,
            reportId: m.reportId,
            part: m.index + 1,
            totalParts: m.total,
            format: "text",
          },
          s.token ? { Authorization: "Bearer " + s.token } : {},
          ctx,
        );
        if (p.result) return p.result;
        await p.response.body?.cancel().catch(() => {});
        return outcomes("success", "已发送", {
          receipt: "HTTP " + p.response.status,
        });
      },
    },
  ];
}
