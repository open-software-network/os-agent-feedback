FROM rust:1.97-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY migrations ./migrations
COPY seed ./seed
COPY public ./public
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/agent-feedback /usr/local/bin/agent-feedback
COPY public ./public
ENV PORT=8080
EXPOSE 8080
CMD ["agent-feedback"]
