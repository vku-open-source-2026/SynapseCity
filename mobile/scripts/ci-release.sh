#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
#
# Protected-host release worker.
#
# Polls successful `mobile-v*` tag builds, downloads the unsigned GitHub Actions
# artifact, signs it with the local upload keystore, and publishes it through the
# Tier-2 files capability into Tier-1 SynapseOCS.
#
# Required env:
#   GITHUB_TOKEN, GITHUB_REPOSITORY
#   RELEASE_PRODUCT, RELEASE_ARTIFACT_PREFIX, RELEASE_FILE_PREFIX
#   SYNAPSEDX_RELEASE_API_KEY
#   KEYSTORE_PATH, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD
# Optional:
#   RELEASE_STATE_DIR (default ~/.local/state/synapse-mobile-release)
#   TAG (process one tag instead of all unprocessed tags)
set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RELEASE_PRODUCT:?RELEASE_PRODUCT is required}"
: "${RELEASE_ARTIFACT_PREFIX:?RELEASE_ARTIFACT_PREFIX is required}"
: "${RELEASE_FILE_PREFIX:?RELEASE_FILE_PREFIX is required}"
: "${SYNAPSEDX_RELEASE_API_KEY:?SYNAPSEDX_RELEASE_API_KEY is required}"
: "${KEYSTORE_PATH:?KEYSTORE_PATH is required}"
: "${KEYSTORE_PASSWORD:?KEYSTORE_PASSWORD is required}"
: "${KEY_ALIAS:?KEY_ALIAS is required}"
: "${KEY_PASSWORD:?KEY_PASSWORD is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${RELEASE_STATE_DIR:-$HOME/.local/state/synapse-mobile-release}"
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/worker.lock"
flock -n 9 || { echo "another release worker is running"; exit 0; }

api() {
  curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_REPOSITORY$1"
}

TAGS_JSON=$(api '/tags?per_page=100')
mapfile -t TAGS < <(jq -r '.[].name | select(startswith("mobile-v"))' <<<"$TAGS_JSON")
(( ${#TAGS[@]} )) || { echo "no mobile tags"; exit 0; }

for TAG_NAME in "${TAGS[@]}"; do
  if [[ -n "${TAG:-}" && "$TAG_NAME" != "$TAG" ]]; then continue; fi
  STATE="$STATE_DIR/$TAG_NAME.json"
  [[ -f "$STATE" ]] && continue
  VERSION="${TAG_NAME#mobile-v}"
  echo "== $TAG_NAME =="

  RUNS=$(api '/actions/runs?event=push&per_page=100')
  RUN_ID=$(jq -r --arg tag "$TAG_NAME" '
    .workflow_runs
    | map(select(.head_branch == $tag and .conclusion == "success" and .status == "completed"))
    | sort_by(.created_at) | last | .id // empty
  ' <<<"$RUNS")
  [[ -n "$RUN_ID" ]] || { echo "no successful tag run yet: $TAG_NAME"; continue; }

  ARTIFACTS=$(api "/actions/runs/$RUN_ID/artifacts")
  ARTIFACT_URL=$(jq -r --arg p "$RELEASE_ARTIFACT_PREFIX" '
    .artifacts[] | select(.expired == false and (.name | startswith($p))) | .archive_download_url
  ' <<<"$ARTIFACTS" | head -1)
  [[ -n "$ARTIFACT_URL" ]] || { echo "no artifact for run $RUN_ID"; continue; }

  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$ARTIFACT_URL" -o "$WORK/artifact.zip"
  (cd "$WORK" && unzip -q artifact.zip)
  UNSIGNED="$(find "$WORK" -name '*.apk' -type f | head -1)"
  [[ -n "$UNSIGNED" ]] || { echo "no APK in artifact"; continue; }

  SIGNED="$WORK/${RELEASE_FILE_PREFIX}-${VERSION}-release.apk"
  bash "$SCRIPT_DIR/sign-release.sh" "$UNSIGNED" "$SIGNED"
  SHA=$(sha256sum "$SIGNED" | cut -d' ' -f1)

  RESULT=$(node "$SCRIPT_DIR/publish-release.mjs" \
    --product "$RELEASE_PRODUCT" \
    --version "$VERSION" \
    --arch arm64-x86_64 \
    --apk "$SIGNED")
  echo "$RESULT"
  URL=$(jq -r '.publicUrl' <<<"$RESULT")
  jq -n --arg tag "$TAG_NAME" --arg sha "$SHA" --arg url "$URL" --arg run "$RUN_ID" \
    '{tag:$tag,sha256:$sha,publicUrl:$url,runId:$run,publishedAt:(now|todate)}' > "$STATE"
  rm -rf "$WORK"
  trap - EXIT
  echo "published $TAG_NAME -> $URL"
done
