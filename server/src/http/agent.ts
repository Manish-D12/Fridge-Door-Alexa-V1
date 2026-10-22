import { Router } from 'express';
import { AgentActionInput, AgentChatInput } from '@fridge-door/shared';
import type { Agent } from '../agent/agent.js';
import { AppError } from '../lib/errors.js';
import { requestContext } from './context.js';
import { parse } from './rest.js';

/**
 * The Echo Show simulator's assistant. Same identity headers as /mcp and /api;
 * they are forwarded on the agent's own MCP connection.
 *
 *   POST /agent/chat     { message, sessionId? }          -> AgentReply
 *   POST /agent/action   { tool, arguments, sessionId? }  -> AgentReply (photo, date choice)
 */
export function createAgentRouter(agent: Agent | undefined, defaultHouseholdId: string): Router {
  const router = Router();
  const identity = (req: Parameters<typeof requestContext>[0]) => {
    const ctx = requestContext(req, defaultHouseholdId);
    return { householdId: ctx.householdId, member: ctx.userId };
  };
  const requireAgent = (): Agent => {
    if (!agent) throw new AppError('internal', "The assistant isn't set up on this server. Add GEMINI_API_KEY to server/.env.");
    return agent;
  };

  router.post('/chat', async (req, res) => {
    res.json(await requireAgent().chat(identity(req), parse(AgentChatInput, req.body)));
  });

  router.post('/action', async (req, res) => {
    res.json(await requireAgent().act(identity(req), parse(AgentActionInput, req.body)));
  });

  return router;
}
