import { cp, mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (!["darwin", "linux"].includes(process.platform)) throw new Error("Release packaging supports macOS and Linux");
const root = resolve(import.meta.dir, "..");
const { version } = await Bun.file(join(root, "package.json")).json();
const output = resolve(process.argv[2] ?? join(root, "release"));
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "lazyhb-release-"));
try {
  const directory = join(temporary, "lazyhb");
  await mkdir(join(directory, "bin"), { recursive: true });
  await mkdir(join(directory, "lib"), { recursive: true });
  for (const name of ["dist", "native", "node_modules", "package.json", "README.md"]) {
    await cp(join(root, name), join(directory, "lib", name), { recursive: true });
  }
  await cp(process.execPath, join(directory, "lib", "bun"));
  await chmod(join(directory, "lib", "bun"), 0o755);
  const launcher = join(directory, "bin", "lazyhb");
  await writeFile(launcher, '#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$ROOT/lib/bun" "$ROOT/lib/dist/index.js" "$@"\n', { mode: 0o755 });
  const archive = join(output, `lazyhb-${version}-${process.platform}-${process.arch}.tar.gz`);
  const result = spawnSync("tar", ["-czf", archive, "-C", temporary, "lazyhb"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Release archive creation failed");
  console.log(archive);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
