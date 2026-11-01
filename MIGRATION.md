# OpenInfra to SynapseCity migration

SynapseCity keeps the OpenInfra domain boundary and removes the duplicate
platform infrastructure that used to sit beside it.

| OpenInfra concern | SynapseCity boundary | Owner after migration |
| --- | --- | --- |
| assets and GIS attributes | `POST/GET/PATCH /v1/assets` | SynapseCity domain, Tier-2 records API for storage |
| incidents and citizen reports | `POST/GET /v1/incidents` | SynapseCity domain, Tier-2 records API for storage |
| public NGSI-LD projection | `/v1/public/assets`, `/v1/public/incidents` | Tier 2 publication capability -> Tier 1 SynapseLDS |
| Celery/Redis jobs | capability events emitted by Tier 2 | Tier 1 SynapseQueue |
| MongoDB collections | SynapseBase collections behind Tier 2 | Tier 1 |
| MinIO/object storage | future Tier-2 file capability | Tier 1 managed object API |
| domain validation/status | request handlers and future domain modules | SynapseCity |

The first migration slice covers the two flows that demonstrate the boundary:
asset lifecycle records and incidents. Sensors, work orders, maintenance
costs, QR/NFC reports, and analytics should be added as new City datasets using
the same Tier-2 records contract. They must not introduce a second database or
queue in this repository.

All public records are explicitly projected and marked public before they reach
SynapseLDS. The original domain records remain behind authenticated Tier-2
routes.
