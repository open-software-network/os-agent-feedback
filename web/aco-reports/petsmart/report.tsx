import { IconMinusMedium } from "central-icons/IconMinusMedium";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import Image from "next/image";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * PetSmart ACO (AI Commerce Optimization) Report — the page content served at
 * /aco-report/petsmart once the report password is unlocked. Styled with the
 * app's components and design tokens; screenshots live in ./assets and are
 * served through the gated asset route.
 */

const asset = (name: string) => `/aco-report/petsmart/assets/${name}`;

/**
 * Screenshots are served through the gated asset route, which requires the
 * report cookie — so they must render unoptimized (the Next.js image
 * optimizer would fetch them server-side without the cookie and get a 401).
 * Dimensions are the checked-in PNGs', so the layout holds while they load.
 */
const shot = (name: string, width = 2760, height = 1800) => ({
  src: asset(name),
  width,
  height,
});

type Shot = ReturnType<typeof shot>;

type Signal = {
  key: string;
  value: string;
  provenance: string;
  confidence: string;
  note: string;
};

type Beat = {
  img?: Shot;
  url?: string;
  kicker: string;
  title: string;
  body: string;
  reply?: string;
  replyLink?: string;
  panel?: Signal[];
  panelFooter?: string;
};

type Journey = {
  id: string;
  tab: string;
  lede: string;
  prompt: string;
  beats: Beat[];
};

const journeys: Journey[] = [
  {
    id: "direct",
    tab: "Journey 1 · Direct ask",
    lede: "The customer asks their agent to shop PetSmart by name.",
    prompt:
      "Hey, we need a new feeder for our pets. We have two 3-year-old cats and a dog, and one of the cats is SUPER food-motivated — she finishes her bowl in seconds and then pushes the others out of the way and eats their food too. It's becoming a real problem, the other two are losing weight. We'd like to stay around $200. Can you look at PetSmart and find something that would actually work for us?",
    beats: [
      {
        img: shot("1-agent-guide.png"),
        url: "petsmart demo /  ·  User-Agent: Claude-User/1.0",
        kicker: "The crawl",
        title: "The agent fetches the storefront and gets a machine-readable graph",
        body: "Given only the prompt and the store URL, the agent fetched the homepage with an honest agent User-Agent and received the experience guide instead of HTML — an entry into the need-negotiation graph, with the traversal rules spelled out. It followed them exactly: nine URLs opened, every one supplied by the merchant, none constructed.",
      },
      {
        img: shot("real-2-decision.png"),
        url: "…/agent-decide/j-10c8e60e…/feeder/consider-pets/pets-cats-and-dog/motivation-one-food-motivated/budget-target-200/priority-functional-fit",
        kicker: "Disclosure and ranking",
        title: "It disclosed four needs — and chose their strengths itself",
        body: "The agent expressed pets-cats-and-dog and motivation-one-food-motivated as hard constraints (the customer's own words), encoded the budget as a $200 target rather than a ceiling because the customer said “around $200”, and inferred priority-functional-fit from “something that would actually work”. The merchant ranked one exact match — the SmartTag RFID Multi-Pet Feeder, every dimension backed by catalog evidence — and five near misses, each with the constraint it violates.",
      },
      {
        kicker: "The recommendation",
        title: "The customer gets their answer — with the product link inside",
        body: "The agent's reply is grounded entirely in the merchant's evidence: the one exact match, why it solves the food-stealing problem, and why the runner-up fails. The link it hands over is an ordinary product page URL, carrying the journey reference.",
        reply:
          "I found a strong fit at PetSmart: the PetSafe SmartTag RFID Multi-Pet Feeder at $189.99, comfortably within your $200 budget. Each pet wears a small RFID collar tag, and the feeder's locking lid only opens for the pet assigned to that station — so your food-motivated cat physically can't push in and finish the others' meals. It supports per-pet portion schedules and two-station feeding, and it's built for households with both cats and dogs. It was the only feeder in their catalog that matched every one of your needs; the closest alternative (SureFeed Microchip) is cats-only and wouldn't cover your dog. Take a look at the product page here and see if it feels right:",
        replyLink: "…/product/smarttag-rfid-multi-pet-feeder?journey=j-10c8e60e…",
      },
      {
        img: shot("real-7-customer.png", 3000, 1880),
        url: "epode dashboard  ·  Customers → Bubbly Raven",
        kicker: "Now you know them",
        title: "PetSmart now has that information — as a customer record",
        body: "The household's traits arrive as structured signals — no permission round-trip, each value labeled with where it came from and how sure the agent is. In the dashboard they live on a customer record: “Bubbly Raven” is an auto-generated label for the shopper's anonymous first-party browser ID (nobody knows their name), with the agent journey and the browser visit linked to it. Just as telling is what the agent chose not to send: it could have inferred pet.life_stage from “3-year-old cats”, and withheld it on its own judgment.",
        panel: [
          {
            key: "pet.household_mix",
            value: "cats_and_dog",
            provenance: "agent_reports_user_statement",
            confidence: "0.98",
            note: "the customer said it outright — marked remembered: a durable household fact",
          },
          {
            key: "pet.food_motivation",
            value: "one_food_motivated",
            provenance: "agent_reports_user_statement",
            confidence: "0.98",
            note: "the core problem, in the customer's words — marked remembered",
          },
        ],
        panelFooter:
          "Values are constrained to the merchant-defined catalog, so prompts, transcripts, and PII are impossible by schema. Queryable in the API and ready for warehouse export.",
      },
      {
        img: shot("real-3-click.png"),
        url: "…/product/smarttag-rfid-multi-pet-feeder?journey=j-10c8e60e…",
        kicker: "The click",
        title: "The customer opens the link — PetSmart drops its cookie and session",
        body: "Opening the product page mints the signed first-party ps_visitor and ps_session cookies and ties them to the agent journey — the moment anonymous AI traffic becomes the first-party identity behind that customer record. The page carries Epode's customer-context contract, already submit-ready with the field catalog inline; the agent answers through PetSmart's own origin in the same breath.",
      },
      {
        img: shot("real-4-return.png"),
        url: "petsmart demo /  ·  same browser, later",
        kicker: "The payoff",
        title: "Next visit, the homepage knows the household",
        body: "Same URL that served an anonymous grid an hour earlier — but this visitor's cookie now resolves to stored context. The hero greets the two-cats-and-a-dog household and features the feeder; a personalization decision is recorded against the retrieved signals. The customer clicked through and hit Add to cart — a conversion outcome recorded against that decision.",
      },
      {
        img: shot("real-6-journey.png", 3000, 1880),
        url: "epode dashboard  ·  Sessions → session-27280e04",
        kicker: "The journey",
        title: "The agent's crawl as a session timeline — with real think-time",
        body: "session-27280e04 is the agent's journey: ten steps from /agent-guide through the negotiation hops to the /product/feeder click, attributed to Bubbly Raven. The offsets between steps are the agent genuinely reading each response before choosing the next edge — this is observed traffic, not a replay.",
      },
    ],
  },
  {
    id: "listing",
    tab: "Journey 2 · Found a listing",
    lede: "The customer never names PetSmart — a PetSmart listing surfaced in their own search, and they ask if it would work.",
    prompt:
      "We need an automatic feeder. We have two 3-year-old cats and a dog, and one of the cats is SUPER food-motivated — she finishes hers in seconds and then raids everyone else's bowls; the other two are losing weight. I was searching around and this PetSmart one came up — would it actually work for us? …/product/petlibro-wifi-camera-feeder — around $200 is fine if we need to spend more.",
    beats: [
      {
        img: shot("j2-1-listing.png"),
        url: "petsmart demo /product/petlibro-wifi-camera-feeder  ·  User-Agent: Claude-User/1.0",
        kicker: "The listing entry",
        title: "The agent lands on the product page — and gets the graph, not HTML",
        body: "Same product URL a human would open, but the agent's honest User-Agent gets the machine-readable item node: catalog facts, the seller's marketing claim kept attributed and unverified, and an evaluation graph starting right here. No cookies are minted for agents — identities belong to human browsers. This is reverse traversal: the storefront home was never visited.",
      },
      {
        img: shot("j2-2-fit.png"),
        url: "…/agent-product/j-fb217ab1…/petlibro-wifi-camera-feeder/…/evaluate-fit",
        kicker: "Reverse traversal",
        title: "The graph answers the customer's actual question: unsuitable",
        body: "The agent expressed the household from the item — cats and a dog, one food-motivated eater, $200 target — and asked for the fit verdict. The merchant's own catalog answers honestly: hard conflict on pets (this feeder is listed for one-cat or one-dog homes), food-stealing prevention not specified, and the only match is price. The verdict is “unsuitable”, with every line backed by catalog evidence — the merchant tells the truth about its own product.",
      },
      {
        img: shot("j2-3-alternatives.png"),
        url: "…/agent-product/j-fb217ab1…/petlibro-wifi-camera-feeder/…/alternatives",
        kicker: "The redirect",
        title: "Alternatives rank the right product for the same needs",
        body: "A non-suitable verdict unlocks alternatives, ranked against the same expressed needs. The SmartTag RFID Multi-Pet Feeder is the only zero-conflict option (utilityScore 12); every other feeder is excluded with the exact household or motivation conflict it fails on. The wrong-product entry didn't lose the sale — the graph redirected it.",
      },
      {
        kicker: "The recommendation",
        title: "The customer's question gets answered first — then the better option",
        body: "The agent leads with the verdict on the product the customer actually asked about, evidence attached, then hands over the alternative's ordinary product link.",
        reply:
          "I checked the Petlibro feeder you found against PetSmart's own catalog data, and it isn't a fit for your house: it's listed for single-cat or single-dog homes, and its camera and app scheduling only control when food drops — nothing in its specs stops your food-motivated cat from raiding the other bowls, which is your actual problem. The strong match at PetSmart is the PetSafe SmartTag RFID Multi-Pet Feeder at $189.99, comfortably under your $200. It's cataloged specifically for cats-plus-dog households with one food-motivated pet: each pet's RFID collar tag opens only their own station, a locking lid is designed to block food stealing, and per-pet portion schedules let you make sure your two slimmer pets actually get (and finish) their share. It was the only option in the catalog with zero conflicts against your needs — the SureFeed microchip feeder, for example, is cats-only. Here's the product page if you'd like to take a look:",
        replyLink: "…/product/smarttag-rfid-multi-pet-feeder?journey=j-fb217ab1…",
      },
      {
        img: shot("j2-4-journey.png", 3000, 1880),
        url: "epode dashboard  ·  Sessions → session-acd3efea",
        kicker: "The journey",
        title: "The dashboard shows the whole arc — listing entry to click",
        body: "session-acd3efea starts at /product/feeder-agent (the listing the customer found) and walks the /agent-product evaluation hops to the /product/feeder click, attributed to customer “Daring Tiger”. From the click on, this journey converges with Journey 1 — cookie and session minted, both traits reported and remembered, the return visit personalized, and an Add-to-cart conversion recorded. Same discoverable customer, reached through a completely different door.",
      },
    ],
  },
];

function Kicker({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}

function ChatBubble({
  who,
  tone,
  link,
  children,
}: {
  who: string;
  tone: "user" | "agent";
  link?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "max-w-2xl rounded-lg px-4 py-3 text-sm leading-6 ring-1",
        tone === "user" ? "bg-muted ring-foreground/5" : "bg-card ring-foreground/10",
      )}
    >
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {who}
      </span>
      {children}
      {link ? (
        <code className="mt-2 block break-all font-mono text-xs text-muted-foreground">{link}</code>
      ) : null}
    </div>
  );
}

function BrowserFrame({ url, img, title }: { url: string; img: Shot; title: string }) {
  return (
    <figure className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <figcaption className="flex items-center gap-3 border-b bg-muted/50 px-3 py-2">
        <span className="flex flex-none gap-1.5">
          <i className="block size-2 rounded-full bg-foreground/15" />
          <i className="block size-2 rounded-full bg-foreground/15" />
          <i className="block size-2 rounded-full bg-foreground/15" />
        </span>
        <code className="truncate font-mono text-[11px] text-muted-foreground">{url}</code>
      </figcaption>
      <Image
        src={img.src}
        alt={title}
        width={img.width}
        height={img.height}
        unoptimized
        className="block h-auto w-full"
      />
    </figure>
  );
}

function SignalPanel({ signals, footer }: { signals: Signal[]; footer?: string }) {
  return (
    <div className="max-w-3xl rounded-lg border bg-card px-4 py-1">
      {signals.map((signal) => (
        <div
          key={signal.key}
          className="grid gap-x-4 gap-y-0.5 border-b py-3 last:border-b-0 sm:grid-cols-[11.5rem_9rem_1fr] sm:items-baseline"
        >
          <code className="font-mono text-xs font-medium">{signal.key}</code>
          <code className="font-mono text-xs">{signal.value}</code>
          <span className="font-mono text-[11px] text-muted-foreground">
            {signal.provenance} · confidence {signal.confidence}
          </span>
          <span className="text-xs leading-5 text-muted-foreground sm:col-span-3">
            {signal.note}
          </span>
        </div>
      ))}
      {footer ? (
        <p className="border-t py-3 text-xs leading-5 text-muted-foreground">{footer}</p>
      ) : null}
    </div>
  );
}

function BeatSection({ beat, index }: { beat: Beat; index: number }) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-start gap-3">
        <span className="mt-1 grid size-7 flex-none place-items-center rounded-full border border-foreground/20 font-mono text-xs tabular-nums">
          {index + 1}
        </span>
        <div className="grid gap-1">
          <Kicker>{beat.kicker}</Kicker>
          <h2 className="text-balance font-heading text-xl font-medium tracking-tight md:text-2xl">
            {beat.title}
          </h2>
        </div>
      </header>
      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{beat.body}</p>
      {beat.reply ? (
        <ChatBubble who="Agent → customer (verbatim reply)" tone="agent" link={beat.replyLink}>
          {beat.reply}
        </ChatBubble>
      ) : null}
      {beat.panel ? <SignalPanel signals={beat.panel} footer={beat.panelFooter} /> : null}
      {beat.img && beat.url ? (
        <BrowserFrame url={beat.url} img={beat.img} title={beat.title} />
      ) : null}
    </section>
  );
}

function JourneyPanel({ journey }: { journey: Journey }) {
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-4">
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{journey.lede}</p>
        <ChatBubble who="Customer → agent" tone="user">
          {journey.prompt}
        </ChatBubble>
      </div>
      {journey.beats.map((beat, index) => (
        <BeatSection key={beat.title} beat={beat} index={index} />
      ))}
    </div>
  );
}

const beforePoints = [
  "Agent visits look like scraping — no journey, no intent, no session",
  "The agent guesses fit from marketing copy; the wrong product gets recommended, and the sale (or the return) is yours either way",
  "A click-through lands an anonymous visitor; nothing the agent learned survives the handoff",
  "Next visit, the shopper is a stranger again",
  "Agent-assisted revenue is invisible in attribution",
];

const afterPoints = [
  "Every agent visit is a structured journey — the expressed needs (pet mix, food motivation, budget) on a step-by-step timeline",
  "Ranking runs on your catalog evidence; a wrong-product entry gets redirected to the right product instead of a lost sale",
  "One click mints a first-party identity, and the household's traits arrive as provenance-labeled signals on a customer record",
  "Return visits personalize from stored context — decisions recorded against the exact signals used",
  "Conversions attribute back to the agent journey; everything exports to your warehouse",
];

function CompareCard({
  title,
  points,
  tone,
}: {
  title: string;
  points: string[];
  tone: "before" | "after";
}) {
  const after = tone === "after";
  return (
    <div className={cn("rounded-lg border bg-card p-4", after && "border-foreground/25 shadow-sm")}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-heading text-base font-medium">{title}</h3>
        {after ? <Badge variant="attention">Epode</Badge> : null}
      </div>
      <ul className="flex flex-col">
        {points.map((point) => (
          <li
            key={point}
            className={cn(
              "flex gap-2 border-t py-2.5 text-sm leading-5 first:border-t-0",
              !after && "text-muted-foreground",
            )}
          >
            {after ? (
              <IconPlusMedium className="mt-0.5 size-4 flex-none" />
            ) : (
              <IconMinusMedium className="mt-0.5 size-4 flex-none text-muted-foreground" />
            )}
            <span>{point}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PetsmartAcoReport() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-12 px-5 py-10 md:py-14">
      <header className="flex flex-col gap-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="flex items-center gap-2 font-heading text-lg font-medium tracking-tight">
            PetSmart ×
            <Image
              src="/epode-logo.svg"
              alt="Epode"
              width={56}
              height={13}
              className="dark:invert"
            />
          </span>
          <Kicker>AI Commerce Optimization Report · 2026-08-06</Kicker>
        </div>
        <h1 className="max-w-3xl text-balance font-heading text-3xl font-medium tracking-tight md:text-4xl">
          AI agents are already shopping PetSmart. Right now, they leave nothing behind.
        </h1>
      </header>

      <section className="flex flex-col gap-3">
        <Kicker>1 · The narrative</Kicker>
        <p className="max-w-2xl text-base leading-7">
          A growing share of PetSmart traffic isn't people — it's ChatGPT and Claude, shopping on a
          customer's behalf. Today that visit looks like anonymous scraping: the agent reads
          marketing copy, makes its best guess, answers the customer somewhere you can't see, and
          disappears. You don't learn what the household needed, you can't tell whether you won or
          lost the recommendation, and if the shopper ever clicks through, they arrive as a
          stranger.
        </p>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Epode gives the agent a machine-readable version of the storefront that negotiates like
          your best associate would — asking what the household actually needs and answering from
          catalog truth. In exchange, PetSmart gets the whole story: the needs, the journey, a
          first-party customer, and the sale — measured.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <Kicker>2 · Before and after</Kicker>
        <div className="grid gap-4 md:grid-cols-2">
          <CompareCard title="Without Epode" points={beforePoints} tone="before" />
          <CompareCard title="With Epode" points={afterPoints} tone="after" />
        </div>
        <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
          Both runs below ended the same way: a customer record with remembered traits, a
          personalized return visit, and an attributed conversion — reached through two different
          doors.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <Kicker>3 · The how — two real journeys</Kicker>
        <p className="max-w-2xl text-base leading-7">
          Each journey started as a customer message handed to a real Claude agent — nothing else.
          One asks for PetSmart by name; the other found a PetSmart listing on their own and asks
          whether it would work. Everything shown is what actually happened; the customer's browser
          is driven by a script, every decision is the agent's own.
        </p>
      </section>

      <Tabs defaultValue={journeys[0].id}>
        <TabsList variant="line" className="sticky top-0 z-10 w-full justify-start bg-background">
          {journeys.map((journey) => (
            <TabsTab key={journey.id} value={journey.id} className="flex-none">
              {journey.tab}
            </TabsTab>
          ))}
        </TabsList>
        {journeys.map((journey) => (
          <TabsPanel key={journey.id} value={journey.id} className="pt-6">
            <JourneyPanel journey={journey} />
          </TabsPanel>
        ))}
      </Tabs>

      <footer className="border-t pt-6 text-sm leading-6 text-muted-foreground">
        Reproduce it: <code className="font-mono text-xs">examples/petsmart-demo/README.md</code> —
        the storefront, both agent journeys, and the live dashboard, offline in two commands or live
        with <code className="font-mono text-xs">make dev-backend</code>.
      </footer>
    </main>
  );
}
