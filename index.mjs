import { startManagedService } from "./lib/service-manager.mjs";
let started;
export default {
  id: "usage-subscriptions",
  server: async (input, options = {}) => {
    started ??= startManagedService(
      {
        port: Number(options.port) || 3495,
        directory: input?.directory,
        gateway: options.gateway || "",
      },
      {
        onStateChange: (state) =>
          console.info("usage-subscriptions: service " + state),
        onFailure: (error) => {
          started = null;
          console.error("usage-subscriptions: " + error.message);
        },
      },
    ).catch((e) => {
      started = null;
      throw e;
    });
    await started;
    return {};
  },
};
