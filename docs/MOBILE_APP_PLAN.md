# SynapseCity Android app + home-screen widget — implementation plan

Status: completed 2026-11-10 (see `docs/MOBILE_AUDIT.md` for documented hardware/data limitations)
Owner: VKU.VIC
Scope: `mobile/` in this repository. The web console and its API contracts remain
authoritative.

## 1. Stop conditions

Work stops only when one of these is true:

1. **Done**: every item in §11 (Definition of Done) is checked, both debug and
   release APKs build, the app has been exercised against production on an
   Android emulator, the home-screen widget has been exercised, and the audit in
   `docs/MOBILE_AUDIT.md` has no open critical/high finding.
2. **Hard deadline**: 07:30 Asia/Ho_Chi_Minh on 2026-11-10. If the deadline is
   reached, stop, write an honest hand-off in `docs/MOBILE_AUDIT.md`, and list
   exactly what remains.

No other reason is a stop condition. A failing build, a missing tool, an API
mismatch or an emulator problem is a task to solve, not a reason to stop.

## 2. Product boundary (non-negotiable)

SynapseCity owns city infrastructure. The mobile app may use only:

```text
GET  /v1/city
GET  /v1/public/assets
GET  /v1/public/assets/:code
GET  /v1/public/assets/:code/qr-code
GET  /v1/public/assets/:code/maintenance-summary
GET  /v1/public/incidents
GET  /v1/public/incidents/:id
POST /v1/public/incidents
POST /v1/public/files
GET  /v1/public/files/:id/content
*    /v1/auth, /v1/alerts, /v1/notifications, /v1/assets,
     /v1/incidents, /v1/iot, /v1/maintenance, /v1/geofences only after an
     authenticated City operator session
```

The app must never call `sos.synapsecity.sbs` APIs, import SOS code, render
hazard layers, emergency events, EOP, dispatch, resource units, SITREP or AAR.
A link to `https://sos.synapsecity.sbs` is public navigation only.

## 3. What already exists

- Production web console: `https://synapsecity.sbs`.
- Production API: `https://synapsecity.sbs/v1` behind the City gateway/nginx.
- Public asset projection and public incident projection with stable JSON.
- Public asset QR URLs (`https://synapsecity.sbs/asset/<asset_code>`), which the
  app can resolve after a QR/NFC scan.
- City auth (Tier-2 identity), operator alerts and notification records.
- 3 public incidents and a seeded public asset set are already visible in
  production (verified 2026-11-09).

## 4. Mobile architecture

- **Runtime**: Expo SDK 58 / React Native 0.88, TypeScript, Android first.
- **Visuals**: light-first default (`#F4FBFB`/white/teal), based on the
  production web console; light splash, system bars and native widget.
- **Location**: `expo-location` (foreground + last known).
- **QR**: `expo-camera` barcode scanner.
- **NFC**: `react-native-nfc-manager`, NDEF URI/text parsing.
- **Map**: bundled WebView + Leaflet/OSM, with a native SVG "radar" fallback so a
  tile outage never renders as an empty map. Tiles are map context only; assets
  and incidents always come from the City API.
- **Storage**: `expo-secure-store` for tokens; AsyncStorage for preferences and
  the widget snapshot.
- **Data**: typed API client against `/v1`; React Query for cache/refetch;
  no mock data in production builds.
- **Navigation**: a lightweight typed router owned by the app (React
  Navigation was intentionally not added: it pulls extra native codegen into an
  already path-constrained Windows build). It supports tab roots, a detail
  stack, Android back handling and deep links.
- **Notifications**: local notifications when a new public incident (or, for an
  authenticated operator, an alert) is observed; notification polling is
  foreground + widget worker. No server push is invented; production reports
  external notification delivery as unavailable.
- **Widget**: native Android `AppWidgetProvider` + `RemoteViews` +
  `WorkManager`, because React Native cannot render a home-screen widget by
  itself. The widget uses the same HTTPS API and a JSON cache written by the app.

```text
mobile/
  app.json
  App.tsx
  src/
    api/            typed production client + endpoint tests
    components/     UI, map, radar, cards
    hooks/          location, alerts, widget sync
    screens/        Home, Map, Scan, Report, Alerts, Account, Settings
    navigation/
    lib/            formatting, geo, widget bridge, secure storage
  android/          generated Expo project + native widget sources
```

## 5. Feature matrix

| Capability | In app | In widget |
| --- | --- | --- |
| Product/API health | yes | status dot |
| Nearby infrastructure assets (GPS) | list + map | mini-map + nearest 2 |
| Asset search / QR / NFC lookup | yes | "Scan" button |
| Asset detail, QR, maintenance summary | yes | nearest only |
| Public incident map/list/detail | yes | no |
| Citizen incident report (text + location) | yes | "Report" button |
| Optional operator login | yes | no |
| Operator alerts / notifications | after login | no |
| Settings / refresh / about | yes | refresh action |
| SOS public navigation | link only | no |
| Offline/error state | explicit, never fake-safe | explicit "stale" label |

## 6. Production wiring

- Base URL is compiled to `https://synapsecity.sbs` (overridable only by an
  explicit `EXPO_PUBLIC_API_BASE_URL` build env for local testing).
- Startup checks `GET /v1/city`, validates product/tier and refuses to label
  the app "online" when the check fails.
- `GET /v1/public/assets` is the only asset source for anonymous users.
- `POST /v1/public/incidents` is the only write for anonymous users.
- Auth tokens never leave SecureStore in logs. No token in URLs.
- Production nginx is inspected over SSH (`synapsedx.sbs`) to confirm:
  HTTPS redirect/HSTS, `/v1/` proxy target, public route exposure, response
  headers, and that no mobile-only route is required. Findings go in
  `docs/MOBILE_AUDIT.md`.

## 7. Widget specification (Locket-style)

Visual: 4x4 (resizable 4x2–4x4) rounded card, dark graphite background, cyan
accent, large nearest-asset line, two secondary rows, and a generated mini-map
bitmap with the user position and nearby assets. Android widgets use
RemoteViews; the bitmap is rendered by native code from the same JSON snapshot.

Interactions:

- tap card → open Home;
- tap map/nearest row → open asset detail;
- **Scan** → open QR/NFC scanner;
- **Refresh** → enqueue `OneTimeWorkRequest`, fetch `/v1/public/assets`, update;
- stale (>30 min) or offline → show "Dữ liệu cũ" + timestamp, never invent data.

Updates: every 30 min via WorkManager, on app foreground sync, on boot, and on
manual refresh. Location comes from the app's last foreground fix; when absent,
the widget uses the last known city centre and says so.

## 8. Security, privacy, accessibility

- HTTPS only; cleartext traffic disabled.
- No secrets, tokens, GPS or reporter PII in logs/analytics.
- Reporter form does not persist contact data unless the user enters it; photos
  are optional and uploaded through the public file API.
- Runtime permissions requested with rationale; denial leaves the app usable
  (manual city selection, QR from gallery not required).
- Content descriptions, 48dp touch targets, dynamic font scaling where
  practical, Vietnamese-first copy with English fallback.
- Widget cache stores only public asset summary + coarse location; no tokens.

## 9. Build environment

- JDK 17 (Temurin), Android SDK command-line tools, platform 36, build-tools 36,
  platform-tools, emulator, Google APIs x86_64 system image.
- AVD `SynapseCity_API_36`; boot with WHPX when available, otherwise software
  GPU and document the limitation.
- Debug + release APK (`assembleDebug`, `assembleRelease` with a local upload
  keystore that is git-ignored). APK paths and SHA-256 recorded in the audit.

## 10. Verification plan

1. Unit: geo distance/bearing, QR/NFC payload parsing, API envelope parsing,
   severity/status mapping, error/stale-state logic.
2. Contract: a Node script hits production endpoints and asserts the exact
   fields the app consumes; fails on shape drift.
3. Build: TypeScript check, Android lint, unit tests, debug APK, release APK.
4. Emulator: install, launch, grant location, set Da Nang coordinates, verify
   nearby list/map, deep link `synapsecity://asset/<code>`, QR payload parser,
   report validation, offline banner, widget bind/update screenshot.
5. Production audit: nginx config, headers, TLS, API status codes, no SOS data
   in City app; screenshot/evidence list.

## 11. Definition of Done

- [x] `docs/MOBILE_APP_PLAN.md` and `docs/MOBILE_AUDIT.md` present in the repo.
- [x] `mobile/` builds from a clean checkout with documented commands.
- [x] No cross-product API/import; boundary grep is clean.
- [x] Home, Map, Scan, Report, Alerts/Account, Settings implemented.
- [x] Nearby assets use real GPS when available and production data; emulator fallback is labelled (see audit).
- [x] QR and NFC payloads resolve production asset URLs; hardware scan test remains a documented follow-up.
- [x] Widget displays nearby assets + mini-map and refreshes against production.
- [x] Production health/error/stale states are honest.
- [x] TypeScript, unit tests, contract test and release APK pass.
- [x] Emulator smoke test with screenshots and `uiautomator` evidence.
- [x] Audit has no open critical/high item; medium items are documented.
- [x] APK checksum and install instructions in `mobile/README.md`.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Emulator acceleration unavailable | Try WHPX; fall back to software GPU; still build and document. |
| OSM tiles blocked/offline | Radar fallback + explicit map-unavailable state. |
| Public incident POST requires Turnstile | Surface typed error and do not fake success; inspect gateway config. |
| Widget background limits | WorkManager 30 min + manual refresh + app foreground sync. |
| Android 13+ notification permission | Request at the right moment; graceful denial. |
| API shape drift | Contract test; tolerant parsers with explicit error states. |
| Time | Implement public/citizen path first, operator auth second, polish last. |
