# Public edge contract

`infra/nginx/synapsecity.conf` is the repository contract for the public TLS
edge. It is **not** automatically installed in the shared production nginx
container. The deployed edge must apply the same server blocks (or route the
retired paths through `synapsecity-console:80`, whose nginx has the same
redirects).

## Retired-route drift (M14)

Production returned `200` for `/login` and `/admin` because the shared edge's
catch-all console proxy bypassed the checked-in redirect locations. Changing the
SPA or gateway cannot repair that edge-level drift.

The operator must update the actual public edge configuration for both
`synapsecity.sbs` and `cloud.synapsecity.sbs` (when that alias is enabled). In
each `server` block, place these locations **before** `location /`:

```nginx
location = /login { return 308 https://synapsedx.sbs/workspace; }
location = /register { return 308 https://synapsedx.sbs/workspace; }
location = /workspace { return 308 https://synapsedx.sbs/workspace; }
location ^~ /workspace/ { return 308 https://synapsedx.sbs/workspace; }
location = /admin { return 308 https://synapsedx.sbs/workspace; }
location ^~ /admin/ { return 308 https://synapsedx.sbs/workspace; }
location = /technician { return 308 https://synapsedx.sbs/workspace; }
location ^~ /technician/ { return 308 https://synapsedx.sbs/workspace; }
```

The current production edge source is the SynapseOne nginx template/config, not
this file. Update that source, build the edge image locally, validate with
`nginx -t`, and recreate/reload only the edge service using the server's compose
lock and rollback procedure. Do not copy a config only into a running container.
No production change is made by this repository patch.

After the edge is updated, run the read-only smoke test (it does not follow
redirects or send credentials):

```bash
npm run smoke:retired-routes
npm run smoke:retired-routes -- https://cloud.synapsecity.sbs
```

Every checked path must return `308` and exactly
`Location: https://synapsedx.sbs/workspace`. The repository contract test
`npm run test:public-only` checks both server blocks offline in CI.

## Trusted client-IP hop (H6)

The public edge is the single trusted source of the client IP. Every proxied
location sets:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

This overwrites any client-supplied XFF value. The Rust gateway forwards an
existing value unchanged and injects its TCP peer only for direct calls with no
edge header. City keys rate limits on the last XFF entry. Keep the gateway host
port loopback-only; exposing it directly would let clients choose their own
rate-limit identity.
