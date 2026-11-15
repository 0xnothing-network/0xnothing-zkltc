import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import config from "../../capacitor.config.ts";
import { androidVersionCode, configureAndroid } from "../../scripts/configure-android.ts";

const walletRoot = fileURLToPath(new URL("../../", import.meta.url));
const scaffoldGradle = 'android {\n    defaultConfig {\n        versionCode 1\n        versionName "1.0"\n    }\n}\n';

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

test("Android regeneration excludes wallet backups and repairs the scaffold package idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallet-android-config-"));
  try {
    const main = join(root, "android/app/src/main");
    const exampleDir = join(root, "android/app/src/androidTest/java/com/getcapacitor/myapp");
    await mkdir(main, { recursive: true });
    await mkdir(exampleDir, { recursive: true });
    const manifestPath = join(main, "AndroidManifest.xml");
    const examplePath = join(exampleDir, "ExampleInstrumentedTest.java");
    await writeFile(manifestPath, '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="Keep label" android:allowBackup="true"><activity android:name=".MainActivity" /></application></manifest>');
    await writeFile(examplePath, 'assertEquals("com.getcapacitor.app", appContext.getPackageName());');
    await writeFile(join(root, "android/app/build.gradle"), scaffoldGradle);

    await configureAndroid(root, "xyz.zeroxnothing.wallet");
    const once = await readFile(manifestPath, "utf8");
    assert.match(once, /android:allowBackup="false"/u);
    assert.match(once, /android:fullBackupContent="@xml\/wallet_backup_rules"/u);
    assert.match(once, /android:dataExtractionRules="@xml\/wallet_data_extraction_rules"/u);
    assert.match(once, /android:label="Keep label"/u);
    assert.match(once, /<activity android:name=".MainActivity" android:taskAffinity="" \/>/u);
    assert.equal(await readFile(examplePath, "utf8"), 'assertEquals("xyz.zeroxnothing.wallet", appContext.getPackageName());');

    const legacy = await readFile(join(main, "res/xml/wallet_backup_rules.xml"), "utf8");
    const modern = await readFile(join(main, "res/xml/wallet_data_extraction_rules.xml"), "utf8");
    for (const domain of ["root", "file", "database", "sharedpref", "external", "device_root", "device_file", "device_database", "device_sharedpref"]) {
      assert.ok(legacy.includes(`<exclude domain="${domain}" path="." />`));
      for (const mode of ["cloud-backup", "device-transfer"]) {
        const rules = modern.split(`<${mode}>`)[1]?.split(`</${mode}>`)[0];
        assert.ok(rules?.includes(`<exclude domain="${domain}" path="." />`), `${mode}: ${domain}`);
      }
    }
    await configureAndroid(root, "xyz.zeroxnothing.wallet");
    assert.equal(await readFile(manifestPath, "utf8"), once);
    await configureAndroid(root, "xyz.zeroxnothing.changed");
    assert.equal(await readFile(examplePath, "utf8"), 'assertEquals("xyz.zeroxnothing.changed", appContext.getPackageName());');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A temp shell as `cap add android` leaves it, with the parts the hook touches. */
async function scaffoldShell(root: string): Promise<string> {
  const main = join(root, "android/app/src/main");
  await mkdir(join(main, "java/xyz/zeroxnothing/wallet"), { recursive: true });
  await mkdir(join(main, "assets/public/_locales/en"), { recursive: true });
  await mkdir(join(main, "assets/public/assets"), { recursive: true });
  await mkdir(join(main, "res/mipmap-xxxhdpi"), { recursive: true });
  await writeFile(join(main, "AndroidManifest.xml"), '<manifest><application><activity android:name=".MainActivity" /></application></manifest>');
  await writeFile(join(main, "java/xyz/zeroxnothing/wallet/MainActivity.java"),
    "package xyz.zeroxnothing.wallet;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n");
  for (const name of ["background.js", "content.js", "inpage.js", "manifest.json", "index.html", "cordova.js", "assets/index.js", "_locales/en/messages.json"]) {
    await writeFile(join(main, "assets/public", name), name);
  }
  await writeFile(join(main, "res/mipmap-xxxhdpi/ic_launcher.png"), "capacitor logo");
  await writeFile(join(root, "android/app/build.gradle"), scaffoldGradle);
  return main;
}

test("Android regeneration installs the secure activity in the appId package idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallet-android-config-"));
  try {
    const main = await scaffoldShell(root);
    const activityPath = join(main, "java/xyz/zeroxnothing/wallet/MainActivity.java");
    await configureAndroid(root, "xyz.zeroxnothing.wallet");
    const once = await readFile(activityPath, "utf8");
    assert.match(once, /^package xyz\.zeroxnothing\.wallet;$/mu);
    assert.match(once, /getWindow\(\)\.setFlags\(WindowManager\.LayoutParams\.FLAG_SECURE, WindowManager\.LayoutParams\.FLAG_SECURE\)/u);
    assert.match(once, /Build\.VERSION\.SDK_INT >= 33\) setRecentsScreenshotEnabled\(false\)/u);
    // Back: the page's window.__walletBack() decides; unhandled backgrounds, never finishes.
    assert.match(once, /window\.__walletBack\(\)===true/u);
    assert.match(once, /moveTaskToBack\(true\)/u);
    assert.doesNotMatch(once, /\bfinish\(\)|onBackPressed\(\)/u);
    await configureAndroid(root, "xyz.zeroxnothing.wallet");
    assert.equal(await readFile(activityPath, "utf8"), once);

    await configureAndroid(root, "xyz.zeroxnothing.changed");
    const moved = await readFile(join(main, "java/xyz/zeroxnothing/changed/MainActivity.java"), "utf8");
    assert.match(moved, /^package xyz\.zeroxnothing\.changed;$/mu);
    assert.equal(moved.replace(/^package [\w.]+;/mu, ""), once.replace(/^package [\w.]+;/mu, ""));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Android regeneration refuses to overwrite a MainActivity that has code of its own", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallet-android-config-"));
  try {
    const main = await scaffoldShell(root);
    const activityPath = join(main, "java/xyz/zeroxnothing/wallet/MainActivity.java");
    const custom = "package xyz.zeroxnothing.wallet;\npublic class MainActivity extends BridgeActivity {\n  { registerPlugin(Foo.class); }\n}\n";
    await writeFile(activityPath, custom);
    const manifest = await readFile(join(main, "AndroidManifest.xml"), "utf8");
    await assert.rejects(configureAndroid(root, "xyz.zeroxnothing.wallet"), /not the empty scaffold/u);
    assert.equal(await readFile(activityPath, "utf8"), custom);
    // The refusal comes before any write: the shell is not left half configured.
    assert.equal(await readFile(join(main, "AndroidManifest.xml"), "utf8"), manifest);
    assert.equal(await exists(join(main, "res/xml/wallet_backup_rules.xml")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Android regeneration replaces an older install of the tracked activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallet-android-config-"));
  try {
    const main = await scaffoldShell(root);
    const activityPath = join(main, "java/xyz/zeroxnothing/wallet/MainActivity.java");
    await configureAndroid(root, "xyz.zeroxnothing.wallet");
    const current = await readFile(activityPath, "utf8");
    // cap sync never regenerates MainActivity, so an earlier release's copy
    // (marked, different text) is what the next sync finds.
    const older = current.replace("Edit it here, not in android/.", "Edit it here.");
    assert.notEqual(older, current);
    assert.ok(older.includes("Tracked source: scripts/configure-android.ts"));
    await writeFile(activityPath, older);
    await configureAndroid(root, "xyz.zeroxnothing.wallet");
    assert.equal(await readFile(activityPath, "utf8"), current);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Android regeneration drops extension-only files and keeps the web app", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallet-android-config-"));
  try {
    const main = await scaffoldShell(root);
    await configureAndroid(root, "xyz.zeroxnothing.wallet");
    const assets = join(main, "assets/public");
    for (const gone of ["background.js", "content.js", "inpage.js", "manifest.json", "_locales"]) {
      assert.equal(await exists(join(assets, gone)), false, gone);
    }
    for (const kept of ["index.html", "cordova.js", "assets/index.js"]) {
      assert.equal(await readFile(join(assets, kept), "utf8"), kept);
    }
    // A second run on an already clean tree is a no-op, not an error.
    await configureAndroid(root, "xyz.zeroxnothing.wallet");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Android versionCode and versionName follow package.json", async () => {
  assert.equal(androidVersionCode("1.0.9"), 10009);
  assert.equal(androidVersionCode("1.1.0"), 10100);
  assert.equal(androidVersionCode("2.0.0"), 20000);
  assert.ok(androidVersionCode("1.0.10") > androidVersionCode("1.0.9"));
  for (const bad of ["1.0.100", "1.100.0", "1.0", "1.0.9-beta.1", ""]) {
    assert.throws(() => androidVersionCode(bad), /package\.json version/u, bad);
  }

  const { version } = JSON.parse(await readFile(join(walletRoot, "package.json"), "utf8")) as { version: string };
  const root = await mkdtemp(join(tmpdir(), "wallet-android-config-"));
  try {
    await scaffoldShell(root);
    const gradlePath = join(root, "android/app/build.gradle");
    await configureAndroid(root, "xyz.zeroxnothing.wallet");
    const once = await readFile(gradlePath, "utf8");
    assert.ok(once.includes(`        versionCode ${androidVersionCode(version)}\n`));
    assert.ok(once.includes(`        versionName "${version}"\n`));
    await configureAndroid(root, "xyz.zeroxnothing.wallet");
    assert.equal(await readFile(gradlePath, "utf8"), once);

    await writeFile(gradlePath, "android {}\n");
    await assert.rejects(configureAndroid(root, "xyz.zeroxnothing.wallet"), /no versionCode or versionName/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Android regeneration replaces the stock launcher icons and splash with the wallet's", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallet-android-config-"));
  try {
    const main = await scaffoldShell(root);
    await configureAndroid(root, "xyz.zeroxnothing.wallet");
    const tracked = join(walletRoot, "native/android/res");
    for (const name of ["mipmap-xxxhdpi/ic_launcher.png", "mipmap-xxxhdpi/ic_launcher_round.png", "mipmap-xxxhdpi/ic_launcher_foreground.png", "mipmap-mdpi/ic_launcher.png", "drawable/splash.png", "drawable-port-xxxhdpi/splash.png", "drawable-land-mdpi/splash.png"]) {
      assert.deepEqual(await readFile(join(main, "res", name)), await readFile(join(tracked, name)), name);
    }
    // Same pixel sizes as the scaffold files they replace (PNG IHDR width, height).
    const size = async (name: string) => {
      const png = await readFile(join(tracked, name));
      return [png.readUInt32BE(16), png.readUInt32BE(20)];
    };
    assert.deepEqual(await size("mipmap-xxxhdpi/ic_launcher.png"), [192, 192]);
    assert.deepEqual(await size("mipmap-xxxhdpi/ic_launcher_foreground.png"), [432, 432]);
    assert.deepEqual(await size("mipmap-mdpi/ic_launcher_round.png"), [48, 48]);
    assert.deepEqual(await size("drawable/splash.png"), [480, 320]);
    assert.deepEqual(await size("drawable-port-xxxhdpi/splash.png"), [1280, 1920]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Android paints the dark wallet background before the page loads", async () => {
  // Same colour as the dark theme's --bg token and the splash background.
  assert.equal(config.android?.backgroundColor, "#0b0c0e");
  const tokens = await readFile(join(walletRoot, "src/styles/tokens.css"), "utf8");
  assert.ok(tokens.includes(`--bg: ${config.android?.backgroundColor};`));
  const icons = await readFile(join(walletRoot, "scripts/generate-icons.mjs"), "utf8");
  assert.ok(icons.includes(`const ANDROID_BG = "${config.android?.backgroundColor}";`));
  // The page's first paint, before React mounts .w-root, is the same colour.
  const html = await readFile(join(walletRoot, "index.html"), "utf8");
  const rule = /(?:^|\s)html \{([^}]*)\}/u.exec(html)?.[1] ?? "";
  assert.ok(rule.includes(`background: ${config.android?.backgroundColor};`), rule);
});

test("Android cap copy and cap sync both run the configure hook", async () => {
  // A bare `cap copy android` writes the extension's files back into
  // assets/public; the hook is idempotent, so running twice in sync is harmless.
  const { scripts } = JSON.parse(await readFile(join(walletRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const hook of ["capacitor:copy:after", "capacitor:sync:after"]) {
    assert.equal(scripts[hook], "node --experimental-strip-types scripts/configure-android.ts", hook);
  }
});

test("Android configuration refuses a malformed manifest instead of reporting policy installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallet-android-config-"));
  try {
    const main = join(root, "android/app/src/main");
    await mkdir(main, { recursive: true });
    await writeFile(join(main, "AndroidManifest.xml"), "<manifest />");
    await assert.rejects(configureAndroid(root, "xyz.zeroxnothing.wallet"), /no application element/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
