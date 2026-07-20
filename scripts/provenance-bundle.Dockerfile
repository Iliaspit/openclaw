FROM scratch
ARG OPENCLAW_SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/openclaw/openclaw" \
  org.opencontainers.image.revision="${OPENCLAW_SOURCE_REVISION}" \
  org.opencontainers.image.title="OpenClaw build provenance"
COPY . /
