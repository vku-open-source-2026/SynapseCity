# SynapseCity OLP 2026 DX-Lab demo pack

A reproducible 15-minute story for the H-P-D-I capability chain and the strict
Tier-3 → Tier-2 → Tier-1 boundary.

## Prerequisites

1. Tier 1 (SynapseOne) and Tier 2 (SynapseDX) are healthy at their public HTTPS
   URLs.
2. SynapseCity is running (`docker compose up -d` or `npm run start:service`).
3. An operator/admin session token is available as `CITY_DEMO_TOKEN`
   (or pass `--token`). Never commit the token.

## One-command seed

```bash
CITY_DEMO_TOKEN=... npm run demo:seed
```

The seed script is idempotent: it creates the same stable ids on every run and
updates them when they already exist. It writes only through the public City
API, which in turn uses the Tier-2 capabilities SDK/API.

Reset the demo records:

```bash
CITY_DEMO_TOKEN=... npm run demo:reset
```

## 15-minute script

| Minute | Lane | Action | Visible evidence |
| --- | --- | --- | --- |
| 0–2 | Context | Open `/` and `/v1/city` | Product metadata, Tier-2 dependency URL, City-owned feature list |
| 2–4 | H (Human) | Open **Assets** → `DEMO-BRIDGE-01`, set criticality | `PUT /v1/assets/DEMO-BRIDGE-01/criticality` returns 1–5 factors |
| 4–6 | H (Human) | Open **Incidents** → create/refresh `DEMO-INC-01` | Public incident projection hides reporter PII |
| 6–8 | P (Process) | Create a maintenance work order and request approval | `POST /v1/maintenance/:id/approval` returns a Tier-2 HITL approval id |
| 8–10 | P (Process) | Approve the work order as a different operator | `POST /v1/maintenance/:id/approve` records `approved_by`, roles and approval id |
| 10–12 | D (Data) | Open **Reports** → generate the asset-health CSV | `POST /v1/reports` returns a download URL and checksum |
| 12–14 | I (Intelligence) | Open the asset risk panel | `GET /v1/assets/DEMO-BRIDGE-01/risk` shows score, factors, confidence, freshness |
| 14–15 | HITL gate | Request a predictive work order | `POST /v1/assets/DEMO-BRIDGE-01/risk/work-order` returns `202` until approved; approved call creates the work order |

## Evidence checklist

- [ ] `GET /v1/city` lists only City features and marks SOS features as not owned.
- [ ] `GET /v1/assets/DEMO-BRIDGE-01/risk` includes `factors`, `confidence`,
      `data_freshness` and flags (including `stale_sensor_data` when applicable).
- [ ] `POST /v1/maintenance/:id/approval` returns a Tier-2 approval id.
- [ ] A different approver can approve; the requester cannot self-approve.
- [ ] `POST /v1/assets/DEMO-BRIDGE-01/risk/work-order` returns `202` without an
      approved HITL id and `201` with one.
- [ ] The public incident projection has no reporter email/phone.
- [ ] Production uses `SYNAPSEDX_BASE_URL=https://synapsedx.sbs` and never a
      localhost/private address.

## Screenshots

Capture these screens during the run and link them here:

1. City overview with the Tier-2 dependency badge.
2. Asset criticality and risk-factor panel.
3. Maintenance approval pending/approved lane.
4. Report export with checksum.
5. Public incident page with redacted reporter details.
