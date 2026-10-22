import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AddObligationInput,
  AddObligationResult,
  ConfirmItemInput,
  ConfirmItemResult,
  GetSourceInput,
  GetSourceResult,
  IngestImageInput,
  IngestResult,
  IngestTextInput,
  MarkDoneInput,
  MarkDoneResult,
  NextUpInput,
  NextUpResult,
  WhatsDueInput,
  WhatsDueResult,
  WhoHandledInput,
  WhoHandledResult,
} from '@fridge-door/shared';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { ObligationService, RequestContext } from '../service/obligations.js';

export const SERVER_NAME = 'fridge-door';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `fridge-door is the household's shared list of obligations: bills, deliveries (orders), bookings, appointments, deadlines and renewals.
Every tool result has a "speech" field: a short sentence written to be read aloud. Prefer reading it as-is.
Never read ids aloud; keep them to pass to later calls (mark_done, who_handled, get_source, confirm_item).
If a tool reports several matches, ask the person which one they meant rather than guessing.
When ingest_text or ingest_image returns needsConfirmation items, ask each question and pass the answer to confirm_item.
Some items are private to the person who added them; they are filtered out automatically when someone else asks.`;

type Handler<I> = (input: I) => Promise<{ speech: string } & Record<string, unknown>>;

/**
 * Builds an MCP server bound to one request's identity. In stateless
 * Streamable HTTP mode a fresh server is created for every POST /mcp.
 */
export function createMcpServer(service: ObligationService, ctx: RequestContext, logger: Logger): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: 'Fridge Door', version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  const run =
    <I>(tool: string, fn: Handler<I>) =>
    async (input: I): Promise<CallToolResult> => {
      try {
        const data = await fn(input);
        return {
          content: [
            { type: 'text', text: data.speech },
            { type: 'text', text: JSON.stringify(data) },
          ],
          structuredContent: data,
        };
      } catch (err) {
        if (err instanceof AppError) {
          logger.info('tool returned error', { tool, code: err.code });
          const result: CallToolResult = { isError: true, content: [{ type: 'text', text: err.message }] };
          if (err.extra.candidates) {
            result.content.push({ type: 'text', text: JSON.stringify({ code: err.code, candidates: err.extra.candidates }) });
          }
          return result;
        }
        logger.error('tool failed', { tool, err });
        return { isError: true, content: [{ type: 'text', text: 'Sorry, something went wrong reaching the fridge door. Please try again.' }] };
      }
    };

  server.registerTool(
    'whats_due',
    {
      title: "What's due",
      description:
        'List pending household obligations (bills, deliveries, bookings, appointments, deadlines, renewals) due in a time window, soonest first, plus anything already overdue. ' +
        'Use for questions like "what\'s due today?", "anything to pay this week?", "what does Maya have coming up this month?". ' +
        'range "week" means today plus the next 6 days; "month" means the next 30 days. Pass forWhom only when the person names someone.',
      inputSchema: WhatsDueInput,
      outputSchema: WhatsDueResult,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run('whats_due', (input) => service.whatsDue(ctx, input)),
  );

  server.registerTool(
    'next_up',
    {
      title: 'Next up',
      description:
        'Get the single next upcoming appointment, booking, or delivery (order). ' +
        'Use for "what\'s next?", "when is our next appointment?", "when\'s the next delivery?". ' +
        'Pass type to narrow it, e.g. type "order" for deliveries or "bill" for the next bill.',
      inputSchema: NextUpInput,
      outputSchema: NextUpResult,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run('next_up', (input) => service.nextUp(ctx, input)),
  );

  server.registerTool(
    'add_obligation',
    {
      title: 'Add obligation',
      description:
        'Add something the household needs to pay, attend, receive, renew or finish by a date. ' +
        'Use when someone says "remind us the water bill is due Friday" or "add Maya\'s dentist appointment Tuesday at 4". ' +
        'Resolve relative dates ("Friday") to an ISO date first. Put the person\'s exact words in sourceSnippet. ' +
        'Set private to true only if they ask to keep it to themselves. Confirm back using the returned speech.',
      inputSchema: AddObligationInput,
      outputSchema: AddObligationResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    run('add_obligation', (input) => service.add(ctx, input)),
  );

  server.registerTool(
    'mark_done',
    {
      title: 'Mark done',
      description:
        'Mark an obligation as handled, recording who did it. ' +
        'Use for "I paid the water bill", "Dan signed the field trip slip", "the Amazon package arrived". ' +
        'idOrTitle can be an id from an earlier result or words from the title. doneBy is the person who handled it ("I" means the speaker). ' +
        'If several items match, ask which one.',
      inputSchema: MarkDoneInput,
      outputSchema: MarkDoneResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    run('mark_done', (input) => service.markDone(ctx, input)),
  );

  server.registerTool(
    'who_handled',
    {
      title: 'Who handled it',
      description:
        'Say who took care of an obligation and when, or that nobody has yet. ' +
        'Use for "did anyone pay the rent?", "who signed the field trip slip?". idOrTitle can be an id or words from the title.',
      inputSchema: WhoHandledInput,
      outputSchema: WhoHandledResult,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run('who_handled', (input) => service.whoHandled(ctx, input)),
  );

  server.registerTool(
    'get_source',
    {
      title: 'Get source',
      description:
        'Show where an obligation came from: the original email, WhatsApp message, photo text or spoken request, quoted exactly. ' +
        'Use for "where did that come from?" or "what did the email say?". Requires the id from an earlier result.',
      inputSchema: GetSourceInput,
      outputSchema: GetSourceResult,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run('get_source', (input) => service.getSource(ctx, input)),
  );

  server.registerTool(
    'ingest_text',
    {
      title: 'Ingest text',
      description:
        'Hand over the raw text of an email, WhatsApp message or note. Bills, deliveries, bookings, appointments, deadlines and renewals with a date are extracted and added; ' +
        'anything already on the list is skipped. Pass the text unedited. ' +
        'If the result lists needsConfirmation items, ask the person each question and call confirm_item with their answer.',
      inputSchema: IngestTextInput,
      outputSchema: IngestResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    run('ingest_text', (input) => service.ingestText(ctx, input)),
  );

  server.registerTool(
    'ingest_image',
    {
      title: 'Ingest image',
      description:
        'Hand over a photo (a school slip, a paper bill, an appointment card). Its text is transcribed, then obligations with a date are extracted and added, ' +
        'the same way as ingest_text. If the result lists needsConfirmation items, ask each question and call confirm_item.',
      inputSchema: IngestImageInput,
      outputSchema: IngestResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    run('ingest_image', (input) => service.ingestImage(ctx, input)),
  );

  server.registerTool(
    'confirm_item',
    {
      title: 'Confirm item date',
      description:
        'Settle the date of an item that ingest_text or ingest_image flagged with needsConfirmation, after asking the person its question ' +
        '(e.g. "Is the bake sale on October 11 or November 10?"). Pass the item id and the date they chose; this clears the flag.',
      inputSchema: ConfirmItemInput,
      outputSchema: ConfirmItemResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    run('confirm_item', (input) => service.confirmItem(ctx, input)),
  );

  return server;
}
