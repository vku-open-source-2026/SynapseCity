# Third-party components

SynapseCity source is Apache-2.0. Published City datasets are dedicated to the
public domain under PDDL 1.0 (Open Data Commons Public Domain Dedication and
License). Dependencies are installed unmodified from public registries and
remain under their upstream licenses.

| Component family | License | Use |
|---|---|---|
| Node.js, TypeScript, Express, `@synapsedx/capabilities` | Apache-2.0/MIT/ISC/BSD | Domain API and public gateway |
| React, Vite, Tailwind, TanStack | MIT | Infrastructure console |
| Leaflet, MapLibre, Turf | BSD-2-Clause/BSD-3-Clause/MIT | Public map and geospatial tools |
| Font Awesome free icons | MIT or CC-BY-4.0 dual licensing | UI icons, used with attribution |

The Tier-2 client (`@synapsedx/capabilities`) is installed unmodified from the
public npm registry (`^0.3.0`) and remains Apache-2.0. The release does not
bundle `node_modules`; `npm ci` resolves the exact versions recorded in both
lockfiles. No GPL, AGPL, LGPL, SSPL, RSAL, BUSL,
Hippocratic, Commons-Clause, PolyForm, Elastic or other source-available
dependency is part of the release tree. Run `npm ls --all` before changing
dependencies and keep every dependency unmodified.
