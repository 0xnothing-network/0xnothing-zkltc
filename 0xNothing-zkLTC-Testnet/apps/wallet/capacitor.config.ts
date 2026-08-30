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
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
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
