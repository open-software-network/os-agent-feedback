# Agent Feedback for Go

The Go SDK uses only the standard library.

```go
feedback, err := agentfeedback.New(agentfeedback.Options{
    APIKey: os.Getenv("AGENT_FEEDBACK_KEY"),
    Include: []string{"/search", "/docs/**"},
    CustomerRef: func(r *http.Request) string {
        return r.Header.Get("X-Account-ID")
    },
})
if err != nil { log.Fatal(err) }
defer feedback.Shutdown(context.Background())

http.ListenAndServe(":8080", feedback.Middleware(router))
```

It instruments finite JSON and HTML responses, detects `Flush` and leaves streams untouched, and sends telemetry through a bounded background queue. `FeedbackFromResponse` and `SubmitProductOutcome` provide the allow-listed feedback-aware agent path.
