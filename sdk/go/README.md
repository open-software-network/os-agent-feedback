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

It instruments finite JSON and HTML responses, detects `Flush` and leaves streams untouched, and sends telemetry through a bounded background queue with request deadlines and bounded transient retries. `Shutdown` reports the last terminal telemetry delivery error. Response capture defaults to 1 MiB; larger responses pass through byte-for-byte without instrumentation. Set `MaxResponseBodyBytes` to choose a different positive bound. `FeedbackFromResponse` and `SubmitProductFeedback` provide the allow-listed feedback-aware agent path.

Use `FeedbackAskOnce` to store approval or refusal under the returned product-scoped `ConsentScope`; approved future reports set `FeedbackReport.ApprovalSource` to `stored_grant`. Use `FeedbackAskAlways` to require `granted_now` for every report. `FeedbackConsentAction` resolves the agent-local preference without sending it to Epode. `SubmitProductFeedback` adds the required nested `consent` attestation to ask-mode reports and omits it in never-ask mode.
