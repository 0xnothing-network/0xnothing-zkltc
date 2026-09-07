# 0xNothing — logo motion & 0xWallet campaign

Created 2026-09-05. Updated with the requested slogan **nothing to everything**. The logo films feature only the 0xNothing brand and this slogan. Wallet products appear only in the separate campaign images.

## Deliverables

| File | Format | Intended use |
| --- | --- | --- |
| `video/nothing-logo-16x9-1080p.mp4` | 1920×1080, 30 fps, 10 s, H.264/AAC | Landscape brand intro / social |
| `video/nothing-logo-9x16-1080p.mp4` | 1080×1920, 30 fps, 10 s, H.264/AAC | Vertical brand intro / Stories / Reels |
| `images/01-extension-social.png` | 1672×941 PNG | Browser extension campaign |
| `images/02-android-app-social.png` | 1003×1568 PNG | Android app preview campaign |
| `images/03-wallet-platforms-social.png` | 1672×941 PNG | Browser + Android campaign |
| `previews/nothing-logo-poster.png` | 1920×1080 PNG | Logo-film cover |
| `previews/logo-storyboard.png` | 1440×540 PNG | Six selected motion frames |

Open `index.html` for a local gallery with video playback and original image links. The PNGs retain the native dimensions returned by image generation; they have not been stretched or cropped into different ratios.

## Creative direction

- Logo: the project's angular white **N** and small red dot. The motion geometry follows `apps/web/public/0xNothing.jpg`; it is an animation master, not a replacement for the website asset.
- Motion: outline emerges, the N draws in three strokes, the red point settles with a restrained pulse, then the name appears and **nothing to everything** reveals in three parts. The lockup holds before fading. No wallet, token, protocol or other product appears in either film.
- Sound: a quiet original synthesized three-note texture and soft logo accent. No stock music or third-party audio is used. Both videos can be muted for a silent loop.
- Campaign: near-black, mint accents, generous typography and the project's square/monospace wallet interface.

## Product accuracy

The wallet images are **AI-generated marketing mockups based on the repository's public demo UI**, not pixel-exact device screenshots. Their balances and addresses are demo data. They use **LitVM testnet** and **Android app preview** wording. They do not claim a Google Play / App Store release, a verified Chrome Web Store listing, mainnet readiness, guaranteed returns or a security certification.

References used:

- `0xNothing-zkLTC-Testnet/apps/web/public/0xNothing.jpg`
- `0xNothing-zkLTC-Testnet/apps/wallet/store-assets/chrome-web-store-ready/global-en/01-portfolio.png`
- `0xNothing-zkLTC-Testnet/apps/wallet/README.md`
- `0xNothing-zkLTC-Testnet/apps/wallet/src/styles/wallet.css`

The existing website, extension, application source and original brand/store assets were left unchanged by this campaign task. Nothing was published or uploaded to a social account.

## Source & reproduction

- `source/image-prompts.json`: all three exact prompts. Images were generated with the built-in image generation tool, using the original mark and demo UI as references.
- `source/render-logo-motion.mjs`: deterministic vector motion and original audio synthesis. It uses the installed web `sharp` dependency and FFmpeg on PATH; no new dependency was added.
- `source/nothing-motion-master.svg`: the resolved logo lockup at the hold frame.
- `source/nothing-original-sound.wav`: original 48 kHz stereo sound design.
- `captions.md`: ready-to-edit English and Vietnamese copy.
- `manifest.json`: exported media metadata and SHA-256 hashes.

To render the videos again from this repository:

```powershell
node output/nothing-campaign-2026-09-05/source/render-logo-motion.mjs
```

For still-frame previews only, add `--preview`. Re-rendering replaces files inside this campaign folder only.
