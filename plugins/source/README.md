# Retired Tier-3 route source (reference only)

This directory is a **source archive**, not an application and not part of any
build. It preserves the exact Tier-3 route source that was replaced by the
2026-11-14 workspace redirects, so business UI can be migrated into declarative
SynapseDX plugin widgets without losing the original implementation.

- Product: SynapseCity (`https://synapsecity.sbs`)
- Repository: `https://github.com/vku-open-source-2026/SynapseCity`
- Captured revision: see `manifest.json` (`revision`)
- Active redirect: `https://synapsedx.sbs/workspace`

## What is here

`apps/console/src/routes/…` contains the original files at the captured
revision for:

- `login.tsx`, `register.tsx`
- `admin.tsx` and every `admin/**` route
- `technician.tsx` and every `technician/**` route

`manifest.json` records the original path, archive path, byte size and SHA-256
for each route. It also maps the retired route group to the plugin bundle that
replaces it:

| Retired routes | Replacement bundle |
| --- | --- |
| `/admin/**` | `plugins/city-operations-overview.plugin.json` |
| `/technician/**` | `plugins/city-technician-work.plugin.json` |
| `/login`, `/register` | DX workspace (no Tier-3 plugin) |

The domain pages and components those routes rendered are archived beside the
route files under `apps/console/src/pages/…` (and `apps/console/src/components/…`
where applicable). They were moved out of `apps/console/src` so the console
build cannot include or mount them. Import specifiers in the archive reflect the
original layout and are not resolved here — this is reference source, not a
compilable project.

`manifest.json` records the original path, archive path, byte size and SHA-256
for every route and archived UI file.

## Safety rules

- This archive is **not compiled, bundled, imported or executed**. It sits
  outside `apps/`, so neither `tsc` nor Vite includes it.
- The plugin CLI never imports or executes files under `plugins/`; it only
  reads `plugins/*.plugin.json` as JSON data.
- SynapseDX import accepts only the declarative bundle JSON described in
  `plugins/README.md`. It must not accept or execute TSX from this archive.
- Do not copy secrets, `.env` values, tokens or server-local configuration into
  this directory. The archive is source code only.
- Provenance is preserved through `manifest.json`; do not rewrite the archived
  files. Add a new manifest/snapshot instead if the source is refreshed.

To re-capture after a future migration change, use `git show <revision>:<path>`
for the affected route files and append a new manifest entry — do not run
`git reset` or rewrite the working tree.
