#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
#
# Sign an APK built by GitHub Actions on the protected production host.
# The Android signing key never enters GitHub; only the unsigned artifact does.
#
# Required env:
#   KEYSTORE_PATH, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD
# Usage:
#   sign-release.sh unsigned.apk signed.apk
set -euo pipefail
INPUT="${1:?usage: sign-release.sh <unsigned.apk> <signed.apk>}"
OUTPUT="${2:?usage: sign-release.sh <unsigned.apk> <signed.apk>}"
: "${KEYSTORE_PATH:?KEYSTORE_PATH is required}"
: "${KEYSTORE_PASSWORD:?KEYSTORE_PASSWORD is required}"
: "${KEY_ALIAS:?KEY_ALIAS is required}"
: "${KEY_PASSWORD:?KEY_PASSWORD is required}"

for tool in zipalign apksigner sha256sum; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }
done

ALIGNED="$(mktemp --suffix=.apk)"
trap 'rm -f "$ALIGNED"' EXIT
zipalign -f -p 4 "$INPUT" "$ALIGNED"
apksigner sign \
  --ks "$KEYSTORE_PATH" \
  --ks-pass "env:KEYSTORE_PASSWORD" \
  --ks-key-alias "$KEY_ALIAS" \
  --key-pass "env:KEY_PASSWORD" \
  --out "$OUTPUT" \
  "$ALIGNED"
apksigner verify --verbose --print-certs "$OUTPUT"
sha256sum "$OUTPUT"
