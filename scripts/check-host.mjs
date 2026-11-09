import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
const base = process.env.PLUGIN_TEST_URL || "http://127.0.0.1:3495",
  messages = [];
const receiver = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    messages.push({ at: Date.now(), body: await request.json() });
    return new Response(null, { status: 204 });
  },
});
let channel, subscription;
const html = await (await fetch(base)).text(),
  token = html.match(/name="usage-token" content="([^"]+)"/)?.[1];
assert.ok(token, "installed service exposes its page");
async function api(path, method = "GET", body) {
  const response = await fetch(base + "/api/v1/" + path, {
    method,
    headers: {
      "X-Usage-Token": token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || response.status);
  return result;
}
try {
  const initial = await api("status"),
    metadata = await api("capabilities");
  channel = await api("channels", "POST", {
    name: "本机验收（回环测试）",
    type: "webhook",
    config: { url: "http://127.0.0.1:" + receiver.port },
  });
  const draft = structuredClone(metadata.presets[0]);
  draft.name = "本机一分钟定时验收";
  draft.enabled = true;
  draft.skipEmpty = false;
  draft.schedule = { type: "interval", minutes: 1 };
  draft.route = { primaryChannelId: channel.id };
  draft.content.blocks = draft.content.blocks.filter(
    (b) => b.type === "account-table",
  );
  subscription = await api("subscriptions", "POST", draft);
  console.log(
    "Installed-host schedule created; waiting for one local-only delivery.",
  );
  const start = Date.now(),
    deadline = start + 130000;
  while (Date.now() < deadline && !messages.length)
    await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.ok(
    messages.length,
    "host timer must deliver without a page being open",
  );
  const jobs = await api("deliveries?subscriptionId=" + subscription.id);
  assert.ok(
    jobs.some((j) => j.status === "sent"),
    "host records successful send",
  );
  assert.equal(messages[0].body.format, "text");
  const status = await api("status");
  const report = {
    checkedAt: new Date().toISOString(),
    magpieVersion: "0.1.3436",
    installedHost: true,
    timedLocalWebhook: true,
    elapsedMs: messages[0].at - start,
    lastTick: status.lastTick,
    leader: status.leader,
    channelsUsed: "loopback receiver only",
    externalMessagesSent: false,
  };
  mkdirSync("outputs", { recursive: true });
  writeFileSync(
    "outputs/host-schedule-check.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  if (subscription)
    await api("subscriptions/" + subscription.id, "DELETE").catch(() => {});
  if (subscription) {
    const jobs = await api("deliveries?subscriptionId=" + subscription.id);
    for (const j of jobs)
      if (
        ["pending", "waiting", "unknown", "partial", "failed"].includes(
          j.status,
        )
      )
        await api("deliveries/" + j.id + "/cancel", "POST", {}).catch(() => {});
  }
  if (channel) await api("channels/" + channel.id, "DELETE").catch(() => {});
  receiver.stop(true);
}
