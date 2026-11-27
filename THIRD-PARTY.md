# Third-party components

SynapseCity source is licensed under Apache-2.0. Published City datasets are
intended to be dedicated to the public domain under PDDL 1.0. Dependencies are
installed unmodified from public registries and remain under their upstream
licenses; SynapseCity does not relicense them.

This inventory covers the four npm lockfiles (root/console workspace,
contribution console, and mobile) and the three Cargo lockfiles (City service,
gateway, and contribution service). Exact resolved versions, source locations,
and machine-readable SBOMs are produced by `npm run licenses:inventory` and
`npm run sbom:generate` in CI. The release notice bundle is
[`licenses/THIRD-PARTY-NOTICES.txt`](licenses/THIRD-PARTY-NOTICES.txt).

## Runtime and build component families

| Component family | Verified registry expression(s) | Use / choice |
| --- | --- | --- |
| React, Vite, Axios, React Router, Leaflet, Turf, MapLibre | MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause | Web/mobile UI, HTTP, routing, maps, geospatial processing |
| Rust Axum/Reqwest/Tokio/serde ecosystem | MIT, Apache-2.0, ISC, BSD, Zlib, Unicode-3.0, CDLA-Permissive-2.0, permissive dual licenses | Rust services; choose Apache-2.0 or MIT where an `OR` choice is offered |
| `@synapsedx/capabilities`, `synapsedx`, `synapseone` | Apache-2.0 | Published Tier-2/Tier-1 SDKs; `synapseone` is legacy migration/rollback only in the contribution service |
| Font Awesome Free icon packages | `(CC-BY-4.0 AND MIT)` | Both terms apply to the icon packages. Attribution is visible in the console footer and below; this is not an `OR` choice |
| `@turf/jsts` / `jsts` | `EDL-1.0 OR EPL-1.0` | SynapseCity chooses **EDL-1.0**; its text is included |
| `node-forge` | `BSD-3-Clause OR GPL-2.0` | SynapseCity chooses **BSD-3-Clause**; no GPL linkage is introduced by this choice |
| `lightningcss` | `MPL-2.0` | Web/mobile build tooling; MPL text and source availability are documented below |
| `cssparser@0.38.0`, `dtoa-short@0.3.5` | `MPL-2.0` | Statically linked into the contribution backend through `ammonia`; MPL text and source availability are documented below |
| ICU / Unicode data and `webpki-roots` | Unicode-3.0, CDLA-Permissive-2.0 | Unicode/data notices are retained by the generated inventory |
| Mobile Sharp/libvips packages | `LGPL-3.0-or-later` (plus package dual terms) | Development-only asset tooling; not confirmed to be bundled in the APK. Re-review before any runtime bundling |

## Removed dependency

`react-leaflet` / `@react-leaflet/core` (Hippocratic-2.1) have been removed from
the contribution console. The map uses Leaflet directly under BSD-2-Clause.
The license gate rejects Hippocratic-licensed packages in every npm lockfile.

## MPL-2.0 source availability

The contribution backend includes MPL-2.0 `cssparser@0.38.0` and
`dtoa-short@0.3.5`; web/mobile build graphs include MPL-2.0 Lightning CSS. The
full MPL-2.0 text is in [`licenses/MPL-2.0.txt`](licenses/MPL-2.0.txt).

Corresponding source is available from the public SynapseCity repository at the
exact release commit recorded in the image/release metadata:

- Repository: <https://github.com/vku-open-source-2026/SynapseCity>
- Source tree: <https://github.com/vku-open-source-2026/SynapseCity/tree/SOURCE_COMMIT>
- Source archive: <https://github.com/vku-open-source-2026/SynapseCity/archive/SOURCE_COMMIT.tar.gz>

The Cargo.lock files identify the exact crate versions and checksums. Covered
crate source is also available from crates.io, for example
<https://crates.io/crates/cssparser/0.38.0> and
<https://crates.io/crates/dtoa-short/0.3.5>. npm Lightning CSS source is available
from the package's public registry/repository URL recorded in the SBOM. See
[`licenses/SOURCE-OFFER.md`](licenses/SOURCE-OFFER.md); builds replace
`SOURCE_COMMIT` with the actual release commit.

## Font Awesome attribution

Font Awesome Free is provided by Fonticons, Inc. and contributors. Icon packages
are licensed under `(CC-BY-4.0 AND MIT)` as recorded in the npm lockfiles.
Attribution: **Font Awesome Free by Fonticons, Inc. and contributors —
CC-BY-4.0 and MIT.** License information:
<https://fontawesome.com/license/free>. The console footer exposes this
attribution and a link to the bundled third-party notices.

## Dual-license choices and policy

See [`licenses/LICENSE-CHOICES.md`](licenses/LICENSE-CHOICES.md) for the explicit
EDL/BSD choices. The CI license gate permits the verified permissive, MPL, EDL,
CC-BY, Unicode, and CDLA expressions listed in the inventory. It rejects
Hippocratic, SSPL, BUSL, Commons-Clause, PolyForm, Elastic, RSAL, AGPL, and
runtime GPL/LGPL expressions. Development-only LGPL asset tooling is reported,
not silently omitted. This is a supply-chain policy, not a legal opinion.

## Base images and native mobile dependencies

Runtime images use official Rust, Node, nginx, and Debian base images. Final
container SBOMs are generated in release CI. Android/React Native native
libraries are primarily Apache-2.0/MIT/BSD families; the APK packages the same
project notice bundle under `assets/`. A full native AAR/Maven license inventory
is not claimed by this document and must be added if native dependencies change.
