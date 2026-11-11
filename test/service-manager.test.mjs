import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startManagedService } from "../lib/service-manager.mjs";
import { startServer } from "../lib/server.mjs";
import { createApplication } from "../lib/bootstrap.mjs";
import { makeFixture, settled } from "./helpers.mjs";
import {
  resolveStateDirectory,
  stateIdentity,
} from "../lib/state-directory.mjs";

async function owner(stateDir, mode = "real") {
  const child = Bun.spawn(
    [process.execPath, "test/fixtures/service-owner.mjs", stateDir, "0", mode],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  let line = "";
  while (!line.includes("\n")) {
    const next = await reader.read();
    if (next.done)
      throw new Error(
        "owner exited: " + (await new Response(child.stderr).text()),
      );
    line += new TextDecoder().decode(next.value);
  }
  reader.releaseLock();
  return {
    child,
    port: JSON.parse(line.split("\n")[0]).port,
    async close() {
      if (child.exitCode === null) {
        child.stdin.write("stop\n");
        child.stdin.end();
      }
      await child.exited;
    },
  };
}
const temp = () => mkdtempSync(join(tmpdir(), "magpie-manager-"));

test("scheduled deliveries continue from shared SQLite without repeating the completed run", async () => {
  const root = temp(),
    f = makeFixture(),
    received = [];
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(r) {
      received.push(await r.json());
      return new Response(null, { status: 204 });
    },
  });
  let first, manager, oldApp;
  try {
    oldApp = createApplication({
      stateDir: root,
      clock: f.clock,
      source: f.source,
      start: false,
    });
    first = await startServer({ port: 0, stateDir: root, app: oldApp });
    oldApp.start();
    const channel = await oldApp.saveChannel({
      name: "local",
      type: "webhook",
      config: { url: `http://127.0.0.1:${receiver.port}` },
    });
    const sub = oldApp.saveSubscription({
      ...f.spec,
      enabled: true,
      skipEmpty: false,
      schedule: { type: "interval", minutes: 1 },
      route: { primaryChannelId: channel.id },
    });
    await settled(oldApp);
    f.advance(60000);
    await oldApp.tick();
    expect(received.length).toBe(1);
    manager = await startManagedService(
      { port: first.port, stateDir: root, clock: f.clock, source: f.source },
      { retryInterval: 10 },
    );
    expect(manager.state).toBe("waiting");
    await first.close();
    oldApp.repository.close();
    oldApp = null;
    const next = await manager.ready;
    await settled(next.app);
    await next.app.tick();
    expect(received.length).toBe(1);
    f.advance(60000);
    await next.app.tick();
    expect(received.length).toBe(2);
    const jobs = next.app.repository.jobs({ subscriptionId: sub.id });
    expect(jobs.length).toBe(2);
    expect(new Set(jobs.map((j) => j.executionKey)).size).toBe(2);
    expect(jobs.every((j) => j.status === "sent")).toBe(true);
  } finally {
    await first?.close();
    await manager?.close();
    oldApp?.repository.close();
    receiver.stop(true);
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner disappearing during the health probe is taken over without a false conflict", async () => {
  const root = temp();
  let old, manager;
  try {
    old = await owner(root, "leaving");
    manager = await startManagedService({
      port: old.port,
      stateDir: root,
      start: false,
    });
    expect(manager.state).toBe("running");
    expect((await manager.ready).app).toBeDefined();
  } finally {
    await manager?.close();
    await old?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ["real", "compatible"])
  test(`manager takes over after a separate ${mode} owner process exits`, async () => {
    const root = temp();
    let old, manager;
    try {
      old = await owner(root, mode);
      const states = [];
      manager = await startManagedService(
        { port: old.port, stateDir: root, start: false },
        { retryInterval: 10, onStateChange: (s) => states.push(s) },
      );
      expect(manager.state).toBe("waiting");
      expect(manager.service).toBeUndefined();
      await old.close();
      const bound = await manager.ready;
      expect(manager.state).toBe("running");
      expect(bound.app).toBeDefined();
      const health = await (
        await fetch(`http://127.0.0.1:${old.port}/healthz`)
      ).json();
      expect(health.ready).toBe(true);
      expect(health.instanceId).toBe(stateIdentity({ stateDir: root }));
      expect(states).toEqual(["starting", "waiting", "running"]);
    } finally {
      await manager?.close();
      await old?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

test("manager refuses other state directories and unidentified legacy services before creating a database", async () => {
  const root = temp();
  let old;
  try {
    const first = join(root, "first"),
      second = join(root, "second");
    old = await owner(first);
    await expect(
      startManagedService({ port: old.port, stateDir: second, start: false }),
    ).rejects.toMatchObject({ code: "instance_conflict" });
    expect(existsSync(join(second, "state.sqlite"))).toBe(false);
    await old.close();
    old = await owner(first, "legacy");
    await expect(
      startManagedService({ port: old.port, stateDir: second, start: false }),
    ).rejects.toMatchObject({ code: "service_incompatible" });
    expect(existsSync(second)).toBe(false);
  } finally {
    await old?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("closing a waiting manager cancels takeover and timeout fails explicitly", async () => {
  const root = temp();
  let old, manager;
  try {
    old = await owner(root, "compatible");
    manager = await startManagedService(
      { port: old.port, stateDir: root, start: false },
      { retryInterval: 10 },
    );
    await manager.close();
    expect(manager.state).toBe("closed");
    await expect(manager.ready).rejects.toMatchObject({ name: "AbortError" });
    await old.close();
    expect(existsSync(join(root, "state.sqlite"))).toBe(false);
    old = await owner(root, "compatible");
    let time = 0;
    manager = await startManagedService(
      { port: old.port, stateDir: root, start: false },
      {
        maxWait: 100,
        retryInterval: 50,
        now: () => time,
        delay: async (ms) => {
          time += ms;
        },
      },
    );
    await expect(manager.ready).rejects.toMatchObject({
      code: "handover_timeout",
    });
    expect(manager.state).toBe("failed");
    expect(manager.service).toBeUndefined();
  } finally {
    await manager?.close();
    await old?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("state directory precedence and normalized identities survive first creation", () => {
  const root = temp();
  try {
    const path = join(root, "nested", "state");
    const before = stateIdentity({ stateDir: path });
    mkdirSync(path, { recursive: true });
    expect(
      stateIdentity({
        stateDir: join(root, "nested", "..", "nested", "state"),
      }),
    ).toBe(before);
    expect(
      resolveStateDirectory({
        stateDir: path,
        directory: join(root, "ignored"),
      }),
    ).toBe(resolve(path));
    expect(resolveStateDirectory({ directory: root })).toBe(
      join(resolve(root), "usage-subscriptions"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
