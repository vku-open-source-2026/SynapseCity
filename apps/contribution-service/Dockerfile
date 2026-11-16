# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
#
# Self-contained build: the `synapseone` SDK is resolved from crates.io.
FROM rust:1.100-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app
COPY --from=builder /app/target/release/contribution-backend /usr/local/bin/contribution-backend
COPY LICENSE NOTICE THIRD-PARTY.md README.md /usr/share/doc/contribution-backend/
ENV BIND_ADDR=0.0.0.0:8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/contribution-backend", "--healthcheck"]
USER app
ENTRYPOINT ["/usr/local/bin/contribution-backend"]
