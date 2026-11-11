// Loaded only after the serving backend supports this application's API.
import { createOriginalState, mountOriginal } from "./original-view.js";
import { formatCount } from "./display-format.js";
import { connectHost } from "./host.js";
const $ = (id) => document.getElementById(id);
const icons = {
  chart: '<path d="M3 13V8m5 5V3m5 10V6"/>',
  calendar:
    '<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M5 2v3m6-3v3M2.5 7h11"/>',
  send: '<path d="m2 7 11-5-3.5 12-2-5L2 7Zm5.5 2L13 2"/>',
  history: '<path d="M2.5 5v3h3M3 8a5.5 5.5 0 1 1 .5 4M8 4.5V8l2 1.5"/>',
  settings:
    '<path d="m6.5 2-.5 1.5-1.5.9-1.5-.3-1 2 1.1 1.2v1.4L2 9.9l1 2 1.5-.3 1.5.9.5 1.5h2l.5-1.5 1.5-.9 1.5.3 1-2-1.1-1.2V7.3L13 6.1l-1-2-1.5.3L9 3.5 8.5 2h-2Z"/><circle cx="7.5" cy="8" r="2"/>',
  tree: '<rect x="5.5" y="1.5" width="5" height="3" rx=".8"/><rect x="1" y="11.5" width="4" height="3" rx=".8"/><rect x="11" y="11.5" width="4" height="3" rx=".8"/><path d="M8 4.5V8m-5 3.5V9a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v2.5M8 8v3.5"/>',
  external:
    '<path d="M8 2h6v6m0-6-7 7M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/>',
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/>',
  close: '<path d="m3.5 3.5 9 9m0-9-9 9"/>',
};
function paintIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[el.dataset.icon] || ""}</svg>`;
  });
}
paintIcons();
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const token = document.querySelector('meta[name="usage-token"]').content;
const endpoint = (path) => new URL("api/v1/" + path, location.href);
const state = {
  page: "usage",
  usageView:
    new URLSearchParams(location.search).get("usageView") === "original"
      ? "original"
      : "enhanced",
  cap: null,
  settings: null,
  display: null,
  channels: [],
  subscriptions: [],
  data: null,
  columns: ["calls", "errors", "tokens", "costUsd"],
  grouping: "account",
  period: "today",
  sort: "tokens",
  filters: {
    providers: [],
    accounts: [],
    models: [],
    agents: [],
    sources: ["through", "direct", "reported"],
  },
  custom: {},
  includeCache: true,
  showZeroAccounts: true,
  editor: null,
  draft: null,
  request: 0,
};
const originalState = createOriginalState();
let originalView,
  usageController,
  settingsDirty = false,
  sessionExpired = false;
let host,
  readController = new AbortController(),
  refreshJob,
  refreshQueued = false,
  initialized = false;
const pageVisible = () => !document.hidden && (host?.visible ?? true);
document.addEventListener("input", (event) => {
  if (event.target.closest("#settings-form")) settingsDirty = true;
});
document.addEventListener("change", (event) => {
  if (event.target.closest("#settings-form")) settingsDirty = true;
});
function expiredConnection() {
  if (sessionExpired) return;
  sessionExpired = true;
  clearTimeout(refreshTimer);
  $("connection-expired").hidden = false;
  const url = new URL(location.href);
  if (
    !$("editor").open &&
    !(settingsDirty && $("settings-form")) &&
    url.searchParams.get("reconnected") !== "1"
  ) {
    url.searchParams.set("reconnected", "1");
    location.replace(url.href);
  }
}
const titles = {
  usage: ["用量", "按账号与模型查看消耗，以及账号当前额度。"],
  subscriptions: [
    "订阅",
    "选择报告内容和发送时间，配置一个主渠道与可选备用渠道。",
  ],
  channels: [
    "通知渠道",
    "配置机器人、邮箱或 Webhook，再发送测试消息验证连接。",
  ],
  deliveries: ["发送记录", "查看报告生成、主备切换、重试和消息确认。"],
  settings: ["设置", "调整统计、显示、刷新和历史记录设置。"],
};
const statuses = {
  pending: "待执行",
  waiting: "等待重试",
  building: "生成报告",
  sending: "发送中",
  sent: "已发送",
  failed: "失败",
  unknown: "结果未知",
  partial: "部分成功",
  skipped: "已跳过",
  canceled: "已取消",
};
const option = (id, label, selected) =>
  '<option value="' +
  esc(id) +
  '"' +
  (selected ? " selected" : "") +
  ">" +
  esc(label) +
  "</option>";
const field = (label, html, wide = false) =>
  '<label class="field' +
  (wide ? " wide" : "") +
  '"><span>' +
  esc(label) +
  "</span>" +
  html +
  "</label>";
const input = (name, value = "", type = "text", extra = "") =>
  '<input name="' +
  esc(name) +
  '" type="' +
  type +
  '" value="' +
  esc(value) +
  '" ' +
  extra +
  ">";
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), 4000);
}
function bindSaveForm(form, save) {
  const buttons = [...form.querySelectorAll('[type="submit"]')];
  let saving = false;
  const submit = async (event) => {
    // Magpie's sandbox blocks native submission before a submit event is
    // dispatched. Cancel the button's default action and call the API here.
    // Enter in an input activates the same default submit button.
    event.preventDefault();
    if (saving || !form.reportValidity()) return;
    saving = true;
    buttons.forEach((button) => (button.disabled = true));
    try {
      await save(form);
    } finally {
      saving = false;
      buttons.forEach((button) => (button.disabled = false));
    }
  };
  buttons.forEach((button) => button.addEventListener("click", submit));
  form.addEventListener("submit", submit);
}
async function api(path, method = "GET", body, options = {}) {
  if (sessionExpired)
    throw new Error("后台已重启，请重新连接后继续；未保存内容仍保留在当前页面");
  const r = await fetch(endpoint(path), {
    method,
    headers: {
      "X-Usage-Token": token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal:
      method === "GET"
        ? AbortSignal.any([
            readController.signal,
            ...(options.signal ? [options.signal] : []),
          ])
        : options.signal,
  });
  if (r.status === 401) expiredConnection();
  const value = await r.json();
  if (!r.ok) {
    const e = new Error(value.error?.message || "操作失败");
    e.details = value.error?.details;
    throw e;
  }
  return value;
}
function errorText(e) {
  return (
    e.message +
    (Array.isArray(e.details)
      ? "\n" +
        e.details
          .map((d) => (d.path ? d.path + "：" : "") + (d.message || ""))
          .join("\n")
      : "")
  );
}
function note(message = "") {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}
function metric(id, value, row = {}) {
  const display = state.display?.effective || state.settings;
  const d = state.cap.metrics.find((m) => m.id === id);
  if (value == null) return "未提供";
  if (d?.type === "money") {
    const n = Number(value) * (display.currency === "CNY" ? display.usdCny : 1);
    return row.unpriced > 0 && n === 0
      ? "未定价"
      : (display.currency === "CNY" ? "¥" : "$") +
          n.toFixed(n > 0 && n < 0.01 ? 6 : 2) +
          (row.unpriced ? " + 未定价" : "");
  }
  if (d?.type === "percent") return Number(value).toFixed(1) + "%";
  if (d?.type === "ms") return Math.round(value) + " ms";
  return formatCount(value, display.chineseUnits);
}
function badge(status) {
  return (
    '<span class="badge ' +
    (status === "sent"
      ? "good"
      : ["failed", "unknown", "partial"].includes(status)
        ? "bad"
        : status === "waiting"
          ? "warn"
          : "") +
    '">' +
    esc(statuses[status] || status) +
    "</span>"
  );
}
async function refreshLists() {
  [state.channels, state.subscriptions] = await Promise.all([
    api("channels"),
    api("subscriptions"),
  ]);
}
async function runtime() {
  try {
    const r = await api("status");
    $("runtime").innerHTML =
      "<i></i><span>" +
      (r.leader ? "后台运行中" : "等待宿主执行权") +
      "\n上次检查：" +
      (r.lastTick
        ? new Date(r.lastTick).toLocaleTimeString("zh-CN")
        : "尚未执行") +
      "</span>";
    $("runtime").classList.toggle("online", r.leader);
  } catch (error) {
    if (error.name === "AbortError") return;
    $("runtime").innerHTML = "<i></i><span>后台未连接</span>";
    $("runtime").classList.remove("online");
  }
}
function navigate(page) {
  disposeUsage();
  state.page = page;
  note();
  document.querySelectorAll("[data-page]").forEach((b) => {
    b.classList.toggle("active", b.dataset.page === page);
    if (b.dataset.page === page) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("page-title").textContent = titles[page][0];
  $("page-description").textContent = titles[page][1];
  renderPage().catch((e) => note(errorText(e)));
}
async function renderPage() {
  if (state.page !== "usage") disposeUsage();
  if (state.page === "usage") renderUsage();
  if (state.page === "subscriptions") {
    await refreshLists();
    renderSubscriptions();
  }
  if (state.page === "channels") {
    await refreshLists();
    renderChannels();
  }
  if (state.page === "deliveries") await renderDeliveries();
  if (state.page === "settings") renderSettings();
}
function availableFilterOptions(key, selected = []) {
  const items = [...(state.data?.options?.[key] || [])];
  for (const id of selected)
    if (!items.some((item) => item.id === id))
      items.push({ id, label: id + "（当前周期无记录／已不可用）" });
  return items;
}
function filterControls(filters, scope = "usage") {
  const opts = state.data?.options || {
    providers: [],
    accounts: [],
    models: [],
    agents: [],
  };
  return (
    '<div class="filter-grid">' +
    [
      ["providers", "供应商"],
      ["accounts", "账号"],
      ["models", "模型"],
      ["agents", "Agent"],
    ]
      .map(([key, label]) =>
        field(
          label,
          '<select multiple data-filter="' +
            key +
            '" data-scope="' +
            scope +
            '" aria-label="' +
            label +
            '筛选">' +
            availableFilterOptions(key, filters[key])
              .map((o) => option(o.id, o.label, filters[key]?.includes(o.id)))
              .join("") +
            "</select>",
        ),
      )
      .join("") +
    '</div><div class="check-grid">' +
    [
      ["through", "网关请求"],
      ["direct", "本地会话直连记录"],
      ["reported", "应用上报"],
    ]
      .map(
        ([id, label]) =>
          '<label><input type="checkbox" data-source="' +
          id +
          '" ' +
          (filters.sources?.includes(id) ? "checked" : "") +
          ">" +
          label +
          "</label>",
      )
      .join("") +
    '</div><p class="footer-note">多选列表为空表示不限制该项；不同维度同时生效。按 Ctrl / Command 可多选。</p></div>'
  );
}
function readFilters(root) {
  const f = {};
  root
    .querySelectorAll("[data-filter]")
    .forEach(
      (el) =>
        (f[el.dataset.filter] = [...el.selectedOptions].map((o) => o.value)),
    );
  f.sources = [...root.querySelectorAll("[data-source]:checked")].map(
    (el) => el.dataset.source,
  );
  return f;
}
function disposeUsage() {
  ++state.request;
  usageController?.abort();
  originalView?.dispose();
  originalView = null;
}
function renderUsage() {
  disposeUsage();
  const content = $("content");
  content.innerHTML =
    '<div class="usage-tabs segmented" role="tablist" aria-label="用量视图">' +
    [
      ["enhanced", "增强视图"],
      ["original", "原版用量树"],
    ]
      .map(
        ([id, label]) =>
          `<button role="tab" aria-selected="${state.usageView === id}" data-usage-view="${id}" class="${state.usageView === id ? "active" : ""}">${label}</button>`,
      )
      .join("") +
    '</div><div id="usage-view"></div>';
  content.querySelectorAll("[data-usage-view]").forEach((button) => {
    button.onclick = () => {
      state.usageView = button.dataset.usageView;
      renderUsage();
    };
  });
  if (state.usageView === "original") {
    originalView = mountOriginal($("usage-view"), {
      api,
      settings: { ...state.settings, ...state.display.effective },
      state: originalState,
    });
    return;
  }
  renderEnhancedUsage();
}
function renderEnhancedUsage() {
  const content = $("usage-view");
  content.innerHTML =
    '<div class="toolbar"><div class="segmented" aria-label="归类方式">' +
    [
      ["account", "按账号"],
      ["model", "按模型"],
    ]
      .map(
        ([id, t]) =>
          '<button data-grouping="' +
          id +
          '" class="' +
          (state.grouping === id ? "active" : "") +
          '">' +
          t +
          "</button>",
      )
      .join("") +
    '</div><label>周期 <select id="period">' +
    state.cap.periods
      .map((p) => option(p.id, p.label, state.period === p.id))
      .join("") +
    '</select></label><label>排序 <select id="sort">' +
    [
      ["tokens", "Token"],
      ["costUsd", "费用"],
      ["calls", "调用"],
      ["name", "名称"],
    ]
      .map(([id, t]) => option(id, t, state.sort === id))
      .join("") +
    '</select></label><label><input type="checkbox" id="cache-toggle" ' +
    (state.includeCache ? "checked" : "") +
    '> Token 含缓存</label><label><input type="checkbox" id="zero-toggle" ' +
    (state.showZeroAccounts ? "checked" : "") +
    "> 显示无调用账号</label></div>" +
    (state.period === "custom"
      ? '<div class="toolbar date-controls"><label>开始 ' +
        input("from", state.custom.from || "", "date") +
        "</label><label>结束 " +
        input("to", state.custom.to || "", "date") +
        '</label><button id="apply-dates" class="secondary">应用日期</button></div>'
      : "") +
    '<details class="filter-panel" id="usage-filters"><summary>筛选与显示列</summary><div class="filter-body">' +
    filterControls(state.filters) +
    '<div class="section-heading">显示列</div><div class="check-grid">' +
    state.cap.metrics
      .map(
        (m) =>
          '<label><input type="checkbox" data-column="' +
          m.id +
          '" ' +
          (state.columns.includes(m.id) ? "checked" : "") +
          ">" +
          esc(m.label) +
          "</label>",
      )
      .join("") +
    '</div><div class="actions" style="margin-top:16px"><button id="apply-filters">应用筛选</button><button id="reset-filters" class="secondary">清除筛选</button><button id="save-view" class="secondary">保存为默认显示</button></div></details>' +
    '<div id="usage-results">' +
    (state.data
      ? usageResults(state.data)
      : '<div class="empty">正在读取用量…</div>') +
    "</div>";
  $("period").onchange = (e) => {
    state.period = e.target.value;
    renderUsage();
  };
  $("sort").onchange = (e) => {
    state.sort = e.target.value;
    loadUsage();
  };
  $("cache-toggle").onchange = (e) => {
    state.includeCache = e.target.checked;
    loadUsage();
  };
  $("zero-toggle").onchange = (e) => {
    state.showZeroAccounts = e.target.checked;
    loadUsage();
  };
  content.querySelectorAll("[data-grouping]").forEach(
    (b) =>
      (b.onclick = () => {
        state.grouping = b.dataset.grouping;
        renderUsage();
      }),
  );
  if ($("apply-dates"))
    $("apply-dates").onclick = () => {
      state.custom = {
        from: content.querySelector('[name="from"]').value,
        to: content.querySelector('[name="to"]').value,
      };
      loadUsage();
    };
  $("apply-filters").onclick = () => {
    state.filters = readFilters($("usage-filters"));
    state.columns = [...content.querySelectorAll("[data-column]:checked")].map(
      (el) => el.dataset.column,
    );
    loadUsage();
  };
  $("reset-filters").onclick = () => {
    state.filters = {
      providers: [],
      accounts: [],
      models: [],
      agents: [],
      sources: ["through", "direct", "reported"],
    };
    renderUsage();
  };
  $("save-view").onclick = async () => {
    try {
      state.settings = await api("settings", "PATCH", {
        ...state.settings,
        preferences: {
          columns: state.columns,
          grouping: state.grouping,
          period: state.period === "custom" ? "today" : state.period,
          sort: state.sort,
        },
      });
      toast("默认显示已保存");
    } catch (e) {
      note(errorText(e));
    }
  };
  if (state.period !== "custom" || (state.custom.from && state.custom.to))
    void loadUsage();
}
async function loadUsage(fresh = false) {
  if (state.page !== "usage" || state.usageView !== "enhanced") return;
  usageController?.abort();
  usageController = new AbortController();
  const request = ++state.request,
    q = new URLSearchParams({
      period: state.period,
      grouping: state.grouping,
      sort: state.sort,
      includeCache: String(state.includeCache),
      showZeroAccounts: String(state.showZeroAccounts),
      ...state.custom,
    });
  for (const [key, value] of Object.entries(state.filters))
    q.set(key, JSON.stringify(value));
  if (fresh) q.set("fresh", "1");
  try {
    const data = await api("usage?" + q, "GET", undefined, {
      signal: usageController.signal,
    });
    if (
      request !== state.request ||
      state.page !== "usage" ||
      state.usageView !== "enhanced"
    )
      return;
    state.data = data;
    $("usage-results").innerHTML = usageResults(data);
    // Populate initially empty filter lists without disturbing selections or open state.
    for (const key of ["providers", "accounts", "models", "agents"]) {
      const el = $("usage-filters").querySelector(
        '[data-filter="' + key + '"]',
      );
      el.innerHTML = data.options[key]
        .map((o) => option(o.id, o.label, state.filters[key]?.includes(o.id)))
        .join("");
    }
    note(data.warnings?.map((w) => w.message).join("\n") || "");
  } catch (e) {
    if (request === state.request && e.name !== "AbortError")
      note(errorText(e));
  }
}
function usageResults(data) {
  const s = data.totals,
    cols = state.columns.length ? state.columns : ["calls"];
  const row = (item, label, cls) =>
    '<tr class="' +
    cls +
    '"><td class="name">' +
    label +
    "</td>" +
    cols.map((k) => "<td>" + esc(metric(k, item[k], item)) + "</td>").join("") +
    "</tr>";
  let body = "";
  for (const p of data.groups) {
    body += row(p, esc(p.label), "provider-row");
    for (const g of p.children) {
      body += row(
        g,
        esc(g.label) +
          (g.kind === "quota-only"
            ? '<span class="badge">无调用</span>'
            : g.kind === "api-key"
              ? '<span class="badge">API 密钥组</span>'
              : g.kind === "unknown"
                ? '<span class="badge">未知账号</span>'
                : ""),
        "group-row",
      );
      for (const leaf of g.children)
        body += row(
          leaf,
          '<span class="leaf-marker">↳</span>' + esc(leaf.label),
          "leaf-row",
        );
    }
  }
  return (
    '<section class="stats-strip" aria-label="用量概览">' +
    [
      ["调用", "calls", s.calls, "失败 " + s.errors + " · 重试 " + s.retried],
      [
        "Token",
        "tokens",
        s.tokens,
        state.includeCache ? "输入 + 输出 + 缓存" : "输入 + 输出",
      ],
      [
        "预估费用",
        "costUsd",
        s.costUsd,
        s.unpriced ? s.unpriced + " 次未定价" : "Magpie 价格估算",
      ],
      [
        "供应商",
        "calls",
        data.groups.length,
        new Set([
          ...data.rows.map((r) => JSON.stringify([r.provider, r.account])),
          ...data.quotas.cards.map((q) =>
            JSON.stringify([q.provider, q.account]),
          ),
        ]).size + " 个账号／统计组",
      ],
    ]
      .map(
        ([label, id, value, sub]) =>
          '<div class="stat"><span class="stat-label">' +
          label +
          '</span><strong class="stat-value">' +
          esc(metric(id, value, s)) +
          '</strong><span class="stat-sub">' +
          esc(sub) +
          "</span></div>",
      )
      .join("") +
    '</section><section class="panel"><div class="panel-title"><h2>' +
    esc(data.period.label) +
    " · " +
    (data.grouping === "account"
      ? "供应商 → 账号 → 模型"
      : "供应商 → 模型 → 账号") +
    '</h2><span class="muted">' +
    esc(data.period.from) +
    " — " +
    esc(data.period.to) +
    '</span></div><div class="table-wrap"><table><thead><tr><th>项目</th>' +
    cols
      .map(
        (k) =>
          "<th>" +
          esc(state.cap.metrics.find((m) => m.id === k)?.label || k) +
          "</th>",
      )
      .join("") +
    "</tr></thead><tbody>" +
    (body ||
      '<tr><td colspan="' +
        (cols.length + 1) +
        '" class="empty">当前范围没有调用记录</td></tr>') +
    '</tbody></table></div></section><section class="panel"><div class="panel-title"><h2>当前账号额度与余额</h2><span class="muted">账号整体状态，不按模型分摊</span></div>' +
    quotaCards(data.quotas) +
    '</section><p class="footer-note">用量读取：' +
    esc(data.generatedAt) +
    (data.stale ? " · 正在显示旧数据" : "") +
    " · 扫描 " +
    data.scanned +
    " 条匹配账本记录。费用为估算，积分保留供应商原单位。</p>"
  );
}
function quotaCards(q) {
  if (q.state === "failed")
    return '<div class="empty">额度读取失败：' + esc(q.error) + "</div>";
  if (!q.cards.length)
    return '<div class="empty">选中范围没有可用的额度信息</div>';
  return (
    '<div class="quota-grid">' +
    q.cards
      .map(
        (c) =>
          '<div class="quota-card"><div class="quota-card-head"><strong>' +
          esc(c.providerName) +
          " / " +
          esc(c.accountName) +
          "</strong></div>" +
          (c.error
            ? '<p class="form-error">额度读取失败</p>'
            : c.windows
                .map((w) => {
                  const expired =
                    w.resetsAt && Date.parse(w.resetsAt) <= Date.now();
                  return (
                    '<div class="quota-window"><div class="quota-window-head"><span>' +
                    esc(w.name) +
                    "</span><span>" +
                    esc(
                      expired
                        ? "旧窗口，等待刷新"
                        : w.unlimited
                          ? "不限额"
                          : w.display ||
                            (w.used == null
                              ? "未提供"
                              : "已用 " + w.used.toFixed(1) + "%"),
                    ) +
                    "</span></div>" +
                    (!expired && w.used != null
                      ? '<div class="progress"><span style="width:' +
                        Math.min(100, Math.max(0, w.used)) +
                        '%"></span></div>'
                      : "") +
                    "<small>重置：" +
                    esc(
                      w.resetsAt
                        ? new Date(w.resetsAt).toLocaleString("zh-CN")
                        : "未提供",
                    ) +
                    (w.pool || w.family ? " · 共享额度" : "") +
                    "</small></div>"
                  );
                })
                .join("")) +
          "<p>余额：" +
          esc(
            c.balance ??
              (c.windows
                .filter((w) => w.balance != null)
                .map((w) => w.name + " " + w.balance + " " + w.unit)
                .join(" · ") ||
                "未提供"),
          ) +
          (c.sharedBalance ? ' <span class="badge">共享余额</span>' : "") +
          "</p><small>读取：" +
          esc(
            c.readAt ? new Date(c.readAt).toLocaleString("zh-CN") : "时间未知",
          ) +
          (c.stale ? " · 缓存" : "") +
          "</small></div>",
      )
      .join("") +
    "</div>"
  );
}
function routeDescription(s) {
  const find = (id) =>
    state.channels.find((c) => c.id === id)?.name || "渠道已删除";
  return (
    find(s.route.primaryChannelId) +
    (s.route.backupChannelId ? " → 备用：" + find(s.route.backupChannelId) : "")
  );
}
function scheduleDescription(s) {
  const t = s.schedule;
  return t.type === "interval"
    ? "每 " + t.minutes + " 分钟"
    : t.type === "daily"
      ? "每日 " + t.time
      : t.type === "weekly"
        ? "每周" +
          ["日", "一", "二", "三", "四", "五", "六"][t.weekday] +
          " " +
          t.time
        : t.type === "monthly"
          ? "每月 " + (t.day === "last" ? "月末" : t.day + " 日") + " " + t.time
          : "cron " + t.expression;
}
function renderSubscriptions() {
  $("content").innerHTML =
    '<div class="page-top"><p>每份订阅使用一个主渠道，可选择备用渠道。</p><div class="actions"><select id="preset">' +
    state.cap.presets.map((p, i) => option(i, p.name, false)).join("") +
    '</select><button id="new-sub">新建订阅</button></div></div><section class="panel">' +
    (state.subscriptions.length
      ? state.subscriptions
          .map(
            (s) =>
              '<div class="list-card"><div class="list-card-main"><strong>' +
              esc(s.name) +
              '</strong><span class="badge ' +
              (s.enabled ? "good" : "") +
              '">' +
              (s.enabled ? "已启用" : "已停用") +
              "</span><p>" +
              esc(scheduleDescription(s)) +
              " · " +
              esc(s.timezone) +
              "</p><p>" +
              esc(routeDescription(s)) +
              " · " +
              s.content.blocks.length +
              ' 个内容区块</p></div><div class="actions"><button class="secondary small" data-action="edit-sub" data-id="' +
              s.id +
              '">编辑</button><button class="secondary small" data-action="copy-sub" data-id="' +
              s.id +
              '">复制</button><button class="secondary small" data-action="toggle-sub" data-id="' +
              s.id +
              '">' +
              (s.enabled ? "暂停" : "启用") +
              '</button><button class="small" data-action="send-sub" data-id="' +
              s.id +
              '">立即发送</button><button class="danger small" data-action="delete-sub" data-id="' +
              s.id +
              '">删除</button></div></div>',
          )
          .join("")
      : '<div class="empty">还没有订阅。配置通知渠道后，可从预设创建。</div>') +
    "</section>";
  $("new-sub").onclick = async () => {
    if (!state.channels.length) {
      toast("请先添加通知渠道");
      navigate("channels");
      return;
    }
    try {
      await refreshDisplay();
      const draft = structuredClone(state.cap.presets[+$("preset").value]);
      Object.assign(draft.content, state.display.effective);
      openSubscription(draft);
    } catch (error) {
      note(errorText(error));
    }
  };
}
function renderChannels() {
  $("content").innerHTML =
    '<div class="page-top"><p>凭据由后台保存，页面只显示是否已配置。</p><button id="new-channel">添加渠道</button></div><section class="panel">' +
    (state.channels.length
      ? state.channels
          .map(
            (c) =>
              '<div class="list-card"><div class="list-card-main"><strong>' +
              esc(c.name) +
              '</strong><span class="badge">' +
              esc(
                state.cap.channels.find((a) => a.id === c.type)?.label ||
                  c.type,
              ) +
              "</span><p>" +
              esc(channelTarget(c)) +
              "</p><small>" +
              (c.configured ? "凭据已配置" : "未配置凭据／无需认证") +
              '</small></div><div class="actions"><button class="secondary small" data-action="edit-channel" data-id="' +
              c.id +
              '">编辑</button><button class="small" data-action="test-channel" data-id="' +
              c.id +
              '">发送测试</button><button class="danger small" data-action="delete-channel" data-id="' +
              c.id +
              '">删除</button></div></div>',
          )
          .join("")
      : '<div class="empty">添加 Telegram、OneBot、SMTP 或 Webhook 发送目标。</div>') +
    "</section>";
  $("new-channel").onclick = () =>
    openChannel({ name: "", type: "telegram", config: {} });
}
function channelTarget(c) {
  return c.type === "telegram"
    ? "Chat ID " + c.config.chatId
    : c.type === "onebot11"
      ? (c.config.targetType === "group" ? "群聊 " : "私聊 ") +
        c.config.targetId
      : c.type === "smtp"
        ? c.config.to
        : c.config.url;
}
function htmlField(d, value, prefix = "") {
  const name = prefix + d.id;
  if (d.type === "select")
    return field(
      d.label,
      '<select name="' +
        esc(name) +
        '">' +
        d.options.map((o) => option(o.id, o.label, value === o.id)).join("") +
        "</select>",
    );
  return field(
    d.label,
    input(
      name,
      value ?? d.default ?? "",
      d.type === "number"
        ? "number"
        : d.type === "boolean"
          ? "checkbox"
          : "text",
      d.required ? "required" : "",
    ),
  );
}
function openChannel(draft) {
  state.editor = "channel";
  state.draft = structuredClone(draft);
  const d = state.draft,
    def = state.cap.channels.find((c) => c.id === d.type);
  $("editor-content").innerHTML =
    '<div class="dialog-head"><h2>' +
    (d.id ? "编辑渠道" : "添加通知渠道") +
    '</h2><button class="icon-only" data-close="editor" aria-label="关闭编辑器"><span data-icon="close"></span></button></div><form id="channel-form"><div class="form-grid">' +
    field("名称", input("name", d.name, "text", "required")) +
    field(
      "渠道类型",
      '<select name="type" ' +
        (d.id ? "disabled" : "") +
        ">" +
        state.cap.channels
          .map((c) => option(c.id, c.label, c.id === d.type))
          .join("") +
        "</select>",
    ) +
    def.fields
      .map((f) => htmlField(f, d.config[f.id] ?? f.default, "config."))
      .join("") +
    def.secretFields
      .map((f) =>
        field(
          f.label + (d.id ? "（留空保留）" : ""),
          input(
            "secret." + f.id,
            "",
            "password",
            'autocomplete="new-password"',
          ),
        ),
      )
      .join("") +
    '</div><p class="footer-note">测试消息由你点击“发送测试”后发出。保存配置不会发送。</p><div class="form-error" id="editor-error"></div><div class="editor-footer"><button type="button" class="secondary" data-close="editor">取消</button><button type="submit">保存渠道</button></div></form>';
  $("channel-form").elements.type.onchange = (e) => {
    openChannel({
      name: $("channel-form").elements.name.value,
      type: e.target.value,
      config: {},
    });
  };
  bindSaveForm($("channel-form"), async (form) => {
    const f = new FormData(form),
      config = {},
      secret = {};
    for (const field of def.fields)
      config[field.id] =
        field.type === "number"
          ? Number(f.get("config." + field.id))
          : String(f.get("config." + field.id) || "");
    for (const field of def.secretFields)
      if (f.get("secret." + field.id))
        secret[field.id] = f.get("secret." + field.id);
    try {
      await api(
        "channels" + (d.id ? "/" + d.id : ""),
        d.id ? "PATCH" : "POST",
        {
          name: f.get("name"),
          type: d.type,
          config,
          secret,
          revision: d.revision,
        },
      );
      $("editor").close();
      await refreshLists();
      renderChannels();
      toast("渠道已保存");
    } catch (error) {
      $("editor-error").textContent = errorText(error);
    }
  });
  if (!$("editor").open) $("editor").showModal();
  paintIcons($("editor"));
}
function readSubscription() {
  const f = $("subscription-form"),
    d = structuredClone(state.draft),
    v = new FormData(f);
  d.name = v.get("name");
  d.enabled = v.get("enabled") === "on";
  d.timezone = v.get("timezone");
  d.route = {
    primaryChannelId: v.get("primary"),
    backupChannelId: v.get("backup") || null,
  };
  d.filters = readFilters(f.querySelector("#subscription-filters"));
  const type = v.get("scheduleType");
  d.schedule =
    type === "interval"
      ? { type, minutes: Number(v.get("minutes")) }
      : type === "cron"
        ? { type, expression: v.get("expression") }
        : type === "weekly"
          ? { type, time: v.get("time"), weekday: Number(v.get("weekday")) }
          : type === "monthly"
            ? {
                type,
                time: v.get("time"),
                day: v.get("day") === "last" ? "last" : Number(v.get("day")),
              }
            : { type: "daily", time: v.get("time") };
  d.content.layout = v.get("layout");
  d.content.currency = v.get("currency");
  d.content.usdCny = Number(v.get("usdCny"));
  if (v.get("chineseUnits") === "legacy") delete d.content.chineseUnits;
  else d.content.chineseUnits = v.get("chineseUnits") === "chinese";
  d.content.includeCache = v.get("includeCache") === "on";
  d.content.hideAccountNames = v.get("hideAccountNames") === "on";
  d.skipEmpty = v.get("skipEmpty") === "on";
  d.catchUp = v.get("catchUp");
  d.content.blocks = [...f.querySelectorAll(".block")].map((el) => ({
    id: el.dataset.id,
    type: el.querySelector('[name="blockType"]').value,
    title: el.querySelector('[name="blockTitle"]').value,
    period: el.querySelector('[name="blockPeriod"]')?.value || "today",
    grouping:
      el.querySelector('[name="blockType"]').value === "model-table"
        ? "model"
        : "account",
    fields: [...el.querySelectorAll("[data-metric]:checked")].map(
      (e) => e.dataset.metric,
    ),
    sort: el.querySelector('[name="blockSort"]')?.value || "tokens",
    limit: el.querySelector('[name="blockLimit"]')?.value
      ? Number(el.querySelector('[name="blockLimit"]').value)
      : null,
    from: el.querySelector('[name="blockFrom"]')?.value || undefined,
    to: el.querySelector('[name="blockTo"]')?.value || undefined,
  }));
  return d;
}
function scheduleInputs(s) {
  if (s.type === "interval")
    return field(
      "间隔（分钟，最少 1）",
      input("minutes", s.minutes || 60, "number", 'min="1" required'),
    );
  if (s.type === "cron")
    return field(
      "五字段 cron",
      input("expression", s.expression || "0 22 * * *", "text", "required"),
    );
  let html = field(
    "发送时间",
    input("time", s.time || "22:00", "time", "required"),
  );
  if (s.type === "weekly")
    html += field(
      "星期",
      '<select name="weekday">' +
        ["日", "一", "二", "三", "四", "五", "六"]
          .map((w, i) => option(i, "周" + w, s.weekday === i))
          .join("") +
        "</select>",
    );
  if (s.type === "monthly")
    html += field(
      "日期",
      '<select name="day">' +
        Array.from({ length: 31 }, (_, i) =>
          option(i + 1, i + 1 + " 日", s.day === i + 1),
        ).join("") +
        option("last", "月末", s.day === "last") +
        "</select>",
    );
  return html;
}
function blockHTML(b, index) {
  const def = state.cap.blocks.find((d) => d.id === b.type),
    usage = def.source === "usage";
  const order = [
    ...b.fields,
    ...state.cap.metrics
      .map((m) => m.id)
      .filter((id) => !b.fields.includes(id)),
  ];
  return (
    '<section class="block" data-id="' +
    esc(b.id) +
    '"><div class="block-head"><select name="blockType" aria-label="区块类型">' +
    state.cap.blocks
      .map((t) => option(t.id, t.label, t.id === b.type))
      .join("") +
    '</select><button type="button" class="secondary small" data-block="up" data-index="' +
    index +
    '" aria-label="上移区块">↑</button><button type="button" class="secondary small" data-block="down" data-index="' +
    index +
    '" aria-label="下移区块">↓</button><button type="button" class="danger small" data-block="remove" data-index="' +
    index +
    '">移除</button></div><div class="form-grid">' +
    field("区块标题（可留空）", input("blockTitle", b.title || "")) +
    (usage
      ? field(
          "统计周期",
          '<select name="blockPeriod">' +
            state.cap.periods
              .map((p) => option(p.id, p.label, p.id === b.period))
              .join("") +
            "</select>",
        ) +
        field(
          "排序",
          '<select name="blockSort">' +
            [
              ["tokens", "Token"],
              ["costUsd", "费用"],
              ["calls", "调用"],
              ["name", "名称"],
            ]
              .map(([id, t]) => option(id, t, b.sort === id))
              .join("") +
            "</select>",
        ) +
        field(
          "最多显示行数（留空显示全部）",
          input("blockLimit", b.limit || "", "number", 'min="1"'),
        ) +
        (b.period === "custom"
          ? field("开始日期", input("blockFrom", b.from || "", "date")) +
            field("结束日期", input("blockTo", b.to || "", "date"))
          : "")
      : "") +
    "</div>" +
    (usage
      ? '<div class="metric-options">' +
        order
          .map((id) => {
            const m = state.cap.metrics.find((d) => d.id === id);
            return (
              '<label class="metric-option"><input type="checkbox" data-metric="' +
              id +
              '" ' +
              (b.fields.includes(id) ? "checked" : "") +
              ">" +
              esc(m.label) +
              '<button type="button" data-metric-up="' +
              id +
              '" data-index="' +
              index +
              '" aria-label="上移' +
              esc(m.label) +
              '">↑</button></label>'
            );
          })
          .join("") +
        "</div>"
      : '<p class="footer-note">显示账号整体最近读取状态，并注明读取时间。</p>') +
    "</section>"
  );
}
function openSubscription(draft) {
  state.editor = "subscription";
  state.draft = structuredClone(draft);
  const d = state.draft;
  if (!d.route.primaryChannelId && state.channels.length)
    d.route.primaryChannelId = state.channels[0].id;
  $("editor-content").innerHTML =
    '<div class="dialog-head"><h2>' +
    (d.id ? "编辑订阅" : "新建订阅") +
    '</h2><button class="icon-only" data-close="editor" aria-label="关闭编辑器"><span data-icon="close"></span></button></div><form id="subscription-form"><div class="form-grid">' +
    field("订阅名称", input("name", d.name, "text", "required")) +
    field("时区", input("timezone", d.timezone, "text", "required")) +
    field(
      "主渠道",
      '<select name="primary" required>' +
        option("", "请选择", !d.route.primaryChannelId) +
        state.channels
          .map((c) => option(c.id, c.name, d.route.primaryChannelId === c.id))
          .join("") +
        "</select>",
    ) +
    field(
      "备用渠道",
      '<select name="backup">' +
        option("", "不使用备用渠道", !d.route.backupChannelId) +
        state.channels
          .map((c) => option(c.id, c.name, d.route.backupChannelId === c.id))
          .join("") +
        "</select>",
    ) +
    '</div><div class="section-heading">发送时间</div><div class="form-grid">' +
    field(
      "触发方式",
      '<select name="scheduleType">' +
        [
          ["interval", "固定间隔"],
          ["daily", "每日"],
          ["weekly", "每周"],
          ["monthly", "每月"],
          ["cron", "高级 cron"],
        ]
          .map(([id, t]) => option(id, t, d.schedule.type === id))
          .join("") +
        "</select>",
    ) +
    scheduleInputs(d.schedule) +
    '</div><details class="filter-panel" id="subscription-filters"><summary>数据范围</summary><div class="filter-body">' +
    filterControls(d.filters, "subscription") +
    '</details><div class="section-heading">报表内容</div><div class="form-grid">' +
    field(
      "文字布局",
      '<select name="layout">' +
        state.cap.layouts
          .map((l) => option(l.id, l.label, l.id === d.content.layout))
          .join("") +
        "</select>",
    ) +
    field(
      "币种",
      '<select name="currency">' +
        option("USD", "美元", d.content.currency === "USD") +
        option("CNY", "人民币", d.content.currency === "CNY") +
        "</select>",
    ) +
    field(
      "美元兑人民币汇率",
      input("usdCny", d.content.usdCny || 0, "number", 'min="0" step="0.0001"'),
    ) +
    field(
      "数字单位",
      '<select name="chineseUnits">' +
        (d.content.chineseUnits === undefined
          ? option("legacy", "保留原格式", true)
          : "") +
        option("western", "K / M / B", d.content.chineseUnits === false) +
        option("chinese", "万 / 亿", d.content.chineseUnits === true) +
        "</select>",
    ) +
    '</div><div class="check-grid"><label><input name="includeCache" type="checkbox" ' +
    (d.content.includeCache ? "checked" : "") +
    '> Token 含缓存</label><label><input name="hideAccountNames" type="checkbox" ' +
    (d.content.hideAccountNames ? "checked" : "") +
    '> 隐藏账号名称</label></div><div id="blocks">' +
    d.content.blocks.map(blockHTML).join("") +
    '</div><button type="button" id="add-block" class="secondary">＋ 添加内容区块</button><div class="section-heading">运行选项</div><div class="form-grid">' +
    field(
      "错过执行时",
      '<select name="catchUp">' +
        option("latest", "恢复后补最近一份", d.catchUp === "latest") +
        option("skip", "跳过错过的执行", d.catchUp === "skip") +
        "</select>",
    ) +
    '</div><div class="check-grid"><label><input name="skipEmpty" type="checkbox" ' +
    (d.skipEmpty ? "checked" : "") +
    '> 全部内容为空时跳过</label><label><input name="enabled" type="checkbox" ' +
    (d.enabled ? "checked" : "") +
    '> 启用定时发送</label></div><div class="form-error" id="editor-error"></div><div class="editor-footer"><button type="button" class="secondary" data-close="editor">取消</button><button type="button" class="secondary" id="preview-sub">预览</button><button type="submit">保存订阅</button></div></form>';
  const form = $("subscription-form");
  form.elements.scheduleType.onchange = () => {
    const n = readSubscription();
    n.schedule = {
      type: form.elements.scheduleType.value,
      time: "22:00",
      minutes: 60,
      weekday: 1,
      day: 1,
      expression: "0 22 * * *",
    };
    openSubscription(n);
  };
  form.querySelectorAll('[name="blockType"],[name="blockPeriod"]').forEach(
    (e) =>
      (e.onchange = () => {
        const next = readSubscription();
        for (const block of next.content.blocks) {
          if (
            state.cap.blocks.find((d) => d.id === block.type)?.source ===
              "usage" &&
            !block.fields.length
          )
            block.fields = ["calls", "errors", "tokens", "costUsd"];
        }
        openSubscription(next);
      }),
  );
  form.querySelectorAll("[data-block]").forEach(
    (b) =>
      (b.onclick = () => {
        const n = readSubscription(),
          i = +b.dataset.index,
          j = b.dataset.block === "up" ? i - 1 : i + 1;
        if (b.dataset.block === "remove") n.content.blocks.splice(i, 1);
        else if (j >= 0 && j < n.content.blocks.length)
          [n.content.blocks[i], n.content.blocks[j]] = [
            n.content.blocks[j],
            n.content.blocks[i],
          ];
        openSubscription(n);
      }),
  );
  form.querySelectorAll("[data-metric-up]").forEach(
    (b) =>
      (b.onclick = () => {
        const n = readSubscription(),
          fields = n.content.blocks[+b.dataset.index].fields,
          i = fields.indexOf(b.dataset.metricUp);
        if (i > 0) [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]];
        openSubscription(n);
      }),
  );
  $("add-block").onclick = () => {
    const n = readSubscription();
    n.content.blocks.push({
      id: crypto.randomUUID(),
      type: "summary",
      period: "today",
      grouping: "account",
      title: "",
      fields: ["calls", "errors", "tokens", "costUsd"],
      sort: "tokens",
      limit: null,
    });
    openSubscription(n);
  };
  $("preview-sub").onclick = async () => {
    try {
      const p = await api("reports/preview", "POST", readSubscription());
      showPreview(p);
    } catch (e) {
      $("editor-error").textContent = errorText(e);
    }
  };
  bindSaveForm(form, async () => {
    try {
      const n = readSubscription();
      await api(
        "subscriptions" + (n.id ? "/" + n.id : ""),
        n.id ? "PATCH" : "POST",
        n,
      );
      $("editor").close();
      await refreshLists();
      renderSubscriptions();
      toast("订阅已保存");
    } catch (error) {
      $("editor-error").textContent = errorText(error);
    }
  });
  if (!$("editor").open) $("editor").showModal();
  paintIcons($("editor"));
}
function showPreview(p) {
  showReportContent({
    text: p.text,
    channels: p.channels.map(
      (c) => c.role + "：" + c.name + " · " + c.parts.length + " 条消息",
    ),
  });
}
function showDelivery(job) {
  showReportContent({
    title: "发送详情",
    text: job.text,
    emptyText: job.report ? "暂无报告内容" : "报告尚未生成",
    error: job.lastError,
    events: job.events,
    channels: (job.channels || []).map((c, index) => {
      const confirmed = (job.receipts || []).filter(
        (r) => r.channelId === c.id,
      ).length;
      const total =
        index === job.stage && Array.isArray(job.parts)
          ? " / 共 " + job.parts.length + " 条"
          : "";
      return (
        (index === 0 ? "主渠道" : "备用渠道") +
        "：" +
        c.name +
        " · " +
        confirmed +
        " 条消息已确认" +
        total
      );
    }),
  });
}
function showReportContent({
  title = "报表预览",
  channels = [],
  text,
  emptyText = "暂无报告内容",
  error,
  events = [],
}) {
  $("preview-title").textContent = title;
  $("preview-content").innerHTML =
    (channels.length
      ? '<div class="check-grid preview-channels">' +
        channels
          .map((label) => '<span class="badge">' + esc(label) + "</span>")
          .join("") +
        "</div>"
      : "") +
    (error ? '<p class="footer-note">' + esc(error) + "</p>" : "") +
    '<pre class="preview-text">' +
    esc(text || emptyText) +
    "</pre>" +
    (events.length
      ? '<p class="footer-note">' +
        events
          .map((e) =>
            esc(new Date(e.at).toLocaleString("zh-CN") + " " + e.message),
          )
          .join("<br>") +
        "</p>"
      : "");
  $("preview").showModal();
}
async function renderDeliveries() {
  const jobs = await api("deliveries");
  if (state.page !== "deliveries") return;
  $("content").innerHTML =
    '<div class="page-top"><p>结果未知时，请先核对接收端；手动重试可能再次投递。</p></div><section class="panel">' +
    (jobs.length
      ? jobs
          .map(
            (j) =>
              '<div class="list-card"><div class="list-card-main"><strong>' +
              esc(j.subscription?.name || "渠道测试") +
              "</strong>" +
              badge(j.status) +
              "<p>" +
              esc(new Date(j.createdAt).toLocaleString("zh-CN")) +
              " · " +
              esc(j.channels[j.stage]?.name || "") +
              "</p><p>" +
              esc(j.lastError || j.receipts.length + " 条消息已确认") +
              '</p></div><div class="actions"><button class="secondary small" data-action="detail-job" data-id="' +
              j.id +
              '">详情</button>' +
              (["unknown", "partial", "failed"].includes(j.status)
                ? '<button class="small" data-action="retry-job" data-id="' +
                  j.id +
                  '">重试</button>'
                : "") +
              (!["sent", "skipped", "canceled", "sending"].includes(j.status)
                ? '<button class="secondary small" data-action="cancel-job" data-id="' +
                  j.id +
                  '">结束任务</button>'
                : "") +
              "</div></div>",
          )
          .join("")
      : '<div class="empty">尚无发送记录。</div>') +
    "</section>";
}
function renderSettings() {
  const s = state.settings,
    defs = state.cap.settingsFields;
  const displayKeys = new Set([
    "displayMode",
    "currency",
    "usdCny",
    "chineseUnits",
  ]);
  const control = (d) => {
    if (d.type === "boolean")
      return (
        '<label class="toggle-label">' +
        input(d.id, "", "checkbox", s[d.id] ? "checked" : "") +
        esc(d.label) +
        "</label>"
      );
    if (d.type === "select")
      return field(
        d.label,
        '<select name="' +
          esc(d.id) +
          '">' +
          d.options
            .map((o) => option(o.id, o.label, s[d.id] === o.id))
            .join("") +
          "</select>",
      );
    const extra = [
      d.min !== undefined ? 'min="' + d.min + '"' : "",
      d.max !== undefined ? 'max="' + d.max + '"' : "",
      d.step !== undefined ? 'step="' + d.step + '"' : "",
    ].join(" ");
    return field(
      d.label,
      input(d.id, s[d.id], d.type === "number" ? "number" : "text", extra),
    );
  };
  $("content").innerHTML =
    '<form id="settings-form" class="panel settings-panel"><h2>显示设置</h2><div class="form-grid">' +
    defs
      .filter((d) => displayKeys.has(d.id))
      .map(control)
      .join("") +
    '</div><p id="display-effective" class="footer-note" role="status"></p><h2>常规设置</h2><div class="form-grid">' +
    defs
      .filter((d) => !displayKeys.has(d.id))
      .map(control)
      .join("") +
    '</div><p class="footer-note">后台随 Magpie 插件宿主运行。页面关闭后仍执行；宿主停止期间不发送，恢复后按订阅规则处理。</p><div class="form-error" id="settings-error"></div><button type="submit">保存设置</button></form>';
  const form = $("settings-form");
  let custom = {
    currency: s.currency,
    usdCny: s.usdCny,
    chineseUnits: s.chineseUnits,
  };
  let mode = s.displayMode;
  const readCustom = () => {
    custom = {
      currency: form.elements.currency.value,
      usdCny: Number(form.elements.usdCny.value),
      chineseUnits: form.elements.chineseUnits.checked,
    };
  };
  const paintDisplay = (resetCustom = false) => {
    const value = mode === "magpie" ? state.display.magpie.effective : custom;
    for (const key of ["currency", "usdCny", "chineseUnits"]) {
      const element = form.elements[key];
      element.disabled = mode === "magpie";
      if (mode === "magpie" || resetCustom) {
        if (key === "chineseUnits") element.checked = value[key];
        else element.value = value[key];
      }
    }
    form.elements.usdCny.required =
      mode === "custom" && form.elements.currency.value === "CNY";
    form.elements.usdCny.min = form.elements.usdCny.required ? "0.0001" : "0";
    const snapshot = mode === "magpie" ? state.display.magpie : state.display;
    $("display-effective").textContent =
      (mode === "magpie" ? "Magpie 当前显示：" : "当前已保存显示：") +
      displayDescription(
        snapshot,
        mode === "magpie" ? "magpie" : state.display.mode,
      );
  };
  form.elements.displayMode.onchange = () => {
    if (mode === "custom") readCustom();
    mode = form.elements.displayMode.value;
    paintDisplay(true);
  };
  form.elements.currency.onchange = () => {
    readCustom();
    paintDisplay();
  };
  form.updateDisplay = paintDisplay;
  paintDisplay(true);
  bindSaveForm(form, async () => {
    if (mode === "custom") readCustom();
    const v = new FormData(form),
      patch = { ...state.settings, ...custom, displayMode: mode };
    for (const d of defs.filter((d) => !displayKeys.has(d.id)))
      patch[d.id] =
        d.type === "boolean"
          ? v.get(d.id) === "on"
          : d.type === "number"
            ? Number(v.get(d.id))
            : v.get(d.id);
    try {
      state.settings = await api("settings", "PATCH", patch);
      await refreshDisplay();
      scheduleRefresh();
      toast("设置已保存");
      settingsDirty = false;
    } catch (error) {
      $("settings-error").textContent = errorText(error);
    }
  });
}
function displayDescription(
  snapshot,
  mode = snapshot.mode || state.settings.displayMode,
) {
  const value = snapshot.effective;
  return (
    `${mode === "magpie" ? "跟随 Magpie" : "自定义"} · ${value.currency} · 美元汇率 ${value.usdCny} · ${value.chineseUnits ? "万／亿" : "K/M/B"}` +
    (snapshot.rate.at
      ? ` · 汇率读取于 ${new Date(snapshot.rate.at).toLocaleString("zh-CN")}`
      : "") +
    (snapshot.rate.stale ? " · 汇率为备用值或已过期" : "") +
    (snapshot.warnings.length
      ? "\n" + snapshot.warnings.map((w) => w.message).join("；")
      : "")
  );
}
async function refreshDisplay() {
  const next = await api("display");
  const changed =
    JSON.stringify(state.display?.effective) !== JSON.stringify(next.effective);
  state.display = next;
  if ($("display-status"))
    $("display-status").textContent = displayDescription(next);
  if ($("settings-form")) $("settings-form").updateDisplay?.();
  if (changed && state.page === "usage") {
    if (state.usageView === "original")
      originalView?.updateDisplay({ ...state.settings, ...next.effective });
    else if (state.data && $("usage-results"))
      $("usage-results").innerHTML = usageResults(state.data);
  }
}
async function confirmAction(title, message) {
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("confirm").showModal();
  return new Promise((resolve) => {
    $("confirm-yes").onclick = () => {
      $("confirm").close();
      resolve(true);
    };
    $("confirm-no").onclick = () => {
      $("confirm").close();
      resolve(false);
    };
    $("confirm").oncancel = () => resolve(false);
  });
}
document.addEventListener("click", async (event) => {
  const close = event.target.closest("[data-close]");
  if (close) {
    $(close.dataset.close).close();
    return;
  }
  const nav = event.target.closest("[data-page]");
  if (nav) {
    navigate(nav.dataset.page);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === "edit-sub")
      openSubscription(state.subscriptions.find((s) => s.id === id));
    if (action === "copy-sub") {
      const s = structuredClone(state.subscriptions.find((s) => s.id === id));
      delete s.id;
      delete s.revision;
      s.enabled = false;
      s.name += " 副本";
      openSubscription(s);
    }
    if (action === "toggle-sub") {
      const s = state.subscriptions.find((s) => s.id === id);
      await api("subscriptions/" + id, "PATCH", { ...s, enabled: !s.enabled });
      await refreshLists();
      renderSubscriptions();
    }
    if (
      action === "send-sub" &&
      (await confirmAction(
        "立即发送",
        "将按保存的内容发送到订阅的主渠道，失败时按规则使用备用渠道。",
      ))
    ) {
      await api("subscriptions/" + id + "/send", "POST", {});
      toast("发送任务已创建");
      navigate("deliveries");
    }
    if (
      action === "delete-sub" &&
      (await confirmAction(
        "删除订阅",
        "删除该订阅并取消尚未发送的任务。历史发送记录保留。",
      ))
    ) {
      await api("subscriptions/" + id, "DELETE");
      await refreshLists();
      renderSubscriptions();
    }
    if (action === "edit-channel")
      openChannel(state.channels.find((c) => c.id === id));
    if (
      action === "test-channel" &&
      (await confirmAction(
        "发送测试消息",
        "将向“" +
          state.channels.find((c) => c.id === id).name +
          "”发送一条文字测试消息。",
      ))
    ) {
      await api("channels/" + id + "/test", "POST", {});
      toast("测试任务已创建");
      navigate("deliveries");
    }
    if (
      action === "delete-channel" &&
      (await confirmAction(
        "删除渠道",
        "删除该渠道及保存的凭据。仍被订阅引用的渠道无法删除。",
      ))
    ) {
      await api("channels/" + id, "DELETE");
      await refreshLists();
      renderChannels();
    }
    if (action === "detail-job") {
      const j = await api("deliveries/" + id);
      showDelivery(j);
    }
    if (
      action === "retry-job" &&
      (await confirmAction(
        "重试投递",
        "结果未知时，接收端可能已经收到。确认再次尝试当前渠道的未确认部分？",
      ))
    ) {
      await api("deliveries/" + id + "/retry", "POST", {});
      await renderDeliveries();
    }
    if (action === "cancel-job") {
      await api("deliveries/" + id + "/cancel", "POST", {});
      await renderDeliveries();
    }
  } catch (e) {
    note(errorText(e));
  }
});
$("refresh").onclick = async () => {
  $("refresh").classList.add("loading");
  $("refresh").disabled = true;
  try {
    await refreshDisplay();
    if (state.page === "usage") {
      if (state.usageView === "original") await originalView?.refresh(true);
      else await loadUsage(true);
    } else await renderPage();
    await runtime();
  } catch (e) {
    note(errorText(e));
  } finally {
    $("refresh").classList.remove("loading");
    $("refresh").disabled = false;
  }
};
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!initialized || !pageVisible() || sessionExpired) return;
  refreshTimer = setTimeout(
    () => void refreshVisible(),
    Math.max(15, state.settings.refreshSeconds) * 1000,
  );
}
function refreshVisible() {
  if (!initialized || !pageVisible() || sessionExpired)
    return Promise.resolve();
  if (refreshJob) {
    refreshQueued = true;
    return refreshJob;
  }
  const controller = readController,
    page = state.page;
  refreshJob = (async () => {
    await Promise.all([runtime(), refreshDisplay()]);
    if (controller.signal.aborted || !pageVisible() || page !== state.page)
      return;
    if (state.page === "usage" && !$("editor").open) {
      if (state.usageView === "original") await originalView?.refresh();
      else await loadUsage();
    }
    if (state.page === "deliveries" && !$("preview").open)
      await renderDeliveries();
  })()
    .catch((error) => {
      if (error.name !== "AbortError" && !sessionExpired)
        note(errorText(error));
    })
    .finally(() => {
      refreshJob = null;
      scheduleRefresh();
      if (refreshQueued) {
        refreshQueued = false;
        void refreshVisible();
      }
    });
  return refreshJob;
}
function visibilityChanged() {
  clearTimeout(refreshTimer);
  if (!initialized) return;
  if (!pageVisible()) {
    refreshQueued = false;
    readController.abort();
    readController = new AbortController();
    usageController?.abort();
    originalView?.cancelRefresh();
  } else if (initialized) void refreshVisible();
}
host = connectHost({ onVisibility: visibilityChanged });
document.addEventListener("visibilitychange", visibilityChanged);
addEventListener("pagehide", () => {
  initialized = false;
  clearTimeout(refreshTimer);
  readController.abort();
  host.dispose();
});
$("reconnect").onclick = () => {
  const url = new URL(location.href);
  url.searchParams.delete("reconnected");
  location.replace(url.href);
};
try {
  [state.cap, state.settings, state.display] = await Promise.all([
    api("capabilities"),
    api("settings"),
    api("display"),
  ]);
  await refreshLists();
  const p = state.settings.preferences;
  if (p) {
    state.columns = p.columns;
    state.grouping = p.grouping;
    state.period = p.period;
    state.sort = p.sort;
  }
  state.includeCache = state.settings.includeCache;
  state.showZeroAccounts = state.settings.showZeroAccounts;
  await renderPage();
  initialized = true;
  $("display-status").textContent = displayDescription(state.display);
  if (pageVisible()) void runtime();
  scheduleRefresh();
} catch (e) {
  note(errorText(e));
  $("content").innerHTML =
    '<div class="empty">后台连接失败，请刷新重试。</div>';
}
