// Reuse the pinned upstream's formatting/search tools without its global DOM
// controller, storage, token metadata or separate HTTP service (MIT).
import "./original-assets/i18n.js";
import "./original-assets/view.js";

const V = globalThis.UsageView;
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function createOriginalState() {
  return {
    period: "today",
    sort: "tokens",
    query: "",
    includeCache: true,
    providers: new Set(),
    accounts: new Set(),
    data: null,
    loadedPeriod: null,
  };
}

export function mountOriginal(root, { api, settings, state }) {
  V.setLang("zh");
  V.setChineseUnits(settings.chineseUnits === true);
  root.className = "original-tree";
  root.innerHTML = `<div class="toolbar">
    <label>原版周期 <select data-original="period" aria-label="原版统计周期">${[
      ["today", "今天"],
      ["7d", "7 天"],
      ["30d", "30 天"],
      ["all", "全部"],
    ]
      .map(([id, name]) => `<option value="${id}">${name}</option>`)
      .join("")}</select></label>
    <label>排序 <select data-original="sort" aria-label="原版排序">${[
      ["tokens", "Token"],
      ["cost", "费用"],
      ["calls", "调用"],
      ["name", "名称"],
    ]
      .map(([id, name]) => `<option value="${id}">${name}</option>`)
      .join("")}</select></label>
    <label><input type="checkbox" data-original="cache"> Token 含缓存</label>
    <button type="button" data-original="refresh" class="secondary">刷新原版用量</button>
  </div><p class="footer-note">原版视图使用独立周期和搜索；切换标签会保留各自的筛选。</p>
  <div class="original-tiles" data-original="summary"></div>
  <section class="panel"><div class="original-tools"><h2>账号用量树</h2><input type="search" data-original="search" aria-label="搜索原版账号或模型" placeholder="搜索供应商、账号或模型"><button type="button" data-original="expand" class="secondary">展开全部</button></div>
  <p data-original="status" role="status"></p><div data-original="rows"></div></section>
  <p class="footer-note" data-original="updated"></p>`;
  const $ = (name) => root.querySelector(`[data-original="${name}"]`);
  $("period").value = state.period;
  $("sort").value = state.sort;
  $("search").value = state.query;
  $("cache").checked = state.includeCache;
  let disposed = false,
    request = 0,
    controller,
    loading = false,
    error = "";
  let currency = settings.currency === "CNY" ? "cny" : "usd";
  const hasData = () => state.data && state.loadedPeriod === state.period;
  const visible = () =>
    V.sortProviders(state.data?.providers || [], state.sort, state.includeCache)
      .map((p) => ({ ...p, accounts: V.visibleAccounts(p, state.query) }))
      .filter((p) => p.accounts.length);
  const compare = (a, b) =>
    state.sort === "name"
      ? String(a.alias || a.account || a.model).localeCompare(
          String(b.alias || b.account || b.model),
        )
      : state.sort === "tokens"
        ? V.tokenTotal(b, state.includeCache) -
          V.tokenTotal(a, state.includeCache)
        : (Number(b[state.sort]) || 0) - (Number(a[state.sort]) || 0);
  const money = (item) =>
    V.money(item.cost, item.unpriced, item.calls, currency, settings.usdCny);
  const stats = (item) =>
    `<span>${esc(V.count(item.calls))} 次</span><span>${esc(V.count(V.tokenTotal(item, state.includeCache)))} Token</span><span>${esc(money(item))}</span>`;
  const modelTable = (account) => {
    const rows = V.models(
      { ...account, models: [...account.models].sort(compare) },
      "zh",
      currency,
      settings.usdCny,
      state.includeCache,
    );
    return `<div class="original-models"><table><thead><tr><th>模型</th><th>调用</th><th>Token</th><th>Token 占比</th><th>费用</th><th>错误率</th></tr></thead><tbody>${rows.map((m) => `<tr><td>${esc(m.name)}${m.hosts.length ? `<small>${esc(m.hosts.join(" · "))}</small>` : ""}</td><td>${esc(m.calls)}</td><td>${esc(m.tokens)}</td><td>${esc(m.share)}</td><td>${esc(m.cost)}</td><td>${esc(m.errorRate)}</td></tr>`).join("")}</tbody></table>${rows.length ? "" : "<p>当前账号没有模型记录</p>"}</div>`;
  };
  function draw() {
    if (disposed) return;
    $("refresh").disabled = loading;
    $("status").textContent = error || (loading ? "正在读取原版用量…" : "");
    if (!hasData()) {
      $("summary").replaceChildren();
      $("rows").replaceChildren();
      $("updated").textContent = "";
      return;
    }
    const data = state.data;
    $("summary").innerHTML = V.tiles(
      data.summary,
      "zh",
      currency,
      settings.usdCny,
      state.includeCache,
    )
      .map(
        (t) =>
          `<article><span>${esc(t.label)}</span><strong>${esc(t.value)}</strong><small>${esc(t.sub)}</small></article>`,
      )
      .join("");
    const providers = visible();
    $("rows").innerHTML =
      providers
        .map(
          (p) =>
            `<details class="original-provider" data-provider="${esc(p.id)}" ${state.providers.has(p.id) ? "open" : ""}><summary><strong>${esc(p.providerName)}</strong><span>${p.accounts.length} 个账号</span>${stats(p)}</summary><div class="original-accounts">${[
              ...p.accounts,
            ]
              .sort(compare)
              .map(
                (a) =>
                  `<details class="original-account" data-account="${esc(a.id)}" ${state.accounts.has(a.id) ? "open" : ""}><summary><span><strong>${esc(a.alias || a.account)}</strong><small>${esc(a.alias ? a.account : a.kind === "api-key" ? "API 密钥统计组" : "")} · ${a.models.length} 个模型</small></span>${stats(a)}</summary>${modelTable(a)}</details>`,
              )
              .join("")}</div></details>`,
        )
        .join("") ||
      `<div class="empty">${state.query ? "没有匹配的账号或模型" : "当前周期没有调用记录"}</div>`;
    const allOpen =
      providers.length > 0 &&
      providers.every(
        (p) =>
          state.providers.has(p.id) &&
          p.accounts.every((a) => state.accounts.has(a.id)),
      );
    $("expand").textContent = allOpen ? "收起全部" : "展开全部";
    if (!loading && !error)
      $("status").textContent = (data.warnings || [])
        .map((w) => w.message || w.code || "")
        .join("；");
    $("updated").textContent =
      `来源：Magpie 请求账本 · ${data.stale ? "上次读取 · " : ""}${data.generatedAt ? new Date(data.generatedAt).toLocaleString("zh-CN") : ""}`;
  }
  async function refresh(fresh = false) {
    if (disposed) return;
    const id = ++request;
    controller?.abort();
    controller = new AbortController();
    const period = state.period;
    loading = true;
    error = "";
    draw();
    try {
      const data = await api(
        `original/tree?period=${encodeURIComponent(period)}${fresh ? "&fresh=1" : ""}`,
        "GET",
        undefined,
        { signal: controller.signal },
      );
      if (disposed || id !== request) return;
      state.data = data;
      state.loadedPeriod = period;
    } catch (e) {
      if (disposed || id !== request || e.name === "AbortError") return;
      error = `${hasData() ? "刷新失败，保留上次数据：" : "读取失败："}${e.message}`;
    } finally {
      if (!disposed && id === request) {
        loading = false;
        draw();
      }
    }
  }
  const onToggle = (event) => {
    const el = event.target;
    if (!el.isConnected) return;
    const key = el.dataset.provider ?? el.dataset.account;
    if (key === undefined) return;
    const set =
      el.dataset.provider !== undefined ? state.providers : state.accounts;
    if (el.open) set.add(key);
    else set.delete(key);
    const providers = visible();
    $("expand").textContent =
      providers.length &&
      providers.every(
        (p) =>
          state.providers.has(p.id) &&
          p.accounts.every((a) => state.accounts.has(a.id)),
      )
        ? "收起全部"
        : "展开全部";
  };
  root.addEventListener("toggle", onToggle, true);
  $("period").onchange = (e) => {
    state.period = e.target.value;
    void refresh();
  };
  $("sort").onchange = (e) => {
    state.sort = e.target.value;
    draw();
  };
  $("cache").onchange = (e) => {
    state.includeCache = e.target.checked;
    draw();
  };
  $("search").oninput = (e) => {
    state.query = e.target.value;
    draw();
  };
  $("refresh").onclick = () => void refresh(true);
  $("expand").onclick = () => {
    const providers = visible();
    const collapse = providers.every(
      (p) =>
        state.providers.has(p.id) &&
        p.accounts.every((a) => state.accounts.has(a.id)),
    );
    for (const p of providers) {
      if (collapse) state.providers.delete(p.id);
      else state.providers.add(p.id);
      for (const a of p.accounts) {
        if (collapse) state.accounts.delete(a.id);
        else state.accounts.add(a.id);
      }
    }
    draw();
  };
  draw();
  void refresh();
  return {
    refresh,
    updateDisplay(next) {
      settings = next;
      currency = next.currency === "CNY" ? "cny" : "usd";
      V.setChineseUnits(next.chineseUnits === true);
      draw();
    },
    cancelRefresh() {
      ++request;
      controller?.abort();
      loading = false;
    },
    dispose() {
      disposed = true;
      ++request;
      controller?.abort();
      root.removeEventListener("toggle", onToggle, true);
    },
  };
}
