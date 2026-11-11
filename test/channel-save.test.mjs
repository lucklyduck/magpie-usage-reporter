import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../lib/bootstrap.mjs";
import { startServer } from "../lib/server.mjs";

test("sandbox channel writes persist configuration and credentials across a service restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magpie-channel-save-"));
  let app, server;
  try {
    app = createApplication({ stateDir: directory, start: false });
    server = await startServer({ port: 0, app });
    const base = "http://127.0.0.1:" + server.port,
      headers = {
        Origin: "null",
        "X-Usage-Token": server.token,
        "Content-Type": "application/json",
      };
    const preflight = await fetch(base + "/api/v1/channels", {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-usage-token",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("null");
    const created = await fetch(base + "/api/v1/channels", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Persistence fixture",
        type: "telegram",
        config: { chatId: "123456789" },
        secret: { token: "fixture-token-never-sent" },
      }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("Access-Control-Allow-Origin")).toBe("null");
    const channel = await created.json();
    expect(channel.configured).toBe(true);
    expect(JSON.stringify(channel)).not.toContain("fixture-token-never-sent");
    const updated = await fetch(base + "/api/v1/channels/" + channel.id, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ...channel, name: "Edited fixture", secret: {} }),
    });
    expect(updated.status).toBe(200);
    await server.close();
    server = null;
    app.repository.close();
    app = null;
    app = createApplication({ stateDir: directory, start: false });
    const channels = await app.channelList();
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe("Edited fixture");
    expect(channels[0].configured).toBe(true);
    expect((await app.credentials.get(channel.id)).token).toBe(
      "fixture-token-never-sent",
    );
    expect(JSON.stringify(channels)).not.toContain("fixture-token-never-sent");
    expect(app.repository.jobs()).toHaveLength(0);
  } finally {
    await server?.close();
    app?.repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
