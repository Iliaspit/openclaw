#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"
IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:local}"
LIVE_IMAGE_NAME="${OPENCLAW_LIVE_IMAGE:-${IMAGE_NAME}-live}"

if [[ "${OPENCLAW_SKIP_DOCKER_BUILD:-}" == "1" ]]; then
  echo "==> Reuse live-test image: $LIVE_IMAGE_NAME"
  exit 0
fi

echo "==> Build live-test image: $LIVE_IMAGE_NAME (target=build)"
SOURCE_REVISION="$(git -C "$ROOT_DIR" rev-parse --verify 'HEAD^{commit}')"
run_logged live-build docker build --target build \
  --build-arg "OPENCLAW_SOURCE_REVISION=$SOURCE_REVISION" \
  --build-arg "OPENCLAW_PROVENANCE_ARTIFACT_URI=docker-image://$LIVE_IMAGE_NAME#dist" \
  --build-arg "OPENCLAW_INSTALL_BROWSER=${OPENCLAW_INSTALL_BROWSER:-}" \
  -t "$LIVE_IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"
