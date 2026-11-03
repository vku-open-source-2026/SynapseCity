# Contributing to SynapseCity

SynapseCity is Apache-2.0 software maintained by VKU.VIC.

Before changing code, read:

1. [`PRODUCT_BOUNDARY.md`](PRODUCT_BOUNDARY.md) for this repository's owned and
   not-owned features.
2. [`AGENTS.md`](AGENTS.md) for the Tier-2 dependency contract, API namespaces,
   datasets and console routes.
3. The workspace `FEATURE_BOUNDARY.md` for the authoritative split with
   SynapseCitySOS (when working in the monorepo).

Rules for a pull request:

- Keep city persistence in SynapseDX; do not add a database, queue or in-memory
  production store.
- Use only `city-*` datasets and the City `/v1` namespaces.
- Do not import SynapseCitySOS modules or types and do not call its API. A
  public HTTPS navigation link is allowed; a data dependency is not.
- Do not add emergency, hazard, EOP, dispatch, SITREP, AAR or command-centre
  pages to this console.
- Build with `npm ci && npm run build`, run `npm test`, and keep the gateway
  foreign-namespace 404 tests passing.
- Retain SPDX headers, `NOTICE` and a changelog entry for user-visible changes.

Use GitHub Issues for bugs and proposals. The issue tracker is
<https://github.com/vku-open-source-2026/SynapseCity/issues>.
