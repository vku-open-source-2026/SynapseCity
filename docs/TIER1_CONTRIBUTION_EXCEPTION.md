# Contribution-service Tier-1 exception

Status: **temporary, scoped, pending Tier-2 migration**.

`apps/contribution-service` is the only City application allowed to call the
Tier-1 SynapseBase SDK. It reads and writes the legacy
`contribution_submissions`, `contribution_features` and
`contribution_sos_reports` collections until the `city-contribution-*` Tier-2
datasets replace them. The exception must not be copied to `city-service`, the
gateway, the console or the mobile app; `scripts/tier-boundary.test.mjs`
enforces that boundary.

## Risk

The service holds a long-lived account API key rather than a Tier-2 capability
credential. A compromise has account-wide blast radius and bypasses Tier-2
audit/rate-limit semantics.

## Required controls while the exception exists

- **Rotation owner:** the City deployment owner must rotate
  `CONTRIBUTION_SYNAPSEONE_API_KEY` at least every 90 days and immediately after
  any suspected exposure. Record the owner and last rotation date in the
  deployment secret store, never in this repository or an issue.
- **Least privilege:** the key must be restricted to the three
  `contribution_*` collections and read/write only; no collection creation
  outside that prefix, no admin scope, no account-wide wildcard.
- **Expiry:** set an expiry date on the credential in the identity provider and
  open a migration ticket before that date. An unexpiring key is not accepted
  for a new deployment.
- **Network:** the container keeps exactly one edge-network reference
  (`synapseone_synapseone-net`, aliased as `edge`). Do not add the service to any
  other Tier-1 network or publish a host port.
- **Credential handling:** `SYNAPSEONE_API_KEY` is injected only into
  `contribution-service`; Tier-3 apps use `SYNAPSEDX_*` only.
- **CI guard:** `npm run test:tier-boundary` fails when a Tier-1 import,
  environment variable or network reference appears outside the allowlist.

## Tier-2 migration

Target state: contribution data is stored/read through Tier-2 records/datasets
with a scoped Tier-2 credential, and `synapseone` is removed from
`Cargo.toml`, `docker-compose.yml` and `.env.example`. When migration completes,
remove the allowlist from `scripts/tier-boundary.test.mjs` so the guard requires
zero Tier-1 references.
