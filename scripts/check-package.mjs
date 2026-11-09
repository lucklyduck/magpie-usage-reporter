import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
const { startServer, buildId } =
  await import("../.smoke/package/node_modules/magpie-usage-subscriptions/lib/server.mjs");
const server = await startServer({
  port: 0,
  stateDir: ".smoke/package/state",
  start: false,
});
try {
  const base = "http://127.0.0.1:" + server.port,
    health = await (await fetch(base + "/healthz")).json(),
    html = await (await fetch(base)).text();
  assert.equal(health.name, "magpie-usage-subscriptions");
  assert.equal(health.ready, true);
  assert.match(html, /usage-token/);
  const token = html.match(/name="usage-token" content="([^"]+)"/)[1];
  const cap = await (
    await fetch(base + "/api/v1/capabilities", {
      headers: { "X-Usage-Token": token },
    })
  ).json();
  assert.deepEqual(
    cap.channels.map((c) => c.id),
    ["telegram", "onebot11", "smtp", "webhook"],
  );
  const report = {
    checkedAt: new Date().toISOString(),
    installableTarball: true,
    ready: health.ready,
    channels: cap.channels.map((c) => c.id),
    formats: cap.formats,
    isolatedProductionInstall: true,
  };
  mkdirSync("outputs", { recursive: true });
  writeFileSync("outputs/package-check.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await server.close();
}
