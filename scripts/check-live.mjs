import { MagpieSource } from "../lib/adapters/magpie.mjs";
import { groupRows } from "../lib/domain/grouping.mjs";
import { sum } from "../lib/domain/stats.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
const source = new MagpieSource(),
  data = await source.load({ period: "today", fresh: true }),
  summary = await source.json("/v1/magpie/usage?period=today"),
  quotas = await source.quotas();
const account = sum(groupRows(data.rows, "account")),
  model = sum(groupRows(data.rows, "model"));
const fields = [
    "calls",
    "errors",
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "costUsd",
  ],
  comparison = fields.map((key) => ({
    key,
    account: account[key],
    model: model[key],
    equal: Math.abs(account[key] - model[key]) < 0.000001,
  }));
if (!comparison.every((c) => c.equal))
  throw new Error("Account/model totals differ");
const report = {
  checkedAt: new Date().toISOString(),
  source: "local Magpie",
  state: data.state,
  calls: data.totals.calls,
  currentGatewayCalls: summary.calls,
  matchingGroupings: true,
  quotasState: quotas.state,
  quotaCards: quotas.cards.length,
  scanned: data.scanned,
  comparison,
  note: "Gateway may receive calls between reads; costs and counts above contain no account identifiers.",
};
mkdirSync("outputs", { recursive: true });
writeFileSync("outputs/live-check.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
