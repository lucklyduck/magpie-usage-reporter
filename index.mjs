import { startServer } from "./lib/server.mjs";
let started;
export default {
  id: "usage-subscriptions",
  server: async (input, options = {}) => {
    started ??= startServer({
      port: Number(options.port) || 3495,
      directory: input?.directory,
      gateway: options.gateway || "",
    }).catch((e) => {
      started = null;
      throw e;
    });
    await started;
    return {};
  },
};
