package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	agentfeedback "github.com/open-software-network/os-epode/sdk/go"
)

func respond(response http.ResponseWriter, value any) {
	response.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(response).Encode(value)
}

func main() {
	apiKey := os.Getenv("AGENT_FEEDBACK_KEY")
	if apiKey == "" {
		log.Fatal("AGENT_FEEDBACK_KEY is required")
	}
	feedback, err := agentfeedback.New(agentfeedback.Options{
		APIKey:   apiKey,
		Endpoint: os.Getenv("AGENT_FEEDBACK_URL"),
		Include:  []string{"/api/status"},
		CustomerRef: func(request *http.Request) string {
			return request.Header.Get("X-Customer-Ref")
		},
		RuntimeHint: func(request *http.Request) string {
			return request.UserAgent()
		},
	})
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", func(response http.ResponseWriter, _ *http.Request) {
		respond(response, map[string]any{
			"example":         "company-product-go-http",
			"productEndpoint": "/api/status",
			"frameworks":      []string{"net/http", "Chi", "Gin", "Echo", "Fiber adapters"},
			"reliability":     map[string]string{"genericAgent": "best_effort", "feedbackAwareAgent": "deterministic"},
		})
	})
	mux.HandleFunc("GET /health", func(response http.ResponseWriter, _ *http.Request) {
		respond(response, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/status", func(response http.ResponseWriter, _ *http.Request) {
		respond(response, map[string]any{
			"service": "checkout", "available": true, "region": "us-east",
			"checkedAt": time.Now().UTC().Format(time.RFC3339Nano),
			"source":    "example-company-go-status",
		})
	})
	server := &http.Server{
		Addr:              ":" + env("PORT", "8080"),
		Handler:           feedback.Middleware(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	_ = feedback.Shutdown(ctx)
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
