# Epode for Go

Version 0.4.0 preserves the existing agent-feedback middleware and adds a
typed company-side customer-enrichment client using only the standard library.

```go
epode, err := agentfeedback.NewCustomerClient(agentfeedback.CustomerClientOptions{
    APIKey: os.Getenv("EPODE_API_KEY"),
})
if err != nil { log.Fatal(err) }

statusCode := 200
durationMS := int64(handlerDuration / time.Millisecond)
request := epode.RequestEnrichment(ctx, agentfeedback.EnrichmentRequestInput{
    CustomerIdentity: agentfeedback.CustomerIdentity{UserRef: authenticatedUser.ID},
    InteractionID: interactionID,
    Operation: "/api/recommendations",
    Surface: agentfeedback.SurfaceHTTPJSON,
    StatusCode: &statusCode,
    DurationMS: &durationMS,
    SessionRef: productJourney.ID,
    RuntimeHint: verifiedRuntimeLabel,
    Purpose: agentfeedback.ProductPersonalization,
    Remember: true,
})

customerContext := epode.GetCustomerContext(ctx, agentfeedback.CustomerContextInput{
    CustomerIdentity: agentfeedback.CustomerIdentity{UserRef: authenticatedUser.ID},
    Purpose: agentfeedback.ProductPersonalization,
})
result := normalResult
if customerContext.Available {
    result = personalize(normalResult, customerContext.Items)
}
```

`RequestEnrichment`, `GetCustomerContext`, `RecordPersonalizationDecision`,
and `TrackPersonalizationOutcome` use strict time budgets, reject redirects,
and fail open. Use `AnonymousRef` for a product-owned pre-login identifier, or
`InteractionID` alone for interaction-only context. Mount `Relay` at the two
paths in `CustomerContextRelayPaths`; it validates bounded agent answers before
forwarding the short-lived handle and never exposes the company key.

`Surface` defaults to `SurfaceHTTPJSON`; use `SurfaceHTML` or `SurfaceMCP` for those product
surfaces. Optional status, duration, session, and runtime fields describe the same call.
`SessionRef` must be product-issued and `RuntimeHint` must be a bounded, non-sensitive
server-observed label. Never copy prompts, tool arguments, raw customer content, or regulated
traits into these fields.

## Existing feedback middleware

The Go SDK uses only the standard library.

### Completed MCP tools

Record a completed invocation without exposing arguments, results, errors, timestamps, or raw
telemetry:

`Operation` is already normalized product metadata and must contain no customer value.

```go
err := feedback.RecordMCPCompletion(agentfeedback.MCPCompletion{
    Operation: "get_summary", Outcome: agentfeedback.MCPOutcomeSuccess,
    AccountRef: authenticatedAccount.ID, SessionRef: journey.ID,
})
```

For typed handlers, keep an account-scoped journey registry in product code. The result's canonical
journey may replace the input candidate only when the trusted extractor confirms the same account:

```go
wrapped := agentfeedback.WrapMCPHandler(feedback, "create_summary", createSummary,
    func(ctx context.Context, in CreateInput, out CreateResult) (agentfeedback.MCPHandlerObservation, error) {
        account := authenticatedAccount(ctx)
        canonical, owner := journeys.Lookup(out.SummaryID) // product-owned registry
        observation := agentfeedback.MCPHandlerObservation{
            MCPCompletion: agentfeedback.MCPCompletion{AccountRef: account.ID, SessionRef: in.JourneyID},
            IsError: out.IsError,
        }
        if owner == account.ID {
            observation.ResultSessionRef = canonical
            observation.ResultAccountRef = owner
        }
        return observation, nil
    })
```

There is deliberately no MCP transport-session fallback. Extractors must use authenticated product
context and product-workflow sessions, never tool arguments as identity or transport IDs as journeys.
Extractor failures and panics are isolated and record an unlinked completion; handler results, errors,
and panics are preserved. Disabled and post-shutdown runtimes do not invoke extractors. `Flush(ctx)`
serializes delivery of one batch (up to 50 events) with the worker; it is a checkpoint, not a full
drain. `Shutdown` begins terminal acceptance and performs the existing bounded best-effort final batch.

```go
feedback, err := agentfeedback.New(agentfeedback.Options{
    APIKey: os.Getenv("AGENT_FEEDBACK_KEY"),
    Include: []string{"/search", "/docs/**"},
    AccountRef: func(r *http.Request) string { return authenticatedAccountID(r.Context()) },
    UserRef: func(r *http.Request) string { return authenticatedUserID(r.Context()) },
    AnonymousRef: func(r *http.Request) string { return firstPartyVisitorID(r.Context()) },
    CustomerRef: func(r *http.Request) string {
        return authenticatedAccountID(r.Context())
    },
})
if err != nil { log.Fatal(err) }
defer feedback.Shutdown(context.Background())

instrumented := feedback.Middleware(router)
http.ListenAndServe(":8080", authenticateProductRequest(instrumented))
```

Authentication and authorized tenant selection must wrap and run before Epode. Never derive
identity references from agent arguments, a caller-controlled raw header, query value, email, or name.
`AccountRef` and `UserRef` are verified company assertions; `AnonymousRef` is a product-scoped
first-party pre-login reference. They are background telemetry only and never enter the capability.

It instruments finite JSON and HTML responses, detects `Flush` and leaves streams untouched, and sends telemetry through a bounded background queue with a monotonic process-local sequence, a 30-second background deadline, and six bounded exponential transient attempts. `Shutdown` reports the last terminal telemetry delivery error. Response capture defaults to 1 MiB; larger responses pass through byte-for-byte without instrumentation. Set `MaxResponseBodyBytes` to choose a different positive bound. `FeedbackFromResponse`, `InspectFeedbackConsent`, and `SubmitProductFeedback` provide the allow-listed feedback-aware agent path. Inspection is authoritative, bounded, and redirect-free; decision and report helpers inspect first so stale Ask-once envelopes cannot cause duplicate prompts or overwrite a remembered decision.

The default `CacheMode: CacheSafe` leaves explicitly shared-cacheable responses completely unchanged. Set `CacheMode: CacheRequest` to instrument only requests carrying `Agent-Feedback-Request: 1`; both variants use `Vary` and eligible ordinary 2xx `GET`/`HEAD` responses carry a same-path-and-query discovery `Link`. Set `CacheMode: CachePrivate` when every included response is intentionally private. Every instrumented response becomes `Cache-Control: private, no-store` because its capability is unique.

Use `FeedbackAskOnce` with a stable opaque `CustomerRef`. HTTP responses never wait for Epode: middleware signs a subject-bound capability locally, reads only process-local cached consent, and refreshes that cache in the background after an eligible response. Epode Companion verifies the capability and resolves the authoritative remembered decision before it asks or reports. Unknown customers receive an answer-first decision contract; `SubmitFeedbackConsent` records `approved|declined` with Epode and approval reveals a separate report contract. Approved and declined responses include a scoped `ManageConsent` action so an explicit user request can reverse the saved choice; declined responses remain quiet otherwise. `FeedbackAskAlways` repeats that two-step flow for each report. Agents store no preference, and reports contain no consent fields.
