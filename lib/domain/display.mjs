// Counts use the same K/M/B or 万/亿 conventions as the pinned usage tree.
// This module has no runtime dependencies and is shared with the browser.
export function formatCount(value, chineseUnits = false) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const short = (number, digits = 2) => String(Number(number.toFixed(digits)));
  if (chineseUnits && abs >= 1e8) return short(n / 1e8) + "亿";
  if (chineseUnits && abs >= 1e4) return short(n / 1e4, 1) + "万";
  if (abs >= 1e9) return short(n / 1e9) + "B";
  if (abs >= 1e6) return short(n / 1e6) + "M";
  if (abs >= 1e3) return short(n / 1e3) + "K";
  return String(Math.round(n));
}

/** @returns {import("../../types/contracts.d.ts").DisplaySnapshot} */
export function defaultMagpieDisplay() {
  return {
    effective: { currency: "USD", usdCny: 7.2, chineseUnits: false },
    source: "fallback",
    stale: true,
    rate: { source: "fallback", at: null, stale: true },
    warnings: [
      {
        code: "magpie_display_fallback",
        message: "尚未读取到 Magpie 显示设置，使用默认值",
      },
    ],
  };
}

/** @param {any} settings
 * @param {import("../../types/contracts.d.ts").DisplaySnapshot} magpie
 * @returns {import("../../types/contracts.d.ts").EffectiveDisplay}
 */
export function effectiveDisplay(settings, magpie) {
  const mode = settings.displayMode;
  return {
    mode,
    ...(mode === "magpie"
      ? magpie
      : {
          effective: {
            currency: settings.currency,
            usdCny: settings.usdCny,
            chineseUnits: settings.chineseUnits,
          },
          source: "custom",
          stale: false,
          rate: { source: "custom", at: null, stale: false },
          warnings: [],
        }),
    magpie,
  };
}
