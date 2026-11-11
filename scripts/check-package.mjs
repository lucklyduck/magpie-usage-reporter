import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildId as workspaceBuildId } from "../lib/server.mjs";
const packageDir = resolve(process.env.PLUGIN_PACKAGE_DIR || ".smoke/package");
const { startServer, buildId } = await import(
  pathToFileURL(
    join(packageDir, "node_modules/magpie-usage-subscriptions/lib/server.mjs"),
  ).href
);
const server = await startServer({
  port: 0,
  stateDir: join(packageDir, "state"),
  directory: join(packageDir, "host-fixture"),
  start: false,
});
try {
  const base = "http://127.0.0.1:" + server.port,
    health = await (await fetch(base + "/healthz")).json(),
    html = await (await fetch(base)).text();
  assert.equal(health.name, "magpie-usage-subscriptions");
  assert.equal(health.ready, true);
  assert.equal(health.serviceProtocol, 1);
  assert.equal(health.build, buildId());
  assert.equal(
    health.build,
    workspaceBuildId(),
    "installed package must contain the final workspace build",
  );
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
  for (const path of [
    "/original-view.js",
    "/host.js",
    "/main.js",
    "/display-format.js",
    "/original-assets/i18n.js",
    "/original-assets/view.js",
  ]) {
    const resource = await fetch(base + path, { headers: { Origin: "null" } });
    assert.equal(resource.status, 200);
    assert.equal(resource.headers.get("Access-Control-Allow-Origin"), "null");
    await resource.text();
  }
  assert.equal(
    (await fetch(base, { headers: { Origin: "null" } })).headers.has(
      "Access-Control-Allow-Origin",
    ),
    false,
  );
  const displayResponse = await fetch(base + "/api/v1/display", {
    headers: { "X-Usage-Token": token, Origin: "null" },
  });
  assert.equal(cap.uiProtocol, 1);
  assert.equal(displayResponse.status, 200);
  const display = await displayResponse.json();
  assert.equal(display.mode, "magpie");
  assert.equal(display.effective.currency, "USD");
  assert.equal((await fetch(base + "/api/v1/display")).status, 401);
  const report = {
    checkedAt: new Date().toISOString(),
    installableTarball: true,
    ready: health.ready,
    channels: cap.channels.map((c) => c.id),
    formats: cap.formats,
    isolatedProductionInstall: true,
    originalViewAssets: true,
    tokenDocumentCorsProtected: true,
    serviceProtocol: health.serviceProtocol,
    hostAndDisplayAssets: true,
    authenticatedDisplay: true,
    matchesWorkspaceBuild: true,
    build: health.build,
  };
  mkdirSync("outputs", { recursive: true });
  writeFileSync("outputs/package-check.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await server.close();
}
