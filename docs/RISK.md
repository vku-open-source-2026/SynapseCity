# Asset criticality and outage risk

`PUT /v1/assets/:id/criticality` stores four explicit factors:

- `service_impact` 1–5
- `population_served` (people)
- `redundancy` 1–5 (1 = no redundancy)
- `safety_impact` 1–5

`GET /v1/assets/:id/risk` returns a 0–100 score, band, confidence and every
weighted factor (`criticality`, `condition`, `incidents`, `maintenance`,
`sensor`). Missing/stale sensor data is reported as `no_sensor_data` /
`stale_sensor_data` and lowers confidence instead of being treated as healthy.
`GET /v1/risk/top?limit=10` ranks assets for the operator dashboard.

`POST /v1/assets/:id/risk/work-order` creates a recommended predictive work
order. When HITL is required, the first call returns `202` with a Tier-2
approval; the approved retry stores the risk factors, confidence, freshness and
approval id on the work order.
