# SynapseCity workflows (git-managed)

`mcp-docs-reader.json` is the canonical text of the SynapseCity docs-reader
workflow. Edit this file in git; do not edit the deployed copy by hand.

- Tier: SynapseCity (Tier 3). Provision it only through the SynapseDX
  capabilities API/SDK; Tier-3 must not call SynapseOne directly.
- Trigger: `mcpTrigger` tool `read_synapsecity_docs`.
- The workflow reads `apps/console/docs/README.md` (override with
  `{"path":"..."}`) from the public GitHub repository.
- Activate it, then connect an MCP client to the SynapseOne gateway `/mcp`
  with a Bearer JWT or `X-API-Key`.

CI should validate the JSON before deployment.
