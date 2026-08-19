/**
 * Editable copy for the two Founding Reader messages (§10.7.2: "approve participant, send
 * welcome email, issue private reading link").
 *
 * The set of templates is closed. A founder may rewrite what a message says; nobody can
 * create a new message type from the dashboard, because a general-purpose composer with a
 * recipient list is the email campaign tooling §10.6.4 rules out. There is no schedule, no
 * sequence and no follow-up template here for the same reason a reminder sequence is absent
 * from `beta.js`: it would be a drip campaign wearing a study's clothes.
 *
 * Two guarantees govern rendering:
 *
 * 1. **The substituter is not a template engine.** It replaces four named placeholders and
 *    does nothing else — no expressions, no includes, no conditionals, no property paths.
 *    Stored copy is founder-authored, but it is still stored data reaching a rendering step,
 *    and a data-driven expression evaluator is a server-side injection surface. Anything
 *    that is not one of the four names is rejected when the template is stored, so a typo
 *    surfaces at edit time rather than in a reader's inbox.
 * 2. **Every substituted value is escaped for its destination.** HTML entities in the HTML
 *    body, control characters stripped everywhere, and CR/LF stripped from the subject —
 *    a display name imported from a spreadsheet must never be able to open a new header.
 *
 * Copy is linted against `content/rules.json` before it can be stored (§10.6.2's
 * prohibited-terms lint, applied here to email copy). A template carrying a prohibited term
 * is refused with `422` naming the term; there is no override, because the message goes to
 * a stranger who did not consent to marketing language.
 */

import { EMAIL_TEMPLATE_KEYS, SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps } from '../../db/collections.js';
import { writeAudit } from '../../lib/audit.js';
import { assertCleanCopy } from '../../lib/rulesLint.js';
import { ApiError } from '../../plugins/errors.js';
import { toIso } from './schemas.js';

/** Audit actions this module writes. */
export const TEMPLATE_AUDIT_ACTIONS = Object.freeze({
  TEMPLATE_UPDATE: 'email_template.update',
});

/**
 * The four placeholders, and nothing else.
 *
 * `displayName` renders the participant's name, or `Hello` when the record carries none, so
 * a salutation line reads correctly either way. `cohortName` and `expiresAt` render empty
 * when unknown — Phase 1 invitation codes are single-use rather than time-limited (§5.7), so
 * `expiresAt` is empty until a cohort study window is modelled, and the seeded copy does not
 * depend on it.
 */
export const TEMPLATE_PLACEHOLDERS = Object.freeze([
  'displayName',
  'invitationUrl',
  'cohortName',
  'expiresAt',
]);

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

const MERCHANT_NAME = 'One Global People';

/** The salutation used when a participant record carries no name. */
const ANONYMOUS_SALUTATION = 'Hello';

/**
 * Seeded copy. Written on first read so a fresh deployment can send before anyone has
 * opened the editor, and never rewritten afterwards — a founder's edit is not undone by a
 * restart.
 */
export const DEFAULT_TEMPLATES = Object.freeze({
  beta_invitation: Object.freeze({
    subject: `Your private reading link — ${MERCHANT_NAME}`,
    bodyText: [
      '{{displayName}},',
      '',
      'Thank you for offering your time as a Founding Reader.',
      '',
      'Your private reading link:',
      '{{invitationUrl}}',
      '',
      'The link is yours alone. Read at whatever pace suits you. You may stop at any point',
      'and return later; your place is kept. When you reach the end of the Opening Arc you',
      'will be offered a short set of observations to answer, if you wish to.',
      '',
      'Nothing is expected of you beyond your honest reading.',
      '',
      `— ${MERCHANT_NAME}`,
    ].join('\n'),
    bodyHtml: [
      '<p>{{displayName}},</p>',
      '<p>Thank you for offering your time as a Founding Reader.</p>',
      '<p>Your private reading link:<br>',
      '<a href="{{invitationUrl}}">{{invitationUrl}}</a></p>',
      '<p>The link is yours alone. Read at whatever pace suits you. You may stop at any',
      'point and return later; your place is kept. When you reach the end of the Opening Arc',
      'you will be offered a short set of observations to answer, if you wish to.</p>',
      '<p>Nothing is expected of you beyond your honest reading.</p>',
      `<p>— ${MERCHANT_NAME}</p>`,
    ].join('\n'),
  }),

  beta_welcome: Object.freeze({
    subject: `Your private reading link — ${MERCHANT_NAME}`,
    bodyText: [
      '{{displayName}},',
      '',
      'Your place as a Founding Reader is recorded, and the Opening Arc is open to you.',
      '',
      'Your private reading link:',
      '{{invitationUrl}}',
      '',
      'Read at whatever pace suits you. You may stop at any point and return later; your',
      'place is kept. The manuscript is not attached to this message and never will be —',
      'the link is the only way in, and it is yours alone.',
      '',
      `— ${MERCHANT_NAME}`,
    ].join('\n'),
    bodyHtml: [
      '<p>{{displayName}},</p>',
      '<p>Your place as a Founding Reader is recorded, and the Opening Arc is open to you.</p>',
      '<p>Your private reading link:<br>',
      '<a href="{{invitationUrl}}">{{invitationUrl}}</a></p>',
      '<p>Read at whatever pace suits you. You may stop at any point and return later; your',
      'place is kept. The manuscript is not attached to this message and never will be —',
      'the link is the only way in, and it is yours alone.</p>',
      `<p>— ${MERCHANT_NAME}</p>`,
    ].join('\n'),
  }),
});

/* -------------------------------------------------------------------------- */
/* Substitution                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Escape a value for insertion into HTML text or an attribute.
 *
 * @param {string} value The raw value.
 * @returns {string} The escaped value.
 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strip control characters from a substituted value.
 *
 * Line feeds survive in a body (a name never contains one legitimately, but a founder-set
 * cohort name might wrap); everything below 0x20 other than LF and TAB is removed, and the
 * subject drops those two as well because a header cannot carry them.
 *
 * @param {unknown} value Any value.
 * @param {{ allowNewlines?: boolean }} [options] Whether LF and TAB survive.
 * @returns {string} The cleaned value.
 */
export function cleanValue(value, options = {}) {
  const allowNewlines = options.allowNewlines === true;
  const text = value === null || value === undefined ? '' : String(value);
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === 0x0a || code === 0x09) {
      out += allowNewlines ? character : ' ';
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue;
    out += character;
  }
  return allowNewlines ? out : out.replace(/\s+/g, ' ').trim();
}

/**
 * Every placeholder name appearing in a piece of copy, in order of first appearance.
 *
 * @param {string} text The copy.
 * @returns {string[]} The names.
 */
export function placeholdersIn(text) {
  const found = [];
  for (const match of String(text ?? '').matchAll(PLACEHOLDER_PATTERN)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/**
 * Replace the four known placeholders. Nothing else in the string is interpreted.
 *
 * @param {string} text The copy.
 * @param {Record<string, unknown>} values Placeholder values.
 * @param {{ html?: boolean, singleLine?: boolean }} [options] `html` escapes every
 *        substitution for HTML; `singleLine` additionally forbids line breaks (subjects).
 * @returns {string} The rendered copy.
 */
export function substitute(text, values, options = {}) {
  const html = options.html === true;
  const allowNewlines = options.singleLine !== true && !html;

  const rendered = String(text ?? '').replace(PLACEHOLDER_PATTERN, (whole, name) => {
    // An unknown name is left exactly as written. It cannot reach a reader: `update` rejects
    // copy containing one, so this branch only ever runs on copy that predates a rename.
    if (!TEMPLATE_PLACEHOLDERS.includes(name)) return whole;
    const value = cleanValue(values?.[name], { allowNewlines });
    return html ? escapeHtml(value) : value;
  });

  // An optional placeholder that rendered empty leaves a hole where its line used to be.
  // Collapsing runs of blank lines is the whole of the tidy-up; nothing else is rewritten.
  return options.singleLine === true
    ? cleanValue(rendered)
    : rendered.replace(/\n{3,}/g, '\n\n');
}

/**
 * Render a template's three parts.
 *
 * @param {{ subject: string, bodyText: string, bodyHtml?: string|null }} template The copy.
 * @param {Record<string, unknown>} values Placeholder values.
 * @returns {{ subject: string, text: string, html: string|null }} The message.
 */
export function renderCopy(template, values) {
  return {
    subject: substitute(template.subject, values, { singleLine: true }),
    text: substitute(template.bodyText, values),
    html: template.bodyHtml ? substitute(template.bodyHtml, values, { html: true }) : null,
  };
}

/**
 * Reject copy that names a placeholder the renderer does not know.
 *
 * @param {string} text The copy.
 * @param {string} field The field name, for the message.
 * @returns {void}
 * @throws {ApiError} 422 naming the unknown placeholder.
 */
function assertKnownPlaceholders(text, field) {
  const unknown = placeholdersIn(text).filter((name) => !TEMPLATE_PLACEHOLDERS.includes(name));
  if (unknown.length === 0) return;
  throw new ApiError(
    422,
    'UNKNOWN_PLACEHOLDER',
    `${field} uses {{${unknown[0]}}}, which is not a placeholder. ` +
      `Available: ${TEMPLATE_PLACEHOLDERS.map((name) => `{{${name}}}`).join(', ')}.`,
  );
}

/**
 * The salutation value for a participant, so an unnamed record still reads as a greeting.
 *
 * @param {string|null|undefined} displayName The stored name.
 * @returns {string} The value for `{{displayName}}`.
 */
export function salutationFor(displayName) {
  const name = cleanValue(displayName);
  return name === '' ? ANONYMOUS_SALUTATION : name;
}

/**
 * The private reading link written into invitation mail: `PUBLIC_ORIGIN + INVITE_PATH + ?fr=`.
 *
 * The code is the whole point of the link. §10.7.2 is "send welcome email, issue private
 * reading link", and §5.7 makes each code single-use and bound to one participant so that
 * completion is tracked without asking anybody to identify themselves, and so that a leaked
 * link can be revoked on its own.
 *
 * This used to return the bare origin and take no code at all, which quietly cost all of
 * that: every Founding Reader in a cohort received the same anonymous address, arrived as an
 * ordinary visitor, and `claimInvitation` — which exists, and works — was never reached,
 * because nothing ever carried a code for it to claim. The invitation record stayed at
 * `invited` for readers who had in fact read.
 *
 * Codes match `^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$` (`modules/sessions/schemas.js`), so they
 * survive `encodeURIComponent` unchanged; it is applied anyway rather than trusted, because
 * an organisation cohort code is typed by hand.
 *
 * @param {object} config The application configuration.
 * @param {string} [code] The participant's invitation code. Omitted gives the plain address.
 * @returns {string} The absolute URL, with no trailing slash on the origin.
 */
export function buildInvitationUrl(config, code) {
  const origin = String(config.origins?.publicOrigin ?? '').replace(/\/+$/, '');
  const path = String(config.email?.invitePath ?? '/');
  const value = typeof code === 'string' ? code.trim() : '';

  // Assembled through `URL` so the join is a real one. Concatenating produced
  // `https://site?fr=CODE` whenever INVITE_PATH was the default `/` — accepted by browsers,
  // but it is the address a Founding Reader is asked to trust, and it should not look like a
  // typing mistake in the one message that introduces the work to them.
  try {
    const url = new URL(path, `${origin}/`);
    if (value !== '') url.searchParams.set('fr', value);
    return url.toString();
  } catch {
    // An unparseable PUBLIC_ORIGIN is a configuration fault the loader already reports; a
    // message with a plain address still beats no message.
    return value === '' ? origin : `${origin}/?fr=${encodeURIComponent(value)}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Projection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} document An `email_templates` document.
 * @returns {object} The dashboard projection.
 */
export function toTemplateResponse(document) {
  return {
    key: document._id,
    subject: document.subject,
    bodyText: document.bodyText,
    bodyHtml: document.bodyHtml ?? null,
    version: Number.isInteger(document.version) ? document.version : 1,
    updatedBy: document.updatedBy ?? null,
    updatedAt: toIso(document.updatedAt),
    placeholders: [...TEMPLATE_PLACEHOLDERS],
  };
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ db: import('mongodb').Db, config: object, logger?: object }} deps Dependencies.
 * @returns {object} The admin templates service.
 */
export function createAdminTemplatesService({ db, config, logger = null }) {
  const templates = db.collection(COLLECTIONS.EMAIL_TEMPLATES);

  /**
   * Read a template, seeding the default the first time it is asked for.
   *
   * `$setOnInsert` rather than a read-then-write: two coordinators opening the editor at
   * once must not race each other into two different seeds.
   *
   * @param {string} key A value from `EMAIL_TEMPLATE_KEYS`.
   * @returns {Promise<object>} The stored document.
   * @throws {ApiError} 404 when the key is not one of the closed set.
   */
  async function load(key) {
    const defaults = DEFAULT_TEMPLATES[key];
    if (!defaults) throw new ApiError(404, 'NOT_FOUND', 'That template does not exist.');

    const existing = await templates.findOne({ _id: key });
    if (existing) return existing;

    const now = new Date();
    const seed = {
      subject: defaults.subject,
      bodyText: defaults.bodyText,
      bodyHtml: defaults.bodyHtml,
      version: 1,
      updatedBy: null,
      ...creationStamps(SCHEMA_VERSION, now),
    };
    await templates.updateOne({ _id: key }, { $setOnInsert: seed }, { upsert: true });
    logger?.info?.({ template: key }, 'email template seeded from its default copy');
    return (await templates.findOne({ _id: key })) ?? { _id: key, ...seed };
  }

  return {
    /**
     * `GET /admin/templates`.
     *
     * @returns {Promise<{ templates: object[] }>} Every template, seeded if absent.
     */
    async list() {
      const documents = [];
      for (const key of EMAIL_TEMPLATE_KEYS) documents.push(await load(key));
      return { templates: documents.map(toTemplateResponse) };
    },

    /**
     * `GET /admin/templates/:key`.
     *
     * @param {string} key The template key.
     * @returns {Promise<{ template: object }>} The template.
     */
    async get(key) {
      return { template: toTemplateResponse(await load(key)) };
    },

    /**
     * `PUT /admin/templates/:key`.
     *
     * @param {object} admin The acting administrator.
     * @param {string} key The template key.
     * @param {{ subject: string, bodyText: string, bodyHtml?: string|null }} input The body.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ template: object }>} The stored template.
     */
    async update(admin, key, input, options = {}) {
      const current = await load(key);

      // Copy first, placeholders second: a founder who wrote a prohibited term wants to hear
      // about the term, not about a typo three lines further down.
      assertCleanCopy(input.subject, 'subject');
      assertCleanCopy(input.bodyText, 'bodyText');
      if (input.bodyHtml) assertCleanCopy(input.bodyHtml, 'bodyHtml');

      assertKnownPlaceholders(input.subject, 'subject');
      assertKnownPlaceholders(input.bodyText, 'bodyText');
      if (input.bodyHtml) assertKnownPlaceholders(input.bodyHtml, 'bodyHtml');

      if (!input.bodyText.includes('{{invitationUrl}}')) {
        // Every message this collection holds exists to carry one private reading link. A
        // template without it is a message that arrives promising a link and has none.
        throw new ApiError(
          422,
          'MISSING_PLACEHOLDER',
          'The message must include {{invitationUrl}} — it is the private reading link.',
        );
      }

      const now = new Date();
      const version = (Number.isInteger(current.version) ? current.version : 1) + 1;
      const updated = await templates.findOneAndUpdate(
        { _id: key },
        {
          $set: {
            subject: input.subject,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml ?? null,
            version,
            updatedBy: admin._id,
            updatedAt: now,
          },
        },
        { returnDocument: 'after' },
      );

      await writeAudit(db, {
        actorType: 'admin',
        actorId: admin._id,
        action: TEMPLATE_AUDIT_ACTIONS.TEMPLATE_UPDATE,
        targetCollection: COLLECTIONS.EMAIL_TEMPLATES,
        targetId: key,
        before: { version: current.version ?? 1, subject: current.subject },
        after: { version, subject: input.subject },
        correlationId: options.correlationId ?? null,
      });

      return { template: toTemplateResponse(updated) };
    },

    /**
     * `POST /admin/templates/:key/preview` — render, never send.
     *
     * Draft copy may be supplied in the body so a founder can see the result before storing
     * it; the same lint runs, so a preview cannot be used to sneak past the rules and see
     * what prohibited copy would look like.
     *
     * @param {string} key The template key.
     * @param {{ subject?: string, bodyText?: string, bodyHtml?: string|null }} [draft] Copy
     *        to preview instead of what is stored.
     * @returns {Promise<{ preview: { subject: string, text: string, html: string|null } }>}
     *          The rendered message.
     */
    async preview(key, draft = {}) {
      const stored = await load(key);
      const candidate = {
        subject: draft.subject ?? stored.subject,
        bodyText: draft.bodyText ?? stored.bodyText,
        bodyHtml: draft.bodyHtml === undefined ? stored.bodyHtml : draft.bodyHtml,
      };

      assertCleanCopy(candidate.subject, 'subject');
      assertCleanCopy(candidate.bodyText, 'bodyText');
      if (candidate.bodyHtml) assertCleanCopy(candidate.bodyHtml, 'bodyHtml');
      assertKnownPlaceholders(candidate.subject, 'subject');
      assertKnownPlaceholders(candidate.bodyText, 'bodyText');
      if (candidate.bodyHtml) assertKnownPlaceholders(candidate.bodyHtml, 'bodyHtml');

      // Sample values, never a real participant: a preview must not be a way to read a
      // named person's details out of the invitations collection.
      return {
        preview: renderCopy(candidate, {
          displayName: 'Sample Reader',
          // A sample code, so the preview shows the shape of a real private link rather than
          // a bare address the founder would have to imagine the rest of.
          invitationUrl: buildInvitationUrl(config, 'SAMPLE-CODE-0000'),
          cohortName: 'Founding Readers — first cohort',
          expiresAt: '',
        }),
      };
    },

    /**
     * Render a stored template for delivery.
     *
     * @param {string} key The template key.
     * @param {{ displayName?: string|null, invitationUrl: string, cohortName?: string|null,
     *           expiresAt?: string|null }} values Placeholder values.
     * @returns {Promise<{ subject: string, text: string, html: string|null }>} The message.
     */
    async render(key, values) {
      const stored = await load(key);
      return renderCopy(stored, {
        displayName: salutationFor(values.displayName),
        invitationUrl: values.invitationUrl,
        cohortName: values.cohortName ?? '',
        expiresAt: values.expiresAt ?? '',
      });
    },
  };
}

export default createAdminTemplatesService;
