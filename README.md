# fridge-door

A shared household obligations tracker for **Amazon Alexa+** (Echo / Echo Show), exposed as an
[MCP](https://modelcontextprotocol.io) server. It covers the things that end up stuck to the fridge
door: bills, deliveries, bookings, appointments, deadlines and renewals. Ask it:

> "Alexa, what's due this week?" · "When's the next delivery?" · "I paid the water bill." ·
> "Who signed Maya's field trip slip?" · "Where did that come from?"

Every tool result includes a `speech` field, a sentence written to be read aloud, plus typed
structured data for screens such as the Echo Show.

## Layout

```
/server   MCP server (Streamable HTTP at /mcp) + REST API (/api), Express 5, TypeScript
/shared   zod schemas shared by server and web (@fridge-door/shared)
/samples  example emails and messages for trying extraction (npm run samples)
/web      Echo Show 10 simulator: React + Vite + Tailwind, voice in, cards on screen
```

```
server/src
├── index.ts            entry point
├── config.ts           env parsing (zod)
├── http/app.ts         Express app: /mcp, /api, /healthz, host validation, auth, CORS, errors
├── http/rest.ts        REST mirror of the MCP tools
├── http/context.ts     identity headers + bearer auth
├── http/agent.ts       /agent routes for the simulator
├── agent/agent.ts      the "Alexa+" brain: an MCP client of /mcp driving a tool-calling model
├── mcp/server.ts       MCP tool registrations (voice-oriented descriptions)
├── service/            business logic shared by MCP and REST (+ spoken-title matching)
├── extract/            document -> obligations: prompt, validation, snippet and date checks
├── llm/                LLM providers behind one interface: Gemini (default) and Bedrock
├── store/              DynamoDB and local JSON implementations of ObligationStore
└── lib/                time-zone helpers, errors, logger
```

## Requirements

- Node.js 20.19+ (developed on Node 24)
- For DynamoDB: AWS credentials in the standard provider chain (env vars, `~/.aws`, SSO, or an IAM role)

## Quick start (no AWS)

```bash
npm install
cp .env.example server/.env        # STORAGE=local is already set in the example
npm run seed                       # 10 demo items in server/.data/obligations.json
npm run dev                        # server on :3000 and the Echo Show simulator on :5173
```

`npm run dev` runs both with [concurrently](https://www.npmjs.com/package/concurrently); use
`npm run dev:server` or `npm run dev:web` for one of them.

For a production build: `npm run build && npm start`.

### With DynamoDB

```bash
# in server/.env: STORAGE=dynamodb, AWS_REGION=..., (optional) AWS_PROFILE=...
npm run create-table               # creates fridge-door-obligations (PK householdId, SK id, on-demand)
npm run seed
npm run dev
```

For [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html),
set `DYNAMODB_ENDPOINT=http://localhost:8000`.

## Configuration

All settings are environment variables, documented in [`.env.example`](.env.example). The main ones:

| Variable | Default | Purpose |
|---|---|---|
| `STORAGE` | `dynamodb` | `local` (JSON file) or `dynamodb` |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listen address |
| `ALLOWED_HOSTS` | — | Host-header allow-list; set this when `HOST=0.0.0.0` |
| `API_KEY` | — | If set, `/mcp` and `/api` require `Authorization: Bearer <key>` |
| `DEFAULT_HOUSEHOLD_ID` | `demo-household` | Used when no `X-Household-Id` header is sent |
| `HOUSEHOLD_TIMEZONE` | `America/Los_Angeles` | What "today" and "tomorrow" mean |
| `DEFAULT_CURRENCY` | `USD` | Currency for items that don't specify one |
| `CORS_ORIGINS` | — | Browser origins allowed to call the API. The simulator needs `http://localhost:5173` (set in `.env.example`) |
| `AGENT_MCP_URL` | `http://127.0.0.1:PORT/mcp` | Where the simulator's agent connects as an MCP client |
| `LLM_PROVIDER` | `gemini` | Extraction model: `gemini` or `bedrock` |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | — / `gemini-2.5-flash-lite` | Gemini settings |
| `GEMINI_FALLBACK_MODELS` | `gemini-2.5-flash-lite,gemini-2.5-flash` | Tried in order, once each, when a model is out of quota (429), overloaded (503) or retired (404) |
| `EXTRACTION_CACHE_DIR` | `server/.data/extraction-cache` | Model answers cached by content hash; delete it to clear |
| `BEDROCK_MODEL_ID` | — | Bedrock Converse model id (e.g. Claude Haiku); uses `AWS_REGION` |

## MCP

- SDK: `@modelcontextprotocol/sdk` 1.32.1, whose latest protocol version is **2025-11-25**. The server
  negotiates `2025-11-25` with current clients and still accepts older protocol versions.
- Transport: **Streamable HTTP** at `POST /mcp`, in stateless mode: each request gets a fresh server
  and transport, and responses are plain JSON. No legacy SSE endpoint. `GET` and `DELETE` on `/mcp`
  return 405.
- Every tool declares an `outputSchema` and returns `structuredContent`. The content has two text
  blocks: the `speech` sentence, then the JSON.

| Tool | Arguments | What it does |
|---|---|---|
| `whats_due` | `range`: today \| tomorrow \| week \| month, `forWhom?` | Pending items in the window, soonest first, plus anything overdue. `week` = the next 7 days, `month` = the next 30 days |
| `next_up` | `type?` | The next upcoming appointment, booking or delivery (or the given type) |
| `add_obligation` | `type`, `title`, `dueDate`, `sourceSnippet`, `amount?`, `currency?`, `forWhom?`, `source?`, `confidence?`, `private?`, `addedBy?` | Adds an item. A date-only `dueDate` means the end of that day in the household's time zone |
| `mark_done` | `idOrTitle`, `doneBy` | Marks an item handled. Spoken titles like "the water bill" or "Maya's dentist" are accepted |
| `who_handled` | `idOrTitle` | Who handled the item and when, or that nobody has yet |
| `get_source` | `id` | The exact original snippet and where it came from |
| `ingest_text` | `text`, `source` | Extracts dated obligations from an email or message, skips ones already on the list, and adds the rest |
| `ingest_image` | `base64`, `mimeType` | Checks the file signature, transcribes the photo, then extracts from the transcript like `ingest_text` |
| `confirm_item` | `id`, `chosenDate` | Settles an item that ingest flagged with `needsConfirmation` (e.g. "10/11") |

### Extraction

`ingest_text` and `ingest_image` send the document to the model named by `LLM_PROVIDER` and ask for
structured JSON. The document is fenced with a random marker and the system prompt treats it as data,
never instructions. The model has no tools, so a document can't change or delete anything: the worst
it can do is propose a bad candidate, and every candidate is re-checked in code:

- **Shape**: validated with zod. Malformed items are dropped.
- **sourceSnippet** must be found verbatim in the text (or the photo's transcript). Only whitespace and
  quote/dash style may differ, and what's stored is the document's own text. Otherwise it's dropped.
- **Amounts** must be a number that appears in the document, or they're cleared.
- **Ambiguous dates**: a numeric date like `10/11` that reads both ways is flagged
  `needsConfirmation` with a `confirmationQuestion` naming both dates, even if the model missed it.
  A weekday that fits only one reading ("Sun 10/11") settles it.
  Other items from the same document on that same day ("drop off goods by 8:30 that morning") are
  flagged too, since their date came from the ambiguous one. Each flagged item lists its
  `confirmationOptions` (the dates to offer).
- **Duplicates**: skipped when an item visible to the caller has the same type, the same local due
  date and a similar title.
- Relative dates ("Friday", "next Friday") are resolved against today in `HOUSEHOLD_TIMEZONE`; the
  prompt includes a two-week calendar. "Next Friday" means the first Friday after today.

**Quota and caching.** If Gemini answers 429 / `RESOURCE_EXHAUSTED` or 503 / `UNAVAILABLE`, the call
is retried once on each model in `GEMINI_FALLBACK_MODELS` in turn (the primary `GEMINI_MODEL` is never
repeated). A fallback model that Google has retired (404) is skipped. Any other error fails straight
away, and each request times out after 45 seconds. On the free tier each model allows about 20
requests a day, and an agent turn uses two or three. The model's raw answer is cached in `EXTRACTION_CACHE_DIR`, keyed by a
SHA-256 of the document text (or the photo's bytes) and the prompt, so the same document never calls
the model twice. All the checks above still run on cached answers, and editing the prompt changes the
key. Relative dates in a cached answer stay resolved against the day it was first read. A cache that
can't be written (e.g. a read-only disk) just means no caching.

The result's `speech` summarises what was added ("I found 2 things: …") and asks any confirmation
questions. Without a configured provider the server still starts and the ingest tools say so.

When a title matches more than one item, the tool returns an `isError` result that lists the candidates
("I found 2 matches… Which one did you mean?"), so the assistant can ask the person which one they meant.

### Identity and private items

Identity comes from **request headers**, never from tool arguments, so a model can't be talked into
revealing someone else's private items:

- `X-Household-Id`: the partition to read and write (defaults to `DEFAULT_HOUSEHOLD_ID`)
- `X-Household-Member`: the household member making the request (`X-User-Id` is still accepted)

A private item is only returned when `X-Household-Member` matches its `addedBy` (case-insensitive). To everyone
else it behaves exactly like a missing item, including in `get_source`, `mark_done` and `who_handled`.
In production these headers should be set by the authenticated layer in front of the server (for
example an API gateway that maps the Alexa account or voice profile), and `API_KEY` or real OAuth
should be enabled.

## REST API (for the web app)

These endpoints use the same service, validation and identity headers as the MCP tools.

| Method | Path | Body / query |
|---|---|---|
| GET | `/api/obligations` | List every item visible to the caller |
| GET | `/api/obligations/due` | `?range=week&forWhom=Maya` |
| GET | `/api/obligations/next` | `?type=order` |
| POST | `/api/obligations` | `add_obligation` arguments → `201` |
| POST | `/api/obligations/mark-done` | `{ idOrTitle, doneBy }` |
| GET | `/api/obligations/who-handled` | `?idOrTitle=rent` |
| GET | `/api/obligations/:id/source` | |
| POST | `/api/obligations/confirm` | `{ id, chosenDate }` |
| POST | `/api/ingest/text` | `{ text, source }` |
| POST | `/api/ingest/image` | `{ base64, mimeType }` |
| POST | `/agent/chat` | `{ message, sessionId? }` → `{ speech, card, sessionId, toolCalls }` (simulator) |
| POST | `/agent/action` | `{ tool: "ingest_image" | "confirm_item", arguments, sessionId? }` (simulator buttons) |
| GET | `/healthz` | Liveness check (no auth) |

Errors are returned as `{ "error": { "code", "message", "candidates?", "issues?" } }`, using status
`400`, `401`, `404`, `409` (ambiguous) or `500`.

```bash
curl -s -H "X-Household-Member: Dan" "http://127.0.0.1:3000/api/obligations/due?range=week"
```

## Testing with MCP Inspector

Start the server (`npm run seed && npm run dev`), then use either the UI or the CLI.

**UI**

```bash
npx @modelcontextprotocol/inspector
```

Choose transport **Streamable HTTP** and URL `http://localhost:3000/mcp`, then click Connect. To act
as a specific person, add the header `X-Household-Member: Priya` in the connection settings (add
`Authorization: Bearer …` too if `API_KEY` is set). Open **Tools → List Tools** and run any tool.

**CLI**

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http --method tools/list

npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http \
  --method tools/call --tool-name whats_due --tool-arg range=week

npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http \
  --header "X-Household-Member: Dan" \
  --method tools/call --tool-name mark_done --tool-arg "idOrTitle=the water bill" doneBy=Dan

npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http \
  --method tools/call --tool-name get_source --tool-arg id=seed-field-trip-slip
```

The CLI exits non-zero when a tool returns `isError: true`, for example on a deliberate "not found".

### Demo data

`npm run seed` resets `DEFAULT_HOUSEHOLD_ID` and adds 10 items. Their dates are relative to today, so
the demo always has something due:

field trip permission slip (photo) · water bill (Gmail) · car insurance renewal · Amazon delivery ·
dentist appointment (WhatsApp) · family movie booking · parent-teacher conference · credit card
payment (**private to Priya**) · dishwasher warranty expiry · rent (**already paid by Dan**).

Seeded ids are stable (`seed-water-bill`, `seed-credit-card`, …), which makes `get_source` easy to try.
Use `npm run seed -- --no-reset` to upsert without clearing the household first.

### Sample documents

`npm run samples` runs each file in [`/samples`](samples) through `ingest_text` with the real provider,
against a temporary copy of the demo household, and reports whether any existing item changed. It
needs `GEMINI_API_KEY` (or Bedrock settings). Pass names to run a subset: `npm run samples -- 05 06`.
It shares the server's extraction cache, so re-running a sample costs no quota and prints
`model calls: 0 (answer from cache)`; add `--fresh` to ask the model again.

## Automated tests

```bash
npm test
```

The suite uses Node's built-in test runner and covers:

- time-zone and DST handling
- every service operation, including privacy and title matching
- extraction with a fake model: snippet checks, dropped and invalid items, duplicates, ambiguous
  dates, `confirm_item`, and that ingesting never changes existing items
- the extraction cache (memory and on disk) and Gemini model fallback on quota, overload and retired models
- the simulator agent with a scripted model: it lists and calls tools over real MCP, keeps sessions
  per speaker, builds cards, and handles photo and date-confirmation buttons
- an end-to-end run that starts the real Express app and calls every tool through the official SDK
  client over Streamable HTTP, then exercises the REST API

## Echo Show simulator (`/web`)

The demo: an Echo Show 10 screen in the browser, with an "Alexa+" agent that uses fridge-door
**exactly the way Alexa+ would, as an MCP client**. Each turn, `POST /agent/chat` opens a Streamable
HTTP connection to this server's own `/mcp` with the official SDK client, calls `tools/list`, hands
the tools to Gemini (function calling, same provider and fallback chain as extraction), runs whatever
the model calls through `tools/call`, and returns `{ speech, card }`. The speaker's
`X-Household-Member` header travels on that MCP connection, so private items and `doneBy` work as
they would on a real device. The card is built from the last tool result. The chip under each answer
(`MCP · whats_due → get_source`) shows which tools ran.

### Running the demo

```bash
npm install
cp .env.example server/.env       # add GEMINI_API_KEY; CORS_ORIGINS=http://localhost:5173 is already set
npm run seed
npm run dev
```

Open **http://localhost:5173** in Chrome or Edge, which have Web Speech recognition. Then:

| Do | You'll see |
|---|---|
| Wait on the idle screen | Clock, date, and a "Coming up" card cycling through the next 3 items |
| Hold **Space** (or the mic button) and say *"What's due this week?"* | Live transcript, the light bar pulses while listening, sweeps while thinking and glows while speaking; a due list with type icons, dates, amounts and who each item is for |
| *"I paid the water bill"* | A "Done" card: handled by the current speaker |
| *"What did the school notice say?"* | The item, with the original text quoted in a "From your photo" box |
| Camera button → snap or **Upload photo** (try `samples/07-science-fair-notice.jpg`) | "Reading your photo…", then a card of what was added |
| A document with an ambiguous date, such as `samples/05-ambiguous-date.txt` | A question with one button per date; tapping one confirms it in place |
| Switch **Mom / Dad / Riya** (top right) | A new conversation as that person; Mom (Priya) sees her private credit card bill, the others don't |

The chips under the device send the example questions without a microphone. The keyboard button
opens a text box, which is shown automatically in browsers without speech recognition (e.g. Firefox).
Replies are spoken with `speechSynthesis`; speaking, or pressing Space, interrupts the current reply.
Escape returns to the clock.

The members are defined in `web/src/members.ts`. Mom and Dad send the names used by the demo data
(Priya and Dan), so their private items and `doneBy` line up. Set `VITE_API_URL` (default
`http://127.0.0.1:3000`) or `VITE_API_KEY` in `web/.env` if the server runs elsewhere or has
`API_KEY` set.

## Connecting to Alexa+

Alexa+ needs a publicly reachable HTTPS endpoint. Deploy the server (container, App Runner, ECS,
or behind a tunnel for development) with:

```
HOST=0.0.0.0
ALLOWED_HOSTS=your-domain.example.com
API_KEY=<long random secret>
STORAGE=dynamodb
```

Then register `https://your-domain.example.com/mcp` as the MCP endpoint.

## License

[MIT](LICENSE)
