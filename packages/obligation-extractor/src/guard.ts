import { randomBytes } from 'node:crypto';

/**
 * Prompt-injection guard. The main defences are structural: the document is
 * fenced with a random marker it can't forge, the system prompt says it is
 * data, the model gets no tools, and every answer is re-checked in code
 * (verify.ts). The phrase check below is one more layer on top of those:
 * it is cheap, explainable, and catches the common "ignore previous
 * instructions" style. It is not meant to be complete.
 */

export interface Fenced {
  /** e.g. "DOCUMENT-3f9a1c2b7d4e" */
  marker: string;
  /** The document wrapped in <marker> ... </marker>. */
  text: string;
}

/** Wraps untrusted text in a random marker that does not occur in it, so it can't close its own fence. */
export function fenceDocument(document: string): Fenced {
  let marker: string;
  do marker = `DOCUMENT-${randomBytes(6).toString('hex')}`;
  while (document.includes(marker));
  return { marker, text: `<${marker}>\n${document}\n</${marker}>` };
}

/** Phrases that address an AI rather than a person, or try to step outside the document. */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(all\s+|any\s+)?(the\s+|your\s+)?(previous|prior|above|earlier|preceding)\s+(instructions|rules|messages|prompts?)\b/i,
  /\bdisregard\s+(all\s+|any\s+)?(the\s+|your\s+)?(previous|prior|above|earlier)\b/i,
  /\b(new|updated|revised|additional)\s+instructions\b/i,
  /\byou\s+are\s+now\b/i,
  /\b(system|developer|admin)\s+(message|prompt|note|override)\b/i,
  /\b(for|to)\s+the\s+(ai|assistant|model|llm|chatbot|bot)\b/i,
  /\b(maintenance|developer|debug|god)\s+mode\b/i,
  /\b(reveal|print|show|repeat)\s+(your|the)\s+(system\s+)?(prompt|instructions)\b/i,
  /\b(mark|set)\s+(all|every)\b.{0,40}\b(paid|done|complete|handled)\b/i,
  /\bdelete\s+(all|every)\b/i,
  /<\/?\s*(document|system|instructions?|assistant|user)\s*>/i,
];

/** The injection-like phrases found in `text`, in order. Empty for ordinary bills, notices and messages. */
export function findInjectionMarkers(text: string): string[] {
  return INJECTION_PATTERNS.flatMap((re) => {
    const m = re.exec(text);
    return m ? [m[0]] : [];
  });
}

/**
 * The paragraph (text between blank lines) around `start..end`. A quote is
 * judged with its paragraph, since an injected request usually announces
 * itself a sentence before the part that looks like a real bill.
 */
export function paragraphAround(document: string, start: number, end: number): string {
  let from = 0;
  let to = document.length;
  for (const m of document.matchAll(/\n[ \t\r]*\n/g)) {
    if (m.index + m[0].length <= start) from = m.index + m[0].length;
    else if (m.index >= end) {
      to = m.index;
      break;
    }
  }
  return document.slice(from, to);
}
