# Contribution-service legacy Tier-1 migration path

Status: **Tier-2 production migration complete (2026-11-26); Tier-1 retained only
for explicit migration/rollback**.

`apps/contribution-service` stores production records in Tier-2 datasets
`city-contribution-features`, `city-contribution-submissions`, and
`city-contribution-sos-reports` through the published `synapsedx` SDK. The
`synapseone` SDK and legacy `contribution_*` collections remain only for the
one-off `migrate_base_to_dx` binary and `STORAGE_BACKEND=base` rollback. This
exception must not be copied to `city-service`, the gateway, the console or the
mobile app; `scripts/tier-boundary.test.mjs` enforces that boundary.

## Legacy credential controls

- **Rotation owner:** the City deployment owner rotates the legacy key at least
  every 90 days and immediately after suspected exposure; record the owner and
  date in the secret store, never in source control.
- **Least privilege:** restrict `CONTRIBUTION_SYNAPSEONE_API_KEY` to the three
  `contribution_*` collections and read/write only; no admin or account-wide
  wildcard.
- **Expiry:** use a dated credential for migration/rollback and remove it when
  that path is retired.
- Inject it only when running the migration or an explicit rollback. New and
  normal production deployments use `CONTRIBUTION_SYNAPSEDX_API_KEY` or
  `CONTRIBUTION_SYNAPSEDX_TOKEN` instead.
- Keep the legacy credential out of logs, source control, and public issues.
- Do not add the contribution service to another Tier-1 network or publish a
  host port.

## Tier-2 migration

The migration uses deterministic feature IDs, preserves `legacy_id` and
`legacy_source`, and checks for a committed record after ambiguous transport
failures before retrying. Tier-2 reads page to completion without the former
silent 10,000-record cap. Records without legacy IDs fail closed.

After rollback is no longer required, remove `synapseone`, the `base` backend,
and the corresponding tier-boundary allowlist entries together.
