# City HITL approvals (Tier-2)

City keeps its own thresholds and domain validation, but every high-risk
decision uses the Tier-2 `approvals` capability. No Tier-1 call and no second
approval store exists in City.

## Flow

1. `POST /v1/incidents/:id/cost-approval`
2. `POST /v1/budgets/transactions/:id/approval`
3. `POST /v1/maintenance/:id/approval`
4. Optional: `POST /v1/assets/:id/risk/work-order` (creates a predictive
   maintenance approval when `CITY_HITL_REQUIRED=true`).

Each returns `202 { approval, hitl_required: true }`. Tier-2 owns the roles,
quorum, SLA (`CITY_APPROVAL_SLA_MINUTES`, default 30), decisions and audit.

Decide through `POST /v1/hitl/approvals/:id/decide`; list pending/escalated
approvals through `GET /v1/hitl/approvals`.

Apply the domain effect with `POST .../approve { "approval_id": "..." }`.
When `CITY_HITL_REQUIRED=true`, an approval id is mandatory (`428
approval_required`); the approval must be approved, belong to the same entity
and action, and the requester cannot approve their own request.

## Backward compatibility

`/v1/incidents/:id/approve-cost`, `/v1/budgets/transactions/:id/approve` and
`/v1/maintenance/:id/approve` keep their existing paths. In environments that
have not enabled `CITY_HITL_REQUIRED`, the old direct-approval behaviour still
works; production enables the flag and operators migrate to the two-step flow.
