# Releasing SynapseCity

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`:

1. `npm ci`
2. `npm run check:release` (pinned Tier-2 SDK tarball/checksum)
3. `npm run build`
4. `npm test`
5. console lint
6. Playwright browser E2E
7. `docker compose config` + `docker compose build`

## Release

Push a semantic tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` builds and tests, then publishes:

```text
ghcr.io/vku-open-source-2026/synapsecity-city-service:v0.2.0
ghcr.io/vku-open-source-2026/synapsecity-gateway:v0.2.0
ghcr.io/vku-open-source-2026/synapsecity-console:v0.2.0
```

Each image also gets `latest` and `sha-<commit>` tags. The GitHub release
contains `docker-compose.yml`, the nginx edge snippet and the pinned Tier-2 SDK
tarball/checksum.

## Deploy

On the production host, use the released images or the released Compose file:

```bash
docker compose pull
docker compose up -d
curl -fsS https://synapsecity.sbs/health
```

Set `CITY_AUTH_MODE=tier2`, `CITY_BOOTSTRAP_ADMIN_EMAILS` and the Tier-2
environment before restarting the service. Public map/data endpoints do not
require a City session; operator routes do.

## Rollback

Deploy the previous `v*` image tags or check out the previous tag and run
`docker compose up -d`. Database migrations are owned by Tier-1/Tier-2; this
repository has no private database.
