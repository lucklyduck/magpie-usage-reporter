import { accountKey, modelKey, matches, sum, finish } from "./stats.mjs";
import { invariant, AppError } from "./errors.mjs";
function aggregateTable(rows, mode, includeCache) {
  const groups = new Map();
  for (const row of rows) {
    const key =
      mode === "model"
        ? modelKey(row.provider, row.model)
        : accountKey(row.provider, row.account);
    const g = groups.get(key) || {
      provider: row.provider,
      providerName: row.providerName,
      label: mode === "model" ? row.model : row.accountName,
      account: row.account,
      model: row.model,
      kind: row.kind,
      _rows: [],
    };
    g._rows.push(row);
    groups.set(key, g);
  }
  return [...groups.values()].map(({ _rows, ...g }) => ({
    ...g,
    ...sum(_rows, includeCache),
  }));
}
export function selectCards(cards, filters = {}) {
  return cards.filter(
    (q) =>
      (!filters.providers?.length || filters.providers.includes(q.provider)) &&
      (!filters.accounts?.length ||
        filters.accounts.includes(accountKey(q.provider, q.account))),
  );
}
export class ReportBuilder {
  /** @param {{usage: import("../../types/contracts.d.ts").UsageSource, quotas: import("../../types/contracts.d.ts").QuotaSource, registries: any, clock?: import("../../types/contracts.d.ts").Clock}} dependencies */
  constructor({
    usage,
    quotas,
    registries,
    clock = { now: () => Date.now() },
  }) {
    this.usage = usage;
    this.quotas = quotas;
    this.registries = registries;
    this.clock = clock;
  }
  async build(spec, at = this.clock.now()) {
    const report = {
      id: "",
      title: spec.name,
      generatedAt: new Date(this.clock.now()).toISOString(),
      scheduledAt: new Date(at).toISOString(),
      timezone: spec.timezone,
      currency: spec.content.currency,
      usdCny: spec.content.usdCny,
      blocks: [],
      warnings: [],
      empty: true,
    };
    const snapshots = new Map();
    let quota;
    const dataFor = async (b) => {
      const key = JSON.stringify([b.period, b.from, b.to]);
      if (!snapshots.has(key))
        snapshots.set(
          key,
          this.usage.load({
            period: b.period,
            from: b.from,
            to: b.to,
            at,
            timezone: spec.timezone,
            filters: spec.filters,
            includeCache: spec.content.includeCache,
            fresh: true,
          }),
        );
      const data = await snapshots.get(key);
      if (data.state !== "complete")
        throw new AppError(
          "用量明细不完整，本次报告未发送",
          502,
          "incomplete_usage",
          data.warnings,
        );
      return data;
    };
    for (const b of spec.content.blocks) {
      const definition = this.registries.blocks.get(b.type);
      if (definition.build) {
        report.blocks.push(
          await definition.build({ spec, b, report, dataFor }),
        );
        report.empty = false;
        continue;
      }
      if (definition.source === "usage") {
        const data = await dataFor(b);
        let rows;
        if (b.type === "summary")
          rows = [{ label: "用量合计", ...data.totals }];
        else
          rows = aggregateTable(
            data.rows,
            b.type === "model-table" ? "model" : "account",
            spec.content.includeCache,
          );
        if (spec.content.hideAccountNames && b.type === "account-table")
          rows = rows.map((r, i) => ({ ...r, label: "账号 " + (i + 1) }));
        rows.sort((a, z) =>
          b.sort === "name"
            ? String(a.label).localeCompare(String(z.label))
            : (z[b.sort] || 0) - (a[b.sort] || 0),
        );
        const rest = b.limit ? rows.slice(b.limit) : [],
          visible = b.limit ? rows.slice(0, b.limit) : rows;
        report.blocks.push({
          id: b.id,
          type: b.type,
          title: b.title || definition.label,
          period: data.period,
          fields: b.fields,
          rows: visible,
          totals: data.totals,
          omitted: rest.length,
          rest: sum(rest, spec.content.includeCache),
        });
        report.empty = report.empty && data.rows.length === 0;
      } else {
        quota ??= await this.quotas.load();
        let cards = selectCards(quota.cards, spec.filters);
        if (spec.filters.models?.length || spec.filters.agents?.length) {
          const data = await dataFor({ ...b, period: "today" });
          const selected = new Set(
            data.rows.map((r) => accountKey(r.provider, r.account)),
          );
          cards = cards.filter((q) =>
            selected.has(accountKey(q.provider, q.account)),
          );
        }
        const lines = [];
        if (quota.state === "failed") {
          lines.push("额度读取失败：" + quota.error);
          report.warnings.push({ message: "额度读取失败，用量统计仍可用" });
          report.empty = false;
        }
        for (let i = 0; i < cards.length; i++) {
          const q = cards[i],
            name = spec.content.hideAccountNames
              ? "账号 " + (i + 1)
              : q.accountName;
          const prefix = (q.providerName || q.provider) + " / " + name;
          if (q.error) {
            lines.push(prefix + "：读取失败");
            continue;
          }
          const stamp =
            "（读取：" +
            (q.readAt || "时间未知") +
            (q.stale ? "，缓存" : "") +
            "）";
          if (b.type === "balance") {
            if (q.balance != null)
              lines.push(
                prefix +
                  "：" +
                  q.balance +
                  (q.sharedBalance
                    ? " [共享余额 " + q.sharedBalance + "]"
                    : "") +
                  " " +
                  stamp,
              );
            else {
              const wallets = q.windows.filter((w) => w.balance != null);
              if (!wallets.length) lines.push(prefix + "：未提供 " + stamp);
              for (const w of wallets)
                lines.push(
                  prefix +
                    " / " +
                    w.name +
                    "：" +
                    w.balance +
                    " " +
                    w.unit +
                    (w.pool || w.family ? " [共享余额]" : "") +
                    " " +
                    stamp,
                );
            }
          }
          if (b.type === "quota") {
            if (!q.windows.length) lines.push(prefix + "：额度未提供 " + stamp);
            for (const w of q.windows) {
              const expired =
                w.resetsAt && Date.parse(w.resetsAt) <= this.clock.now();
              const value = expired
                ? "旧窗口，等待刷新"
                : w.unlimited
                  ? "不限额"
                  : w.display ||
                    (w.used == null
                      ? "未提供"
                      : "已用 " +
                        w.used.toFixed(1) +
                        "%，剩余 " +
                        Math.max(0, 100 - w.used).toFixed(1) +
                        "%");
              lines.push(
                prefix +
                  " / " +
                  w.name +
                  "：" +
                  value +
                  (w.pool || w.family ? " [共享额度]" : "") +
                  " " +
                  stamp,
              );
            }
          }
          if (b.type === "reset") {
            if (!q.windows.length) lines.push(prefix + "：重置时间未提供");
            for (const w of q.windows)
              lines.push(
                prefix +
                  " / " +
                  w.name +
                  "：" +
                  (w.resetsAt || "未提供") +
                  " " +
                  stamp,
              );
          }
        }
        if (!cards.length && quota.state !== "failed")
          lines.push("选中范围没有可用的账号额度信息");
        report.blocks.push({
          id: b.id,
          type: b.type,
          title: b.title || definition.label,
          lines,
        });
        report.empty = report.empty && cards.length === 0;
      }
    }
    return report;
  }
}
