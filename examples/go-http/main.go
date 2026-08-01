package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	agentfeedback "github.com/open-software-network/os-epode/sdk/go"
)

type accountIDKey struct{}

func authenticateProductRequest(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		authorization := request.Header.Get("Authorization")
		if authorization == "" {
			next.ServeHTTP(response, request)
			return
		}
		if authorization != "Bearer example-company-token" {
			http.Error(response, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(request.Context(), accountIDKey{}, "example-account")
		next.ServeHTTP(response, request.WithContext(ctx))
	})
}

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
			value, _ := request.Context().Value(accountIDKey{}).(string)
			return value
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
		Handler:           authenticateProductRequest(feedback.Middleware(mux)),
		ReadHeaderTimeout: 5 * time.Second,
	}
	serverErrors := make(chan error, 1)
	go func() { serverErrors <- server.ListenAndServe() }()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	var serveErr error
	select {
	case <-stop:
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			serveErr = err
		}
	}
	signal.Stop(stop)
	serverContext, cancelServer := context.WithTimeout(context.Background(), 5*time.Second)
	if err := server.Shutdown(serverContext); err != nil {
		log.Printf("HTTP server shutdown: %v", err)
	}
	cancelServer()
	feedbackContext, cancelFeedback := context.WithTimeout(context.Background(), 5*time.Second)
	if err := feedback.Shutdown(feedbackContext); err != nil {
		log.Printf("Epode telemetry shutdown: %v", err)
	}
	cancelFeedback()
	if serveErr != nil {
		log.Fatal(serveErr)
	}
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
