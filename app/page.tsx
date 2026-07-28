const dashboard = "https://app.epode.ai";

const protocolCode = `// Pick your framework adapter once:
Node    app.use(agentFeedback(options))
Python  app = AgentFeedbackASGI(app, **options)
Go      handler = feedback.Middleware(router)
Rust    router.layer(AgentFeedbackLayer::new(options)?)

// Every adapter emits the same language-neutral contract.`;

const review = `{
  "outcome": "success",
  "note": "The search result completed the task."
}`;

export default function Home() {
  return (
    <main>
      <nav className="topbar">
        <a className="wordmark" href="#top">AGENT FEEDBACK</a>
        <div>
          <a href={`${dashboard}/.well-known/agent-feedback-v1.json`}>Protocol</a>
          <a className="button" href={`${dashboard}/auth/start`}>Open dashboard</a>
        </div>
      </nav>

      <section id="top" className="hero">
        <p className="eyebrow">OUTCOME FEEDBACK FROM CUSTOMER AGENTS</p>
        <h1>Did your product actually work for your customer&apos;s agent?</h1>
        <p className="lede">
          Instrument your API, MCP server, or agent-readable website once—in the
          language you already use. MCP exposes an explicit outcome tool; HTTP
          offers a compact receipt that feedback-aware runtimes can submit.
        </p>
        <div className="actions">
          <a className="button primary" href={`${dashboard}/auth/start`}>Set up a product</a>
          <a className="button" href="#integration">See the integration</a>
        </div>
      </section>

      <section className="flow" aria-label="How Agent Feedback works">
        <article><b>1</b><h2>Your product responds</h2><p>The SDK adds a two-hour, write-only receipt locally. Your response never waits for us.</p></article>
        <span aria-hidden="true">→</span>
        <article><b>2</b><h2>The customer&apos;s agent uses it</h2><p>HTTP begins as an opportunity. MCP tool use is confirmed immediately.</p></article>
        <span aria-hidden="true">→</span>
        <article><b>3</b><h2>The agent reviews the outcome</h2><p>One short result: success, partial, or failure, plus a sentence explaining why.</p></article>
      </section>

      <section id="integration" className="integration">
        <div>
          <p className="eyebrow">ONE-TIME SETUP</p>
          <h2>Use any backend. Keep every handler unchanged.</h2>
          <p>
            Select the routes where agent feedback is useful. Customer grouping is
            optional and comes from authentication your product already has.
          </p>
          <ul>
            <li>No agent identity or Agent Feedback account required</li>
            <li>No blocking call on the product response path</li>
            <li>No prompts, transcripts, credentials, or raw payloads accepted</li>
            <li>Node, Python, Go, Rust, and MCP adapters use the same contract</li>
            <li>Every other stack can implement the small public HTTP protocol</li>
          </ul>
        </div>
        <pre><code>{protocolCode}</code></pre>
      </section>

      <section className="languages">
        <p className="eyebrow">PROTOCOL FIRST</p>
        <h2>One receipt contract. Every product stack.</h2>
        <div>
          <article><b>Node</b><p>Express and Fastify middleware plus MCP instrumentation.</p></article>
          <article><b>Python</b><p>ASGI for FastAPI, Starlette, Quart, and Django; WSGI for Flask and Django.</p></article>
          <article><b>Go</b><p>Standard <code>net/http</code> middleware compatible with routers built on it.</p></article>
          <article><b>Rust</b><p>An Axum/Tower layer with bounded, non-blocking telemetry.</p></article>
          <article><b>Anything else</b><p>Use the language-neutral protocol and shared conformance vector.</p></article>
        </div>
      </section>

      <section className="review-shape">
        <div><p className="eyebrow">THE WHOLE REVIEW</p><h2>Small enough for an agent. Structured enough for product decisions.</h2></div>
        <pre><code>{review}</code></pre>
      </section>

      <section className="truth">
        <h2>We report what is proven—not what is guessed.</h2>
        <div>
          <article><b>Opportunity</b><p>An eligible HTTP response carried feedback instructions.</p></article>
          <article><b>Confirmed interaction</b><p>An MCP tool was used or an HTTP receipt returned with a review.</p></article>
          <article><b>Optional session</b><p>Continuity exists only when your product or MCP provides proof. We never infer an agent identity.</p></article>
        </div>
      </section>

      <footer>
        <span>AGENT FEEDBACK</span>
        <a href={`${dashboard}/auth/start`}>Sign in →</a>
      </footer>
    </main>
  );
}
