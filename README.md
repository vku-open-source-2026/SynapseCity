# SynapseCity (Tier 3)

SynapseCity is the domain-facing migration of the OpenInfra product. It keeps
the useful infrastructure concepts (assets, incidents, locations and public
projections) while moving persistence, publication and queueing into the two
lower tiers:

```text
SynapseCity -> @synapsedx/capabilities -> @synapseone/sdk -> SynapseOne API
```

The product is split into independently deployable parts:

```text
apps/gateway       public HTTPS API boundary (port 8080)
apps/city-service  domain backend (port 8083)
apps/console       static frontend shell
infra/              public-edge snippets and deployment material
```

The service is configured for the public boundary `https://synapsecity.sbs` and
calls `https://synapsedx.sbs`. It has no database, queue connection, or direct
SynapseOne client. Domain records are created through the Tier-2 records API;
public projections are read through Tier-2 SynapseLDS publication.

## Run

Build the Tier-2 SDK first (the workspace-local dependency is intentional for
development), then install and build this service:

```bash
cd ../SynapseDX/sdks/capabilities-js && npm install && npm run build
cd ../../SynapseCity && npm install && npm run build
SYNAPSEDX_BASE_URL=https://synapsedx.sbs npm start
```

For a registry release, replace the `file:` dependency with the published
`@synapsedx/capabilities` version after the package has been released.

## API

- `GET /health` and `GET /ready` include Tier-2 health through the backend.
- `POST/GET/PATCH /v1/assets` manages domain assets through Tier 2.
- `POST/GET /v1/incidents` manages domain incidents through Tier 2.
- `GET /v1/public/assets` and `GET /v1/public/incidents` read published,
  public NGSI-LD entities through Tier 2.

The API intentionally does not expose generic platform primitives. Those stay
behind SynapseDX and SynapseOne.

Map tiles, autocomplete, forward geocoding and reverse geocoding are proxied
through the City backend. Set `VIETMAP_API_KEY` and optionally
`VIETMAP_TILE_STYLE=tm|lm|dm|hm|st` in the server `.env`; the key is never sent
to the browser.

The public edge must route `synapsecity.sbs` to the gateway and an optional
`cloud.synapsecity.sbs` to the console. See `infra/nginx/synapsecity.conf`.

## PoF project checklist

- License: Apache-2.0 (`LICENSE`) with per-source SPDX headers and attribution in `NOTICE`.
- Build from source: `npm ci && npm run build` using Node.js 20+; Docker builds are reproducible with `docker compose build`.
- Issue tracker: [GitHub Issues](https://github.com/vku-open-source-2026/SynapseCity/issues).
- Change history: [`CHANGELOG.md`](CHANGELOG.md). Versioned release tags are published on GitHub.
- Dependency inventory: [`THIRD-PARTY.md`](THIRD-PARTY.md); dependencies are not modified or bundled into the repository.
