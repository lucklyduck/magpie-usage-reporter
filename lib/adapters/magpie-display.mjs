import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { defaultMagpieDisplay } from "../domain/display.mjs";

const canonical = (path) => {
  let result;
  try {
    result = realpathSync.native(path);
  } catch {
    result = resolve(path);
  }
  return process.platform === "win32" ? result.toLowerCase() : result;
};

/** @typedef {{directory?: string, cacheDirectory?: string, environment?: Record<string, string | undefined>, home?: string, read?: (file: string) => Promise<string>, clock?: import("../../types/contracts.d.ts").Clock}} DisplaySourceOptions */

// input.directory identifies Magpie's config; the plugin's stateDir never
// chooses which host's settings to read. Portable Magpie caches in data/cache.
/** @param {DisplaySourceOptions} [options] */
export function magpieDisplayPaths({
  directory,
  cacheDirectory,
  environment = process.env,
  home = homedir(),
} = {}) {
  const configRoot = isAbsolute(environment.XDG_CONFIG_HOME || "")
    ? environment.XDG_CONFIG_HOME
    : join(home, ".config");
  const installed = join(configRoot, "magpie");
  const config = resolve(directory || installed);
  const cacheRoot = isAbsolute(environment.XDG_CACHE_HOME || "")
    ? environment.XDG_CACHE_HOME
    : join(home, ".cache");
  const cache =
    cacheDirectory ||
    (canonical(config) === canonical(installed)
      ? join(cacheRoot, "magpie")
      : join(config, "cache"));
  return {
    settings: join(config, "settings.json"),
    rate: join(cache, "fxrate.json"),
  };
}

export class MagpieDisplaySource {
  /** @param {DisplaySourceOptions} [options] */
  constructor(options = {}) {
    this.paths = magpieDisplayPaths(options);
    this.read = options.read || ((file) => readFile(file, "utf8"));
    this.clock = options.clock || { now: () => Date.now() };
    this.preferences = { currency: "USD", chineseUnits: false };
    this.havePreferences = false;
    /** @type {{value: number, at: string | null, source: "fallback" | "magpie-cache"}} */
    this.lastRate = { value: 7.2, at: null, source: "fallback" };
    this.inFlight = null;
  }
  load() {
    return (this.inFlight ??= this.readSnapshot().finally(() => {
      this.inFlight = null;
    }));
  }
  async readSnapshot() {
    const files = await Promise.allSettled([
      this.read(this.paths.settings),
      this.read(this.paths.rate),
    ]);
    const warnings = [];
    let stale = false;
    try {
      if (files[0].status !== "fulfilled") throw new Error();
      const value = JSON.parse(files[0].value);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (value.currency !== undefined &&
          !["", "usd", "cny"].includes(value.currency)) ||
        (value.chineseUnits !== undefined &&
          typeof value.chineseUnits !== "boolean")
      )
        throw new Error();
      this.preferences = {
        currency: value.currency === "cny" ? "CNY" : "USD",
        chineseUnits: value.chineseUnits === true,
      };
      this.havePreferences = true;
    } catch {
      stale = true;
      warnings.push({
        code: "magpie_settings_unavailable",
        message: this.havePreferences
          ? "Magpie 显示设置暂不可读，保留上次有效设置"
          : "尚未读取到 Magpie 显示设置，使用 USD 和 K/M/B",
      });
    }
    try {
      if (files[1].status !== "fulfilled") throw new Error();
      const value = JSON.parse(files[1].value);
      if (!value || !Number.isFinite(value.rate) || value.rate <= 0)
        throw new Error();
      const at =
        typeof value.at === "string" && Number.isFinite(Date.parse(value.at))
          ? new Date(value.at).toISOString()
          : null;
      this.lastRate = { value: value.rate, at, source: "magpie-cache" };
    } catch {
      warnings.push({
        code: "magpie_rate_unavailable",
        message:
          this.lastRate.source === "fallback"
            ? "Magpie 汇率缓存不可读，使用备用汇率 7.2"
            : "Magpie 汇率缓存暂不可读，保留上次有效汇率",
      });
    }
    const rateStale =
      !this.lastRate.at ||
      this.clock.now() - Date.parse(this.lastRate.at) >= 12 * 60 * 60 * 1000 ||
      Date.parse(this.lastRate.at) > this.clock.now();
    if (rateStale && this.lastRate.source !== "fallback")
      warnings.push({
        code: "magpie_rate_stale",
        message: "Magpie 汇率缓存已过期，继续使用上次有效汇率",
      });
    return {
      ...defaultMagpieDisplay(),
      effective: { ...this.preferences, usdCny: this.lastRate.value },
      source: this.havePreferences ? "magpie" : "fallback",
      stale,
      rate: {
        source: this.lastRate.source,
        at: this.lastRate.at,
        stale: rateStale,
      },
      warnings,
    };
  }
}
