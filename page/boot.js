(async () => {
  let port = 3495,
    theme = "light",
    service = "";
  try {
    const t = await magpie.ready;
    theme = t?.dark ? "dark" : "light";
    const o = await magpie.options.get();
    if (Number(o?.port) > 0) port = Number(o.port);
    service = magpie.service || "";
  } catch {}
  const target = new URL(service || "http://127.0.0.1:" + port + "/");
  target.searchParams.set("theme", theme);
  document.getElementById("retry").onclick = () => location.reload();
  setTimeout(() => {
    document.getElementById("status").textContent =
      "服务未连接。请检查插件是否启用，或打开 Magpie 的插件日志。";
    document.getElementById("retry").hidden = false;
  }, 7000);
  location.replace(target.href);
})();
