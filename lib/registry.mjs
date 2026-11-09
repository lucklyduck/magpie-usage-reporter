import { GROUPINGS } from "./domain/grouping.mjs";
import { PERIODS } from "./domain/periods.mjs";
import { AppError } from "./domain/errors.mjs";
export class Registry {
  constructor() {
    this.items = new Map();
  }
  add(def) {
    if (!def.id || this.items.has(def.id))
      throw new Error("重复或缺少注册 ID：" + def.id);
    this.items.set(def.id, def);
    return this;
  }
  get(id) {
    const v = this.items.get(id);
    if (!v)
      throw new AppError("未注册的功能：" + id, 400, "unsupported_option");
    return v;
  }
  list() {
    return [...this.items.values()];
  }
}
export function createRegistries() {
  const metrics = new Registry(),
    blocks = new Registry(),
    groupings = new Registry(),
    layouts = new Registry(),
    channels = new Registry(),
    renderers = new Registry();
  const defs = [
    ["calls", "调用", "number"],
    ["errors", "失败", "number"],
    ["retried", "重试", "number"],
    ["canceled", "取消", "number"],
    ["input", "输入", "number"],
    ["output", "输出", "number"],
    ["cacheRead", "缓存读", "number"],
    ["cacheWrite", "缓存写", "number"],
    ["reasoning", "推理（输出子集）", "number"],
    ["tokens", "总 Token", "number"],
    ["costUsd", "预估费用", "money"],
    ["unpriced", "未定价调用", "number"],
    ["errorRate", "错误率", "percent"],
    ["avgTtftMs", "平均首 Token 延迟", "ms"],
  ];
  for (const [id, label, type] of defs)
    metrics.add({
      id,
      label,
      type,
      groupings: ["account", "model"],
      defaultEnabled: ["calls", "errors", "tokens", "costUsd"].includes(id),
      value: (row) => row[id],
    });
  for (const d of GROUPINGS) groupings.add(d);
  for (const [id, label] of [
    ["summary", "用量概览"],
    ["account-table", "账号用量表"],
    ["model-table", "模型用量表"],
    ["quota", "当前额度"],
    ["balance", "当前余额"],
    ["reset", "重置时间"],
  ])
    blocks.add({
      id,
      label,
      source: ["quota", "balance", "reset"].includes(id) ? "quota" : "usage",
    });
  for (const [id, label] of [
    ["table", "等宽表格"],
    ["list", "详细列表"],
    ["compact", "简短摘要"],
  ])
    layouts.add({ id, label });
  return {
    metrics,
    blocks,
    groupings,
    layouts,
    channels,
    renderers,
    periods: PERIODS,
  };
}
export function capabilities(reg) {
  const strip = (items) =>
    items.map(({ send, build, value, render, ...item }) => item);
  return {
    schemaVersion: 1,
    metrics: strip(reg.metrics.list()),
    blocks: strip(reg.blocks.list()),
    groupings: strip(reg.groupings.list()),
    layouts: strip(reg.layouts.list()),
    channels: strip(reg.channels.list()),
    formats: ["text"],
    futureFormats: ["image", "attachment"],
    periods: reg.periods,
  };
}
