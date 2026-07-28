FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY sdk/go ./sdk/go
COPY examples/go-http ./examples/go-http
WORKDIR /app/examples/go-http
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /example-go-http .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=builder /example-go-http /usr/local/bin/example-go-http
ENV PORT=8080
CMD ["example-go-http"]
