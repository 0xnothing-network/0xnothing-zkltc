# UI reference upgrade — 2026-09-10

Scope: preserve the current pixel font, dark palette, circular logos, product logic, existing content and compact three-column Pump Trending on mobile.

Applied:
- Homepage hero uses a thin frame, pixel corner markers and a connected three-entry product grid. Existing slogan and product routes retained. At <=760px entries stack with 62px targets.
- Footer exposes existing /docs and /privacy routes.
- Pump and Pixel active navigation share a mint underline; shared field placeholder and hover treatments are scoped to product roots. Reduced-motion overrides retained.
- New branded 404 provides home and docs recovery links.

References: all 22 requested domains were attempted through web reading. Navbar Gallery, Supahero and Footer Design were additionally inspected visually in the browser. Applied ideas are hierarchy, aligned navigation and concise footer links, adapted to the established pixel styling. No external imagery, new runtime dependencies or copied layouts were added.
Read accessible: navbar.gallery, supahero.io, footer.design, cta.gallery, 60fps.design, designspells.com, bentogrids.com, gridddy.framer.website, onepagelove.com/og, saaspo.com, styles.refero.design, recent.design, curated.design, webinspoo.com, mesh3d.gallery. Some were minimal/script-heavy pages.
Read failures: 404s.design, unsection.com, rebrand.gallery, landing.love, saasframe.io, vantaui.com, simply-buttons.vercel.app. No claim of full visual inspection of all 22.

Validation:
- Targeted ESLint for homepage and new not-found component: exit 0.
- git diff --check: exit 0.
- Desktop screenshots inspected for homepage, 404, Pump and Pixel. 404 home recovery link exercised.
- Mobile viewport capability accepted 390x844 but actual DOM remained 1280px; mobile visual verification is incomplete. Breakpoint code is present, not represented as browser-verified.
- Production build result: see ui-reference-build.log.
- No wallet interaction or onchain transaction performed; no deployment.

Final production build: npm run build exited 0. Additional desktop verification: 0xFi Swap rendered and homepage Docs link reached /docs successfully.
