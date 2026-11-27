# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
#
# Self-contained build: Tier-2 (`synapsedx`) is the production backend.
# Legacy `synapseone` (Tier-1) is kept only for migration/rollback.
FROM rust:1.100-bookworm AS builder
WORKDIR /app
COPY apps/contribution-service/Cargo.toml apps/contribution-service/Cargo.lock ./
COPY apps/contribution-service/src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.title="SynapseCity contribution service" \
      org.opencontainers.image.source="https://github.com/vku-open-source-2026/SynapseCity" \
      org.opencontainers.image.revision=${SOURCE_COMMIT}
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app
COPY --from=builder /app/target/release/contribution-backend /usr/local/bin/contribution-backend
COPY --from=builder /app/target/release/migrate_base_to_dx /usr/local/bin/migrate-base-to-dx
COPY LICENSE NOTICE THIRD-PARTY.md /usr/share/doc/contribution-backend/
COPY licenses /usr/share/doc/contribution-backend/licenses
RUN test -n "${SOURCE_COMMIT}" \
    && sed -i "s/SOURCE_COMMIT/${SOURCE_COMMIT}/g" /usr/share/doc/contribution-backend/licenses/SOURCE-OFFER.md \
    && cp /usr/share/doc/contribution-backend/licenses/SOURCE-OFFER.md /usr/share/doc/contribution-backend/SOURCE-OFFER.txt \
    && if [ -f /usr/share/doc/contribution-backend/licenses/THIRD-PARTY-NOTICES.generated.txt ]; then \
         cp /usr/share/doc/contribution-backend/licenses/THIRD-PARTY-NOTICES.generated.txt /usr/share/doc/contribution-backend/licenses/THIRD-PARTY-NOTICES.txt; \
       fi
ENV BIND_ADDR=0.0.0.0:8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/contribution-backend", "--healthcheck"]
USER app
ENTRYPOINT ["/usr/local/bin/contribution-backend"]
