# Cloudflare + Railway web deployment

This runbook covers the Cloudflare-to-Railway target and keeps its existing
Node.js runtime intact. A separate direct Workers target is documented in
[`CLOUDFLARE_WORKERS.md`](./CLOUDFLARE_WORKERS.md); the two targets can coexist.

```text
visitor -> Cloudflare DNS/CDN/WAF -> Railway Singapore -> Next.js standalone
```

Do not use the Workers adapter when starting the Railway service. Railway must
continue to build the Next.js standalone output and start its generated
`server.js`. Run one Railway replica until replay/rate-limit state has moved to
shared durable storage.

## 1. Deploy the origin

Deploy the repository root on Railway. The checked `Dockerfile` builds
`0xNothing-zkLTC-Testnet/apps/web` and starts the generated standalone
`server.js`. The checked `railway.json` pins one Singapore replica and probes
`/api/health` for an existing service that already uses Railway Config as Code.

Railway deprecated `railway.json` for new services in 2026. Existing services
that already adopted it can use it only until the hard cutoff on **2026-12-01**.
A new service must apply the same region, replica, and health-check values in
the dashboard, through Railway Infrastructure as Code, or with the Railway
CLI; do not assume the legacy file was adopted merely because it exists in the
repository. Run `railway config init` or `railway config pull`, review the
generated `.railway/railway.ts` with `railway config plan`, and migrate before
the cutoff. The checked legacy file remains a compatibility bridge for an
existing service, not the long-term source of truth.
See Railway's current [Config as Code notice](https://docs.railway.com/config-as-code)
and [region identifiers](https://docs.railway.com/deployments/regions).

- Select Railway's Singapore region.
- Add the production hostname as a Railway custom domain.
- Copy both the CNAME and ownership-verification TXT records shown by Railway.
- Keep `/api/health` public and uncached so Railway can probe the origin.

Railway's current domain flow is documented in
[Working with Domains](https://docs.railway.com/networking/domains/working-with-domains).

## 2. Configure Cloudflare DNS and TLS

Create the Railway CNAME and TXT records in Cloudflare. Enable the orange-cloud
proxy on the application CNAME after Railway verifies the domain. For a wildcard,
keep the `_acme-challenge` record DNS-only as Railway requires.

Use these zone settings:

- SSL/TLS encryption mode: **Full**. Railway explicitly requires `Full`, not
  `Full (strict)`, for its Cloudflare-proxied custom-domain flow.
- Edge Certificates: Always Use HTTPS on, Minimum TLS Version 1.2, TLS 1.3 on.
- Network: WebSockets on and HTTP/3 on.
- Speed: Brotli on. Keep Rocket Loader off because this app has a strict CSP,
  React hydration, and wallet-provider scripts.

Do not add a second HTTP-to-HTTPS redirect at the origin. Cloudflare recommends
performing this redirect at the edge to avoid loops.

## 3. Configure production variables

Generate a random proxy secret locally:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Prepare these Railway service variables. Replace the hostname and secret with
the real values; do not commit either secret. Keep all three proxy variables
(`UPLOAD_TRUSTED_PROXY_CLIENT_IP_HEADER`,
`FI_TRUSTED_PROXY_CLIENT_IP_HEADER`, and `TRUSTED_PROXY_SHARED_SECRET`) unset
until the Transform Rule in the next section is deployed, then set the three
together. This avoids a partial rollout and temporary public-route `403`s.

```dotenv
UPLOAD_SIGNING_DOMAIN=0xnothing.xyz
NEXT_PUBLIC_APP_URL=https://0xnothing.xyz/0xFi
UPLOAD_TRUSTED_PROXY_CLIENT_IP_HEADER=cf-connecting-ip
FI_TRUSTED_PROXY_CLIENT_IP_HEADER=cf-connecting-ip
TRUSTED_PROXY_SHARED_SECRET=<same-64-character-hex-secret-as-cloudflare>
```

`NEXT_PUBLIC_APP_URL` is a build-time public value in the root `Dockerfile`; the
other values are server-only runtime variables.

Cloudflare documents `CF-Connecting-IP` as the single visitor address sent to
the origin. The app does not trust it merely because it is present: when
`TRUSTED_PROXY_SHARED_SECRET` is set, the request must also contain the matching
proxy authentication header.

## 4. Authenticate the proxy request header

In Cloudflare, create **Rules -> Transform Rules -> Modify Request Header**:

- Name: `Authenticate 0xNothing origin requests`
- Match: `http.host eq "0xnothing.xyz"`
- Operation: `Set static`
- Header: `x-0xnothing-proxy-secret`
- Value: the exact value stored in Railway as `TRUSTED_PROXY_SHARED_SECRET`

Deploy the Transform Rule first, verify it with Cloudflare Trace, and only then
set all three proxy variables on Railway in one change. When disabling the
boundary, do the reverse: unset all three Railway variables before removing the
Transform Rule. If both apex and `www` serve the app, match both hostnames or
redirect one to the canonical hostname at Cloudflare.

The Set operation overwrites a same-named header supplied by a visitor. When
the Railway secret is configured, the app middleware returns `403 no-store`
for every request without the matching header except `/api/health`. This both
protects the selected `CF-Connecting-IP` value and prevents bypassing the
Cloudflare WAF through Railway's generated public hostname. A private origin or
Cloudflare Tunnel remains the stronger long-term boundary.

Cloudflare documents the setup and plan availability under
[Request Header Transform Rules](https://developers.cloudflare.com/rules/transform/request-header-modification/)
and [Transform Rules](https://developers.cloudflare.com/rules/transform/).

## 5. Add conservative Cache Rules

Cloudflare caches static file extensions by default. Leave HTML and all other
dynamic routes on the default behavior. Add only these two rules. In the
Cloudflare dashboard, put the public-read eligibility rule first and the bypass
rule last so cookie, authorization, mutation, health, and user-data requests
cannot be made eligible by a later rule.

### Cache public read APIs according to origin headers

Expression:

```text
(http.host eq "0xnothing.xyz"
and http.request.method in {"GET" "HEAD"}
and not any(http.request.uri.args["force"][*] == "1")
and (
  http.request.uri.path in {
    "/api/pump/candles"
    "/api/pump/holders"
    "/api/pump/image"
    "/api/pump/markets"
    "/api/pump/stats"
    "/api/pump/trades"
    "/0xFi/api/data/activity"
    "/0xFi/api/data/candles"
    "/0xFi/api/data/pools"
    "/api/marketplace/activity"
    "/api/marketplace/listings"
    "/api/listing-image"
    "/api/pixel-image"
    "/api/token-metadata"
  }
  or starts_with(http.request.uri.path, "/api/pump/markets/")
  or starts_with(http.request.uri.path, "/0xFi/api/token/")
))
```

Settings:

- Cache eligibility: **Eligible for cache**.
- Edge TTL: **Use cache-control header if present, bypass cache if not**.
- Browser TTL: respect the origin header.
- Cache key: standard, including all query-string values.

Never choose **Ignore cache-control header** for this rule. Cacheable public
success responses send explicit TTLs. The JSON routes also send
`Cloudflare-CDN-Cache-Control` so Cloudflare can honor stale-while-revalidate
without changing the existing platform/browser policy. Responses marked
`no-store` remain uncacheable, and the Edge TTL option above bypasses responses
with no cache header. Overriding those safeguards can persist errors or private
data at the edge. Cloudflare documents the behavior in
[Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/) and
[Investigating uncached responses](https://developers.cloudflare.com/cache/troubleshooting/investigating-uncached-responses/).

### Bypass mutations, user data, and health checks

Keep this rule last. Expression:

```text
(http.host eq "0xnothing.xyz" and (
  not (http.request.method in {"GET" "HEAD"})
  or http.cookie ne ""
  or any(lower(http.request.headers.names[*])[*] == "authorization")
  or any(http.request.uri.args["force"][*] == "1")
  or http.request.uri.path eq "/api/health"
  or http.request.uri.path eq "/api/ipfs/upload"
  or http.request.uri.path eq "/api/user-nfts"
))
```

Action: **Bypass cache**.

## 6. WAF and rate limiting

- Enable Cloudflare's managed DDoS/WAF defaults.
- Add an edge rate-limit rule matching both `http.host eq "0xnothing.xyz"` and
  `http.request.uri.path eq "/api/ipfs/upload"`, starting conservatively and
  observing real wallet traffic before tightening it.
- Do not cache, challenge, or rewrite `/api/health`.
- Keep the application rate limits enabled; Cloudflare is an additional layer,
  not their replacement.

## 7. Verify after every production change

Run the local checks first:

```powershell
npm run test:web
npm run typecheck:web
npm run lint:web
npm run build:web
```

Then inspect the deployed headers twice. A safe public API should progress from
`CF-Cache-Status: MISS` or `DYNAMIC` to `HIT` when its origin response is
cacheable, while health and upload responses must never become `HIT`.

```powershell
curl.exe -sS -D - https://0xnothing.xyz/api/health -o NUL
curl.exe -sS -D - https://0xnothing.xyz/api/pump/stats -o NUL
curl.exe -sS -D - https://0xnothing.xyz/api/pump/stats -o NUL
```

Confirm that the public response includes a `cf-ray` header, that the health
response includes `Cache-Control: no-store`, and that the proxy secret never
appears in browser-visible request or response headers.

Finally, test Railway's generated hostname directly, without the proxy secret:

```powershell
curl.exe -sS -D - https://<service>.up.railway.app/ -o NUL
curl.exe -sS -D - https://<service>.up.railway.app/api/health -o NUL
```

The first request must return `403` with `Cache-Control: no-store`; health must
remain `200` with `Cache-Control: no-store`. If the direct root returns `200`,
the origin boundary is not active and Cloudflare WAF can still be bypassed.
