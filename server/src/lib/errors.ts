import type { ErrorCode, Obligation } from '@fridge-door/shared';

export interface Candidate {
  id: string;
  title: string;
  dueDate: string;
  /** What tells it apart from the others: "for Maya", "from Bright Smiles". */
  detail?: string;
}

/** An error whose message is safe to show to the end user (or speak aloud). */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { candidates?: Candidate[]; issues?: unknown[] } = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message: string) => new AppError('not_found', message);

export const badRequest = (message: string, issues?: unknown[]) =>
  new AppError('bad_request', message, issues ? { issues } : {});

export const ambiguous = (message: string, matches: Obligation[], detail?: (o: Obligation) => string) =>
  new AppError('ambiguous', message, {
    candidates: matches.map((o) => ({ id: o.id, title: o.title, dueDate: o.dueDate, ...(detail ? { detail: detail(o) } : {}) })),
  });

export const HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  ambiguous: 409,
  internal: 500,
};
