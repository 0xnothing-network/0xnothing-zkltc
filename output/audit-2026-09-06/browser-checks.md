# Browser interaction checks, 2026-09-07

Local Next development server, read-only UI; no wallet signing or transaction submission.

- 0xFi SwapAssetSelect: ArrowDown opened choices; repeated n cycled matches; Escape returned focus; Tab moved to Reverse and Shift-Tab to amount input. Mobile 390x844 had no horizontal overflow; console errors/warnings empty.
- 0xPump at 390x844: menu opened; Escape closed it and focused Open navigation; clicking Trending outside the header closed it; Portfolio navigation completed with menu closed and disconnected wallet prompt rendered. documentElement.scrollWidth=384, innerWidth=390. Console errors/warnings empty.
- Temporary viewport override reset. Development server stopped before production build validation.

These are targeted interaction checks, not an exhaustive visual or live-wallet end-to-end test.
