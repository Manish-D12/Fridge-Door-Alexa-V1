import { Router, type Request } from 'express';
import type { z } from 'zod';
import {
  AddObligationInput,
  ConfirmItemInput,
  GetSourceInput,
  IngestImageInput,
  IngestTextInput,
  MarkDoneInput,
  NextUpInput,
  WhatsDueInput,
  WhoHandledInput,
} from '@fridge-door/shared';
import { badRequest } from '../lib/errors.js';
import type { ObligationService } from '../service/obligations.js';
import { requestContext } from './context.js';

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const summary = result.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    throw badRequest(`Invalid request: ${summary}`, result.error.issues);
  }
  return result.data;
}

/**
 * REST mirror of the MCP tools, for the web app. Same service, same
 * validation, same identity headers.
 *
 *   GET  /api/obligations                    list everything visible
 *   GET  /api/obligations/due?range=&forWhom=
 *   GET  /api/obligations/next?type=
 *   POST /api/obligations                    add
 *   POST /api/obligations/mark-done          { idOrTitle, doneBy }
 *   GET  /api/obligations/who-handled?idOrTitle=
 *   GET  /api/obligations/:id/source
 *   POST /api/obligations/confirm            { id, chosenDate }
 *   POST /api/ingest/text                    { text, source }
 *   POST /api/ingest/image                   { base64, mimeType }
 */
export function createRestRouter(service: ObligationService, defaultHouseholdId: string): Router {
  const router = Router();
  const ctx = (req: Request) => requestContext(req, defaultHouseholdId);

  router.get('/obligations', async (req, res) => {
    res.json(await service.list(ctx(req)));
  });

  router.get('/obligations/due', async (req, res) => {
    res.json(await service.whatsDue(ctx(req), parse(WhatsDueInput, req.query)));
  });

  router.get('/obligations/next', async (req, res) => {
    res.json(await service.nextUp(ctx(req), parse(NextUpInput, req.query)));
  });

  router.post('/obligations', async (req, res) => {
    const result = await service.add(ctx(req), parse(AddObligationInput, req.body));
    res.status(201).location(`/api/obligations/${result.item.id}/source`).json(result);
  });

  router.post('/obligations/mark-done', async (req, res) => {
    res.json(await service.markDone(ctx(req), parse(MarkDoneInput, req.body)));
  });

  router.get('/obligations/who-handled', async (req, res) => {
    res.json(await service.whoHandled(ctx(req), parse(WhoHandledInput, req.query)));
  });

  router.get('/obligations/:id/source', async (req, res) => {
    res.json(await service.getSource(ctx(req), parse(GetSourceInput, req.params)));
  });

  router.post('/obligations/confirm', async (req, res) => {
    res.json(await service.confirmItem(ctx(req), parse(ConfirmItemInput, req.body)));
  });

  router.post('/ingest/text', async (req, res) => {
    res.json(await service.ingestText(ctx(req), parse(IngestTextInput, req.body)));
  });

  router.post('/ingest/image', async (req, res) => {
    res.json(await service.ingestImage(ctx(req), parse(IngestImageInput, req.body)));
  });

  return router;
}
