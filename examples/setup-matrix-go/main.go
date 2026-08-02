package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	agentfeedback "github.com/open-software-network/os-epode/sdk/go"
)

type productIdentityKey struct{}

type productIdentity struct {
	accountID   string
	userID      string
	anonymousID string
}

func main() {
	options := agentfeedback.Options{
		APIKey: os.Getenv("AGENT_FEEDBACK_KEY"), Endpoint: os.Getenv("AGENT_FEEDBACK_URL"),
		Include: []string{"/search", "/docs/*"},
		AccountRef: func(request *http.Request) string {
			value, _ := request.Context().Value(productIdentityKey{}).(productIdentity)
			return value.accountID
		},
		UserRef: func(request *http.Request) string {
			value, _ := request.Context().Value(productIdentityKey{}).(productIdentity)
			return value.userID
		},
		AnonymousRef: func(request *http.Request) string {
			value, _ := request.Context().Value(productIdentityKey{}).(productIdentity)
			return value.anonymousID
		},
	}
	if os.Getenv("AGENT_FEEDBACK_MODE") == "ask_once" {
		options.CustomerRef = func(request *http.Request) string {
			value, _ := request.Context().Value(productIdentityKey{}).(productIdentity)
			return value.accountID
		}
	}
	feedback, err := agentfeedback.New(options)
	if err != nil {
		log.Fatal(err)
	}
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
	server := &http.Server{Addr: "127.0.0.1:" + env("PORT", "4105"), Handler: authenticate(feedback.Middleware(mux)), ReadHeaderTimeout: 5 * time.Second}
	shutdownSignal := make(chan os.Signal, 1)
	signal.Notify(shutdownSignal, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-shutdownSignal
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := feedback.Shutdown(shutdownContext); err != nil {
		log.Printf("agent feedback shutdown: %v", err)
	}
}

func authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/health" {
			next.ServeHTTP(writer, request)
			return
		}
		token := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		parts := strings.Split(token, ".")
		if len(parts) != 2 {
			http.Error(writer, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		mac := hmac.New(sha256.New, []byte(os.Getenv("SETUP_MATRIX_PRODUCT_AUTH_SECRET")))
		_, _ = mac.Write([]byte(parts[0]))
		signature, signatureErr := base64.RawURLEncoding.DecodeString(parts[1])
		accountBytes, accountErr := base64.RawURLEncoding.DecodeString(parts[0])
		accountID := string(accountBytes)
		if signatureErr != nil || accountErr != nil || !hmac.Equal(signature, mac.Sum(nil)) || !validAccountID(accountID) {
			http.Error(writer, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		identity := productIdentity{
			accountID:   accountID,
			userID:      "user." + accountID,
			anonymousID: "anon." + accountID,
		}
		next.ServeHTTP(writer, request.WithContext(context.WithValue(request.Context(), productIdentityKey{}, identity)))
	})
}

func validAccountID(value string) bool {
	if len(value) == 0 || len(value) > 160 {
		return false
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z') && !(character >= 'A' && character <= 'Z') && !(character >= '0' && character <= '9') && !strings.ContainsRune("_.:-", character) {
			return false
		}
	}
	return true
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
