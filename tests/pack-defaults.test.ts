import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JsonDocument } from "../src/config.js";
import { loadPackDefaults } from "../src/pack-defaults.js";

async function fixture(manifest: Record<string, unknown> = {}) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lazyhb-pack-defaults-")));
  const save = async (relative: string, data: unknown) => {
    const path = join(root, relative);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(data));
  };
  await save("src/manifest.json", manifest);
  return { root, save, document: await JsonDocument.load(join(root, "src/manifest.json")) };
}

test("manifest package wins over saved package; saved signing remains editable consumer values", async () => {
  const f = await fixture({ "app-plus": { distribute: {
    android: { packagename: "com.actual.project", androidpacktype: 0 },
    ios: { appid: "com.actual.ios", dSYMs: false },
  } } });
  try {
    await f.save(".lazyapp/platforms/android/config.json", { applicationId: "com.saved.package" });
    await f.save(".lazyapp/platforms/android/production/config.json", {
      keystore: "/signing/project.keystore", alias: "release", password: "synthetic-password", storepassword: "synthetic-store",
    });
    await f.save(".lazyapp/platforms/ios/config.json", { bundleId: "com.saved.ios", teamId: "TEAM" });
    await f.save(".lazyapp/platforms/ios/production/config.json", {
      certificate: "signing/release.p12", provisioningProfile: "signing/release.mobileprovision", certificatePassword: "synthetic-password",
    });
    const result = await loadPackDefaults(f.root, f.document);
    expect(Object.fromEntries([...result].map(([key, entry]) => [key, entry.value]))).toEqual({
      "android.packagename": "com.actual.project", "android.androidpacktype": "0",
      "android.certfile": "/signing/project.keystore", "android.certalias": "release",
      "ios.bundle": "com.actual.ios", dsyms: "false",
      "ios.certfile": join(f.root, "signing/release.p12"),
      "ios.profile": join(f.root, "signing/release.mobileprovision"),
    });
    expect(result.get("android.packagename")!.source).toBe(`${f.document.path}#/app-plus/distribute/android/packagename`);
    expect(result.get("android.certalias")!.source).toBe(".lazyapp/platforms/android/production/config.json#/alias");
    expect(JSON.stringify([...result])).not.toContain("synthetic-password");
    expect(JSON.stringify([...result])).not.toContain("synthetic-store");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("whitelist omits secrets, unrelated parameters, empty values and compound values", async () => {
  const f = await fixture({ "app-plus": { distribute: {
    android: { packagename: "", certfile: null, certalias: {}, androidpacktype: [] },
    ios: { appid: "  ", dSYMs: null },
    config: "injected.json", project: "/other", token: "synthetic-token",
  } } });
  try {
    await f.save(".lazyapp/platforms/android/config.json", {
      applicationId: "com.fallback", project: "/other", config: "injected.json", privatekey: "synthetic-private", token: "synthetic-token",
    });
    await f.save(".lazyapp/platforms/android/production/config.json", { keystorePassword: "synthetic-password", alias: "" });
    const result = await loadPackDefaults(f.root, f.document);
    expect([...result.keys()]).toEqual(["android.packagename"]);
    expect(result.get("android.packagename")!.value).toBe("com.fallback");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("project calls do not leak saved values and relative signing paths resolve from root", async () => {
  const a = await fixture(), b = await fixture();
  try {
    await a.save(".lazyapp/platforms/android/production/config.json", { keystore: "certs/a.keystore", alias: "a" });
    const first = await loadPackDefaults(a.root, a.document);
    expect(first.get("android.certfile")!.value).toBe(join(a.root, "certs/a.keystore"));
    expect((await loadPackDefaults(b.root, b.document)).size).toBe(0);
    first.clear();
    expect((await loadPackDefaults(a.root, a.document)).get("android.certalias")!.value).toBe("a");
  } finally {
    await fs.rm(a.root, { recursive: true, force: true });
    await fs.rm(b.root, { recursive: true, force: true });
  }
});

test("explicit manifest signing fields take precedence and paths resolve from project root", async () => {
  const f = await fixture({ "app-plus": { distribute: {
    android: { certfile: "certs/manifest.keystore", certalias: "manifest" },
    ios: { certfile: "certs/manifest.p12", profile: "certs/manifest.profile" },
  } } });
  try {
    await f.save(".lazyapp/platforms/android/production/config.json", { keystore: "saved.keystore", alias: "saved" });
    const result = await loadPackDefaults(f.root, f.document);
    expect(result.get("android.certfile")!.value).toBe(join(f.root, "certs/manifest.keystore"));
    expect(result.get("android.certalias")!.value).toBe("manifest");
    expect(result.get("ios.certfile")!.value).toBe(join(f.root, "certs/manifest.p12"));
    expect(result.get("ios.profile")!.value).toBe(join(f.root, "certs/manifest.profile"));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

for (const invalid of ['{"password":"synthetic-secret",', "[]", "null"]) {
  test("existing malformed or non-object saved config reports a sanitized error: " + invalid.slice(-1), async () => {
    const f = await fixture({ "app-plus": { distribute: { android: { packagename: "com.manifest" } } } });
    try {
      await f.save(".lazyapp/platforms/android/config.json", {});
      await fs.writeFile(join(f.root, ".lazyapp/platforms/android/config.json"), invalid);
      const error = await loadPackDefaults(f.root, f.document).then(() => null, (error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(".lazyapp/platforms/android/config.json");
      expect(String(error)).not.toContain("synthetic-secret");
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
}

for (const directoryLink of [false, true]) {
  test("rejects optional configuration " + (directoryLink ? "directory" : "file") + " symlinks", async () => {
    const f = await fixture(), external = await fixture();
    try {
      await external.save("saved/config.json", { applicationId: "com.external" });
      if (directoryLink) {
        await fs.mkdir(join(f.root, ".lazyapp/platforms"), { recursive: true });
        await fs.symlink(join(external.root, "saved"), join(f.root, ".lazyapp/platforms/android"), "dir");
      } else {
        await fs.mkdir(join(f.root, ".lazyapp/platforms/android"), { recursive: true });
        await fs.symlink(join(external.root, "saved/config.json"), join(f.root, ".lazyapp/platforms/android/config.json"));
      }
      await expect(loadPackDefaults(f.root, f.document)).rejects.toThrow(".lazyapp/platforms/android/config.json");
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
      await fs.rm(external.root, { recursive: true, force: true });
    }
  });
}

test("x ignores classic roots and uses only evidenced saved package/bundle mappings", async () => {
  const f = await fixture({
    "uni-app-x": {},
    "app-plus": { distribute: { android: { packagename: "com.stale", androidpacktype: 3 }, ios: { appid: "com.stale.ios", dSYMs: true } } },
    "app-android": { distribute: { minSdkVersion: 21 } },
    "app-ios": { distribute: { UIBackgroundModes: [] } },
  });
  try {
    expect((await loadPackDefaults(f.root, f.document)).size).toBe(0);
    await f.save(".lazyapp/platforms/android/config.json", { applicationId: "com.x.android" });
    await f.save(".lazyapp/platforms/ios/config.json", { bundleId: "com.x.ios", teamId: "TEAM" });
    const result = await loadPackDefaults(f.root, f.document);
    expect(Object.fromEntries([...result].map(([key, entry]) => [key, entry.value]))).toEqual({
      "android.packagename": "com.x.android", "ios.bundle": "com.x.ios",
    });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
