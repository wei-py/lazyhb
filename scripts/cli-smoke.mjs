import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { delimiter, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { HXClient, executable } from "../dist/hx.js";
import { spawnSync } from "node:child_process";
const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lazyhb-cli-")));
const previousPath = process.env.PATH;
const previousCli = process.env.HX_CLI;
try {
  const bin = join(root, "bin");
  await fs.mkdir(bin);
  const filename = process.platform === "win32" ? "fixture-cli.exe" : "fixture-cli";
  const chosen = join(bin, filename);
  await fs.copyFile(process.execPath, chosen);
  await fs.chmod(chosen, 0o700);
  process.env.PATH = bin;
  process.env.HX_CLI = chosen;
  assert.equal(await executable(), chosen);
  assert.equal(await executable(filename), chosen);
  await assert.rejects(executable(join(root, filename)));
  await assert.rejects(executable(""));
  await assert.rejects(executable(bin));
  assert.equal(await executable("./" + relative(process.cwd(), chosen)), chosen);
  process.env.PATH = relative(process.cwd(), bin);
  assert.equal(await executable(filename, false), chosen);
  const previousCwd = process.cwd();
  try {
    process.chdir(bin);
    process.env.PATH = delimiter;
    assert.equal(await executable(filename, false), chosen);
    process.env.PATH = root;
    await assert.rejects(executable(filename, false));
  } finally {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCli === undefined) delete process.env.HX_CLI;
    else process.env.HX_CLI = previousCli;
  }
  console.log("PASS explicit CLI isolation, PATH names/relative/empty entries, environment override");
  const probe = join(root, "cli-probe.mjs");
  const record = join(root, "used-config");
  await fs.writeFile(
    probe,
    `
import { readFileSync, writeFileSync, statSync } from 'node:fs';
if (process.argv.includes('--help')) console.log('HBuilderX isolated probe\\nproject list\\n  Fixture project list\\npack\\n  Fixture packing\\n\\t--project\\tProject path\\n\\t--android.certpassword\\t证书密码\\n\\t--android.storepassword\\t证书库密码\\n\\t--sourceMap\\t取值有[true|false]\\n\\t--config\\tConfiguration path\\nlaunch web\\n  Web\\n\\t--ui\\t取值有[true|false]\\n\\t--compile\\t取值有[true|false]');
else if (process.argv[2] === 'pack') {
  if (process.argv.length !== 5 || process.argv[3] !== '--config') process.exit(31);
  const filename = process.argv[4]; const settings = JSON.parse(readFileSync(filename, 'utf8'));
  if (process.platform !== 'win32' && (statSync(filename).mode & 0o077)) process.exit(32);
  if (settings.android.certpassword !== 'fixture-private-password' || settings.android.storePassword !== 'fixture-store-password' || settings.sourceMap !== true) process.exit(33);
  writeFileSync(${JSON.stringify(record)}, filename);
  console.log('accepted ' + settings.android.certpassword + ' ' + settings.android.storePassword);
  console.log(settings.android.certpassword.slice(0, 2) + String.fromCharCode(27) + '[31m' + settings.android.certpassword.slice(2));
  process.stdout.write('x'.repeat(65537) + settings.android.certpassword.slice(0, 16) + String.fromCharCode(27) + '[');
  await Bun.sleep(25);
  console.log('31m' + settings.android.certpassword.slice(16));
} else process.exit(34);
`,
  );
  const client = new HXClient(process.execPath, { argumentPrefix: [probe] });
  await client.discover();
  assert.throws(() =>
    client.arguments("launch web", { ui: "true", compile: "true" }),
  );
  assert.throws(() => client.arguments("launch web", { ui: "false" }));
  const lines = [];
  const code = await client.run(
    "pack",
    {
      project: root,
      "android.certpassword": "fixture-private-password",
      "android.storepassword": "fixture-store-password",
      sourceMap: "true",
    },
    (line) => lines.push(line),
    { allowSensitive: true },
  );
  assert.equal(code, 0);
  assert.equal(
    lines.some((line) => line.includes("fixture-private")),
    false,
    "formatted credentials must stay redacted",
  );
  assert.match(lines.join("\n"), /已隐藏/);
  assert.doesNotMatch(
    lines.join("\n"),
    /fixture-private-password|fixture-store-password/,
  );
  assert.equal(
    lines.some((line) => /fixture-private|private-password/.test(line)),
    false,
    "credential fragments must not leak across output chunks",
  );
  const temporary = await fs.readFile(record, "utf8");
  await assert.rejects(fs.lstat(temporary), { code: "ENOENT" });
  const config = join(root, "owned-pack.json");
  await fs.writeFile(
    config,
    JSON.stringify({
      android: {
        certpassword: "fixture-private-password",
        storePassword: "fixture-store-password",
      },
      sourceMap: true,
    }),
    { mode: 0o600 },
  );
  assert.equal(await client.run("pack", { config }, () => {}), 0);
  assert.equal(JSON.parse(await fs.readFile(config, "utf8")).sourceMap, true);
  const malformed = join(root, "invalid-config.json");
  await fs.writeFile(
    malformed,
    '{"certpassword":"fixture-private-password", invalid}',
  );
  await assert.rejects(
    client.run("pack", { config: malformed }, () => {}),
    (error) => {
      assert.match(String(error), /有效 UTF-8 JSON/);
      assert.doesNotMatch(String(error), /fixture-private-password/);
      return true;
    },
  );
  if (process.platform !== "win32") {
    const fifo = join(root, "config-pipe");
    assert.equal(spawnSync("mkfifo", [fifo], { timeout: 2000 }).status, 0);
    const runner = join(root, "fifo-runner.mjs");
    await fs.writeFile(
      runner,
      `
const { HXClient } = await import(${JSON.stringify(new URL("../dist/hx.js", import.meta.url).href)});
const client = new HXClient(process.execPath, { argumentPrefix: [${JSON.stringify(probe)}] });
await client.discover();
try { await client.run('pack', {config:${JSON.stringify(fifo)}}, () => {}); process.exitCode=2; }
catch (error) { if (!String(error).includes('普通文件')) throw error; }
`,
    );
    const result = spawnSync(process.execPath, [runner], {
      timeout: 2000,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      "FIFO must be rejected promptly: " +
        (result.error?.message ?? result.stderr),
    );
  }
  console.log(
    "PASS no argv credentials, private temporary pack config, redaction, cleanup and owned config retention",
  );
} finally {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousCli === undefined) delete process.env.HX_CLI;
  else process.env.HX_CLI = previousCli;
  await fs.rm(root, { recursive: true, force: true });
}
