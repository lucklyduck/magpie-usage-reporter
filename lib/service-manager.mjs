import { setTimeout as wait } from "node:timers/promises";
import { startServer, NAME, SERVICE_PROTOCOL } from "./server.mjs";
import { resolveStateDirectory, stateIdentity } from "./state-directory.mjs";
import { AppError } from "./domain/errors.mjs";

// The plugin hook finishes loading while an older host drains its calls.
// Only the process which actually binds the port may construct a worker.
export async function startManagedService(options = {}, policy = {}) {
  const {
    retryInterval = 500,
    maxWait = 12 * 60 * 1000,
    probeTimeout = 1000,
    now = () => performance.now(),
    delay = (ms, signal) => wait(ms, undefined, { signal }),
    onStateChange = () => {},
    onFailure = () => {},
  } = policy;
  const settings = { ...options, stateDir: resolveStateDirectory(options) };
  const instanceId = stateIdentity(settings);
  const abort = new AbortController();
  let state = "starting",
    service,
    error,
    monitor,
    closing;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Callers may wait on ready later; a background failure is still logged.
  void ready.catch(() => {});
  const transition = (next) => {
    state = next;
    try {
      onStateChange(next);
    } catch {}
  };
  const fail = (e) => {
    error = e;
    transition("failed");
    rejectReady(e);
    try {
      onFailure(e);
    } catch {}
  };
  async function bind() {
    try {
      const bound = await startServer(settings);
      if (abort.signal.aborted) {
        await bound.close();
        return true;
      }
      service = bound;
      transition("running");
      resolveReady(bound);
      return true;
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
    }
    return false;
  }
  async function attempt() {
    if (await bind()) return;
    let health;
    try {
      const response = await fetch(
        `http://127.0.0.1:${settings.port || 3495}/healthz`,
        {
          signal: AbortSignal.any([
            abort.signal,
            AbortSignal.timeout(probeTimeout),
          ]),
        },
      );
      if (response.ok) health = await response.json();
      else await response.body?.cancel();
    } catch {}
    if (abort.signal.aborted) return;
    // The listener can disappear between EADDRINUSE and the probe. Binding
    // again is safe; treating that race as a foreign service is not.
    if (!health && (await bind())) return;
    if (health?.name !== NAME)
      throw new AppError(
        "插件端口已被其他服务占用，请设置不同端口",
        409,
        "port_in_use",
      );
    if (health.serviceProtocol !== SERVICE_PROTOCOL || !health.instanceId)
      throw new AppError(
        "旧服务缺少兼容的实例标识，请等待当前调用结束后完整重启 Magpie 插件宿主",
        409,
        "service_incompatible",
      );
    if (health.instanceId !== instanceId)
      throw new AppError(
        "插件端口属于另一配置目录，请设置不同端口",
        409,
        "instance_conflict",
      );
    if (state !== "waiting") transition("waiting");
  }
  try {
    transition("starting");
    await attempt();
  } catch (e) {
    fail(e);
    throw e;
  }
  if (!service) {
    const since = now();
    monitor = (async () => {
      try {
        while (!abort.signal.aborted && !service) {
          if (now() - since >= maxWait)
            throw new AppError(
              "等待旧宿主退出已超时，请完整重启 Magpie 插件宿主",
              503,
              "handover_timeout",
            );
          await delay(
            Math.min(retryInterval, maxWait - (now() - since)),
            abort.signal,
          );
          if (!abort.signal.aborted) await attempt();
        }
      } catch (e) {
        if (!abort.signal.aborted) fail(e);
      }
    })();
  }
  return {
    ready,
    get state() {
      return state;
    },
    get service() {
      return service;
    },
    get error() {
      return error;
    },
    close() {
      return (closing ??= (async () => {
        abort.abort();
        rejectReady(new DOMException("服务管理器已关闭", "AbortError"));
        await monitor;
        await service?.close();
        transition("closed");
      })());
    },
  };
}
