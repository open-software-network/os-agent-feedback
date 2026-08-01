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

The default `CacheMode: CacheSafe` leaves explicitly shared-cacheable responses completely unchanged. Set `CacheMode: CacheRequest` to instrument only requests carrying `Agent-Feedback-Request: 1`; both variants use `Vary` and eligible ordinary 2xx `GET`/`HEAD` responses carry a same-path-and-query discovery `Link`. Set `CacheMode: CachePrivate` when every included response is intentionally private. Every instrumented response becomes `Cache-Control: private, no-store` because its capability is unique.

Use `FeedbackAskOnce` with a stable opaque `CustomerRef`. HTTP responses never wait for Epode: middleware signs a subject-bound capability locally, reads only process-local cached consent, and refreshes that cache in the background after an eligible response. Epode Companion verifies the capability and resolves the authoritative remembered decision before it asks or reports. Unknown customers receive an answer-first decision contract; `SubmitFeedbackConsent` records `approved|declined` with Epode and approval reveals a separate report contract. Approved and declined responses include a scoped `ManageConsent` action so an explicit user request can reverse the saved choice; declined responses remain quiet otherwise. `FeedbackAskAlways` repeats that two-step flow for each report. Agents store no preference, and reports contain no consent fields.
