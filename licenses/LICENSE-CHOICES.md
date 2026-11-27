# License choices

These choices apply only where the upstream package metadata offers an `OR`
alternative. They do not relicense dependencies and are not legal conclusions.

| Package family | Registry expression | SynapseCity choice |
| --- | --- | --- |
| `@turf/jsts` / `jsts` | `EDL-1.0 OR EPL-1.0` | EDL-1.0; full text in `EDL-1.0.txt` |
| `node-forge` | `BSD-3-Clause OR GPL-2.0` | BSD-3-Clause; standard text in `BSD-3-Clause.txt` plus upstream notice in the generated inventory |
| `r-efi` | `MIT OR Apache-2.0 OR LGPL-2.1-or-later` | MIT OR Apache-2.0; no LGPL choice is used |
| Rust dual MIT/Apache crates | `MIT OR Apache-2.0` and equivalent slash forms | Apache-2.0 or MIT; both are recorded in the inventory |
| npm packages with `MPL-2.0 OR Apache-2.0` | `MPL-2.0 OR Apache-2.0` | Choose Apache-2.0 where the alternative applies; standalone MPL packages remain documented |
| Font Awesome Free icons | `CC-BY-4.0 AND MIT` | Both apply; attribution and canonical license URI are provided |

Development-only Sharp/libvips packages carry LGPL terms in addition to other
package terms. They are asset-generation tools and are not confirmed to be in
the APK. The license gate reports them; any future runtime bundling requires a
new source/relinking review.
