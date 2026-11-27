# MPL and third-party source offer

SynapseCity distributes executable forms that include MPL-2.0 covered software,
including `cssparser@0.38.0` and `dtoa-short@0.3.5` in the contribution backend.
Web/mobile build graphs also contain MPL-2.0 Lightning CSS. The full MPL-2.0
license is provided in `MPL-2.0.txt`.

Corresponding source for this release is available from the public repository:

- Repository: https://github.com/vku-open-source-2026/SynapseCity
- Exact release commit: SOURCE_COMMIT
- Source tree: https://github.com/vku-open-source-2026/SynapseCity/tree/SOURCE_COMMIT
- Source archive: https://github.com/vku-open-source-2026/SynapseCity/archive/SOURCE_COMMIT.tar.gz

The exact dependency versions and checksums are recorded in the Cargo.lock and
package-lock.json files in that source tree. Covered crate source is also
available from its public crates.io package page (for example
https://crates.io/crates/cssparser/0.38.0 and
https://crates.io/crates/dtoa-short/0.3.5). Covered npm source is available from
the registry and repository URLs in the generated SBOM.

Release builds replace `SOURCE_COMMIT` with the actual commit and include this
rendered notice as `SOURCE-OFFER.txt` in frontend `dist`, runtime images, and
Android APK assets. Local builds must set `SOURCE_COMMIT` to the commit on which
they are based; an uncommitted working tree is not represented as public source.
