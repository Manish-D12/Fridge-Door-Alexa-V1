# obligation-extractor

Turn untrusted text (emails, chat messages, photo transcripts) into **verified** household
obligations, such as bills, deliveries, bookings, appointments, deadlines and renewals, with any LLM.

The model only proposes. Everything it returns is checked in code against the document it came
from, so a confused or manipulated model can at worst produce a candidate that gets rejected.

Extracted from [fridge-door](https://github.com/Manish-D12/fridge-door), a shared household tracker
for Alexa+ built as an MCP server.

```
npm install github:Manish-D12/obligation-extractor zod
```

(Not on the npm registry yet. Installing from GitHub builds it through the `prepare` script.)

Zero runtime dependencies besides [zod](https://zod.dev). Node 20.19+, ESM, TypeScript types
included. No LLM SDK: you bring the model call.

## What's in it

| Export | What it is |
|---|---|
| `EXTRACTION_SYSTEM_PROMPT` | The system prompt: what counts as an obligation, verbatim-quote rules, relative and ambiguous dates, and a security section that treats the document as data |
| `RESPONSE_SCHEMA` | JSON Schema for structured output, in the subset that Gemini `responseJsonSchema` and Claude / Bedrock tool schemas both accept |
| `buildExtractionPrompt(doc, opts)` | The user message: today's date and a two-week calendar in the household's time zone, plus the document in a random fence |
| `verifyExtraction(answer, doc, opts)` | Re-checks the model's answer: shape, the quote, instruction text, amounts and ambiguous dates |
| `extractObligations(doc, opts)` | All three steps for one document, around a `generateJson` function you supply |
| `locateSnippet`, `amountAppears`, `ambiguousAlternative` | The individual checks |
| `fenceDocument`, `findInjectionMarkers`, `INJECTION_PATTERNS` | The injection guard |
| `TRANSCRIBE_SYSTEM_PROMPT` | For photos: transcribe first, then extract from the transcript, so quotes can be verified |

## Usage

```ts
import { extractObligations } from 'obligation-extractor';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const { items, rejected } = await extractObligations(emailText, {
  timeZone: 'America/Los_Angeles',
  sourceDescription: 'an email',
  generateJson: async ({ system, prompt, schema }) => {
    const res = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: prompt,
      config: { systemInstruction: system, temperature: 0, responseMimeType: 'application/json', responseJsonSchema: schema },
    });
    return JSON.parse(res.text ?? '{}');
  },
});
```

Each item looks like this:

```jsonc
{
  "type": "booking",
  "title": "Bake sale",
  "dueDate": "2026-11-12",            // a date (due by the end of that local day), or an ISO instant if a time was stated
  "amount": null,
  "currency": null,
  "forWhom": null,
  "sourceSnippet": "Our class bake sale is on 11/12 in the front courtyard.",   // always an exact substring of the input
  "confidence": 0.8,
  "needsConfirmation": true,
  "confirmationQuestion": "Is Bake sale on Thursday, November 12, or Friday, December 11?",
  "confirmationOptions": ["2026-11-12", "2026-12-11"]
}
```

`rejected` lists `{ title, reason }` for every candidate that was dropped: `invalid`, `snippet_not_found` or
`instruction_text`.

To use another model, change only `generateJson`. For Claude, for example, pass `schema` as a tool's
`input_schema` and return the tool call's input.

## The checks

1. **Shape.** Validated with zod. `""` is read as `null`, and malformed items are rejected. At most 20
   candidates are considered, since a runaway answer is more likely an attack or a misread.
2. **Source-snippet verification.** Every item must quote the document. The quote has to be found
   verbatim; only whitespace and quote or dash style may differ, because models re-flow lines and
   straighten quotes. The stored snippet is the document's own text, never the model's version, so
   you can always show the user where an item came from.
3. **Injection guard.**
   - The document goes inside a random `<DOCUMENT-…>` fence that it can't close itself, so a
     fake `</document>` in an email does nothing.
   - The system prompt says the content is data and lists what to ignore.
   - In code, a quote whose paragraph talks to an AI is rejected, even if the quote itself looks like
     a real bill. Examples are "ignore previous instructions", "for the AI assistant", "you are now in
     maintenance mode" and "mark all bills as paid".
   - Pair this with the fact that the model has no tools: the worst a document can do is propose a
     candidate.
4. **Amounts.** Kept only if the number appears in the document (`$1,243.57` matches 1243.57).
5. **Ambiguous dates.** A numeric date such as `10/11` that reads both ways is flagged
   `needsConfirmation` with both dates, even if the model missed it. A weekday that fits only one
   reading (`Sun 10/11`) settles it. Other items from the same document on that day ("drop off goods by
   8:30 that morning") are flagged too, because their date came from the ambiguous one.

The phrase list in `findInjectionMarkers` is a cheap extra layer, not a complete defence. Keep the
structural ones too: no tools for the extraction model, and verification before anything is saved.

## Tips

- **Photos.** Transcribe with `TRANSCRIBE_SYSTEM_PROMPT` first, then extract from the transcript. Quotes
  are then checked against text you can show the user.
- **Caching.** The model's raw answer is safe to cache by a hash of the document and the prompt. Run
  `verifyExtraction` on cached answers too.
- **Time zones.** Pass the household's IANA zone. "Friday" and "tomorrow" are resolved against today in
  that zone, using the calendar in the prompt.

## Development

```
npm install
npm test        # node:test, no network, no API key
npm run build
```

The test fixtures include a deliberately malicious email (`test/fixtures/malicious-email.txt`).

## License

[MIT](LICENSE)
