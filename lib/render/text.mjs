import stringWidth from "string-width";
export function formatMetric(value, def, row, report) {
  if (value == null) return "未提供";
  if (def.type === "money") {
    const n = Number(value) * (report.currency === "CNY" ? report.usdCny : 1);
    const s =
      (report.currency === "CNY" ? "¥" : "$") +
      n.toFixed(n > 0 && n < 0.01 ? 6 : 2);
    return row.unpriced > 0
      ? n === 0
        ? "未定价"
        : s + "（另有 " + row.unpriced + " 次未定价）"
      : s;
  }
  if (def.type === "percent") return Number(value).toFixed(1) + "%";
  if (def.type === "ms") return Math.round(value) + " ms";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 }).format(
    value,
  );
}
function oneLine(value) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ");
}
function shorten(text, max = 48) {
  let out = "";
  for (const c of oneLine(text)) {
    if (stringWidth(out + c) > max - 1) return out + "…";
    out += c;
  }
  return out;
}
function table(headers, rows) {
  const grid = [headers, ...rows].map((r) => r.map((v) => shorten(v)));
  const widths = headers.map((_, i) =>
    Math.max(...grid.map((r) => stringWidth(r[i] || ""))),
  );
  return grid
    .map(
      (r, i) =>
        r
          .map((cell, j) => cell + " ".repeat(widths[j] - stringWidth(cell)))
          .join(" | ") +
        (i === 0 ? "\n" + widths.map((w) => "-".repeat(w)).join("-+-") : ""),
    )
    .join("\n");
}
export function renderText(report, layout = "table", registries) {
  const lines = [
    report.title,
    "生成时间：" +
      new Intl.DateTimeFormat("zh-CN", {
        timeZone: report.timezone,
        dateStyle: "medium",
        timeStyle: "medium",
        hourCycle: "h23",
      }).format(new Date(report.generatedAt)),
    "时区：" + report.timezone,
    "",
  ];
  for (const block of report.blocks) {
    lines.push("【" + block.title + "】");
    if (block.period) lines.push(block.period.from + " 至 " + block.period.to);
    if (block.rows) {
      const defs = block.fields.map((id) => registries.metrics.get(id));
      const values = (row) =>
        defs.map((d) =>
          formatMetric(d.value ? d.value(row) : row[d.id], d, row, report),
        );
      const labels = (row) =>
        [
          row.providerName || row.provider,
          row.label || row.model || row.accountName,
        ]
          .filter(Boolean)
          .join(" / ");
      if (layout === "table")
        lines.push(
          table(
            ["项目", ...defs.map((d) => d.label)],
            block.rows.map((r) => [labels(r), ...values(r)]),
          ),
        );
      else
        for (const row of block.rows)
          lines.push(
            labels(row) +
              "\n" +
              defs
                .map((d, i) => d.label + "：" + values(row)[i])
                .join(layout === "compact" ? " · " : "\n"),
          );
      if (block.totals)
        lines.push(
          "范围合计：" +
            defs
              .map(
                (d) =>
                  d.label +
                  " " +
                  formatMetric(
                    d.value ? d.value(block.totals) : block.totals[d.id],
                    d,
                    block.totals,
                    report,
                  ),
              )
              .join(" · "),
        );
      if (block.omitted)
        lines.push(
          "另有 " +
            block.omitted +
            " 项未逐行显示；其余合计：" +
            defs
              .map(
                (d) =>
                  d.label +
                  " " +
                  formatMetric(
                    d.value ? d.value(block.rest) : block.rest[d.id],
                    d,
                    block.rest,
                    report,
                  ),
              )
              .join(" · "),
        );
    }
    if (block.lines) lines.push(...block.lines);
    lines.push("");
  }
  if (report.warnings.length)
    lines.push(
      "数据提示：" + report.warnings.map((x) => x.message || x).join("；"),
    );
  lines.push(
    "费用为 Magpie 价格估算；订阅实际支出另计。当前额度为账号整体最近读取状态。",
  );
  return lines.join("\n");
}
export function splitText(text, limit = 3500) {
  if (!Number.isInteger(limit) || limit < 100)
    throw new Error("消息长度限制无效");
  const result = [];
  let chunk = "";
  for (const line of String(text).split("\n")) {
    for (const c of line + "\n") {
      if (chunk.length + c.length > limit) {
        result.push(chunk.trimEnd());
        chunk = "";
      }
      chunk += c;
    }
  }
  if (chunk.trim()) result.push(chunk.trimEnd());
  return result.length ? result : [""];
}
export function payloads(report, text, adapter, config = {}) {
  const cap = adapter.capabilities.maxTextLength || 1000000;
  const limit = Math.min(Number(config.maxMessageLength) || cap, cap);
  const body = splitText(text, Math.max(100, limit - 100));
  return body.map((part, index) => ({
    title: report.title,
    text:
      (body.length > 1
        ? "[" +
          String(index + 1) +
          "/" +
          body.length +
          "] " +
          report.title +
          "\n"
        : "") + part,
    reportId: report.id,
    index,
    total: body.length,
    format: "text",
  }));
}
