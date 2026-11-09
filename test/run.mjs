import { readdirSync } from "node:fs";
const dirs = ["test", "vendor/page-usage-tree/test"];
const files = dirs.flatMap((dir) =>
  readdirSync(dir)
    .filter(
      (p) =>
        p.endsWith(".test.mjs") &&
        (process.env.MAGPIE_LIVE_TEST === "1" || p !== "parity.test.mjs"),
    )
    .map((p) => dir + "/" + p),
);
const result = Bun.spawnSync([process.execPath, "test", ...files], {
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
});
process.exit(result.exitCode);
