import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
export class FileCredentialStore {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  file(id) {
    return join(
      this.directory,
      createHash("sha256").update(id).digest("hex") + ".json",
    );
  }
  async get(id) {
    try {
      return JSON.parse(readFileSync(this.file(id), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return {};
      throw new Error("无法读取通知凭据");
    }
  }
  async set(id, value) {
    const file = this.file(id),
      tmp = file + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
      renameSync(tmp, file);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }
  async delete(id) {
    try {
      unlinkSync(this.file(id));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}
