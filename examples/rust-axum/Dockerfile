FROM rust:1.97-bookworm AS builder
WORKDIR /app
COPY sdk/rust ./sdk/rust
COPY examples/rust-axum ./examples/rust-axum
WORKDIR /app/examples/rust-axum
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/examples/rust-axum/target/release/agent-feedback-example-rust-axum /usr/local/bin/example-rust-axum
ENV PORT=8080
CMD ["example-rust-axum"]
