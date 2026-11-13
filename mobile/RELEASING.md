# Releasing the Android app

The release path is deliberately split so the Android signing key never enters
GitHub Actions:

```text
GitHub Actions (public CI)
  verify -> typecheck/test/contract
  build  -> unsigned arm64-v8a + x86_64 APK artifact

Production release host (protected)
  download artifact -> zipalign -> apksigner (local keystore)
  -> Tier-2 files capability -> Tier-1 SynapseOCS
  -> public stable download URL + checksum
```

This follows the tier boundary: the release job calls **Tier-2**
`/v1/capabilities/files`; Tier-2 stores bytes in **Tier-1** SynapseOCS. The job
never receives S3 credentials.

## Trigger a build

- Workflow: **Actions → Mobile build → Run workflow**.
- Or push a tag:

```bash
git tag mobile-v0.1.1
git push origin mobile-v0.1.1
```

The workflow uploads:

```text
SynapseCity-<version>-unsigned.apk
SHA256SUMS.txt
```

## Sign and publish on the production host

Prerequisites (already provisioned on the production release host):

```text
~/release-secrets/synapsecity-release.keystore
~/release-secrets/tier2-release.key
```

`tier2-release.key` is a scoped Tier-1 API key with `files:write` and
`files:publish`; it is not a platform-admin key.

```bash
export SYNAPSEDX_RELEASE_API_KEY="$(cat ~/release-secrets/tier2-release.key)"
export KEYSTORE_PATH="$HOME/release-secrets/synapsecity-release.keystore"
export KEYSTORE_PASSWORD='...'
export KEY_ALIAS='synapsecity'
export KEY_PASSWORD='...'

bash mobile/scripts/sign-release.sh \
  /tmp/SynapseCity-0.1.1-unsigned.apk /tmp/SynapseCity-0.1.1-release.apk

node mobile/scripts/publish-release.mjs \
  --product synapsecity \
  --version 0.1.1 \
  --arch arm64-x86_64 \
  --apk /tmp/SynapseCity-0.1.1-release.apk
```

The publish script creates a public file record, asks Tier-2 for a short-lived
presigned OCS upload URL, uploads the APK, completes the checksum/size
verification, downloads it again anonymously, and prints:

```json
{
  "publicUrl": "https://synapsedx.sbs/v1/capabilities/public/files/synapsecity-android-0.1.1-arm64-x86_64/content",
  "sha256": "...",
  "size": 66861954
}
```

Use that URL as the release download link. Keep the checksum in the release
notes and in `docs/MOBILE_AUDIT.md`.

## Automatic tag release worker (production)

A protected host can poll GitHub for successful `mobile-v*` tag builds and run
the signing/publish steps automatically:

```bash
export GITHUB_TOKEN=...
export GITHUB_REPOSITORY=vku-open-source-2026/SynapseCity
export RELEASE_PRODUCT=synapsecity
export RELEASE_ARTIFACT_PREFIX=synapsecity-android
export RELEASE_FILE_PREFIX=SynapseCity
export SYNAPSEDX_RELEASE_API_KEY="$(cat ~/release-secrets/tier2-release.key)"
set -a; source ~/release-secrets/sign-city.env; set +a
bash mobile/scripts/ci-release.sh
```

Run it from a 5-minute systemd timer or cron. It stores processed tags under
`~/.local/state/synapse-mobile-release/` and uses a lock so two workers cannot
publish concurrently. A tag is only processed after its workflow run is green.

## Rollback

Publish a new versioned file id for the previous build or point the download
page at the previous `publicUrl`. Never reuse a version id for different bytes;
the script verifies checksum and replaces an incomplete record only.
