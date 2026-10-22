import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { HOUSEHOLD_HEADER, MEMBER_HEADER, USER_HEADER } from '@fridge-door/shared';
import { AppError, badRequest } from '../lib/errors.js';
import type { RequestContext } from '../service/obligations.js';

const HOUSEHOLD_ID = /^[A-Za-z0-9._:@-]{1,100}$/;

/**
 * Identity comes from headers set by the client (or, in production, by the
 * auth layer in front of this server), never from tool arguments, so the model
 * cannot talk its way into someone else's private items.
 */
export function requestContext(req: Request, defaultHouseholdId: string): RequestContext {
  const household = req.get(HOUSEHOLD_HEADER)?.trim() || defaultHouseholdId;
  if (!HOUSEHOLD_ID.test(household)) throw badRequest(`Invalid ${HOUSEHOLD_HEADER} header.`);
  const user = req.get(MEMBER_HEADER)?.trim() || req.get(USER_HEADER)?.trim() || null;
  if (user !== null && user.length > 100) throw badRequest(`Invalid ${MEMBER_HEADER} header.`);
  return { householdId: household, userId: user };
}

/** Optional shared-secret bearer auth (enabled when API_KEY is set). */
export function bearerAuth(apiKey: string | undefined) {
  const expected = apiKey ? Buffer.from(apiKey) : null;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!expected) return next();
    const header = req.get('authorization') ?? '';
    const token = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (token.length === expected.length && timingSafeEqual(token, expected)) return next();
    next(new AppError('unauthorized', 'Missing or invalid bearer token.'));
  };
}
