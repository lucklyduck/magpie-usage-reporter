import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../lib/server.mjs";
import { makeFixture } from "./helpers.mjs";

test("token-bearing documents cannot be read through null-origin CORS", async () => {
  const f = makeFixture(),
    server = await startServer({ port: 0, app: f.app });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const document = await fetch(base, { headers: { Origin: "null" } });
    expect(document.status).toBe(200);
    expect(document.headers.has("Access-Control-Allow-Origin")).toBe(false);
    for (const path of [
      "app.js",
      "original-view.js",
      "original-assets/view.js",
    ]) {
      const response = await fetch(`${base}/${path}`, {
        headers: { Origin: "null" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("null");
    }
    const denied = await fetch(`${base}/api/v1/settings`, {
      headers: { Origin: "null" },
    });
    expect(denied.status).toBe(401);
    const invalid = await fetch(`${base}/api/v1/settings`, {
      headers: { "X-Usage-Token": "é".repeat(server.token.length) },
    });
    expect(invalid.status).toBe(401);
  } finally {
    await server.close();
    f.repo.close();
  }
});

test("original tree uses the authenticated API and legacy URLs lead to the integrated tab", async () => {
  const f = makeFixture(),
    server = await startServer({ port: 0, app: f.app });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/api/v1/original/tree`)).status).toBe(401);
    const headers = { "X-Usage-Token": server.token, Origin: "null" };
    for (const period of ["today", "7d", "30d", "all"]) {
      const r = await fetch(
        `${base}/api/v1/original/tree?period=${period}&fresh=1`,
        { headers },
      );
      expect(r.status).toBe(200);
      const tree = await r.json();
      expect(tree.period).toBe(period);
      expect(tree.summary.calls).toBe(10);
      expect(tree.providers.length).toBe(2);
    }
    expect(
      (await fetch(`${base}/api/v1/original/tree?period=nope`, { headers }))
        .status,
    ).toBe(400);
    for (const path of ["original", "original/"]) {
      const r = await fetch(`${base}/${path}`, { redirect: "manual" });
      expect(r.status).toBe(302);
      const target = new URL(r.headers.get("Location"), `${base}/${path}`);
      expect(target.pathname).toBe("/");
      expect(target.searchParams.get("usageView")).toBe("original");
    }
    const gone = await fetch(`${base}/original/api/tree`, { headers });
    expect(gone.status).toBe(410);
  } finally {
    await server.close();
    f.repo.close();
  }
});

test("bound services identify their directory and never silently reuse another listener", async () => {
  const root = mkdtempSync(join(tmpdir(), "magpie-instance-contract-"));
  let first, second;
  try {
    first = await startServer({
      port: 0,
      stateDir: join(root, "first"),
      start: false,
    });
    const h = await (
      await fetch(`http://127.0.0.1:${first.port}/healthz`)
    ).json();
    expect(h.serviceProtocol).toBe(1);
    expect(h.instanceId).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(h)).not.toContain(root);
    let error;
    try {
      second = await startServer({
        port: first.port,
        stateDir: join(root, "second"),
        start: false,
      });
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe("EADDRINUSE");
    expect(existsSync(join(root, "second", "state.sqlite"))).toBe(false);
  } finally {
    await second?.close();
    await first?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
