# Aangan Studio: phone enquiry agent

This agent answers Aangan Studio's inbound phone enquiries 24/7. It qualifies each caller against the studio's five criteria. Then it does one of four things:

- books a consultation and sends the designer a handoff note
- declines the caller gracefully
- escalates the call to the studio head
- queues a callback

The agent never quotes a price.

```
phone ─► Vaani (vaanivoice.ai: telephony, STT/TTS, Hindi + English)
        │  BYOL WebSocket, one per call ──► server/vaani-ws.ts (always-on call server)
        │  call-event webhooks ───────────► Vercel /api/voice/vaani (caller number, missed-call safety net)
        ▼
adapters/voice/vaani.ts ──► core/ (channel-agnostic) ──► adapters/actions.ts
                              load context                 ├─ handoff: Telegram (primary) + Resend email
                              NLU (Gemini | rules)         ├─ booking: Cal.com prefilled link
                              policy decides next step     └─ store: Supabase (enquiries, turns,
                              NLG words it (Gemini | tmpl)        qualifications, handoffs, bookings,
                              PRICING GUARDRAIL (hard)            callbacks, cost)
                              classify outcome                         │
                              build handoff note                       ▼
                              emit actions                  app/ dashboard (Next.js)
```

The **brain is separate from the channel.** `core/` takes a normalized `Enquiry` and has no knowledge of telephony, Telegram or Supabase. To add WhatsApp or a web form later, you write one new adapter that produces `Enquiry` turns and calls `Session.onCallerTurn()` / `finalize()`. The Vaani adapter is about 100 lines and is the template for that.

## Live deployment

- Dashboard: https://aangan-studio-five.vercel.app (basic auth; password is `DASHBOARD_PASSWORD`)
- Vaani call-event webhook: `https://aangan-studio-five.vercel.app/api/voice/vaani?token=<VAANI_WEBHOOK_SECRET>`
- Vaani call server (BYOL WebSocket): `npm run voice-server`. This needs an always-on host or a tunnel; see step 7 below.
- Every push to `main` auto-deploys (Vercel project `aangan-studio`, region `bom1`).

## Quick start (no keys needed)

```bash
npm install
```

```bash
npm test
```

```bash
npm run harness -- --all
```

```bash
npm run harness -- T13
```

```bash
npm run chat -- --rules
```

```bash
npm run dev
```

Each command:

- `npm test` runs 94 tests: T01–T20, the guardrail, Hinglish, actions, voice and metrics.
- `npm run harness -- --all` replays every transcript and shows its outcome against its label.
- `npm run harness -- T13` shows one call in full: generated conversation, criteria, outcome, handoff note and actions.
- `npm run chat -- --rules` lets you be the caller in your terminal. Drop `--rules` to use Gemini once a key is set.
- `npm run dev` starts the dashboard. Without Supabase it replays T01–T20 in demo mode.

## How the rules are enforced

| Rule | Where | How |
|---|---|---|
| **Never quote pricing** | `core/guardrail.ts` | A hard check runs over *every* agent reply after the model. If the caller's turn is a pricing question, the reply is replaced with the scripted deflection from `pricing.md`, word for word, whatever the model wrote. Any other reply containing ₹/Rs/lakh/crore, a per-sq-ft rate, a number range, a `pricing.md` figure or "it'll cost around / rates start at / typically" is also replaced. Handoff notes go through the same scan (`assertNoPricing`). `pricing.md` is never put in the model prompt, and money figures are redacted from the other files before they reach the model. A test runs all 20 calls with a deliberately leaky model; no price reaches a caller. |
| **Five criteria + boundary rules** | `core/qualify.ts`, `core/policy.ts` | These are deterministic. The model extracts facts; code decides the outcome. If criteria 1, 2 or 3 are unclear, the agent asks **one** direct question per criterion and never repeats it. If criterion 4 or 5 is unclear, the lead counts as qualified and the uncertainty goes in the note. The agent never probes for budget. A volunteered budget is checked internally against `pricing.md` floors, and is flagged only when it is under 50% of the floor ("clearly too low"). Any failed criterion means a decline. Two or more failures use the rubric's generic wording. |
| **Outcomes** | `core/session.ts` (`classify`, `finalize`) | **QUALIFIED:** book plus handoff. **DECLINED:** studio wording per reason. **ESCALATED:** studio head, 15-minute callback. **CALLBACK:** missed or dropped calls are queued for the next business opening. A recovery flag (T16) means: book directly and mark "handle with care". |
| **Never a dead end** | tests | Every outcome carries a `nextStep` and at least one action. This is asserted for all 21 calls. |
| **Source of truth** | `knowledge/` | `npm run knowledge` embeds the markdown into `core/knowledge/generated.ts`, and a test fails if that copy goes stale. The service-area lists, deflection wording and multi-fail wording are all *parsed* from the files. |

### Results on the September transcripts (rules brain)

21 of 21 calls match the brief's labels (T17 counts as two calls). T02 and T13 get the exact deflection on both of their pricing questions, and both still book. Run `npm run harness -- --all`, or `npm run eval:live` to run the same set through Gemini.

**With Gemini (`gemini-3.5-flash-lite`, run on 10 Oct 2026):** 21 of 21 match, with 0 model fallbacks and 0 prices reaching a caller. Each call cost about ₹0.38, at about 2.7 s per caller turn (extract + reply). Prices are from third-party listings ($0.30 / $2.50 per 1M tokens); confirm them on Google's pricing page.

A volunteered budget ("my budget is X, is that possible?") is treated as a budget-sanity turn (qualified.md §4), not a pricing question. The agent addresses it without echoing the figure, and the guardrail still blocks any number.

Judgement calls I made where the files leave room:
- **Minimum completion window = 10 weeks.** This comes from qualified.md ("8–10 weeks") and T07's front desk. Diwali 2026 is 8 November, about 9 weeks after T07's 8 September call, so T07 fails on timeline and is offered a November start plus a scheduled follow-up.
- **Commercial minimum = 500 sq ft.** This comes from T18's front-desk wording; services.md doesn't state one.
- **Kharadi (T10) counts as an adjoining Pune area.** services.md says "and adjoining areas" without listing them. The list in `core/knowledge/index.ts` is editable, and handoff notes mark adjoining areas "please confirm".
- **When 1/2/3 stay unclear after the one question, the agent books and lists them as UNCERTAIN in the note.** It does not decline. This is how T11, T13, T14 and T16 reach the brief's QUALIFIED outcome.
- **Business hours = Mon–Sat 10am–7pm IST**, which drives the after-hours split. Change it in `core/config.ts`.
- **Hinglish deflection.** The rule allows only the English deflection, so I added a Hinglish translation (`PRICING_DEFLECTION_HINGLISH`) with the same meaning and no figures. **The studio should sign off on that wording.**
- **Strict pricing rule beats the decline flow.** If an already-declined caller asks "how much?", the reply is still the deflection, even though it offers to book. I chose the non-negotiable rule over conversational smoothness.

## Live setup

1. **Env.** Copy `.env.example` to `.env.local`, or to Vercel project env vars. Everything below is optional; each missing piece degrades to a stub.
2. **Gemini.** Set `GEMINI_API_KEY`. The default model is `gemini-3.5-flash-lite`: about 1 s per call with no hidden "thinking". `gemini-3.8-flash` measured about 4 s per call, which is too slow for a phone turn. `gemini-2.5-*` is closed to new accounts. The ₹ cost uses `GEMINI_USD_PER_M_INPUT/OUTPUT` and `USD_TO_INR`, so check current pricing. Each caller turn makes 2 small calls (extract + word), with a 4-second timeout that falls back to the rules brain.
3. **Supabase.** Create a project, then run `supabase/migrations/0001_init.sql` in the SQL editor. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (server-only; RLS is on with no policies).
4. **Telegram.** Create a bot with @BotFather and set `TELEGRAM_BOT_TOKEN`. Add the bot to the designers' group and set `TELEGRAM_DESIGNER_CHAT_ID`. Optionally set `TELEGRAM_STUDIO_HEAD_CHAT_ID` for escalations; otherwise escalations go to the designer chat.
5. **Resend.** Set `RESEND_API_KEY`, `HANDOFF_EMAIL_TO` and `STUDIO_HEAD_EMAIL`. You need a verified sending domain for `HANDOFF_EMAIL_FROM`; otherwise Resend only delivers to your own address.
6. **Cal.com.** Set `CALCOM_BOOKING_URL` to the consultation event page. Links are prefilled with name, phone and notes. On the event's **Booking form**, set Confirmation to **Phone**. This makes the built-in `attendeePhoneNumber` question required, and links prefill it.
7. **Vaani** (vaanivoice.ai; protocol from docs.vaanivoice.ai, *Bring Your Own LLM* and *Webhook Setup*):
   - **Call server.** Vaani's BYOL holds a WebSocket open for the whole call, and Vercel can't host that, so `server/vaani-ws.ts` runs separately.
     - **To test for free:** run `npm run voice-server` on your Mac and expose port 8787 with a tunnel (`cloudflared tunnel --url http://localhost:8787` or `ngrok http 8787`).
     - **For production:** deploy the included `Dockerfile` to an always-on host. Fly.io Mumbai costs about $2–5/month.
   - **Vaani agent → Brain → Reasoning LLM → Bring your Own LLM:**
     - URL: `wss://<call-server-host>/vaani`. Vaani appends `/<call_id>` itself.
     - Auth Token: your `VAANI_BYOL_TOKEN`.
     - **Fallback: "No fallback"**, so Vaani's own LLM can never answer around the pricing guardrail.
   - **Vaani agent → Welcome message:** `Hello, Aangan Studio. How can I help you today?` Vaani speaks this before our server is called, and it's recorded as the first agent turn.
   - **Vaani → Settings → Webhooks:** `https://<vercel-app>/api/voice/vaani?token=<VAANI_WEBHOOK_SECRET>`.
     - `call_started` gives us the caller's number.
     - `call_postprocessing` acts as a safety net: if the call server never handled a call, it's logged as missed and a callback is queued, like T08.
   - **Phone number** (Vaani → Telephony): Vobiz numbers cost about ₹100 setup plus ₹500–999/month. Without one, you can test with Vaani's in-browser calls.
8. **Dashboard.** Set `DASHBOARD_PASSWORD`; the page is behind basic auth. In production it refuses to serve without a password.
9. **Deploy.** Push to GitHub and import the repo in Vercel. Every push to `main` auto-deploys. `vercel.json` pins the functions to Mumbai (`bom1`) for latency.

## What is stubbed vs live

| Piece | Status |
|---|---|
| Core: qualification, policy, guardrail, handoff note, outcomes | **Live**, and fully tested offline |
| Rules brain (regex NLU + studio-wording templates) | **Live**. Used by tests and as the runtime fallback |
| Gemini brain (`gemini-3.5-flash-lite`) | **Live.** On T01–T20: 21 of 21 correct, ₹0.38 per call, about 2.7 s per reply. Falls back to rules on timeout or error |
| Supabase store | **Live** |
| Telegram | **Live** (Aangan Leads group) |
| Resend email | **Built, off.** Needs `RESEND_API_KEY` and recipient addresses; stubs to console until then |
| Dashboard | **Live** on Vercel (basic auth), auto-deploys from GitHub |
| Cal.com | **Link generation is live.** Picking a slot *on the call* (Cal.com API v2 bookings) is not built: the caller picks the slot from the link |
| Sending the booking link *to the caller* | **Stub.** Phone has no channel for it yet. It needs an SMS/WhatsApp adapter, or Vaani's own SMS if it has one. The link is stored and is in the designer's note |
| Vaani voice adapter | **Built to Vaani's documented protocol** (BYOL WebSocket + call-event webhooks). Tested with a fake Vaani client over a real local WebSocket: every September call gets its labelled outcome on the voice path. Also checked live: Gemini + Supabase over a WebSocket, ₹0.36 per call. **Not yet connected to Vaani itself.** That needs the call server running somewhere Vaani can reach and a Vaani agent configured (step 7). No paid voice or phone APIs are called in tests |
| Phone number + always-on call-server hosting | **Paid, not bought.** Vobiz number: ₹100 setup + ₹500–999/month. Hosting: about $2–5/month. Vaani's in-browser calls (₹100 trial balance) work without a number |
| Callback execution (someone actually calling back) | **Human step.** Callbacks are queued in `callbacks` and announced on Telegram. A caller ringing back resolves their pending callback automatically (T17) |
| Abandoned voice sessions | **Handled.** A WebSocket close finalises the call. If the call server was unreachable, Vaani's `call_postprocessing` webhook logs a missed call and queues a callback |

## Layout

```
knowledge/        services.md, qualified.md, pricing.md (internal), transcripts PDF + extracted text
core/             types, session pipeline, nlu, policy, qualify, guardrail, nlg, prompt, handoff, timeline
adapters/         brain.ts, llm/gemini.ts, voice/vaani.ts, handoff/{telegram,email}.ts, booking/calcom.ts, actions.ts
server/           vaani-ws.ts: always-on BYOL WebSocket call server (`npm run voice-server`, Dockerfile)
store/            Store port, memory + Supabase implementations
dashboard/        metrics (pure) + data loading
app/              Next.js: dashboard page, /api/voice/vaani (Vaani call-event webhook)
cli/              harness.ts (transcripts), chat.ts (interactive)
tests/            fixtures/transcripts.json (generated by scripts/build-fixtures.ts) + suites
```
