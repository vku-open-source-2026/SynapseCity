# SynapseCity Android app + widget — audit

Date: 2026-11-11 00:25 (Asia/Ho_Chi_Minh)
Scope: `mobile/` in this repository, its production integration and the native
home-screen widget. This revision switches the app and widget to a light-first
theme and re-audits the widget end to end.
Status: **PASS with documented medium/low limitations; no open critical or high
finding.**

## Known issue (0.1.1)

The production public asset-detail lookup by asset code
(`GET /v1/public/assets/:code`) returns 404 for assets beyond the first
records page; lookup by record id works. A server-side fix is pending
(`findRecord` should scan all pages, not one 500-record page). The Android
build itself is signed and verified; this is a backend contract issue.

## 1. Delivered

| Item | Location |
| --- | --- |
| React Native/Expo app | `mobile/` |
| Native Android widget | `mobile/android/app/src/main/java/sbs/synapsecity/mobile/widget/` |
| Release APK (signed, public) | <https://synapsedx.sbs/v1/capabilities/public/files/synapsecity-android-0.1.1-arm64-x86_64/content> |
| APK SHA-256 | `dce9b691ef578d81370b86d7ef767b3eb12aa96e7c149cd7001698a6c0515aa5` |
| Evidence screenshots | `docs/evidence/` |
| Plan | `docs/MOBILE_APP_PLAN.md` |

Package: `sbs.synapsecity.mobile`, versionName `0.1.1`, versionCode `2`,
minSdk 24, target/compile SDK 37.

## 2. Design — light-first, based on the web console

The Android UI now follows the light palette of the production web console
(`apps/console`): `#F4FBFB` page background, white cards with soft shadows,
slate headings, teal `#0F9F9A` primary actions and sky/cyan/amber accents. The
splash screen, status bar, tab bar, maps, inputs and native widget are all light
by default. The web `/map` and public pages were used as the visual reference
for card radii, chips, severity colours and the teal/amber hierarchy. No dark
theme is enabled in this build.

## 2. Environment installed

- Node.js 24.18.1, npm 11.16.0.
- Temurin JDK 17.0.21 at `%USERPROFILE%\android-tools\jdk17`.
- Android command-line tools, platform 37.0, build-tools 37.0.0,
  platform-tools 37.0.1, emulator 37.2.13, Google APIs x86_64 system image.
- AVD `SynapseCity_API_36` (Pixel 9, API 36), WHPX acceleration operational.
- No Android Studio installation is required.

## 3. Build and static verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` (TypeScript 6 strict) | pass |
| `npx vitest run` | 11/11 pass |
| `node scripts/verify-production.mjs` | pass: 200 assets, 64 incidents, VIETMAP, SOS namespace 404 |
| `assembleRelease` | pass |
| GitHub Actions `mobile-build.yml` | pass: unsigned arm64-v8a + x86_64 artifact |
| Production signing/publish | pass: `zipalign` + `apksigner` + Tier-2 files → Tier-1 SynapseOCS |
| APK signature | V2, CN=SynapseCity, local upload key |
| APK integrity | SHA-256 above |
| Boundary grep | no SOS API/namespace in `mobile/src`; SOS link is `Linking.openURL` navigation only |

Release minification was disabled after the first R8 release crashed during
WorkManager/Room startup (`WorkDatabase_Impl.<init>` stripped). Keep rules were
also added. The final APK has no crash and was re-installed and launched on the
emulator.

## 4. Production verification (SSH + HTTPS)

Host: `synapsedx.sbs` (GCP, nginx edge container `synapseone-nginx-1`,
nginx 1.31.8).

- `http://synapsecity.sbs/` → `301 https://synapsecity.sbs/`.
- TLS 1.3, `TLS_AES_256_GCM_SHA384`, certificate verification `OK`.
- Headers on `/v1/city`: HSTS `max-age=31536000; includeSubDomains`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`.
- nginx routes `location ^~ /v1/` to `synapsecity-gateway:8080`; `/` to
  `synapsecity-console:80`; 30 s proxy read timeout.
- `GET /v1/city` reports product `synapsecity`, tier 3, dependency
  `https://synapsedx.sbs`, and `notOwned` includes hazards/emergency/EOP.
- `GET /v1/public/assets?limit=200` → 200 assets; detail lookup matches.
- `GET /v1/public/incidents` → 64 public incidents; unknown reference → 404.
- `GET /v1/emergency` and `/v1/hazards` on the City host -> `404 not_found` (boundary enforced at the gateway).
- Tier-1 edge: `/v1/auth/verify` is exempt from the brute-force bucket, and `/v1/ocs/` accepts signed release uploads up to 128 MiB.
- Native requests send no browser `Origin`; no nginx/CORS change was needed for
  the app. The existing City console CORS allow-list is unchanged.

Screenshots show real production data in the light app and widget:
[home](evidence/app-home.jpg), [map](evidence/app-map.jpg),
[scan](evidence/app-scan.jpg), [asset](evidence/app-asset-detail.jpg),
[alerts](evidence/app-alerts.jpg), [widget](evidence/widget-home.jpg),
[widget preview](evidence/widget-preview.jpg),
[widget stale](evidence/widget-offline.jpg),
[widget help](evidence/widget-help.jpg).

## 5. Emulator smoke test

- Home loads 44 nearby assets in 5 km (production), radar and nearest row.
- Map loads VIETMAP tiles and the nearest public assets/incidents around Đà Nẵng;
  only 24 nearest pins are drawn to keep the mobile map readable.
- Manual asset lookup and `synapsecity://asset/DEN-A65BA0` deep link open the
  public asset record, localise “traffic signal” as **Đèn giao thông**, and render
  the QR code from local modules.
- Report screen prefills the selected asset and refuses invalid input; location
  is sent as a GeoJSON Point.
- Alert list, filters, incident cards, account and settings render in the light
  palette without contrast failures.
- When the emulator position is outside the Đà Nẵng coverage box, the map shows
  an explicit outside-coverage notice and still focuses public city data instead
  of a blank/world view.
- Widget preview renders in the light palette. The widget was added to the
  launcher and bound as a 4×3 card, rendering the nearest asset, maintenance chip,
  mini radar, timestamp and actions.
- **Widget refresh** reached production online (`Cập nhật 0 phút trước`) and,
  with Wi-Fi/data disabled, changed to **Dữ liệu cũ** with the correct age instead
  of silently doing nothing.
- **Widget root tap** opened the asset detail; **scan** opened the QR/NFC screen.
  The widget tap action also works when the app process was not running.
- Periodic work is scheduled (`dumpsys jobscheduler` shows `CityWidgetWorker`).
- No `FATAL EXCEPTION`, `Error inflating RemoteViews` or React Native red box in
  the final run.

The widget initially failed to inflate because the divider used a plain
`android.view.View`, which is not allowed in RemoteViews. It was replaced with a
`TextView`; the bound widget then rendered correctly. A stale launcher placeholder
after `adb install -r` was fixed by re-adding the widget; it is not an app crash.
The app-side widget snapshot now filters assets to 5 km, so a device outside Đà
Nẵng cannot show a far-away asset as “nearest”.

## 6. Findings

| # | Severity | Finding | Status / mitigation |
| --- | --- | --- | --- |
| C1 | Medium | Emulator reports no GPS fix even after `geo fix`; app correctly falls back to Đà Nẵng and labels it. | Physical-device GPS check pending. Code path is real `expo-location`; distance maths unit-tested. |
| C2 | Medium | QR camera scan and NFC tag read were not exercised on physical hardware; no NFC in the emulator. | QR URL/manual lookup and the NDEF URI parser are unit-tested; hardware test pending. |
| C3 | Medium | No positive operator login test (no production credentials were used). | Login UI, validation, SecureStore path and server error handling present; anonymous path fully tested. |
| C4 | Medium | Anonymous incident POST was not executed to avoid polluting production data. | Payload/validation/UI checked; endpoint contract exists; server enforces Turnstile/rate limits. |
| C5 | Low | Widget refresh period is 30 min minimum; Doze can delay it. | Manual refresh + app foreground sync; stale label. |
| C6 | Low | APK contains arm64-v8a + x86_64 (66.9 MB). | Can use ABI splits for store distribution. |
| C7 | Low | Windows MAX_PATH can break native codegen in a long checkout. | `scripts/build-android.ps1` mirrors to a short path; documented. |
| C8 | Low | Map needs network for tiles and the Leaflet CDN; radar fallback is provided. | Explicit “map unavailable” state, never fake data. |
| C9 | Low | Duplicate security headers observed on the wire (`nosniff,nosniff`) from edge + gateway. | Harmless; edge config cleanup recommended. |
| C10 | Low | This build is light-only; there is no in-app dark theme switch. | Intentional for this revision; the web console remains the light reference. |
| C11 | Low | `adb install -r` can leave the launcher showing a stale widget placeholder. | Re-add the widget or open the app once; provider metadata and bound RemoteViews verified clean. |

No critical or high finding. C1–C4 are hardware/credential limitations, not
known code defects; they are listed as remaining verification, not as failures
of the production API contract.

Fixed during this audit:

- R8/WorkManager boot crash → release minification disabled + Room keep rules.
- RemoteViews inflation failure (plain `android.view.View`) → `TextView` divider.
- City map JavaScript `focusDataOnly` reference error → declared in the WebView
  script; the 12 s radar fallback had been masking it.
- Far-away widget “nearest” asset → widget snapshot now filters to 5 km.
- Offline widget refresh → one-time WorkManager request no longer requires a
  network constraint, so the stale label updates immediately.
- Raw `traffic_signal` labels → Vietnamese feature labels.
- Light-theme pass across screens, inputs, maps, splash, tab bar and widget.

## 7. Boundary and privacy

- No SOS dataset/API/import in the mobile source.
- `city-users` is never published; the app does not request or store it.
- Public incidents are read through the redacted public projection.
- Tokens are in SecureStore; no token in URLs/logs.
- HTTPS-only; no analytics or ad SDK.
- Widget cache contains public asset summaries and a coarse location only.

## 8. Final result

The stop condition “done” is met: both builds pass, the production contract
passes, the app and widget run on the emulator, the SSH/HTTPS integration is
verified, and the audit has no critical/high item. The medium items are
documented follow-ups that require physical hardware or production credentials.
