import { join } from "node:path";
import { resolveStateDirectory } from "./state-directory.mjs";
import { SQLiteRepository } from "./adapters/store.mjs";
import { FileCredentialStore } from "./adapters/credentials.mjs";
import { MagpieSource } from "./adapters/magpie.mjs";
import { MagpieDisplaySource } from "./adapters/magpie-display.mjs";
import { createRegistries } from "./registry.mjs";
import { notificationAdapters } from "./channels/index.mjs";
import { Application } from "./application.mjs";
export function createApplication(options = {}) {
  const directory = resolveStateDirectory(options);
  const repository =
    options.repository || new SQLiteRepository(join(directory, "state.sqlite"));
  const credentials =
    options.credentials ||
    new FileCredentialStore(join(directory, "credentials"));
  const registries = options.registries || createRegistries();
  if (!registries.channels.list().length)
    for (const channel of notificationAdapters(options.notifications))
      registries.channels.add(channel);
  let app;
  const source =
    options.source ||
    new MagpieSource({
      clock: options.clock,
      getGateway: () => app?.settings().gateway || options.gateway || "",
    });
  app = new Application({
    repository,
    credentials,
    registries,
    source,
    quotaSource: options.quotaSource,
    clock: options.clock,
    displaySource:
      options.displaySource ||
      new MagpieDisplaySource({
        directory: options.directory,
        cacheDirectory: options.cacheDirectory,
        clock: options.clock,
      }),
  });
  source.signal = app.abort.signal;
  if (options.start !== false) app.start();
  return app;
}
