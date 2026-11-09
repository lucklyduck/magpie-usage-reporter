import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
mkdirSync("outputs", { recursive: true });
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const licenses = Object.keys(pkg.dependencies).map((name) => {
  const p = JSON.parse(
    readFileSync(resolve("node_modules", name, "package.json"), "utf8"),
  );
  return {
    name,
    version: p.version,
    license: p.license || "see package",
    repository: p.repository,
  };
});
writeFileSync(
  "outputs/dependency-licenses.json",
  JSON.stringify(licenses, null, 2),
);
const r = Bun.spawnSync(
  [process.execPath, "pm", "pack", "--destination", "outputs"],
  { stdio: ["inherit", "inherit", "inherit"], env: process.env },
);
if (r.exitCode) process.exit(r.exitCode);
console.log("Release: outputs/" + pkg.name + "-" + pkg.version + ".tgz");
