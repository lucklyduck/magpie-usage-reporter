import { startServer, NAME, SERVICE_PROTOCOL } from "../../lib/server.mjs";
import { stateIdentity } from "../../lib/state-directory.mjs";
const [stateDir, port, mode = "real"] = process.argv.slice(2);
const options = { stateDir, port: Number(port), start: false };
let service;
if (mode === "real") service = await startServer(options);
else {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(port),
    fetch() {
      if (mode === "leaving") {
        server.stop(true);
        return new Response(null);
      }
      const value = { name: NAME, build: "previous-build", ready: true };
      if (mode === "compatible")
        Object.assign(value, {
          serviceProtocol: SERVICE_PROTOCOL,
          instanceId: stateIdentity(options),
        });
      return Response.json(value);
    },
  });
  service = { port: server.port, close: () => server.stop(true) };
}
console.log(JSON.stringify({ port: service.port }));
process.stdin.on("data", async () => {
  await service.close();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  await service.close();
  process.exit(0);
});
