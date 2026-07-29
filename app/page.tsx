import {
  Activity,
  ArrowRight,
  Boxes,
  Check,
  Lock,
  MessageSquare,
  ShieldCheck,
  Terminal,
} from "lucide-react";

import { CodePanel } from "./components/code-panel";
import { Badge } from "./components/ui/badge";
import { ButtonLink } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { Separator } from "./components/ui/separator";

const dashboard = "https://app.epode.ai";

const container = "mx-auto w-full max-w-6xl px-6";
const eyebrow =
  "text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground";
const sectionTitle =
  "text-3xl font-semibold tracking-tight text-balance sm:text-4xl";

const expressCode = `import { agentFeedback } from "@agent-feedback/node/express";

app.use(agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  include: ["/search", "/docs/*"],
  customerRef: (req) => req.user?.accountId, // optional opaque ID
}));`;

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

const steps = [
  {
    icon: Terminal,
    title: "Your product responds",
    description:
      "The SDK adds a two-hour, write-only receipt locally. Your response never waits for us.",
  },
  {
    icon: Boxes,
    title: "The customer’s agent uses it",
    description:
      "HTTP begins as an opportunity. MCP tool use is confirmed immediately.",
  },
  {
    icon: MessageSquare,
    title: "The agent reviews the outcome",
    description:
      "One short result: success, partial, or failure, plus a sentence explaining why.",
  },
];

const integrationPoints = [
  "No agent identity or Agent Feedback account required",
  "No blocking call on the product response path",
  "No prompts, transcripts, credentials, or raw payloads accepted",
  "Node, Python, Go, Rust, and MCP adapters use the same contract",
  "Every other stack can implement the small public HTTP protocol",
];

const languages = [
  {
    name: "Node",
    description: "Express and Fastify middleware plus MCP instrumentation.",
  },
  {
    name: "Python",
    description:
      "ASGI for FastAPI, Starlette, Quart, and Django; WSGI for Flask and Django.",
  },
  {
    name: "Go",
    description: (
      <>
        Standard{" "}
        <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground">
          net/http
        </code>{" "}
        middleware compatible with routers built on it.
      </>
    ),
  },
  {
    name: "Rust",
    description: "An Axum/Tower layer with bounded, non-blocking telemetry.",
  },
  {
    name: "Anything else",
    description:
      "Use the language-neutral protocol and shared conformance vector.",
  },
];

const evidence = [
  {
    icon: Activity,
    title: "Opportunity",
    description: "An eligible HTTP response carried feedback instructions.",
  },
  {
    icon: ShieldCheck,
    title: "Confirmed interaction",
    description:
      "An MCP tool was used or an HTTP receipt returned with a review.",
  },
  {
    icon: Lock,
    title: "Optional session",
    description:
      "Continuity exists only when your product or MCP provides proof. We never infer an agent identity.",
  },
];

function Logo() {
  return (
    <span className="flex size-6 items-center justify-center rounded-md bg-primary text-[10px] font-semibold tracking-tight text-primary-foreground">
      AF
    </span>
  );
}

export default function Home() {
  return (
    <div id="top" className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 border-b border-border bg-background/75 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
        <nav
          aria-label="Primary"
          className={`${container} flex h-14 items-center justify-between gap-4`}
        >
          <a
            href="#top"
            className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Logo />
            <span className="text-sm font-semibold tracking-tight">
              Agent Feedback
            </span>
          </a>

          <div className="flex items-center gap-1.5 sm:gap-3">
            <ButtonLink
              variant="ghost"
              size="sm"
              className="hidden text-muted-foreground hover:text-foreground sm:inline-flex"
              href={`${dashboard}/.well-known/agent-feedback-v1.json`}
            >
              Protocol
            </ButtonLink>
            <ButtonLink size="sm" href={`${dashboard}/auth/start`}>
              Open dashboard
            </ButtonLink>
          </div>
        </nav>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-border">
          <div
            aria-hidden="true"
            className="hero-glow pointer-events-none absolute inset-0"
          />
          <div
            aria-hidden="true"
            className="grid-faint pointer-events-none absolute inset-x-0 top-0 h-[30rem]"
          />

          <div className={`${container} relative pb-16 pt-20 md:pb-24 md:pt-28`}>
            <div className="max-w-3xl">
              <Badge
                variant="outline"
                className="rounded-full px-3 py-1 text-[11px] font-medium text-muted-foreground"
              >
                <Activity className="text-foreground/60" />
                Outcome feedback from customer agents
              </Badge>

              <h1 className="mt-6 text-balance text-[clamp(2.5rem,6vw,4.25rem)] font-semibold leading-[1.05] tracking-[-0.035em]">
                Did your product actually work for your customer&apos;s agent?
              </h1>

              <p className="mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
                Instrument your API, MCP server, or agent-readable website
                once—in the language you already use. MCP exposes an explicit
                outcome tool; HTTP offers a compact receipt that feedback-aware
                runtimes can submit.
              </p>

              <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
                <ButtonLink size="lg" href={`${dashboard}/auth/start`}>
                  Set up a product
                  <ArrowRight />
                </ButtonLink>
                <ButtonLink variant="outline" size="lg" href="#integration">
                  See the integration
                </ButtonLink>
              </div>

              <p className="mt-6 text-sm text-muted-foreground">
                One global middleware. No handler changes, no relay endpoint, no
                agent account.
              </p>
            </div>

            <div className="mt-14 md:mt-16">
              <CodePanel filename="server.ts" code={expressCode} />
            </div>
          </div>
        </section>

        {/* How it works */}
        <section aria-labelledby="how-it-works" className={`${container} py-20 md:py-24`}>
          <p className={eyebrow}>How it works</p>
          <h2 id="how-it-works" className={`${sectionTitle} mt-3 max-w-2xl`}>
            Three steps, and none of them sit on your response path.
          </h2>

          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {steps.map((step, index) => {
              const Icon = step.icon;
              return (
                <Card key={step.title} className="h-full gap-4">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted/60 text-muted-foreground">
                        <Icon className="size-4" />
                      </span>
                      <span className="text-sm font-medium tabular-nums text-muted-foreground/70">
                        0{index + 1}
                      </span>
                    </div>
                    <CardTitle className="mt-4">{step.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CardDescription>{step.description}</CardDescription>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>

        {/* Integration */}
        <section
          id="integration"
          className="border-y border-border bg-muted/30"
          aria-labelledby="integration-title"
        >
          <div className={`${container} py-20 md:py-24`}>
            <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
              <div>
                <p className={eyebrow}>One-time setup</p>
                <h2 id="integration-title" className={`${sectionTitle} mt-3`}>
                  Use any backend. Keep every handler unchanged.
                </h2>
                <p className="mt-5 max-w-xl text-pretty leading-relaxed text-muted-foreground">
                  Select the routes where agent feedback is useful. Customer
                  grouping is optional and comes from authentication your
                  product already has.
                </p>

                <ul className="mt-8 space-y-3.5">
                  {integrationPoints.map((point) => (
                    <li key={point} className="flex items-start gap-3">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-xs">
                        <Check className="size-3" strokeWidth={2.75} />
                      </span>
                      <span className="text-sm leading-relaxed text-muted-foreground">
                        {point}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <CodePanel filename="adapters.txt" code={protocolCode} />
            </div>
          </div>
        </section>

        {/* Languages */}
        <section aria-labelledby="languages-title" className={`${container} py-20 md:py-24`}>
          <p className={eyebrow}>Protocol first</p>
          <h2 id="languages-title" className={`${sectionTitle} mt-3 max-w-2xl`}>
            One receipt contract. Every product stack.
          </h2>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {languages.map((language) => (
              <Card key={language.name} className="h-full gap-3 py-5">
                <CardHeader className="px-5">
                  <CardTitle className="text-sm">{language.name}</CardTitle>
                </CardHeader>
                <CardContent className="px-5">
                  <CardDescription className="text-[13px]">
                    {language.description}
                  </CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* The whole review */}
        <section
          aria-labelledby="review-title"
          className="border-y border-border bg-muted/30"
        >
          <div className={`${container} py-20 md:py-24`}>
            <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
              <div>
                <p className={eyebrow}>The whole review</p>
                <h2 id="review-title" className={`${sectionTitle} mt-3`}>
                  Small enough for an agent. Structured enough for product
                  decisions.
                </h2>
                <p className="mt-5 max-w-xl text-pretty leading-relaxed text-muted-foreground">
                  Two fields, submitted after the agent knows what happened. No
                  prompts, no transcripts, no payloads — just the outcome and
                  one sentence of reasoning you can act on.
                </p>
                <div className="mt-7 flex flex-wrap gap-2">
                  <Badge
                    variant="secondary"
                    className="border-success-border bg-success-bg text-success"
                  >
                    success
                  </Badge>
                  <Badge
                    variant="secondary"
                    className="border-warning-border bg-warning-bg text-warning"
                  >
                    partial
                  </Badge>
                  <Badge
                    variant="secondary"
                    className="border-danger-border bg-danger-bg text-danger"
                  >
                    failure
                  </Badge>
                </div>
              </div>

              <CodePanel filename="review.json" code={review} />
            </div>
          </div>
        </section>

        {/* Evidence */}
        <section aria-labelledby="evidence-title" className={`${container} py-20 md:py-24`}>
          <p className={eyebrow}>Evidence, not inference</p>
          <h2 id="evidence-title" className={`${sectionTitle} mt-3 max-w-2xl`}>
            We report what is proven—not what is guessed.
          </h2>

          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {evidence.map((item) => {
              const Icon = item.icon;
              return (
                <Card key={item.title} className="h-full gap-4">
                  <CardHeader>
                    <span className="flex size-9 shrink-0 items-center justify-center self-start rounded-lg border border-border bg-muted/60 text-muted-foreground">
                      <Icon className="size-4" />
                    </span>
                    <CardTitle className="mt-4">{item.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CardDescription>{item.description}</CardDescription>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>

        {/* Final CTA */}
        <section className="border-t border-border bg-muted/30">
          <div className={`${container} py-20 md:py-24`}>
            <Card className="relative overflow-hidden py-0">
              <div
                aria-hidden="true"
                className="hero-glow pointer-events-none absolute inset-0"
              />
              <CardContent className="relative flex flex-col items-center gap-6 px-6 py-16 text-center">
                <h2 className={`${sectionTitle} max-w-2xl`}>
                  Find out what your customers&apos; agents actually
                  experienced.
                </h2>
                <p className="max-w-xl text-pretty leading-relaxed text-muted-foreground">
                  Instrument one product, pick a few routes, and start reading
                  real outcomes instead of guessing from logs.
                </p>
                <ButtonLink size="lg" href={`${dashboard}/auth/start`}>
                  Set up a product
                  <ArrowRight />
                </ButtonLink>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className={`${container} py-12`}>
          <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2.5">
              <Logo />
              <span className="text-sm font-semibold tracking-tight">
                Agent Feedback
              </span>
            </div>
            <div className="flex items-center gap-5 text-sm text-muted-foreground">
              <a
                className="transition-colors hover:text-foreground"
                href={`${dashboard}/.well-known/agent-feedback-v1.json`}
              >
                Protocol
              </a>
              <a
                className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
                href={`${dashboard}/auth/start`}
              >
                Sign in
                <ArrowRight className="size-3.5" />
              </a>
            </div>
          </div>
          <Separator className="my-8" />
          <p className="text-xs text-muted-foreground">
            Outcome feedback from customer agents. No prompts, transcripts, or
            credentials are ever collected.
          </p>
        </div>
      </footer>
    </div>
  );
}
