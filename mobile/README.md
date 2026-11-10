# SynapseCity Android app

Native Android client and home-screen widget for **SynapseCity** (`https://synapsecity.sbs`).
The app is built with Expo SDK 58 / React Native 0.88 and talks directly to the
production City API at `https://synapsecity.sbs/v1`. The UI is **light-first**
(`#F4FBFB`/white/teal), following the production web console palette; the
home-screen widget uses the same light visual language.

## What it does

- **Nearby assets** using the device GPS, sorted by distance with status.
- **Interactive map** using the production City map config (VIETMAP tiles through
  `/v1/map/tiles/...`), with a native radar fallback if tiles fail.
- **QR / NFC scanning**: reads the production QR URL
  (`https://synapsecity.sbs/asset/<code>`) or an NDEF URI from an NFC tag and
  opens the public asset record.
- **Public incidents**: list, search, filter, detail and anonymous citizen
  reporting (`POST /v1/public/incidents`).
- **Operator login**: optional account session for `/v1/alerts` and
  `/v1/notifications`; tokens live in Android SecureStore.
- **Local notifications** for new relevant public incidents.
- **Home-screen widget** (4×3, resizable): nearest asset, status, second asset,
  mini radar, scan and refresh actions, explicit stale-data label.

The app never calls SynapseSOS APIs, never renders hazards/emergency data and
never imports SOS code. The SOS link is public navigation only.

## Build

Prerequisites:

- Node.js 20+ (tested with 24.18)
- JDK 17
- Android SDK platform 37, build-tools 37.0.0, platform-tools
- Android emulator or a physical device

```bash
npm ci
npm run typecheck
npm test
node scripts/verify-production.mjs
npx expo start --dev-client        # development (Metro)
npx expo run:android               # debug install
```

Release APK (signed with the local git-ignored upload keystore when present,
otherwise the debug key):

```bash
npm run build:android
```

Current release artefact:

```text
mobile/dist/SynapseCity-0.1.0-release.apk
SHA-256 D7A78EE4C50B79F0D871ED90B713159B25D9BE0660F58B5FDE78F3534C68D3C7
adb install -r mobile/dist/SynapseCity-0.1.0-release.apk
```

On Windows, generated CMake object paths can exceed `MAX_PATH` when the checkout
path is long. `scripts/build-android.ps1` copies the project to a short build
directory (`C:\synapsecity-build`), links `node_modules`, builds and copies the
APK to `mobile/dist/`. Use it if a direct Gradle build fails with
"Filename longer than 260 characters".

### Signing

`android/keystore.properties` and `android/app/release.keystore` are git-ignored.
A clean checkout still builds a verifiable APK with the debug key. For a
production upload key, generate one and fill both files as documented in
`android/app/build.gradle`.

## Widget

Android widgets cannot be rendered by React Native alone. The widget is native
Kotlin (`android/app/src/main/java/.../widget/`) using `AppWidgetProvider`,
`RemoteViews`, `WorkManager` and a Canvas-rendered mini-map. The JS app writes a
JSON snapshot through the `WidgetBridge` native module.

- Tap card / map → asset detail
- **Quét** → QR/NFC scanner
- **Làm mới** → WorkManager fetches production immediately
- Automatic refresh every 30 minutes and when the app syncs
- Data older than 30 minutes or offline is labelled **Dữ liệu cũ**,
  never presented as current.

Location is the last good foreground fix saved by the app. If permission was
never granted, the widget uses the Đà Nẵng centre and says so.

## Production contract

`node scripts/verify-production.mjs` checks:

- product identity and Tier-2 dependency (`synapsedx.sbs`);
- public assets and asset detail shape;
- public incidents and `404` for unknown references;
- map config/tile template;
- City gateway returns `404 not_found` for SOS namespaces.

## Verification

```bash
npm run typecheck     # TypeScript 6 strict
npm test              # Vitest core tests
npm run verify        # production contract
npm run build:android # release APK
```

Evidence and limitations are recorded in [`../docs/MOBILE_AUDIT.md`](../docs/MOBILE_AUDIT.md).

## Privacy / safety

- HTTPS only; Android cleartext traffic is disabled.
- No analytics SDK, no third-party tracking, no ad SDK.
- No GPS, token or reporter PII in logs.
- Public incident reports are anonymous; contact fields are not sent by this app.
- This is an infrastructure operations app, not an emergency service. For
  emergencies call 112/113/114/115.

## Licence

Apache-2.0. Copyright 2026 VKU.VIC. See `LICENSE` and `NOTICE` in the repository
root.
