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

export const PROHIBITED_TERMS = Object.freeze([...rules.prohibited_terms]);

export const PROHIBITED_MECHANICS = Object.freeze([...(rules.prohibited_mechanics ?? [])]);

export const THRESHOLD_PHRASE = rules.threshold_phrase;

export const SHARING_RULE = rules.sharing_rule;

export const FAMILY_PATHWAY_BANNED_SUBSTRINGS = Object.freeze(['member', 'membership']);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MATCHERS = Object.freeze(
  [...PROHIBITED_TERMS]
    .sort((a, b) => b.length - a.length)
    .map((term) => ({
      term,
      pattern: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, 'giu'),
    })),
);

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

export function isCleanCopy(text) {
  return findProhibitedTerms(text).length === 0;
}

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
