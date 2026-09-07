# Wallet source audit and repairs

Completed 2026-09-07. Scope: `0xNothing-zkLTC-Testnet/apps/wallet`. The shared working tree was preserved; only the wallet files listed below were changed by this audit. No wallet stylesheet or design token was changed.

## Read coverage

The accompanying `wallet-reviewed.json` contains the complete reviewed-file ledger, current line and byte counts, and SHA-256 hashes. Every entry was read in full; truncated tool output was followed by another bounded read. Counting generated bundles or a search hit as a full read was avoided.

| Scope | Files read | Lines in final snapshot |
| --- | ---: | ---: |
| `src/` including all TS/TSX, translations, ABI fragments and the entire stylesheet | 100 | 20,644 |
| `tests/` including the new regression tests | 22 | 1,948 |
| First-party build/config/public metadata/docs/showcase/native policy source | 28 | 2,252 |
| Existing ignored Android shell, Gradle wrappers/templates, Java/XML/config and generated policy copies | 36 | 1,141 |
| **Total** | **186** | **25,985** |

The initial non-generated text inventory was 144 files. Two typed-data files and four Android source/test/policy files were added during repairs. The Android shell contributed 34 existing text files plus two generated policy copies. Total final source size in the ledger is 927,578 bytes.

Explicit exclusions from full-source reading: package-lock generated dependency records; `node_modules`; built `dist/`; Android `.gradle`, `build/`, and copied `assets/public/`; JAR/APK/AAB/native binaries; fonts and raster images; existing store export ZIPs and raster screenshots; machine-specific `local.properties`. Gradle launch scripts and generated native configuration were nevertheless read because they govern the local wrapper. The font's presence in `dist/fonts/` was checked separately. Raster marketing exports were not regenerated or visually re-audited.

Graft graph context and call chains were consulted before source edits. Codebase Memory coverage was checked for the wallet scope and all reviewed paths, including new native sources. The final scope response had 69 recorded gaps and `has_more: false`; most are excluded assets/build outputs. Three native parse-partial files (`android/app/build.gradle:22`, Cordova `build.gradle:57`, `android/gradlew:180`) and excluded store source/docs were covered with complete direct reads. Newly written files and generated copies can report `metadata_changed`; the ledger and direct source reads, rather than the graph's absence of a warning, are the coverage evidence. No claim of a complete graph or absence of all defects is made.

## Implemented repairs

1. **Signing and private-key reveal now verify account identity.** In `src/core/keyring/vault.ts:459`, the common `accountForMeta` resolver checks that the derived/imported key's address matches the requested public metadata address. Before this change, corrupt HD indices or imported account metadata could cause a different key to sign or be revealed under the requested account. Both signing and password-confirmed key reveal now reject that mismatch. HD and imported-key regression cases were added in `tests/core/vault.test.ts`.

2. **Hostile typed-data display fields fail closed.** `src/ui/lib/typedData.ts:12` parses the untrusted JSON into validated display text and a nonnegative safe-integer chain identifier. Objects/arrays in domain/name/primaryType, malformed roots, invalid numeric representations, and unsafe integers return an unreadable request. `Approve.tsx` uses this helper, so malformed dapp metadata cannot crash React by supplying an object as display content. Valid number, decimal-string and hexadecimal-string chain IDs remain supported. Behavioral regression cases are in `tests/ui/typedData.test.ts`.

3. **Android backup policy is reproducible after shell regeneration.** The Android vault is AES-GCM ciphertext in Capacitor Preferences; the unlocked AES key is only in process memory. The generated application manifest previously had `allowBackup="true"`. Android's default backup includes shared preferences and other private app data, so the ciphertext could be copied even though the wallet promises device-local storage. The package now runs `scripts/configure-android.ts:16` after every Capacitor sync. Tracked XML under `native/android/res/xml/` excludes every app data domain from legacy backup, modern cloud backup and device transfer, and the hook sets `allowBackup="false"` plus both manifest policy references. `/android/` is anchored in `.gitignore` so policy source under `native/android/` is versionable. This does not change the vault encryption scheme. Platform behavior was verified against [Android Auto Backup documentation](https://developer.android.com/identity/data/autobackup); lifecycle hook placement was verified against the installed Capacitor CLI and [Capacitor hooks documentation](https://capacitorjs.com/docs/cli/hooks).

4. **The generated instrumented test uses the configured application ID.** The same durable hook aligns Capacitor's scaffold assertion with `appId` from `capacitor.config.ts`, replacing its stale `com.getcapacitor.app` expectation. It only touches the known scaffold test. The new Android configuration regressions exercise regeneration, both backup rule formats, idempotence, changes to app ID and rejection of an invalid manifest.

5. **Documentation and showcase metadata match current source.** README now states Chrome 120, current test paths, selected-network typed-data checks, and the Android backup policy. A stale fixed test count was replaced by a description of the discovered suite. The store showcase reads chain ID 4441 from `src/config/chain.ts` and version 1.0.1 from package metadata. Its displayed receive address and QR now derive from one demo address. Existing raster exports still contain their previous captured content and need new captures before being presented as current store assets.

## Verification with captured results

| Check | Final result | Evidence |
| --- | --- | --- |
| Full wallet `npm test` | **102 passed, 0 failed, exit 0** | Session 97710, final chunk `671764`, 16,232 ms |
| Wallet `npm run typecheck` after Android hook/test changes | **exit 0** | Session 38258, final chunk `50e9db` |
| Wallet `npm run build:android` | **exit 0** | Session 43887, final chunk `a956d5`; app, service worker, injection scripts, Capacitor sync and post-sync hook all completed |
| Android manifest/resource processing and instrumented Java compilation | **exit 0** | Session 48136, final chunk `18da90`; 93 tasks, 34 executed, 59 up-to-date; 1m 1s |
| Standalone Vite build of `store-assets/source/showcase.html` | **exit 0** | Chunk `270e3a`; isolated output `wallet-showcase-build/` |
| `git diff --check -- apps/wallet` | **exit 0** | Chunk `224898`, subsequently rechecked while inspecting generated manifest |
| CSS SHA-256 compared with pre-edit baseline | **identical** | `BBCB8A760BF7E50725C19765C6EB1E80E8098E54D18405BAB263B5C72A485EBD` |

The native command used installed JDK 21.0.12.1+1 and Gradle 8.14.3 with `ANDROID_HOME=C:/Users/tdat/AppData/Local/Android/Sdk`, executing `:app:processDebugMainManifest :app:processDebugResources :app:compileDebugAndroidTestJavaWithJavac --no-daemon`. The first attempt exited 1 because no SDK path was configured in the shell; the explicit-path retry passed. No global environment setting was changed.

Nonfatal warnings retained: Vite leaves the document-relative Departure Mono URL for runtime resolution (the emitted font exists at `dist/fonts/DepartureMono-Regular.woff2`, 22,496 bytes); a build run reported time spent inside Vite plugin hooks; Gradle warned about Capacitor's `flatDir` repositories and installed SDK XML parser version skew. Native resources and Java compilation still completed successfully.

Earlier verification after the first two runtime repairs also passed 100 wallet tests, typecheck and regular build with exit 0. The 102-test run above supersedes that result after native work. No further wallet source change followed these final checks except the `.gitignore` anchoring, which was inspected separately.

## Limits and follow-up candidates

This is source review plus local build/test verification. No Android device/emulator instrumentation run, physical backup/restore exercise, live browser-extension signing, RPC transaction broadcast, deployment or store publication was performed. Native compilation is not evidence that OS backup/restore has been exercised. Existing operating-system backups are not deleted by this patch. Seed phrases and separate imported-key backups remain required for recovery.

The review also identified candidates for additional dedicated regression work, not covered by the implemented fixes: `quoteSend` rereads the mutable global RPC client across awaits; custom-token built-in address filtering is applied on custom networks; local portfolio snapshots are keyed by account without a network discriminator; local history decoding does not validate every status/kind before presentation. Their practical user-visible impact and migration behavior were not established in this patch set, so they should not be counted as repaired or as proof of live vulnerabilities. Public balances/prices/history remain subject to the documented RPC, oracle and local-history limitations.

Graft token-saving estimates observed by this wallet subtask total approximately 183,393 tokens across its captured calls; this is the tool's estimate, not measured model usage.
