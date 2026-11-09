import { z } from "zod";
import { Cron } from "croner";
import { AppError, invariant } from "./errors.mjs";
import { dateInZone, PERIODS } from "./periods.mjs";
const list = z.array(z.string().max(500)).max(200).default([]);
export const filtersSchema = z.object({
  providers: list,
  accounts: list,
  models: list,
  agents: list,
  sources: z
    .array(z.enum(["through", "direct", "reported"]))
    .min(1)
    .default(["through", "direct", "reported"]),
});
export const SETTING_DEFINITIONS = [
  {
    id: "timezone",
    label: "时区",
    type: "text",
    schema: z.string().default("Asia/Shanghai"),
  },
  {
    id: "currency",
    label: "币种",
    type: "select",
    options: [
      { id: "USD", label: "美元" },
      { id: "CNY", label: "人民币" },
    ],
    schema: z.enum(["USD", "CNY"]).default("USD"),
  },
  {
    id: "usdCny",
    label: "美元兑人民币汇率",
    type: "number",
    min: 0,
    step: 0.0001,
    schema: z.number().min(0).default(0),
  },
  {
    id: "refreshSeconds",
    label: "页面刷新间隔（秒）",
    type: "number",
    min: 15,
    max: 3600,
    schema: z.number().int().min(15).max(3600).default(30),
  },
  {
    id: "historyDays",
    label: "发送历史保留（天）",
    type: "number",
    min: 7,
    max: 365,
    schema: z.number().int().min(7).max(365).default(90),
  },
  {
    id: "gateway",
    label: "Magpie 网关（留空自动发现）",
    type: "text",
    schema: z.string().default(""),
  },
  {
    id: "includeCache",
    label: "默认 Token 含缓存",
    type: "boolean",
    schema: z.boolean().default(true),
  },
  {
    id: "showZeroAccounts",
    label: "默认显示无调用账号",
    type: "boolean",
    schema: z.boolean().default(true),
  },
];
export const settingsSchema = z.object({
  ...Object.fromEntries(SETTING_DEFINITIONS.map((d) => [d.id, d.schema])),
  preferences: z
    .object({
      columns: z.array(z.string()).min(1).max(30),
      grouping: z.enum(["account", "model"]),
      period: z.string(),
      sort: z.string(),
    })
    .optional(),
});
const scheduleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("interval"),
    minutes: z.number().int().min(1).max(525600),
  }),
  z.object({
    type: z.literal("daily"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }),
  z.object({
    type: z.literal("weekly"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    weekday: z.number().int().min(0).max(6),
  }),
  z.object({
    type: z.literal("monthly"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    day: z.union([z.number().int().min(1).max(31), z.literal("last")]),
  }),
  z.object({ type: z.literal("cron"), expression: z.string().min(1).max(100) }),
]);
export const subscriptionSchema = z.object({
  id: z.string().max(100).optional(),
  revision: z.number().int().optional(),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(false),
  timezone: z.string().default("Asia/Shanghai"),
  filters: filtersSchema.default({
    providers: [],
    accounts: [],
    models: [],
    agents: [],
    sources: ["through", "direct", "reported"],
  }),
  schedule: scheduleSchema.default({ type: "daily", time: "22:00" }),
  route: z.object({
    primaryChannelId: z.string().min(1),
    backupChannelId: z.string().nullable().optional(),
  }),
  content: z.object({
    layout: z.string().default("table"),
    currency: z.enum(["USD", "CNY"]).default("USD"),
    usdCny: z.number().min(0).default(0),
    includeCache: z.boolean().default(true),
    hideAccountNames: z.boolean().default(false),
    blocks: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          type: z.string(),
          period: z.string().default("today"),
          grouping: z.enum(["account", "model"]).default("account"),
          title: z.string().max(100).default(""),
          fields: z
            .array(z.string())
            .max(30)
            .default(["calls", "errors", "tokens", "costUsd"]),
          sort: z.string().default("tokens"),
          limit: z.number().int().min(1).max(10000).nullable().default(null),
          from: z.string().optional(),
          to: z.string().optional(),
        }),
      )
      .min(1)
      .max(12),
  }),
  skipEmpty: z.boolean().default(true),
  catchUp: z.enum(["latest", "skip"]).default("latest"),
});
export function parse(schema, value) {
  const p = schema.safeParse(value);
  if (!p.success)
    throw new AppError(
      "配置校验失败",
      400,
      "validation_error",
      p.error.issues.map((x) => ({
        path: x.path.join("."),
        message: x.message,
      })),
    );
  return p.data;
}
export function validateSettings(value) {
  const s = parse(settingsSchema, value);
  dateInZone(Date.now(), s.timezone);
  invariant(s.currency !== "CNY" || s.usdCny > 0, "人民币显示需要配置美元汇率");
  if (s.gateway) {
    let u;
    try {
      u = new URL(s.gateway);
    } catch {
      throw new AppError("网关地址无效");
    }
    invariant(
      ["http:", "https:"].includes(u.protocol) && !u.username && !u.password,
      "网关地址仅支持 HTTP(S)，凭据请单独配置",
    );
  }
  return s;
}
export function validateSubscription(value, reg) {
  const s = parse(subscriptionSchema, value);
  dateInZone(Date.now(), s.timezone);
  invariant(
    s.route.primaryChannelId !== s.route.backupChannelId,
    "主备渠道不能相同",
  );
  invariant(
    s.content.currency !== "CNY" || s.content.usdCny > 0,
    "人民币显示需要配置汇率",
  );
  reg.layouts.get(s.content.layout);
  const ids = new Set();
  for (const b of s.content.blocks) {
    invariant(!ids.has(b.id), "区块 ID 重复");
    ids.add(b.id);
    const def = reg.blocks.get(b.type);
    if (def.source === "usage")
      invariant(b.fields.length > 0, "用量区块至少选择一个指标");
    reg.groupings.get(b.grouping);
    for (const f of b.fields) reg.metrics.get(f);
    invariant(
      PERIODS.some((p) => p.id === b.period),
      "统计周期无效",
    );
  }
  if (s.schedule.type === "cron") {
    invariant(
      s.schedule.expression.trim().split(/\s+/).length === 5,
      "cron 需要五个字段",
    );
    try {
      const c = new Cron(s.schedule.expression, {
        timezone: s.timezone,
        paused: true,
      });
      invariant(c.nextRun(), "cron 没有未来执行时间");
      c.stop();
    } catch (e) {
      throw new AppError("cron 无效：" + e.message);
    }
  }
  return s;
}
export function presets() {
  const base = {
    name: "今日账号用量",
    enabled: false,
    timezone: "Asia/Shanghai",
    schedule: { type: "daily", time: "22:00" },
    filters: {
      providers: [],
      accounts: [],
      models: [],
      agents: [],
      sources: ["through", "direct", "reported"],
    },
    route: { primaryChannelId: "", backupChannelId: null },
    skipEmpty: true,
    catchUp: "latest",
    content: {
      layout: "table",
      currency: "USD",
      usdCny: 0,
      includeCache: true,
      hideAccountNames: false,
      blocks: [],
    },
  };
  const block = (id, type, period = "today") => ({
    id,
    type,
    period,
    grouping: type === "model-table" ? "model" : "account",
    title: "",
    fields: ["calls", "errors", "tokens", "costUsd"],
    sort: "tokens",
    limit: null,
  });
  return [
    {
      ...structuredClone(base),
      content: {
        ...structuredClone(base.content),
        blocks: [block("today", "account-table"), block("quota", "quota")],
      },
    },
    {
      ...structuredClone(base),
      name: "每日综合日报",
      content: {
        ...structuredClone(base.content),
        blocks: [
          block("summary", "summary"),
          block("today", "account-table"),
          block("week", "model-table", "this-week"),
          block("month", "model-table", "this-month"),
          block("quota", "quota"),
          block("balance", "balance"),
          block("reset", "reset"),
        ],
      },
    },
    {
      ...structuredClone(base),
      name: "上周模型周报",
      schedule: { type: "weekly", weekday: 1, time: "09:00" },
      content: {
        ...structuredClone(base.content),
        blocks: [block("week", "model-table", "previous-week")],
      },
    },
  ];
}
