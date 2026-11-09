export const SUM_FIELDS = [
  "calls",
  "errors",
  "retried",
  "canceled",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "costUsd",
  "unpriced",
  "credits",
  "timed",
  "ttftMs",
];
const map = {
  cacheRead: "cache_read",
  cacheWrite: "cache_write",
  costUsd: "cost",
  ttftMs: "ttft_ms",
};
export function stats(raw = {}) {
  const out = Object.fromEntries(
    SUM_FIELDS.map((key) => [key, Number(raw[key] ?? raw[map[key]]) || 0]),
  );
  return finish(out);
}
export function finish(out, includeCache = true) {
  out.tokens =
    out.input +
    out.output +
    (includeCache ? out.cacheRead + out.cacheWrite : 0);
  out.errorRate = out.calls ? (out.errors / out.calls) * 100 : 0;
  out.avgTtftMs = out.timed ? out.ttftMs / out.timed : null;
  return out;
}
export function sum(items, includeCache = true) {
  const out = stats();
  for (const item of items)
    for (const key of SUM_FIELDS) out[key] += Number(item[key]) || 0;
  return finish(out, includeCache);
}
export function sameStats(left, right) {
  return [
    "calls",
    "errors",
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "costUsd",
  ].every(
    (key) =>
      Math.abs((Number(left[key]) || 0) - (Number(right[key]) || 0)) <=
      (key === "costUsd" ? 0.000001 : 0),
  );
}
export const accountKey = (provider, account) =>
  JSON.stringify([provider, account]);
export const modelKey = (provider, model) => JSON.stringify([provider, model]);
export function matches(row, filters = {}) {
  return (
    (!filters.providers?.length || filters.providers.includes(row.provider)) &&
    (!filters.accounts?.length ||
      filters.accounts.includes(accountKey(row.provider, row.account))) &&
    (!filters.models?.length ||
      filters.models.includes(modelKey(row.provider, row.model)))
  );
}
