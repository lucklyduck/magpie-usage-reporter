// Keep this entry independent of new asset routes: a retiring host may
// already read this package's new files while still serving its old API.
const token = document.querySelector('meta[name="usage-token"]').content;
const endpoint = new URL("api/v1/capabilities", location.href);
let started = Date.now(),
  timer,
  running = false,
  stopped = false,
  hostVisible = true;
function notice(message) {
  const content = document.getElementById("content");
  const box = document.createElement("div");
  box.className = "empty";
  const text = document.createElement("p");
  text.dataset.startupStatus = "";
  text.textContent = message;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "重新连接";
  retry.onclick = () => location.reload();
  box.append(text, retry);
  content.replaceChildren(box);
}
function visible() {
  return !document.hidden && hostVisible;
}
function onVisibility(event) {
  if (event.type === "message") {
    const m = event.data;
    if (
      event.source !== parent ||
      m?.magpie !== 1 ||
      m.event !== "visibility" ||
      typeof m.data?.visible !== "boolean"
    )
      return;
    hostVisible = m.data.visible;
  }
  clearTimeout(timer);
  if (visible()) void probe();
}
function dispose() {
  stopped = true;
  clearTimeout(timer);
  document.removeEventListener("visibilitychange", onVisibility);
  removeEventListener("message", onVisibility);
}
async function probe() {
  if (stopped || running || !visible()) return;
  running = true;
  try {
    const response = await fetch(endpoint, {
      headers: { "X-Usage-Token": token },
      signal: AbortSignal.timeout(3000),
    });
    if (response.status === 401) {
      await response.body?.cancel();
      const url = new URL(location.href);
      if (url.searchParams.get("bootReconnect") !== "1") {
        url.searchParams.set("bootReconnect", "1");
        dispose();
        location.replace(url.href);
      } else {
        notice("后台访问令牌已更新，请重新加载页面后连接。");
        dispose();
      }
      return;
    }
    if (!response.ok) {
      await response.body?.cancel();
      notice(
        response.status === 404
          ? "后台正在更新，等待旧宿主结束后自动连接…"
          : "后台暂未就绪，正在等待连接…",
      );
    } else if ((await response.json()).uiProtocol !== 1) {
      notice("后台正在更新，等待旧宿主结束后自动连接…");
    } else {
      // Remove the temporary listeners before the main module owns them.
      dispose();
      await import("./main.js");
      return;
    }
  } catch {
    notice("后台暂未连接，正在等待恢复…");
  } finally {
    running = false;
    if (!stopped && visible()) {
      if (Date.now() - started >= 12 * 60 * 1000) {
        notice("等待后台更新已超时，请重新连接或重启 Magpie 插件宿主。");
        dispose();
      } else timer = setTimeout(() => void probe(), 1000);
    }
  }
}
document.addEventListener("visibilitychange", onVisibility);
addEventListener("message", onVisibility);
addEventListener("pagehide", dispose, { once: true });
void probe();
