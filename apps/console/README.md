# SynapseCity console

React 19 + TypeScript console for city infrastructure operations. It is served
at `https://synapsecity.sbs` and talks to the City gateway under `/v1`.

This console is part of SynapseCity only. It does not implement emergency
operations; those pages and APIs belong to the sibling SynapseCitySOS product.
See [`../../PRODUCT_BOUNDARY.md`](../../PRODUCT_BOUNDARY.md); the workspace
`FEATURE_BOUNDARY.md` holds the authoritative split.

## Product scope

Owned console areas:

- public city asset map and asset detail;
- citizen incident reporting and public incident lookup;
- city operations dashboard and internal asset map;
- asset registry, city incidents and infrastructure alerts;
- IoT sensors, budgets and operational reports;
- city operators, data ingestion and profile settings;
- technician portal for tasks, maintenance and settings.

Never add `/disaster`, `/admin/emergency-center*` or any hazard, EOP, dispatch,
SITREP, AAR or command-centre page. City staff are City operators, not SOS
resource units.

## Tech stack

- React 19.2, TypeScript 5.9, Vite 7.2
- TanStack Router 1.139 (file-based, type-safe routes)
- TanStack Query 5.90 for server state
- Zustand 5.0 for auth and app state
- Axios 1.13 through `src/lib/httpClient.ts`
- Tailwind CSS 4.1, shadcn/ui primitives, Lucide and Font Awesome icons
- Leaflet 1.9 / React Leaflet 5.0, Leaflet Draw and Leaflet Heat

## Routes

```text
/                              city landing
/about                         city product
/docs                          city API docs
/map                           public city asset map
/login /register               auth shell
/asset/$id                     public asset detail
/public/report                 citizen incident report
/public/report/$assetId        report about an asset
/public/incidents/$incidentId  public incident lookup
/admin                         city operations dashboard
/admin/map                     internal asset map
/admin/assets[/$id]            asset registry
/admin/incidents[/create|/$id] city incidents
/admin/alerts[/list]           infrastructure alerts
/admin/iot[/create|/$id]       IoT sensors
/admin/budgets[/create|/$id]   budgets
/admin/reports[/create]        operational reports
/admin/users[/create|/$id]     city operators
/admin/ingest                  data ingestion
/admin/settings                profile
/technician                    technician portal
/technician/tasks/$taskId      technician task
/technician/maintenance/$id    technician maintenance record
/technician/settings           technician settings
```

`src/routeTree.gen.ts` is generated from `src/routes/` and must contain only
these owned routes.

## Project structure

```text
src/
├── api.ts                 API functions
├── components/            shared components (ui/, map, header)
├── hooks/                 custom hooks
├── lib/                   httpClient, queryClient, tile config, utils
├── pages/                 page components
├── routes/                TanStack Router route files
├── stores/                authStore, appStore
├── types/                 City domain types
└── routeTree.gen.ts       generated route tree (do not edit)
```

## Getting started

Prerequisites: Node.js 20.19+ or 22.12+ and npm.

```bash
npm ci
npm run dev          # development server
npm run build        # production build
npm run preview      # preview the production build
npm run lint
npm test
```

Environment:

```env
VITE_BASE_API_URL=/v1
# Local dev only: the Vite dev server proxies /v1 to the City service.
VITE_DEV_API_PROXY=http://localhost:8083
VITE_TURNSTILE_SITE_KEY=
```

Use the same-origin `/v1` path in production. Do not point the console at a
private service, localhost dependency or the SOS origin.

## API calls

Always use the configured client:

```ts
import { httpClient } from '@/lib/httpClient';

const assets = await httpClient.get('/assets');
const incidents = await httpClient.get('/incidents');
await httpClient.post('/incidents', {
  asset_id: 'asset-123',
  category: 'damage',
  description: 'Damaged guardrail',
});
```

With TanStack Query:

```ts
const { data, isLoading } = useQuery({
  queryKey: ['assets'],
  queryFn: () => httpClient.get('/assets').then((response) => response.data),
});
```

The base URL is `/v1`, so paths in calls omit the `/v1` prefix. Public
projections are read from `/public/assets` and `/public/incidents`; the gateway
maps them to the City public API.

## Map

Leaflet and MapLibre render City assets. Tiles, autocomplete, geocoding and
reverse geocoding go through the City backend (`/v1/map` and `/v1/geo`); the
VIETMAP key stays server-side. Do not reuse the SOS map instance or call the
SOS map API.

## Documentation

- [City product boundary](../../PRODUCT_BOUNDARY.md)
- [Tech stack migration](./MIGRATION.md)
- [Quick start](./QUICK_START.md)
- [TanStack Router](https://tanstack.com/router)
- [TanStack Query](https://tanstack.com/query)
- [Zustand](https://docs.pmnd.rs/zustand)
- [shadcn/ui](https://ui.shadcn.com)

## License

Source code is Apache-2.0. Published City datasets are **CC0 1.0 Universal**
(Creative Commons public domain dedication). See the repository `LICENSE`,
`NOTICE` and `THIRD-PARTY.md`.
