import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureAndroid } from "../../scripts/configure-android.ts";

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

    await configureAndroid(root, "xyz.zeroxnothing.wallet");
    const once = await readFile(manifestPath, "utf8");
    assert.match(once, /android:allowBackup="false"/u);
    assert.match(once, /android:fullBackupContent="@xml\/wallet_backup_rules"/u);
    assert.match(once, /android:dataExtractionRules="@xml\/wallet_data_extraction_rules"/u);
    assert.match(once, /android:label="Keep label"/u);
    assert.match(once, /<activity android:name=".MainActivity" \/>/u);
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
