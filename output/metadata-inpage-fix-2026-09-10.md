# Pump metadata and duplicate wallet injection — 2026-09-10

## Root causes and changes
- TokenDetail fetched ipfs:// metadata directly from dweb.link. Gateway CORS/403 combined with query retries caused repeated browser errors.
- Added /api/pump/metadata?cid=... using the existing conservative CID/path parser, fixed HTTPS gateways, redirect rejection, 8-second aggregate deadline, 64 KiB body cap, field projection, bounded cache/coalescing and 30-second negative caching. No arbitrary destination proxy and no CSP loosening.
- TokenDetail routes IPFS metadata through the same-origin endpoint, disables automatic retry/focus/reconnect refetch for optional metadata, and treats an unavailable response header as a failed optional query rather than caching an empty result for an hour. Existing non-IPFS HTTP(S) behavior retained.
- Wallet inpage initialization checks the existing zeroxnothing property before installing listeners, making requests or announcing. Namespace is claimed before announcing; another wallet's ethereum property is preserved. Signing request timeouts unchanged.

## Evidence and verification
- Live request using bafkreig3eedskjp45hcwf47bhfcwxtlw5fayiwmxcc472hvysunyhy2dqy returned HTTP 200, X-Pump-Metadata-Status: available and description PROMO.
- Fresh Edge token page had no dweb error entries. Existing installed extension still logged Cannot redefine property zeroxnothing from chrome-extension://phbdlkllcdmgobigfmejgjfcoifmmndj/inpage.js.
- ObjectMultiplex app-init-liveness/background-liveness warnings and a provider conflict came from MetaMask chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/contentscript.js and inpage.js. Not emitted by this web app.
- Reported CSP warning did not reproduce in the inspected session; supplied message redacted destination as <URL>. Policy was not weakened without an attributable blocked request.
- Web tests: 118/118 pass (exit 0), including proxy invalid destination/traversal rejection, gateway failure recovery, request coalescing, payload projection and negative caching/oversize protection.
- Wallet verify: exit 0; 114/114 tests, typecheck, production build including dist/inpage.js and dist/content.js. New tests execute real inpage source twice and with an existing non-configurable namespace.
- Targeted ESLint: exit 0. git diff --check: exit 0. Graft rebuilt.
- Production web build: see metadata-web-build.log for final result.

## Activation boundary
Browser policy blocked access to the extension management page. Installed extension reload was not performed; user must reload the unpacked extension pointing at apps/wallet/dist (or update their installed distribution) and then reload the web page. No extension was disabled, reinstalled or granted extra permissions. MetaMask warnings require its own extension lifecycle/configuration; no changes made to MetaMask.

Final production web build: exit 0; 33 generated pages. Standalone preview refreshed on 127.0.0.1:3301.
