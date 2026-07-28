# Go `net/http` example

The standard-library middleware works directly with `net/http` and routers built on it.

```go
feedback, _ := agentfeedback.New(agentfeedback.Options{
    APIKey: os.Getenv("AGENT_FEEDBACK_KEY"),
    Include: []string{"/api/status"},
})

http.ListenAndServe(":8080", feedback.Middleware(router))
```
