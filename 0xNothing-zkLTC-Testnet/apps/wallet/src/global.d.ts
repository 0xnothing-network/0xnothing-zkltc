/**
 * Build-time constants.
 *
 * `__WALLET_VERSION__` is replaced by vite.config.ts with the version from
 * package.json, so the version the UI reports can never drift from the one the
 * bundle was built at.
 */
declare const __WALLET_VERSION__: string;
