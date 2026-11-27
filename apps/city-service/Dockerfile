# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM rust:1.100-bookworm AS builder
ARG CARGO_BUILD_JOBS=1
WORKDIR /app
COPY apps/city-service/Cargo.toml apps/city-service/Cargo.lock ./
COPY apps/city-service/src ./src
RUN cargo build --release --locked --jobs=${CARGO_BUILD_JOBS}

FROM debian:bookworm-slim
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.title="SynapseCity City service" \
      org.opencontainers.image.source="https://github.com/vku-open-source-2026/SynapseCity" \
      org.opencontainers.image.revision=${SOURCE_COMMIT}
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app
COPY --from=builder /app/target/release/synapsecity-city /usr/local/bin/synapsecity-city
COPY LICENSE NOTICE THIRD-PARTY.md /usr/share/doc/synapsecity-city/
COPY licenses /usr/share/doc/synapsecity-city/licenses
RUN test -n "${SOURCE_COMMIT}" \
    && sed -i "s/SOURCE_COMMIT/${SOURCE_COMMIT}/g" /usr/share/doc/synapsecity-city/licenses/SOURCE-OFFER.md \
    && cp /usr/share/doc/synapsecity-city/licenses/SOURCE-OFFER.md /usr/share/doc/synapsecity-city/SOURCE-OFFER.txt \
    && if [ -f /usr/share/doc/synapsecity-city/licenses/THIRD-PARTY-NOTICES.generated.txt ]; then \
         cp /usr/share/doc/synapsecity-city/licenses/THIRD-PARTY-NOTICES.generated.txt /usr/share/doc/synapsecity-city/licenses/THIRD-PARTY-NOTICES.txt; \
       fi
ENV PORT=8083
EXPOSE 8083
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/synapsecity-city", "--healthcheck"]
USER app
ENTRYPOINT ["/usr/local/bin/synapsecity-city"]
