import { accountKey, sum } from "./stats.mjs";
/** @param {import("../../types/contracts.d.ts").UsageRow[]} rows */
export function groupRows(rows, mode = "account", options = {}) {
  const roots = new Map();
  const includeCache = options.includeCache !== false;
  for (const row of rows) {
    const root = roots.get(row.provider) || {
      id: row.provider,
      label: row.providerName || row.provider,
      children: [],
      _groups: new Map(),
    };
    roots.set(row.provider, root);
    const groupId =
      mode === "model" ? row.model : accountKey(row.provider, row.account);
    let group = root._groups.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        label: mode === "model" ? row.model : row.accountName,
        kind: row.kind,
        children: [],
      };
      root._groups.set(groupId, group);
      root.children.push(group);
    }
    group.children.push({
      ...row,
      label: mode === "model" ? row.accountName : row.model,
    });
  }
  const compare = (a, b) =>
    options.sort === "name"
      ? String(a.label).localeCompare(String(b.label))
      : Number(b[options.sort || "tokens"] || 0) -
        Number(a[options.sort || "tokens"] || 0);
  const out = [...roots.values()];
  for (const root of out) {
    for (const group of root.children) {
      Object.assign(group, sum(group.children, includeCache));
      group.children.sort(compare);
    }
    Object.assign(root, sum(root.children, includeCache));
    root.children.sort(compare);
    delete root._groups;
  }
  return out.sort(compare);
}
export const GROUPINGS = [
  {
    id: "account",
    label: "按账号归类",
    build: (rows, opts) => groupRows(rows, "account", opts),
  },
  {
    id: "model",
    label: "按模型归类",
    build: (rows, opts) => groupRows(rows, "model", opts),
  },
];
