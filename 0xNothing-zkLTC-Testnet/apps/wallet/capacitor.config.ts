import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Android wrapper over the exact same dist/ that the extension loads.
 * `androidScheme: "https"` keeps the WebView on a secure origin so WebCrypto
 * (used by the keyring) and localStorage behave like they do in the extension.
 */
const config: CapacitorConfig = {
  appId: "xyz.zeroxnothing.wallet",
  appName: "0xNothing Wallet",
  webDir: "dist",
  // Never log, in any build: by default a debug build's bridge writes every
  // plugin call and result to logcat, and those include the encrypted vault
  // record and the account list read through Preferences.
  loggingBehavior: "none",
  android: {
    allowMixedContent: false,
    // Off (the default): with it on, Capacitor hands the keyboard a bare input
    // connection that can inject script and that hides password fields' type.
    captureInput: false,
    webContentsDebuggingEnabled: false,
    // The dark theme's --bg (and the splash), painted before the page parses,
    // so a cold start does not flash white between the splash and the wallet.
    backgroundColor: "#0b0c0e",
  },
  server: {
    androidScheme: "https",
    cleartext: false,
  },
  plugins: {
    CapacitorHttp: { enabled: false },
  },
};

export default config;
