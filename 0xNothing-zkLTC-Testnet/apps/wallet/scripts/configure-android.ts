import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../capacitor.config.ts";

const walletRoot = fileURLToPath(new URL("..", import.meta.url));
const policyNames = ["wallet_backup_rules.xml", "wallet_data_extraction_rules.xml"] as const;
// dist/ is shared with the extension; these can never run in the WebView.
const extensionOnly = ["background.js", "content.js", "inpage.js", "manifest.json", "_locales"] as const;

/** 1.0.9 -> 10009. Rejects shapes that would break the monotonic scheme. */
export function androidVersionCode(version: string): number {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!parts) throw new Error(`[wallet] package.json version ${version} is not major.minor.patch`);
  const [major, minor, patch] = parts.slice(1).map(Number) as [number, number, number];
  if (minor > 99 || patch > 99) throw new Error(`[wallet] package.json version ${version} overflows versionCode`);
  return major * 10000 + minor * 100 + patch;
}

function applicationAttribute(tag: string, name: string, value: string): string {
  const attribute = new RegExp(`\\s+android:${name}\\s*=\\s*["'][^"']*["']`, "u");
  const replacement = ` android:${name}="${value}"`;
  return attribute.test(tag) ? tag.replace(attribute, replacement) : tag.replace(/(\s*\/?)>$/u, `${replacement}$1>`);
}

/** Apply source-controlled policy after Capacitor recreates its ignored shell. */
export async function configureAndroid(rootDir: string, appId: string): Promise<void> {
  if (!/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/u.test(appId)) {
    throw new Error("[wallet] Invalid Android appId in capacitor.config.ts");
  }
  const mainDir = join(rootDir, "android/app/src/main");
  const manifestPath = join(mainDir, "AndroidManifest.xml");
  const manifest = await readFile(manifestPath, "utf8");
  if (!/<application\b[^>]*>/u.test(manifest)) {
    throw new Error("[wallet] AndroidManifest.xml has no application element");
  }
  const configured = manifest.replace(/<application\b[^>]*>/u, (tag) => {
    tag = applicationAttribute(tag, "allowBackup", "false");
    tag = applicationAttribute(tag, "fullBackupContent", "@xml/wallet_backup_rules");
    return applicationAttribute(tag, "dataExtractionRules", "@xml/wallet_data_extraction_rules");
  });

  // The tracked activity (FLAG_SECURE, Back handling) replaces the scaffold's
  // empty BridgeActivity subclass, in the package that matches appId.
  const activity = (await readFile(join(walletRoot, "native/android/java/MainActivity.java"), "utf8"))
    .replace(/^package [\w.]+;/mu, `package ${appId};`);
  const activityPath = join(mainDir, "java", ...appId.split("."), "MainActivity.java");
  // Refuse to overwrite a scaffold that grew code of its own (registerPlugin
  // calls, say): that code would be lost silently. A file with the tracked
  // marker is an older install of ours, since cap sync never regenerates it.
  // Checked before any write, so a refusal leaves the shell as it was.
  const scaffold = await readFile(activityPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (scaffold !== null && scaffold !== activity && !/class MainActivity extends BridgeActivity \{\s*\}/u.test(scaffold)
    && !scaffold.includes("Tracked source: scripts/configure-android.ts")) {
    throw new Error("[wallet] Generated MainActivity.java is not the empty scaffold; merge it into native/android/java");
  }

  // Install policies before the manifest can reference them. They exclude all
  // app data, including Preferences ciphertext and WebView state, on API 24+.
  for (const name of policyNames) {
    const policy = await readFile(join(walletRoot, "native/android/res/xml", name), "utf8");
    const destination = join(mainDir, "res/xml", name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, policy);
  }
  // An empty task affinity keeps another app's activity from being slotted into
  // the wallet's task (task hijacking), which the OS only blocks from API 30.
  const hardened = configured.replace(/<activity\b[^>]*android:name="\.MainActivity"[^>]*>/u, (tag) =>
    applicationAttribute(tag, "taskAffinity", ""));
  if (hardened !== manifest) await writeFile(manifestPath, hardened);

  await mkdir(dirname(activityPath), { recursive: true });
  await writeFile(activityPath, activity);

  for (const name of extensionOnly) {
    await rm(join(mainDir, "assets/public", name), { recursive: true, force: true });
  }

  // Keep App info in step with the version Settings shows (package.json).
  const { version } = JSON.parse(await readFile(join(walletRoot, "package.json"), "utf8")) as { version: string };
  const gradlePath = join(rootDir, "android/app/build.gradle");
  const gradle = await readFile(gradlePath, "utf8");
  if (!/\bversionCode \d+/u.test(gradle) || !/\bversionName "[^"]*"/u.test(gradle)) {
    throw new Error("[wallet] android/app/build.gradle has no versionCode or versionName");
  }
  const versioned = gradle
    .replace(/\bversionCode \d+/u, `versionCode ${androidVersionCode(version)}`)
    .replace(/\bversionName "[^"]*"/u, `versionName "${version}"`);
  if (versioned !== gradle) await writeFile(gradlePath, versioned);

  // Launcher icons and splash images from scripts/generate-icons.mjs. Each one
  // replaces the same-named scaffold PNG, so no XML resource changes.
  const resSource = join(walletRoot, "native/android/res");
  for (const entry of await readdir(resSource, { recursive: true })) {
    if (!entry.endsWith(".png")) continue;
    const destination = join(mainDir, "res", entry);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(resSource, entry), destination);
  }

  // Capacitor's example keeps a generic package assertion after cap add. Only
  // patch that scaffold file; application code and other tests are untouched.
  const examplePath = join(rootDir, "android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java");
  let example: string;
  try {
    example = await readFile(examplePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const aligned = example.replace(
    /assertEquals\("[^"]+",\s*appContext\.getPackageName\(\)\);/u,
    `assertEquals("${appId}", appContext.getPackageName());`,
  );
  if (aligned !== example) await writeFile(examplePath, aligned);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.CAPACITOR_PLATFORM_NAME || process.env.CAPACITOR_PLATFORM_NAME === "android") {
    await configureAndroid(walletRoot, config.appId ?? "");
    console.log("[wallet] Android policy, activity, version, icons and package assertion configured");
  }
}
