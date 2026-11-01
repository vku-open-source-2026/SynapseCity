# SynapseCity — Tier 3 domain product

SynapseCity is the OpenInfra migration surface. It owns city/infrastructure
entities such as assets and incidents, their validation, and domain status. It
does not own platform storage or messaging.

## Dependency contract

- Import the Tier-2 `@synapsedx/capabilities` client from `../SynapseDX/sdk-js`
  during this workspace build; releases must resolve the same package from the
  npm registry.
- Default Tier-2 URL is `https://synapsedx.sbs`. Set `SYNAPSEDX_BASE_URL` only
  to another public HTTPS endpoint. Do not call SynapseOne, a private service
  port, localhost, or a database from this repository.
- Assets/incidents are written through the Tier-2 records API. Public reads use
  the Tier-2 publication/entity API. Queueing and persistence therefore remain
  owned by Tiers 1 and 2.

## Commands

```bash
npm install
npm run build
npm test
npm start
```
