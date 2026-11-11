import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Resolve existing ancestors too, so a directory keeps its identity when it
// is first created, or when reached through a symlink/junction.
export function resolveStateDirectory(options = {}) {
  let path = resolve(
    options.stateDir ||
      process.env.MAGPIE_USAGE_STATE_DIR ||
      join(
        options.directory ||
          join(
            process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
            "magpie",
          ),
        "usage-subscriptions",
      ),
  );
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync.native(path), ...tail);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const parent = dirname(path);
      if (parent === path) throw e;
      tail.unshift(basename(path));
      path = parent;
    }
  }
}

export function stateIdentity(options = {}) {
  const directory = resolveStateDirectory(options);
  const key =
    process.platform === "win32" ? directory.toLowerCase() : directory;
  return createHash("sha256").update(key).digest("hex");
}
