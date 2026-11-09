import { test, expect } from "bun:test";
import { makeFixture, settled } from "./helpers.mjs";
import { SQLiteRepository } from "../lib/adapters/store.mjs";

test("pausing during report generation prevents a later send", async () => {
  const f = makeFixture(),
    s = f.app.saveSubscription(f.spec);
  const original = f.source.load;
  let resume;
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  f.source.load = async (query) => {
    await gate;
    return original(query);
  };
  f.app.enqueue(s);
  const running = f.app.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.app.saveSubscription({ ...s, enabled: false }, s.id);
  resume();
  await running;
  expect(f.calls.length).toBe(0);
  expect(f.repo.jobs()[0].status).toBe("canceled");
  await f.close();
});
test("concurrent channel edits cannot roll back a newer credential", async () => {
  const f = makeFixture();
  f.reg.channels.add({
    id: "guarded",
    label: "Guarded",
    fields: [],
    secretFields: [{ id: "token", required: true }],
    capabilities: { formats: ["text"], maxTextLength: 1000 },
    validate: (c) => c,
    async send() {
      return { outcome: "success" };
    },
  });
  const c = await f.app.saveChannel({
    name: "guard",
    type: "guarded",
    config: {},
    secret: { token: "old" },
  });
  const result = await Promise.allSettled([
    f.app.saveChannel({ ...c, name: "winner", secret: { token: "new" } }, c.id),
    f.app.saveChannel(
      { ...c, name: "loser", secret: { token: "other" } },
      c.id,
    ),
  ]);
  expect(result.filter((r) => r.status === "fulfilled").length).toBe(1);
  expect((await f.credentials.get(c.id)).token).toBe("new");
  expect(f.repo.get("channels", c.id).name).toBe("winner");
  await f.close();
});

test("primary success stops without contacting backup", async () => {
  const f = makeFixture();
  const s = f.app.saveSubscription(f.spec);
  f.app.enqueue(s);
  await f.app.tick();
  expect(f.calls.map((c) => c.id)).toEqual(["primary"]);
  expect(f.repo.jobs()[0].status).toBe("sent");
  await f.close();
});
test("permanent primary failure switches to backup exactly once", async () => {
  const f = makeFixture({
    outcomes: { primary: [{ outcome: "permanent", message: "rejected" }] },
  });
  const s = f.app.saveSubscription(f.spec);
  f.app.enqueue(s);
  await f.app.tick();
  expect(f.calls.map((c) => c.id)).toEqual(["primary", "backup"]);
  expect(f.repo.jobs()[0].status).toBe("sent");
  await f.close();
});
test("retryable primary failures wait, then use backup after three attempts", async () => {
  const f = makeFixture({
    outcomes: {
      primary: Array(3).fill({ outcome: "retryable", message: "429" }),
    },
  });
  const s = f.app.saveSubscription(f.spec);
  f.app.enqueue(s);
  await f.app.tick();
  expect(f.repo.jobs()[0].status).toBe("waiting");
  expect(f.calls.length).toBe(1);
  f.advance(5000);
  await f.app.tick();
  expect(f.calls.length).toBe(2);
  f.advance(30000);
  await f.app.tick();
  expect(f.calls.map((c) => c.id)).toEqual([
    "primary",
    "primary",
    "primary",
    "backup",
  ]);
  expect(f.repo.jobs()[0].status).toBe("sent");
  await f.close();
});
test("unknown outcome blocks automatic fallback and can be explicitly retried", async () => {
  const f = makeFixture({
      outcomes: { primary: [{ outcome: "unknown", message: "timeout" }] },
    }),
    s = f.app.saveSubscription(f.spec);
  f.app.enqueue(s);
  await f.app.tick();
  const j = f.repo.jobs()[0];
  expect(j.status).toBe("unknown");
  expect(f.calls.length).toBe(1);
  f.advance(600000);
  await f.app.tick();
  expect(f.calls.length).toBe(1);
  f.app.retry(j.id);
  await settled(f.app);
  expect(f.repo.getJob(j.id).status).toBe("sent");
  expect(f.calls.every((c) => c.id === "primary")).toBe(true);
  await f.close();
});
test("partial success never switches channels and retries only unconfirmed parts", async () => {
  const f = makeFixture({
    outcomes: {
      primary: [
        { outcome: "success", receipt: "part0" },
        { outcome: "permanent", message: "failed" },
        { outcome: "success", receipt: "part1" },
      ],
    },
  });
  f.reg.channels.get("primary").capabilities.maxTextLength = 240;
  const s = f.app.saveSubscription(f.spec);
  f.app.enqueue(s);
  await f.app.tick();
  const j = f.repo.jobs()[0];
  expect(j.status).toBe("partial");
  expect(j.part).toBe(1);
  expect(f.calls.filter((c) => c.id === "backup").length).toBe(0);
  f.app.retry(j.id);
  await settled(f.app);
  expect(f.repo.getJob(j.id).status).toBe("sent");
  expect(f.calls.filter((c) => c.message.index === 0).length).toBe(1);
  await f.close();
});
test("scheduled execution survives page absence, avoids overlap and resumes latest only", async () => {
  const f = makeFixture();
  const s = f.app.saveSubscription({
    ...f.spec,
    enabled: true,
    schedule: { type: "interval", minutes: 1 },
  });
  await f.app.tick();
  expect(f.repo.jobs().length).toBe(0);
  f.advance(6 * 60000);
  await f.app.tick();
  expect(f.repo.jobs().length).toBe(1);
  expect(f.repo.jobs()[0].status).toBe("sent");
  await f.app.tick();
  expect(f.repo.jobs().length).toBe(1);
  f.app.saveSubscription({ ...s, enabled: false }, s.id);
  f.advance(60000);
  await f.app.tick();
  expect(f.repo.jobs().length).toBe(1);
  await f.close();
});
test("lease prevents a second worker and recovery marks in-flight sends unknown", async () => {
  const f = makeFixture(),
    s = f.app.saveSubscription(f.spec),
    j = f.app.enqueue(s);
  j.status = "sending";
  f.repo.saveJob(j);
  expect(f.repo.lease("worker", "other", f.clock.now(), 60000)).toBe(true);
  await f.app.tick();
  expect(f.calls.length).toBe(0);
  f.advance(61000);
  await f.app.tick();
  expect(f.repo.getJob(j.id).status).toBe("unknown");
  expect(f.calls.length).toBe(0);
  await f.close();
});
test("subscriptions use revision checks and pausing cancels queued work", async () => {
  const f = makeFixture(),
    s = f.app.saveSubscription(f.spec);
  f.app.enqueue(s);
  expect(() => f.app.saveSubscription({ ...s, revision: 0 }, s.id)).toThrow(
    "修改",
  );
  f.app.saveSubscription({ ...s, enabled: false }, s.id);
  expect(f.repo.jobs()[0].status).toBe("canceled");
  await f.close();
});
test("incomplete data never triggers either notification channel", async () => {
  const f = makeFixture();
  f.source.load = async () => {
    throw new Error("gateway failed");
  };
  const s = f.app.saveSubscription(f.spec);
  f.app.enqueue(s);
  await f.app.tick();
  expect(f.calls.length).toBe(0);
  expect(f.repo.jobs()[0].status).toBe("waiting");
  await f.close();
});
test("new adapter can be registered and used without modifying core", async () => {
  const sent = [];
  const f = makeFixture({
    adapters: [
      {
        id: "new-adapter",
        label: "New",
        fields: [],
        secretFields: [],
        capabilities: { formats: ["text"], maxTextLength: 10000 },
        validate: (x) => x,
        async send(c, s, m) {
          sent.push(m.text);
          return { outcome: "success", receipt: "custom" };
        },
      },
    ],
  });
  const c = await f.app.saveChannel({
    name: "新渠道",
    type: "new-adapter",
    config: {},
  });
  const spec = f.app.saveSubscription({
    ...f.spec,
    route: { primaryChannelId: c.id },
  });
  f.app.enqueue(spec);
  await f.app.tick();
  expect(sent.length).toBe(1);
  expect(f.repo.jobs()[0].status).toBe("sent");
  await f.close();
});
