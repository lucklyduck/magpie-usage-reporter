import { test, expect } from "bun:test";
import { startServer } from "../lib/server.mjs";
import { makeFixture, settled } from "./helpers.mjs";

test("sandboxed Magpie pages can load module scripts while foreign origins stay blocked", async () => {
  const f = makeFixture(),
    server = await startServer({ port: 0, app: f.app }),
    base = "http://127.0.0.1:" + server.port;
  try {
    for (const path of ["/", "/app.js", "/style.css", "/icon.svg"]) {
      const response = await fetch(base + path, {
        headers: { Origin: "null" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("null");
      expect(response.headers.get("Vary")).toBe("Origin");
      const foreign = await fetch(base + path, {
        headers: { Origin: "https://evil.test" },
      });
      expect(foreign.status).toBe(403);
      expect(foreign.headers.has("Access-Control-Allow-Origin")).toBe(false);
    }
    const denied = await fetch(base + "/api/v1/settings", {
      headers: { Origin: "null" },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBe("null");
  } finally {
    await server.close();
    f.repo.close();
  }
});

test("inactive identity filters remain visible and never broaden the selected scope", async () => {
  const f = makeFixture();
  const data = await f.app.usage({ filters: { models: ['["gone","model"]'] } });
  expect(data.totals.calls).toBe(0);
  expect(
    data.options.models.find((x) => x.id === '["gone","model"]').unavailable,
  ).toBe(true);
  expect(data.warnings.some((w) => w.code === "inactive_filter")).toBe(true);
  await f.close();
});

test("HTTP API protects writes, hides credentials, and previews without sending", async () => {
  const f = makeFixture(),
    server = await startServer({ port: 0, app: f.app }),
    base = "http://127.0.0.1:" + server.port;
  const call = (path, method = "GET", body, extra = {}) =>
    fetch(base + "/api/v1/" + path, {
      method,
      headers: {
        "x-usage-token": server.token,
        ...(body ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    expect((await fetch(base + "/api/v1/settings")).status).toBe(401);
    expect(
      (await call("settings", "PATCH", {}, { Origin: "https://evil.test" }))
        .status,
    ).toBe(403);
    expect(
      (await call("settings", "PATCH", {}, { "x-usage-token": "wrong" }))
        .status,
    ).toBe(401);
    expect((await call("settings", "PATCH", {})).status).toBe(200);
    const bad = await call("usage?sources=" + encodeURIComponent("[]"));
    expect(bad.status).toBe(400);
    const preview = await call("reports/preview", "POST", f.spec);
    expect(preview.status).toBe(200);
    expect(f.calls.length).toBe(0);
    expect(f.repo.jobs().length).toBe(0);
    const created = await call("subscriptions", "POST", f.spec);
    expect(created.status).toBe(201);
    const sub = await created.json();
    expect(sub.enabled).toBe(false);
    const sent = await call("subscriptions/" + sub.id + "/send", "POST", {});
    expect(sent.status).toBe(202);
    await settled(f.app);
    expect(f.repo.jobs()[0].status).toBe("sent");
    const api = await call("usage");
    const usage = await api.json();
    expect(
      usage.groups.some((p) =>
        p.children.some((a) => a.label === "无调用账号"),
      ),
    ).toBe(true);
    const capabilities = await call("capabilities");
    expect((await capabilities.json()).formats).toEqual(["text"]);
    const old = await fetch(base + "/original/?lang=zh");
    expect(old.status).toBe(200);
    expect(await old.text()).toContain("账号用量");
  } finally {
    await server.close();
    f.repo.close();
  }
});
test("channel edits retain secret values and never expose them through reads", async () => {
  const f = makeFixture();
  f.reg.channels.add({
    id: "secret-channel",
    label: "Secret",
    fields: [],
    secretFields: [{ id: "token", required: true }],
    capabilities: { formats: ["text"], maxTextLength: 1000 },
    validate: (c) => c,
    async send() {
      return { outcome: "success" };
    },
  });
  const c = await f.app.saveChannel({
    name: "channel",
    type: "secret-channel",
    config: {},
    secret: { token: "do-not-leak" },
  });
  expect(JSON.stringify(await f.app.channelList())).not.toContain(
    "do-not-leak",
  );
  expect(c.configured).toBe(true);
  const update = await f.app.saveChannel({ ...c, name: "renamed" }, c.id);
  expect((await f.credentials.get(c.id)).token).toBe("do-not-leak");
  expect(() => f.repo.put("channels", update, 0)).toThrow();
  await f.close();
});
test("SQLite persists revisions, jobs, migration version and resumes after reopen", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const { SQLiteRepository } = await import("../lib/adapters/store.mjs");
  const root = mkdtempSync(join(tmpdir(), "magpie-subscriptions-")),
    file = join(root, "state.sqlite");
  try {
    let repo = new SQLiteRepository(file);
    const s = repo.put("subscriptions", { name: "persist", enabled: false });
    repo.createJob({
      id: "job",
      executionKey: "one",
      subscriptionId: s.id,
      status: "sending",
      nextAt: 1,
      events: [],
    });
    repo.close();
    repo = new SQLiteRepository(file);
    expect(repo.get("subscriptions", s.id).revision).toBe(1);
    repo.recover();
    expect(repo.getJob("job").status).toBe("unknown");
    expect(repo.db.query("PRAGMA user_version").get().user_version).toBe(1);
    repo.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
