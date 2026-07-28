FROM rust:1.97-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY public ./public
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/agent-feedback-example-status /usr/local/bin/agent-feedback-example-status
EXPOSE 8090
CMD ["agent-feedback-example-status"]

