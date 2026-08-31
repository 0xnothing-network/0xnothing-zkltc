# Direct Cloudflare Workers web deployment

This is an additional deployment target. It does not replace the existing
Vercel project or the Cloudflare-to-Railway standalone deployment.

```text
visitor -> Cloudflare Worker (OpenNext) -> LitVM RPC, subgraphs, and Pinata
```

## Repository configuration

The Worker is built with `@opennextjs/cloudflare`. `wrangler.jsonc` is the
runtime source of truth and targets the existing Worker named
`0xnothing-zkltc`. The normal `next build` and `output: "standalone"` remain in
place for Vercel and Railway.

Run these checks from `apps/web` before deployment:

```powershell
npm run test
npm run typecheck
npm run lint
npm run build:cloudflare
npx wrangler deploy --dry-run
```

## Workers Builds settings

Connect the same GitHub repository and use:

```text
Production branch: main
Root directory: 0xNothing-zkLTC-Testnet/apps/web
Build command: npm run build:cloudflare
Deploy command: npm run deploy:cloudflare
```

Cloudflare installs dependencies from the app-local `package-lock.json` before
running the build. Do not set the repository root to `/`: that installs the
root workspace package and leaves Wrangler without `.open-next/worker.js` or
static assets.

## Variables and secrets

`wrangler.jsonc` supplies the non-secret direct-Worker variables and the
`ASSETS` and `IMAGES` bindings. Configure deployment-specific values in the
Cloudflare dashboard:

- Runtime secret: `PINATA_JWT`.
- Runtime variable: `UPLOAD_SIGNING_DOMAIN`, set to the final public Worker
  hostname without a path.
- Build variables: copy only the required `NEXT_PUBLIC_*` production values
  when they intentionally differ from the checked testnet defaults.

If a `NEXT_PUBLIC_*` value is needed by both the build and runtime, add it to
both Workers Builds variables and Runtime variables. Never expose
`PINATA_JWT` as a build variable or a `NEXT_PUBLIC_*` value.

Leave `TRUSTED_PROXY_SHARED_SECRET` unset for this direct Worker. That secret
belongs only to the Cloudflare-to-Railway origin boundary.

## Runtime settings

Wrangler deploys these settings from source control:

- compatibility date `2026-08-31`;
- compatibility flag `nodejs_compat`;
- Workers Logs enabled through observability configuration;
- static assets from `.open-next/assets`;
- Cloudflare Images binding named `IMAGES`.

Enable either the generated `workers.dev` hostname or a custom domain only
after a successful deployment. Then set `UPLOAD_SIGNING_DOMAIN` to that exact
host and verify `/api/health` returns `200` with `Cache-Control: no-store`.

## Scaling boundary

The current in-process upload replay locks and API rate limiters are local to a
Worker isolate. Cloudflare still provides edge distribution, but those maps are
not globally authoritative. Before relying on them as cross-region security
controls, move replay/idempotency state to a Durable Object or D1 and enforce
abuse limits with Cloudflare Rate Limiting. Persistent OpenNext ISR/data cache
through R2 plus a Durable Object is an optional later optimization; it is not
required for the first deploy.

## Production smoke test

Verify at least:

```powershell
curl.exe -sS -D - https://<worker-host>/api/health -o NUL
curl.exe -sS -D - https://<worker-host>/docs -o NUL
curl.exe -sS -D - "https://<worker-host>/_next/image?url=%2F0xNothing.jpg&w=384&q=75" -o NUL
curl.exe -sS -D - https://<worker-host>/api/ipfs/upload -o NUL
```

The first three requests must succeed. The upload configuration endpoint must
report `configured: true` only after both `PINATA_JWT` and
`UPLOAD_SIGNING_DOMAIN` are set.
