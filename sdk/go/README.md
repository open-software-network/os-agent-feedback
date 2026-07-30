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

It instruments finite JSON and HTML responses, detects `Flush` and leaves streams untouched, and sends telemetry through a bounded background queue with a monotonic process-local sequence, a 10-second background deadline, and bounded exponential transient retries. `Shutdown` reports the last terminal telemetry delivery error. Response capture defaults to 1 MiB; larger responses pass through byte-for-byte without instrumentation. Set `MaxResponseBodyBytes` to choose a different positive bound. `FeedbackFromResponse` and `SubmitProductFeedback` provide the allow-listed feedback-aware agent path.

Use `FeedbackAskOnce` with a stable opaque `CustomerRef`. Unknown customers receive only a question-first decision contract; `SubmitFeedbackConsent` records `approved|declined` with Epode and approval reveals a separate report contract. `FeedbackAskAlways` repeats that two-step flow for each report. Agents store no preference, and reports contain no consent fields.
