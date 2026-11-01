# SynapseCity (Tier 3)

SynapseCity is the domain-facing migration of the OpenInfra product. It keeps
the useful infrastructure concepts (assets, incidents, locations and public
projections) while moving persistence, publication and queueing into the two
lower tiers:

```text
SynapseCity -> @synapsedx/capabilities -> @synapseone/sdk -> SynapseOne API
```

The service is configured for the public boundary `https://synapsecity.sbs` and
calls `https://synapsedx.sbs`. It has no database, queue connection, or direct
SynapseOne client. Domain records are created through the Tier-2 records API;
public projections are read through Tier-2 SynapseLDS publication.

## Run

Build the Tier-2 SDK first (the workspace-local dependency is intentional for
development), then install and build this service:

```bash
cd ../SynapseDX/sdk-js && npm install && npm run build
cd ../../SynapseCity && npm install && npm run build
SYNAPSEDX_BASE_URL=https://synapsedx.sbs npm start
```

For a registry release, replace the `file:` dependency with the published
`@synapsedx/capabilities` version after the package has been released.

## API

- `GET /health` and `GET /ready` include Tier-2 health.
- `POST/GET/PATCH /v1/assets` manages domain assets through Tier 2.
- `POST/GET /v1/incidents` manages domain incidents through Tier 2.
- `GET /v1/public/assets` and `GET /v1/public/incidents` read published,
  public NGSI-LD entities through Tier 2.

The API intentionally does not expose generic platform primitives. Those stay
behind SynapseDX and SynapseOne.
