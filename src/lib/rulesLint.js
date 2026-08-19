/**
 * Prohibited-terms lint.
 *
 * `content/rules.json` is the machine-readable source of truth (§14.4.1). Seventeen terms
 * may never appear in user-facing copy — not in a sharing prompt an editor writes in the
 * admin dashboard, not in an email template, not in a receipt line.
 *
 * Matching is case-insensitive and word-boundary anchored, exactly as the rule specifies:
 * "join" matches "Join" and "join us" but not "joined" or "rejoin". That is deliberate —
 * the rule governs the vocabulary of address, not every inflection in the language.
 *
 * The prohibition applies to *copy*. Internal identifiers are unaffected: the order state
 * `converted` is legitimate, the word "convert" in a sentence shown to a reader is not.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RULES_PATH = fileURLToPath(new URL('../../content/rules.json', import.meta.url));

function loadRules() {
  const raw = readFileSync(RULES_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.prohibited_terms) || parsed.prohibited_terms.length === 0) {
    throw new Error('rulesLint: content/rules.json declares no prohibited_terms.');
  }
  return parsed;
}

const rules = loadRules();

/** The seventeen prohibited terms, verbatim. */
export const PROHIBITED_TERMS = Object.freeze([...rules.prohibited_terms]);

/** Prohibited mechanics — enforced by design review, listed here so tooling can cite them. */
export const PROHIBITED_MECHANICS = Object.freeze([...(rules.prohibited_mechanics ?? [])]);

/** "Become Family." — with the period. The only sanctioned phrase for that pathway. */
export const THRESHOLD_PHRASE = rules.threshold_phrase;

/** The Sharing Law, verbatim. */
export const SHARING_RULE = rules.sharing_rule;

/**
 * Additional words banned from reader-facing copy on the "Become Family." pathway
 * (§9.2.10): no UI string may contain "member" in any form.
 */
export const FAMILY_PATHWAY_BANNED_SUBSTRINGS = Object.freeze(['member', 'membership']);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary matchers, longest term first so "join us" is reported before "join".
 * `\b` is unreliable at the edges of multi-word phrases containing punctuation, so the
 * boundary is expressed with explicit lookarounds over word characters.
 */
const MATCHERS = Object.freeze(
  [...PROHIBITED_TERMS]
    .sort((a, b) => b.length - a.length)
    .map((term) => ({
      term,
      pattern: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, 'giu'),
    })),
);

/**
 * Find every prohibited term in a piece of copy.
 *
 * @param {string} text Candidate copy.
 * @returns {Array<{ term: string, index: number, match: string }>} Findings, ordered by
 *          position. Empty when the copy is clean.
 */
export function findProhibitedTerms(text) {
  if (typeof text !== 'string' || text === '') return [];
  const findings = [];
  const claimed = [];

  for (const { term, pattern } of MATCHERS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const start = match.index;
      const end = start + match[0].length;
      // A longer phrase already covering this span wins; do not double-report "join"
      // inside "join us".
      const overlaps = claimed.some((span) => start < span.end && end > span.start);
      if (!overlaps) {
        claimed.push({ start, end });
        findings.push({ term, index: start, match: match[0] });
      }
      match = pattern.exec(text);
    }
  }

  return findings.sort((a, b) => a.index - b.index);
}

/**
 * True when the copy contains no prohibited term.
 *
 * @param {string} text Candidate copy.
 * @returns {boolean} Whether the copy is clean.
 */
export function isCleanCopy(text) {
  return findProhibitedTerms(text).length === 0;
}

/**
 * Assert that copy is publishable. Throws a request-shaped error so a route can surface it
 * without translation.
 *
 * @param {string} text Candidate copy.
 * @param {string} [field] Field name, used in the message.
 * @returns {string} The unchanged text, so this can wrap an assignment.
 * @throws {Error} With `code: 'PROHIBITED_TERM'` and `statusCode: 422`.
 */
export function assertCleanCopy(text, field = 'text') {
  const findings = findProhibitedTerms(text);
  if (findings.length === 0) return text;
  const terms = [...new Set(findings.map((finding) => finding.term))];
  const error = new Error(
    `${field} contains prohibited copy: ${terms.map((term) => `"${term}"`).join(', ')}.`,
  );
  error.code = 'PROHIBITED_TERM';
  error.statusCode = 422;
  error.expose = true;
  error.details = findings;
  throw error;
}

/**
 * Assert that copy on the "Become Family." pathway avoids the additional banned vocabulary.
 *
 * @param {string} text Candidate copy.
 * @param {string} [field] Field name, used in the message.
 * @returns {string} The unchanged text.
 * @throws {Error} With `code: 'PROHIBITED_TERM'` and `statusCode: 422`.
 */
export function assertCleanFamilyCopy(text, field = 'text') {
  assertCleanCopy(text, field);
  if (typeof text !== 'string') return text;
  const lowered = text.toLowerCase();
  const hit = FAMILY_PATHWAY_BANNED_SUBSTRINGS.find((banned) => lowered.includes(banned));
  if (hit) {
    const error = new Error(
      `${field} contains "${hit}"; the "Become Family." pathway uses family language only.`,
    );
    error.code = 'PROHIBITED_TERM';
    error.statusCode = 422;
    error.expose = true;
    throw error;
  }
  return text;
}
