import { EMAIL_TEMPLATE_KEYS, SCHEMA_VERSION } from '../../config/constants.js';
import { COLLECTIONS, creationStamps } from '../../db/collections.js';
import { writeAudit } from '../../lib/audit.js';
import { assertCleanCopy } from '../../lib/rulesLint.js';
import { ApiError } from '../../plugins/errors.js';
import { toIso } from './schemas.js';

export const TEMPLATE_AUDIT_ACTIONS = Object.freeze({
  TEMPLATE_UPDATE: 'email_template.update',
});

export const TEMPLATE_PLACEHOLDERS = Object.freeze([
  'displayName',
  'invitationUrl',
  'cohortName',
  'expiresAt',
]);

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

const MERCHANT_NAME = 'One Global People';

const ANONYMOUS_SALUTATION = 'Hello';

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

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

export function placeholdersIn(text) {
  const found = [];
  for (const match of String(text ?? '').matchAll(PLACEHOLDER_PATTERN)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

export function substitute(text, values, options = {}) {
  const html = options.html === true;
  const allowNewlines = options.singleLine !== true && !html;

  const rendered = String(text ?? '').replace(PLACEHOLDER_PATTERN, (whole, name) => {
    if (!TEMPLATE_PLACEHOLDERS.includes(name)) return whole;
    const value = cleanValue(values?.[name], { allowNewlines });
    return html ? escapeHtml(value) : value;
  });

  return options.singleLine === true
    ? cleanValue(rendered)
    : rendered.replace(/\n{3,}/g, '\n\n');
}

export function renderCopy(template, values) {
  return {
    subject: substitute(template.subject, values, { singleLine: true }),
    text: substitute(template.bodyText, values),
    html: template.bodyHtml ? substitute(template.bodyHtml, values, { html: true }) : null,
  };
}

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

export function salutationFor(displayName) {
  const name = cleanValue(displayName);
  return name === '' ? ANONYMOUS_SALUTATION : name;
}

export function buildInvitationUrl(config, code) {
  const origin = String(config.origins?.publicOrigin ?? '').replace(/\/+$/, '');
  const path = String(config.email?.invitePath ?? '/');
  const value = typeof code === 'string' ? code.trim() : '';

  try {
    const url = new URL(path, `${origin}/`);
    if (value !== '') url.searchParams.set('fr', value);
    return url.toString();
  } catch {
    return value === '' ? origin : `${origin}/?fr=${encodeURIComponent(value)}`;
  }
}

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

export function createAdminTemplatesService({ db, config, logger = null }) {
  const templates = db.collection(COLLECTIONS.EMAIL_TEMPLATES);

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
    async list() {
      const documents = [];
      for (const key of EMAIL_TEMPLATE_KEYS) documents.push(await load(key));
      return { templates: documents.map(toTemplateResponse) };
    },

    async get(key) {
      return { template: toTemplateResponse(await load(key)) };
    },

    async update(admin, key, input, options = {}) {
      const current = await load(key);

      assertCleanCopy(input.subject, 'subject');
      assertCleanCopy(input.bodyText, 'bodyText');
      if (input.bodyHtml) assertCleanCopy(input.bodyHtml, 'bodyHtml');

      assertKnownPlaceholders(input.subject, 'subject');
      assertKnownPlaceholders(input.bodyText, 'bodyText');
      if (input.bodyHtml) assertKnownPlaceholders(input.bodyHtml, 'bodyHtml');

      if (!input.bodyText.includes('{{invitationUrl}}')) {
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

      return {
        preview: renderCopy(candidate, {
          displayName: 'Sample Reader',
          invitationUrl: buildInvitationUrl(config, 'SAMPLE-CODE-0000'),
          cohortName: 'Founding Readers — first cohort',
          expiresAt: '',
        }),
      };
    },

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
