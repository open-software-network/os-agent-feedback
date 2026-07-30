package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	agentfeedback "github.com/open-software-network/os-epode/sdk/go"
)

func main() {
	feedback, err := agentfeedback.New(agentfeedback.Options{
		APIKey: os.Getenv("AGENT_FEEDBACK_KEY"), Endpoint: os.Getenv("AGENT_FEEDBACK_URL"),
		Include: []string{"/search", "/docs/*"},
		CustomerRef: func(request *http.Request) string { return request.Header.Get("x-customer-ref") },
	})
	if err != nil { log.Fatal(err) }
	mux := http.NewServeMux()
	mux.HandleFunc("GET /search", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"stack": "go", "answer": "go-result"})
	})
	mux.HandleFunc("GET /docs/test", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<!doctype html><html><head><title>Go docs</title></head><body>go-docs-result</body></html>"))
	})
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	server := &http.Server{Addr: "127.0.0.1:" + env("PORT", "4105"), Handler: feedback.Middleware(mux), ReadHeaderTimeout: 5 * time.Second}
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed { log.Fatal(err) }
	_ = feedback.Shutdown(context.Background())
}

func env(name, fallback string) string { if value := os.Getenv(name); value != "" { return value }; return fallback }
