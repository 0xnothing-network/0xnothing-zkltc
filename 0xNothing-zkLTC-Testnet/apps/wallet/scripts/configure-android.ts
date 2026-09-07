import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../capacitor.config.ts";

const walletRoot = fileURLToPath(new URL("..", import.meta.url));
const policyNames = ["wallet_backup_rules.xml", "wallet_data_extraction_rules.xml"] as const;

function applicationAttribute(tag: string, name: string, value: string): string {
  const attribute = new RegExp(`\\s+android:${name}\\s*=\\s*["'][^"']*["']`, "u");
  const replacement = ` android:${name}="${value}"`;
  return attribute.test(tag) ? tag.replace(attribute, replacement) : tag.replace(/>$/u, `${replacement}>`);
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

  // Install policies before the manifest can reference them. They exclude all
  // app data, including Preferences ciphertext and WebView state, on API 24+.
  for (const name of policyNames) {
    const policy = await readFile(join(walletRoot, "native/android/res/xml", name), "utf8");
    const destination = join(mainDir, "res/xml", name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, policy);
  }
  if (configured !== manifest) await writeFile(manifestPath, configured);

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
    console.log("[wallet] Android backup policy and package assertion configured");
  }
}
