Package to upload: `0xWallet-1.0.10.zip` in the wallet folder (`apps/wallet/0xWallet-1.0.10.zip`).
Every text field for the dashboard is in `LISTING.md`, next to this file.
`copy-sheet.html`, next to this file, is the quick way to paste them: open it in a browser and use its Copy buttons.

# 0xWallet Chrome Web Store upload map

Upload only files from this `chrome-web-store-ready` directory.

## Store icon

- `store-icon-128.png` -> Store icon (128x128)

## Localized screenshots - Vietnamese

Upload `localized-vi/*.png` in numeric order to **Localized screenshots**.

1. `01-portfolio.png`
2. `02-swap-search.png`
3. `03-review-sign.png`
4. `04-receive-qr.png`
5. `05-local-security-networks.png`

## Global screenshots - English

Upload `global-en/*.png` in numeric order to **Screenshots for all locales**.

1. `01-portfolio.png`
2. `02-swap-search.png`
3. `03-review-sign.png`
4. `04-receive-qr.png`
5. `05-local-security-networks.png`

## Promotional images

- `promo/small-promo-440x280.png` -> Small promo tile
- `promo/marquee-1400x560.png` -> Marquee promo tile

The promotional video field may remain empty.

## Validation

- Screenshots: 1280x800 PNG, RGB 24-bit, no alpha
- Small promo tile: 440x280 PNG, RGB 24-bit, no alpha
- Marquee promo tile: 1400x560 PNG, RGB 24-bit, no alpha
- Store icon: 128x128 PNG, RGB 24-bit, no alpha

All balances and addresses shown are public demo data. No user wallet data is included.

## What the screenshots show (version 1.0.10)

Each screenshot is one real capture of the built extension (360x600 popup, dark theme)
shown at 1.15x on the wallet's graphite background, with a headline and one line.

1. `01-portfolio.png` - Home: total balance, actions, token list with USD values
2. `02-swap-search.png` - Swap: NUSD to zkLTC with the quote, minimum received, route, fee
3. `03-review-sign.png` - Approval window: a local demo site's approve request, decoded
4. `04-receive-qr.png` - Receive: QR code, address, copy, save QR, explorer link
5. `05-local-security-networks.png` - Settings: auto-lock, lock now, password, phrase and key

The demo site request was rejected; no transaction was sent. To remake the images, run
`source/make-shots.mjs` (captures), then the same script with `COMPOSE=1` (layout from
`source/store-shots.html`); the contact sheets in `../previews/` are written with them.

