import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Every file and workspace metadata read below is confined to this disposable home.
// No HBuilderX executable, business project, account, or cloud service is used.
const fixture = await realpath(
  await mkdtemp(path.join(tmpdir(), "lazyhb-platform-")),
);
const originalEnvironment = new Map();
const fixtureEnvironment = {
  HOME: path.join(fixture, "home"),
  USERPROFILE: path.join(fixture, "home"),
  APPDATA: path.join(fixture, "roaming"),
  LOCALAPPDATA: path.join(fixture, "local"),
  XDG_CONFIG_HOME: path.join(fixture, "config"),
  XDG_STATE_HOME: path.join(fixture, "state"),
  LAZYHB_STATE_DIR: path.join(fixture, "registry"),
};
for (const [key, value] of Object.entries(fixtureEnvironment)) {
  originalEnvironment.set(key, process.env[key]);
  process.env[key] = value;
  await mkdir(value, { recursive: true });
}

async function waitUntil(predicate, description, timeout = 10_000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    if (await predicate()) return;
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function forceCleanup(pids) {
  const live = pids.filter(isAlive);
  if (process.platform === "win32") {
    for (const pid of live) {
      await new Promise((resolve, reject) => {
        const killer = spawn(
          path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "taskkill.exe",
          ),
          ["/PID", String(pid), "/T", "/F"],
          { shell: false, windowsHide: true, stdio: "ignore" },
        );
        killer.once("error", reject);
        killer.once("close", resolve);
      });
    }
  } else {
    for (const pid of live) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
}

async function checkRegistryAndDiscovery(
  ProjectRegistry,
  discoverProjects,
  project,
) {
  const registry = new ProjectRegistry();
  assert.equal(
    registry.stateDir,
    fixtureEnvironment.LAZYHB_STATE_DIR,
    "the state override must be honored on the actual host",
  );
  await registry.add(project, "temporary project");
  const secondInstance = new ProjectRegistry();
  assert.equal((await secondInstance.projects())[0].path, project);
  await secondInstance.alias(project, "renamed fixture");
  assert.equal(
    (await registry.projects())[0].alias,
    "renamed fixture",
    "registry operations must reload disk state",
  );
  await registry.add(project);
  assert.equal(
    (await registry.projects()).length,
    1,
    "reimport must not duplicate a project",
  );
  await registry.remove(project);
  assert.equal((await secondInstance.projects()).length, 0);
  assert.equal(
    await readFile(path.join(project, "manifest.json"), "utf8"),
    '{"name":"fixture"}\n',
    "registry removal must not remove or rewrite source files",
  );

  const malformed = path.join(fixture, "malformed-registry");
  await mkdir(malformed);
  await writeFile(path.join(malformed, "projects.json"), "{not json");
  await assert.rejects(() => new ProjectRegistry(malformed).projects());

  if (process.platform !== "win32") {
    const linked = path.join(fixture, "linked-registry");
    await mkdir(linked);
    const target = path.join(fixture, "untouched-registry.json");
    const payload = '{"version":1,"projects":[]}';
    await writeFile(target, payload);
    await symlink(target, path.join(linked, "projects.json"));
    await assert.rejects(() => new ProjectRegistry(linked).projects());
    await assert.rejects(() => new ProjectRegistry(linked).add(project));
    assert.equal(await readFile(target, "utf8"), payload);
  }

  const stale = path.join(fixture, "stale-project");
  await mkdir(stale);
  const configBase =
    process.platform === "darwin"
      ? path.join(fixtureEnvironment.HOME, "Library", "Application Support")
      : process.platform === "win32"
        ? fixtureEnvironment.APPDATA
        : fixtureEnvironment.XDG_CONFIG_HOME;
  const metadata = path.join(configBase, "HBuilderX", "HBuilderX.ini");
  await mkdir(path.dirname(metadata), { recursive: true });
  const ini = `[WorkSpace]\nprojects\\size=1\nprojects\\1\\path="${pathToFileURL(project).href}"\nprojects\\1\\alias=workspace fixture\nprojects\\2\\path="${pathToFileURL(stale).href}"\n`;
  await writeFile(metadata, ini);
  const discovered = await discoverProjects();
  assert.equal(
    discovered.length,
    1,
    "discover only the active native-platform workspace array",
  );
  assert.equal(discovered[0].path, project);
  assert.equal(discovered[0].alias, "workspace fixture");
  assert.equal(
    await readFile(metadata, "utf8"),
    ini,
    "discovery must leave HX metadata untouched",
  );
  console.log(
    `PASS ${process.platform}: registry persistence/removal and native workspace discovery`,
  );
}

async function checkFileSafety(ProjectFiles, project) {
  const files = await ProjectFiles.open(project);
  await files.mkdir("nested");
  await files.create(
    path.join("nested", "unicode.txt"),
    "hello 世界\nneedle\n",
  );
  assert.equal(
    await files.read(path.join("nested", "unicode.txt")),
    "hello 世界\nneedle\n",
  );
  await files.write(
    path.join("nested", "unicode.txt"),
    "edited needle\n",
    "hello 世界\nneedle\n",
  );
  await assert.rejects(() =>
    files.write(
      path.join("nested", "unicode.txt"),
      "lost update",
      "stale source",
    ),
  );
  assert.equal(
    await files.read(path.join("nested", "unicode.txt")),
    "edited needle\n",
  );
  await assert.rejects(() =>
    files.create(path.join("nested", "unicode.txt"), "overwrite"),
  );
  await files.copy(path.join("nested", "unicode.txt"), "copied.txt");
  await assert.rejects(() =>
    files.copy(path.join("nested", "unicode.txt"), "copied.txt"),
  );
  await assert.rejects(() =>
    files.rename(path.join("nested", "unicode.txt"), "copied.txt"),
  );
  assert.equal(await files.read("copied.txt"), "edited needle\n");
  await files.rename("copied.txt", "renamed.txt");
  await files.move("renamed.txt", path.join("nested", "moved.txt"));
  assert.equal(
    await files.read(path.join("nested", "moved.txt")),
    "edited needle\n",
  );
  await assert.rejects(() => files.write(".", "replace root"));
  await assert.rejects(() => files.create("../escaped.txt", "outside"));
  await assert.rejects(() =>
    files.create(path.join(fixture, "absolute.txt"), "outside"),
  );
  assert.equal(await exists(path.join(fixture, "escaped.txt")), false);
  assert.equal(await exists(path.join(fixture, "absolute.txt")), false);

  const outside = path.join(fixture, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "protected.txt"), "untouched");
  await symlink(
    outside,
    path.join(project, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(() => files.read(path.join("link", "protected.txt")));
  await assert.rejects(() =>
    files.write(path.join("link", "protected.txt"), "unsafe"),
  );
  await assert.rejects(() =>
    files.create(path.join("link", "new.txt"), "unsafe"),
  );
  await assert.rejects(() => files.copy("link", "copied-link"));
  await assert.rejects(() => files.move("link", "moved-link"));
  assert.equal(
    await readFile(path.join(outside, "protected.txt"), "utf8"),
    "untouched",
  );
  assert.equal(await exists(path.join(outside, "new.txt")), false);
  assert.equal(
    (await files.entries()).includes(path.join(project, "link")),
    false,
  );

  await files.mkdir("node_modules");
  await files.create(path.join("node_modules", "ignored.txt"), "needle");
  const matches = await files.search("needle");
  assert.ok(
    matches.some(
      (match) => match.path.replaceAll("\\", "/") === "nested/moved.txt",
    ),
  );
  assert.ok(
    matches.every(
      (match) =>
        !match.path.includes("node_modules") && !match.path.startsWith("link"),
    ),
  );
  await writeFile(
    path.join(project, "binary.dat"),
    Buffer.from([0, 1, 2, 255]),
  );
  await assert.rejects(() => files.read("binary.dat"));
  await assert.rejects(() =>
    files.create("too-large.txt", "x".repeat(2 * 1024 * 1024 + 1)),
  );
  if (process.platform === "win32") {
    for (const filename of [
      "CON",
      "NUL.txt",
      "trailing.",
      "trailing ",
      "alternate:stream",
    ]) {
      await assert.rejects(
        () => files.create(filename, "unsafe"),
        `reject Windows special path ${filename}`,
      );
    }
  }
  console.log(
    `PASS ${process.platform}: confined file operations, conflicts, no-overwrite, ${process.platform === "win32" ? "junction" : "symlink"} rejection`,
  );
}

async function checkCancellation(HXClient) {
  const probe = path.join(fixture, "process-probe.mjs");
  const heartbeat = path.join(fixture, "grandchild-heartbeat");
  await writeFile(
    probe,
    `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--help')) {
  console.log('HBuilderX isolated subprocess probe\\nproject list\\n  List fixture projects\\nprobe\\n  Exercise local process cancellation');
} else if (process.argv.includes('--grandchild')) {
  process.on('SIGTERM', () => {});
  setInterval(() => writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 50);
} else if (process.argv[2] === 'probe') {
  process.on('SIGTERM', () => {});
  const child = spawn(process.execPath, [import.meta.filename, '--grandchild'], { shell: false, stdio: 'ignore' });
  console.log(JSON.stringify({ parent: process.pid, child: child.pid }));
  setInterval(() => {}, 1000);
} else if (process.argv[2] === 'project' && process.argv[3] === 'list') {
  console.log('');
} else {
  process.exitCode = 23;
}
`,
  );
  const client = new HXClient(process.execPath, { argumentPrefix: [probe] });
  const commands = await client.discover();
  assert.ok(commands.some((command) => command.name === "probe"));
  let pids;
  let settled = false;
  const running = client.run("probe", {}, (line) => {
    if (line.startsWith("{")) pids = JSON.parse(line);
  });
  // Observe rejection immediately, including when the child exits before readiness.
  const outcome = running
    .then(
      (code) => ({ code }),
      (error) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    await waitUntil(() => {
      if (settled)
        throw new Error(
          "Subprocess probe exited before publishing its process tree",
        );
      return Boolean(pids);
    }, "subprocess tree readiness");
    assert.ok(
      Number.isSafeInteger(pids.parent) && Number.isSafeInteger(pids.child),
    );
    await waitUntil(() => exists(heartbeat), "grandchild heartbeat");
    assert.ok(
      isAlive(pids.parent) && isAlive(pids.child),
      "both processes must really run before cancellation",
    );
    await Promise.race([
      client.cancel(),
      delay(12_000, undefined, { ref: false }).then(() => {
        throw new Error("Cancellation exceeded 12 seconds");
      }),
    ]);
    await waitUntil(() => settled, "runner completion after cancellation");
    const result = await outcome;
    assert.equal(
      result.error?.name,
      "CLICancelledError",
      "local cancellation must reject distinctly, not report success or an ordinary exit code",
    );
    await waitUntil(
      () => !isAlive(pids.parent) && !isAlive(pids.child),
      "parent and grandchild exit",
    );
    const stopped = await readFile(heartbeat, "utf8");
    await delay(180);
    assert.equal(
      await readFile(heartbeat, "utf8"),
      stopped,
      "the grandchild must stop writing after cancellation",
    );
    console.log(
      `PASS ${process.platform}: real subprocess tree cancellation (${process.platform === "win32" ? "taskkill tree" : "process group"})`,
    );
  } finally {
    // Failure cleanup never counts as a successful cancellation assertion.
    if (pids) await forceCleanup([pids.parent, pids.child]);
    await client.cancel();
  }
}

try {
  assert.ok(process.versions.bun, "platform smoke requires Bun");
  const { ProjectRegistry, ProjectFiles, discoverProjects } =
    await import("../dist/projects.js");
  const { HXClient } = await import("../dist/hx.js");
  const project = path.join(fixture, "project with spaces 世界");
  await mkdir(project);
  await writeFile(path.join(project, "manifest.json"), '{"name":"fixture"}\n');
  await checkRegistryAndDiscovery(ProjectRegistry, discoverProjects, project);
  await checkFileSafety(ProjectFiles, project);
  await checkCancellation(HXClient);
  console.log(
    `Platform smoke completed on actual ${process.platform}/${process.arch}, Bun ${process.versions.bun}`,
  );
} finally {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(fixture, { recursive: true, force: true });
}
