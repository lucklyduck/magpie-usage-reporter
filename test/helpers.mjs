import { createRegistries } from "../lib/registry.mjs";
import { stats, sum, matches } from "../lib/domain/stats.mjs";
import { resolvePeriod } from "../lib/domain/periods.mjs";
import { SQLiteRepository } from "../lib/adapters/store.mjs";
import { Application } from "../lib/application.mjs";
import { presets } from "../lib/domain/config.mjs";
export function fixtureRows() {
  return [
    {
      provider: "p1",
      providerName: "供应商一",
      account: "alice",
      accountName: "工作账号",
      model: "shared-model",
      kind: "account",
      ...stats({
        calls: 3,
        input: 1000,
        output: 100,
        cacheRead: 200,
        reasoning: 40,
        costUsd: 0.2,
      }),
    },
    {
      provider: "p1",
      providerName: "供应商一",
      account: "bob",
      accountName: "备用账号",
      model: "shared-model",
      kind: "account",
      ...stats({ calls: 2, errors: 1, input: 500, output: 50, costUsd: 0.1 }),
    },
    {
      provider: "p1",
      providerName: "供应商一",
      account: "alice",
      accountName: "工作账号",
      model: "other-model",
      kind: "account",
      ...stats({ calls: 1, input: 20, output: 5, unpriced: 1 }),
    },
    {
      provider: "p2",
      providerName: "供应商二",
      account: "alice",
      accountName: "另一供应商",
      model: "shared-model",
      kind: "account",
      ...stats({ calls: 4, input: 500, output: 80, costUsd: 0.3 }),
    },
  ];
}
export function makeFixture({
  outcomes = {},
  adapters = [],
  rows = fixtureRows(),
  sourceOverride,
  repository,
} = {}) {
  let now = Date.parse("2026-11-10T06:00:00Z");
  const clock = { now: () => now },
    calls = [],
    reg = createRegistries(),
    repo = repository || new SQLiteRepository(":memory:"),
    vault = new Map();
  const credentials = {
    get: async (id) => vault.get(id) || {},
    set: async (id, v) => {
      vault.set(id, v);
    },
    delete: async (id) => {
      vault.delete(id);
    },
  };
  const source = sourceOverride || {
    async load(q = {}) {
      const selected = rows.filter((r) => matches(r, q.filters));
      return {
        rows: selected,
        totals: sum(selected, q.includeCache !== false),
        state: "complete",
        warnings: [],
        generatedAt: new Date(now).toISOString(),
        period: resolvePeriod(
          q.period || "today",
          q.at ?? now,
          q.timezone || "Asia/Shanghai",
          q,
        ),
        options: { providers: [], accounts: [], models: [], agents: [] },
        scanned: rows.length,
      };
    },
    async quotas() {
      return {
        state: "complete",
        generatedAt: new Date(now).toISOString(),
        cards: [
          {
            provider: "p1",
            providerName: "供应商一",
            account: "alice",
            accountName: "工作账号",
            windows: [
              {
                name: "5h",
                used: 25,
                resetsAt: "2026-11-10T10:00:00Z",
                pool: "shared",
              },
            ],
            balance: "USD 12.00",
            sharedBalance: "wallet-1",
            readAt: "2026-11-10T05:00:00Z",
          },
          {
            provider: "p1",
            providerName: "供应商一",
            account: "empty",
            accountName: "无调用账号",
            windows: [],
            balance: null,
            readAt: null,
          },
        ],
      };
    },
  };
  for (const id of ["primary", "backup"]) {
    let index = 0;
    reg.channels.add({
      id,
      label: id,
      fields: [],
      secretFields: [],
      capabilities: { formats: ["text"], maxTextLength: 10000 },
      validate: (x) => x,
      async send(c, s, m) {
        calls.push({ id, message: m });
        const sequence = outcomes[id] || [];
        return sequence[index++] || { outcome: "success", receipt: id + "-ok" };
      },
    });
  }
  for (const a of adapters) reg.channels.add(a);
  const app = new Application({
    repository: repo,
    credentials,
    source,
    registries: reg,
    clock,
  });
  const channel = (type, name) =>
    repo.put("channels", { name, type, config: {} });
  const p = channel("primary", "主渠道"),
    b = channel("backup", "备用渠道");
  const spec = {
    ...presets()[0],
    route: { primaryChannelId: p.id, backupChannelId: b.id },
  };
  return {
    app,
    repo,
    credentials,
    reg,
    source,
    calls,
    p,
    b,
    spec,
    clock,
    setNow: (value) => {
      now = value;
    },
    advance: (ms) => {
      now += ms;
    },
    async close() {
      await app.stop();
      repo.close();
    },
  };
}
export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function settled(app) {
  for (let i = 0; i < 100 && app.inFlight; i++) await pause(10);
}
