import { resolve } from "node:path";
import { startServer } from "./lib/server.mjs";
const args = process.argv.slice(2),
  arg = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
const service = await startServer({
  port: Number(arg("--port", "3495")),
  stateDir: resolve(arg("--state-dir", ".state")),
  gateway: arg("--gateway", ""),
  start: !args.includes("--no-scheduler"),
});
console.log("Magpie 用量与订阅：http://127.0.0.1:" + service.port);
const close = async () => {
  await service.close();
  process.exit(0);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
