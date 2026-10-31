import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { HXClient, type Command } from "../src/hx.js";
import { TaskRunner } from "../src/task-runner.js";

// These integration tests observe separate OS processes; fake timers cannot
// advance their output, filesystem markers, or process-tree termination.
async function eventually(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(15);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function fixture(): Promise<{ root: string; source: string; helpFile: string; client: HXClient; command: Command; commands: Command[] }> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lazyhb-task-runner-")));
  const source = join(root, "cli.mjs"), helpFile = join(root, "help.txt");
  const help = "HBuilderX isolated task runner fixture\nproject list\n  Fixture projects\nservice\n  Fixture background service\n  --name  Task name\n  --release  Release marker\n  --code  Exit status\n  --count  Output count\n  --tree  Descendant heartbeat\n  --exitOnTerm  Parent exits on SIGTERM\n  --project  Captured project\n  --username  Account\npack\n  Fixture private packing\n  --config  Private configuration\n  --project  Project\n  --android.certpassword  证书密码\n";
  await fs.writeFile(helpFile, help);
  await fs.writeFile(source, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const args = process.argv.slice(2);
const value = key => { const index = args.indexOf('--' + key); return index < 0 ? undefined : args[index + 1]; };
if (args.includes('--help')) {
  appendFileSync(${JSON.stringify(join(root, "discoveries"))}, 'discovered\\n');
  console.log(readFileSync(${JSON.stringify(helpFile)}, 'utf8'));
} else if (args[0] === '--grandchild') {
  process.on('SIGTERM', () => {});
  setInterval(() => writeFileSync(args[1], String(Date.now())), 30);
} else if (args[0] === 'pack') {
  const configuration = JSON.parse(readFileSync(value('config'), 'utf8'));
  console.log('password ' + configuration.android.certpassword);
  console.error('account ' + configuration.username);
} else if (args[0] === 'service') {
  const name = value('name');
  console.log(name + ':ready');
  console.error(name + ':stderr');
  if (value('tree')) {
    process.on('SIGTERM', () => { if (value('exitOnTerm') === 'true') process.exit(0); });
    const child = spawn(process.execPath, [import.meta.filename, '--grandchild', value('tree')], { shell: false, stdio: 'ignore' });
    console.log(JSON.stringify({ name, parent: process.pid, child: child.pid }));
  }
  for (let i = 0; i < Number(value('count') || 0); i++) console.log(name + ':' + i);
  while (!existsSync(value('release'))) await delay(15);
  console.log(name + ':finished');
  process.exitCode = Number(value('code') || 0);
} else process.exitCode = 23;
`);
  const client = new HXClient(process.execPath, { argumentPrefix: [source] });
  const commands = await client.discover();
  return { root, source, helpFile, client, commands, command: commands.find((command) => command.name === "service")! };
}

test("real tasks run concurrently with independent logs, cancellation and exit statuses", async () => {
  const { root, client, command } = await fixture();
  let changes = 0;
  const runner = new TaskRunner(() => { changes++; });
  const firstRelease = join(root, "first-release"), secondRelease = join(root, "second-release");
  try {
    const parameters = { name: "first", release: firstRelease, project: join(root, "project-a") };
    const first = runner.start(client, command, parameters, { project: parameters.project }, { label: "First service", project: parameters.project });
    parameters.name = "mutated-after-start";
    const second = runner.start(client, command, { name: "second", release: secondRelease }, {}, { label: "Second service", project: join(root, "project-b") });
    expect(first.state).toBe("running");
    expect(second.state).toBe("running");
    expect(changes).toBe(2);
    expect(runner.active).toBe(true);
    await eventually(() => first.lines.includes("first:ready") && second.lines.includes("second:ready"), "both independent services to run before either release");
    expect(client.running).toBe(false);
    expect(await fs.readFile(join(root, "discoveries"), "utf8")).toBe("discovered\n");
    expect(first.project).toBe(join(root, "project-a"));
    expect(second.project).toBe(join(root, "project-b"));
    const stopping = runner.stop(first.id);
    expect(first.state).toBe("stopping");
    await stopping;
    expect(first.state).toBe("cancelled");
    expect(first.exitCode).toBeUndefined();
    expect(second.state).toBe("running");
    expect(runner.active).toBe(true);
    await fs.writeFile(secondRelease, "release");
    await eventually(() => !runner.active, "remaining service exit");
    expect(second.state).toBe("succeeded");
    expect(second.exitCode).toBe(0);
    expect(first.lines).toContain("first:stderr");
    expect(second.lines).toContain("second:stderr");
    expect(first.lines.every((line) => !line.startsWith("second:"))).toBe(true);
    expect(second.lines.every((line) => !line.startsWith("first:"))).toBe(true);
    expect(second.lines).toContain("second:finished");
    expect(runner.tasks).toEqual([first, second]);
    expect(changes).toBeGreaterThan(6);
    const failed = runner.start(client, command, { name: "nonzero", release: secondRelease, code: "7" }, {}, { label: "Nonzero service" });
    await eventually(() => !runner.active, "nonzero service exit");
    expect(failed.state).toBe("failed");
    expect(failed.exitCode).toBe(7);
  } finally {
    await runner.stopAll();
    await client.cancel();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("fork retains validated capabilities while the original client rediscovers", async () => {
  const { root, helpFile, client, command } = await fixture();
  const fork = client.fork();
  try {
    await fs.writeFile(helpFile, "HBuilderX revised isolated fixture\nproject list\n  Projects\nreplacement\n  New capability\n");
    await client.discover();
    expect(() => client.arguments(command, { name: "old" })).toThrow("命令不在已发现");
    const release = join(root, "release");
    await fs.writeFile(release, "release");
    const lines: string[] = [];
    expect(await fork.run(command, { name: "snapshot", release }, (line) => { lines.push(line); })).toBe(0);
    expect(lines).toContain("snapshot:finished");
    expect(await fs.readFile(join(root, "discoveries"), "utf8")).toBe("discovered\ndiscovered\n");
  } finally {
    await fork.cancel();
    await client.cancel();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("success output and completed history stay bounded without evicting a running service", async () => {
  const { root, client, command } = await fixture();
  const runner = new TaskRunner(() => {});
  try {
    const release = join(root, "completed-release");
    await fs.writeFile(release, "release");
    const completed = runner.start(client, command, { name: "bounded", release, count: "2500" }, {}, { label: "Noisy service" });
    await eventually(() => !runner.active, "successful noisy service completion");
    expect(completed.state).toBe("succeeded");
    expect(completed.exitCode).toBe(0);
    expect(completed.lines).toHaveLength(2000);
    expect(completed.lines).toContain("bounded:2499");
    expect(completed.lines).toContain("bounded:finished");
    expect(completed.lines).not.toContain("bounded:0");
    const activeRelease = join(root, "active-release");
    const active = runner.start(client, command, { name: "retained", release: activeRelease }, {}, { label: "Retained live service" });
    await eventually(() => active.lines.includes("retained:ready"), "retained service readiness");
    const failures = Array.from({ length: 103 }, (_, index) =>
      runner.start(client, command, { name: "\0" }, {}, { label: `Rejected ${index}` }));
    expect(failures.every((record) => record.state === "running")).toBe(true);
    await eventually(() => failures.every((record) => record.state === "failed"), "bounded failed history");
    expect(runner.tasks).toHaveLength(101);
    expect(runner.tasks).toContain(active);
    expect(runner.tasks).not.toContain(completed);
    expect(runner.tasks).not.toContain(failures[0]);
    expect(runner.tasks).toContain(failures[102]);
    expect(active.state).toBe("running");
    await fs.writeFile(activeRelease, "release");
    await eventually(() => !runner.active, "retained service completion");
    expect(active.state).toBe("succeeded");
    expect(runner.tasks).toHaveLength(100);
  } finally {
    await runner.stopAll();
    await client.cancel();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("validation failures and immediate cancellation settle asynchronously without spawning a service", async () => {
  const { root, client, command } = await fixture();
  const states: string[] = [];
  const runner = new TaskRunner(() => { states.push(...runner.tasks.map((record) => record.state)); });
  try {
    const failed = runner.start(client, command, { unsupported: "value" }, {}, { label: "Rejected service" });
    expect(failed.state).toBe("running");
    expect(failed.error).toBeUndefined();
    await eventually(() => failed.state === "failed", "asynchronous validation failure");
    expect(failed.error).toContain("此版本不支持");
    const cancelled = runner.start(client, command, { name: "never-started", release: join(root, "never-release") }, {}, { label: "Cancelled before spawn" });
    const stopping = runner.stop(cancelled.id);
    expect(runner.stop(cancelled.id)).toBe(stopping);
    expect(cancelled.state).toBe("stopping");
    await stopping;
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.lines).toEqual([]);
    expect(runner.active).toBe(false);
    expect(states).toContain("failed");
    expect(states).toContain("cancelled");
    await runner.stop(99999);
  } finally {
    await runner.stopAll();
    await client.cancel();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("private pack output and task metadata redact credentials while malformed JSON errors remain safe", async () => {
  const { root, client, commands } = await fixture();
  const runner = new TaskRunner(() => {});
  const password = "fixture-pack-password", username = "fixture-pack-account";
  const pack = commands.find((command) => command.name === "pack")!;
  try {
    const configuration = { project: root, android: { certpassword: password }, username };
    const privateFile = join(root, "private.json");
    await fs.writeFile(privateFile, JSON.stringify(configuration));
    const packed = runner.start(client, pack, { config: privateFile }, { allowSensitive: true, packConfiguration: configuration, project: root }, { label: `Pack ${password} ${username}`, project: join(root, username), target: `Device ${username} ${password}` });
    expect(JSON.stringify(packed)).not.toContain(password);
    expect(JSON.stringify(packed)).not.toContain(username);
    await eventually(() => !runner.active, "private pack completion");
    expect(packed.state).toBe("succeeded");
    expect(packed.lines.join("\n")).toContain("[已隐藏]");
    expect(JSON.stringify(packed)).not.toContain(password);
    expect(JSON.stringify(packed)).not.toContain(username);
    expect(JSON.parse(await fs.readFile(privateFile, "utf8"))).toEqual(configuration);
    const malformed = join(root, "malformed.json");
    await fs.writeFile(malformed, `{"certpassword":"${password}", invalid}`);
    const failed = runner.start(client, pack, { config: malformed }, {}, { label: "Malformed private configuration" });
    expect(failed.state).toBe("running");
    await eventually(() => !runner.active, "malformed configuration rejection");
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("有效 UTF-8 JSON");
    expect(JSON.stringify(failed)).not.toContain(password);
  } finally {
    await runner.stopAll();
    await client.cancel();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("spawn errors are captured and redact credential values including formatted metadata", async () => {
  const { root, source, client, command } = await fixture();
  const username = "fixture-private-account";
  const executable = join(root, username + (process.platform === "win32" ? ".exe" : ""));
  const runner = new TaskRunner(() => {});
  let isolated: HXClient | undefined;
  try {
    await fs.copyFile(process.execPath, executable);
    await fs.chmod(executable, 0o700);
    isolated = new HXClient(executable, { argumentPrefix: [source] });
    await isolated.discover();
    await fs.rm(executable);
    const parameters = { name: "failed-spawn", release: join(root, "release"), username };
    const formatted = username.slice(0, 8) + "\x1b[31m" + username.slice(8);
    const failed = runner.start(isolated, command, parameters, { allowSensitive: true }, { label: `Service ${formatted}`, project: join(root, username) });
    expect(failed.state).toBe("running");
    expect(failed.error).toBeUndefined();
    expect(failed.label).toBe("Service [已隐藏]");
    await eventually(() => !runner.active, "spawn failure capture");
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("[已隐藏]");
    expect(JSON.stringify(failed)).not.toContain(username);
  } finally {
    await runner.stopAll();
    await isolated?.cancel();
    await client.cancel();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function isAlive(pid: number): boolean {
  if (process.platform !== "win32") {
    const state = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
    // Unknown/missing ps output is not evidence of exit; kill(0) still decides.
    if (state.exitCode === 0 && /^Z\S*$/.test(state.stdout.toString().trim())) return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

test("stopAll waits for every independent process tree, including SIGTERM-resistant descendants", async () => {
  const { root, client, command } = await fixture();
  const runner = new TaskRunner(() => {});
  const heartbeats = [join(root, "first-heartbeat"), join(root, "second-heartbeat")];
  try {
    const records = heartbeats.map((heartbeat, index) => runner.start(
      client,
      command,
      { name: `tree-${index}`, release: join(root, `never-release-${index}`), tree: heartbeat, exitOnTerm: index === 0 ? "true" : "false" },
      {},
      { label: `Process tree ${index}` },
    ));
    await eventually(async () => records.every((record) => record.lines.some((line) => line.startsWith("{"))) &&
      (await Promise.all(heartbeats.map((heartbeat) => fs.exists(heartbeat)))).every(Boolean), "both descendant heartbeats");
    const trees: { parent: number; child: number }[] = records.map((record) =>
      JSON.parse(record.lines.find((line) => line.startsWith("{"))!));
    for (const tree of trees) {
      expect(isAlive(tree.parent)).toBe(true);
      expect(isAlive(tree.child)).toBe(true);
    }
    const stopped = runner.stopAll();
    expect(records.every((record) => record.state === "stopping")).toBe(true);
    await stopped;
    expect(runner.active).toBe(false);
    expect(records.every((record) => record.state === "cancelled")).toBe(true);
    expect(records.every((record) => record.exitCode === undefined)).toBe(true);
    expect(trees.every((tree) => !isAlive(tree.parent) && !isAlive(tree.child))).toBe(true);
    const finalHeartbeats = await Promise.all(heartbeats.map((heartbeat) => fs.readFile(heartbeat, "utf8")));
    // A real quiet interval detects a surviving external descendant; fake time
    // cannot make that independently scheduled process write to its marker.
    await delay(150);
    expect(await Promise.all(heartbeats.map((heartbeat) => fs.readFile(heartbeat, "utf8")))).toEqual(finalHeartbeats);
  } finally {
    // Failure cleanup only targets PIDs published by this disposable fixture.
    for (const record of runner.tasks) {
      const line = record.lines.find((entry) => entry.startsWith("{"));
      if (!line) continue;
      const tree: { parent: number; child: number } = JSON.parse(line);
      if (process.platform === "win32") {
        if (isAlive(tree.parent)) {
          const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
            ["/PID", String(tree.parent), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
          await once(killer, "close");
        }
      } else {
        try { process.kill(-tree.parent, "SIGKILL"); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
    }
    await runner.stopAll();
    await client.cancel();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
