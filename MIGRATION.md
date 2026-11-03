# OpenInfra to SynapseCity migration

SynapseCity keeps the OpenInfra city-infrastructure domain and removes the
duplicate platform infrastructure that used to sit beside it. The emergency
domain was separated into the sibling SynapseCitySOS product; it is not part of
this repository.

| OpenInfra concern | SynapseCity boundary | Owner after migration |
| --- | --- | --- |
| assets and GIS attributes | `/v1/assets` | SynapseCity domain, Tier-2 records API for storage |
| city incidents and citizen reports | `/v1/incidents`, `/v1/public/incidents` | SynapseCity domain, Tier-2 records API for storage |
| maintenance, preventive maintenance, technician work | `/v1/maintenance` | SynapseCity |
| IoT sensors and readings | `/v1/iot` | SynapseCity |
| infrastructure alerts | `/v1/alerts` | SynapseCity |
| budgets and transactions | `/v1/budgets` | SynapseCity |
| operational reports | `/v1/reports` | SynapseCity |
| city operators | `/v1/users` | SynapseCity |
| geofences and data ingest | `/v1/geofences`, `/v1/ingest` | SynapseCity |
| public NGSI-LD projections | `/v1/public/assets`, `/v1/public/incidents` | Tier 2 publication capability -> Tier 1 SynapseLDS |
| map tiles, geocoding, AI | `/v1/map`, `/v1/geo`, `/v1/ai` | SynapseCity instance |
| Celery/Redis jobs | capability events emitted by Tier 2 | Tier 1 SynapseQueue |
| MongoDB collections | SynapseBase collections behind Tier 2 | Tier 1 |
| MinIO/object storage | future Tier-2 file capability | Tier 1 managed object API |
| domain validation/status | request handlers and domain modules | SynapseCity |

The OpenInfra emergency domain (hazards, emergency events, EOP, dispatch,
emergency resource units, SITREP, AAR, live hazard streaming, command centre
and the public hazard map) is owned by SynapseCitySOS. SynapseCity does not
route, persist or display it and never calls the SOS API.

All City datasets use the `city-` prefix. Public records are explicitly
projected and marked public before they reach SynapseLDS. The original domain
records remain behind authenticated Tier-2 routes.

The runtime split is `apps/gateway` (public edge), `apps/city-service` (domain
backend) and `apps/console` (frontend). The domain backend only imports the
Tier-2 SDK; the gateway and console have no platform credentials.
