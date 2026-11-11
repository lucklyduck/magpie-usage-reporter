const COLORS = [
  "bg",
  "card",
  "fg",
  "fg-2",
  "muted",
  "faint",
  "line",
  "accent",
  "accent-soft",
  "accent-fg",
  "green",
  "red",
  "amber",
];
const FONTS = ["font", "code"];
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// The service document replaces the launcher's bridge. Only the theme,
// visibility and error protocol is needed here; no API token crosses it.
export function connectHost({ onVisibility = () => {}, timeout = 2000 } = {}) {
  const root = document.documentElement;
  const framed = parent !== window;
  const id =
    "usage-ui-" + (crypto.randomUUID?.() || Date.now() + "-" + Math.random());
  let connected = false,
    visible = true,
    finished = false,
    reported = false;
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const system = matchMedia("(prefers-color-scheme: dark)");
  const queryTheme = new URLSearchParams(location.search).get("theme");
  const paint = (theme) => {
    root.lang = "zh-CN";
    root.dataset.theme = theme.dark ? "dark" : "light";
    root.style.colorScheme = theme.dark ? "dark" : "light";
    for (const key of [...COLORS, ...FONTS]) {
      const value = theme.tokens?.[key];
      const valid =
        typeof value === "string" &&
        value.length <= 160 &&
        !/[;{}]|url\s*\(/i.test(value) &&
        CSS.supports(COLORS.includes(key) ? "color" : "font-family", value);
      if (valid) root.style.setProperty("--" + key, value);
      else root.style.removeProperty("--" + key);
    }
  };
  const fallback = () => {
    if (!connected)
      paint({
        dark:
          queryTheme === "dark" || (queryTheme !== "light" && system.matches),
      });
  };
  const setVisible = (value) => {
    if (typeof value !== "boolean" || value === visible) return;
    visible = value;
    onVisibility(value);
  };
  const validTheme = (theme) =>
    object(theme) &&
    typeof theme.dark === "boolean" &&
    (theme.tokens === undefined || object(theme.tokens));
  const finish = () => {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
      resolveReady(connected);
    }
  };
  const receive = (event) => {
    if (
      !framed ||
      event.source !== parent ||
      !object(event.data) ||
      event.data.magpie !== 1
    )
      return;
    const m = event.data;
    if (m.id === id && validTheme(m.result)) {
      connected = true;
      paint(m.result);
      setVisible(m.result.visible);
      finish();
    } else if (m.event === "theme" && validTheme(m.data)) {
      paint(m.data);
    } else if (m.event === "visibility" && object(m.data)) {
      setVisible(m.data.visible);
    }
  };
  const report = (event) => {
    if (
      !framed ||
      !connected ||
      reported ||
      event.reason?.name === "AbortError" ||
      event.error?.name === "AbortError" ||
      /ResizeObserver loop/.test(event.message || "")
    )
      return;
    reported = true;
    // Never forward arbitrary exception text: it may contain a URL or draft.
    parent.postMessage(
      {
        magpie: 1,
        method: "error",
        params: { message: "用量与订阅页面发生未处理错误，请重新打开页面" },
      },
      "*",
    );
  };
  const timer = setTimeout(finish, timeout);
  fallback();
  addEventListener("message", receive);
  addEventListener("error", report);
  addEventListener("unhandledrejection", report);
  system.addEventListener("change", fallback);
  if (framed) parent.postMessage({ magpie: 1, id, method: "hello" }, "*");
  else finish();
  return {
    ready,
    get visible() {
      return visible;
    },
    get connected() {
      return connected;
    },
    dispose() {
      finish();
      removeEventListener("message", receive);
      removeEventListener("error", report);
      removeEventListener("unhandledrejection", report);
      system.removeEventListener("change", fallback);
    },
  };
}
