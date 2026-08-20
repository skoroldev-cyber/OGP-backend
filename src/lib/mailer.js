import config from '../config/index.js';
import { assertCleanCopy, assertCleanFamilyCopy } from './rulesLint.js';
import { sendMail, verifyConnection } from './smtp.js';

const MERCHANT_NAME = 'One Global People';
const MERCHANT_ADDRESS = '37240 Felt Rd, New Boston, MI 48164';
const TAX_STATEMENT = 'One Global People will provide tax documentation as applicable.';

export function maskEmail(address) {
  if (typeof address !== 'string' || !address.includes('@')) return '[address]';
  const [local, domain] = address.split('@');
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

function formatAmount(amountCents, currency = 'USD') {
  const value = (Number(amountCents) / 100).toFixed(2);
  return `$${value} ${currency}`;
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

export function betaWelcomeTemplate({ displayName = null, readingUrl, cohortName = null }) {
  const greeting = displayName ? `${displayName},` : 'Hello,';
  const cohortLine = cohortName ? `\nReading group: ${cohortName}\n` : '';
  return {
    subject: `Your private reading link — ${MERCHANT_NAME}`,
    text: [
      greeting,
      '',
      'Thank you for offering your time as a Founding Reader.',
      '',
      'Your private reading link:',
      readingUrl,
      cohortLine,
      'The link is yours alone. Read at whatever pace suits you. You may stop at any point',
      'and return later; your place is kept. When you reach the end of the Opening Arc you',
      'will be offered a short set of observations to answer, if you wish to.',
      '',
      'Nothing is expected of you beyond your honest reading.',
      '',
      `— ${MERCHANT_NAME}`,
    ].join('\n'),
  };
}

export function receiptTemplate({
  receiptNumber,
  issuedAt,
  amountCents,
  currency = 'USD',
  paymentMethod = null,
  workflow,
  providedInReturn = null,
  receiptUrl = null,
  lineItems = [],
}) {
  const isContribution = workflow === 'donation';
  const opening = isContribution
    ? 'Thank you. Your contribution helps this work continue.'
    : 'Thank you. Your order is recorded.';
  const returnLine = isContribution
    ? `Provided in return: ${providedInReturn ?? 'no goods or services were provided'}`
    : null;
  const items = lineItems.map(
    (item) =>
      `  ${item.quantity} × ${item.description} — ${formatAmount(item.amountCents, currency)}`,
  );

  return {
    subject: `Receipt ${receiptNumber} — ${MERCHANT_NAME}`,
    text: [
      opening,
      '',
      `Receipt number: ${receiptNumber}`,
      `Date: ${formatDate(issuedAt)}`,
      ...(items.length > 0 ? ['Items:', ...items] : []),
      `Amount: ${formatAmount(amountCents, currency)}`,
      ...(paymentMethod ? [`Payment method: ${paymentMethod}`] : []),
      ...(returnLine ? [returnLine] : []),
      '',
      MERCHANT_NAME,
      MERCHANT_ADDRESS,
      '',
      TAX_STATEMENT,
      ...(receiptUrl ? ['', `View this receipt: ${receiptUrl}`] : []),
    ].join('\n'),
  };
}

export function transcriptDeliveryTemplate({ accessUrl, receiptNumber = null }) {
  return {
    subject: `Your digital transcript — ${MERCHANT_NAME}`,
    text: [
      'The complete digital transcript is open to you.',
      '',
      accessUrl,
      '',
      'The link needs no account and does not expire. Keep it somewhere you will find it again.',
      ...(receiptNumber ? ['', `Related receipt: ${receiptNumber}`] : []),
      '',
      `— ${MERCHANT_NAME}`,
    ].join('\n'),
  };
}

export function familyWelcomeTemplate({
  displayName = null,
  communicationPreference,
  withdrawUrl,
}) {
  const greeting = displayName ? `${displayName},` : 'Hello,';
  const preferenceLine =
    communicationPreference === 'updates'
      ? 'You asked to receive occasional updates. They will be rare and quiet.'
      : 'You asked to receive nothing further. Nothing further will be sent.';
  return {
    subject: `Become Family. — ${MERCHANT_NAME}`,
    text: [
      greeting,
      '',
      'Become Family.',
      '',
      'You chose to continue with the One Global Family. Your place is recorded.',
      '',
      preferenceLine,
      '',
      `You may withdraw at any time, and it takes one click: ${withdrawUrl}`,
      'Withdrawing never affects your reading or any transcript access you hold.',
      '',
      `— ${MERCHANT_NAME}`,
    ].join('\n'),
  };
}

export function familyWithdrawalTemplate({ confirmUrl = null, completed = false }) {
  if (!completed && confirmUrl) {
    return {
      subject: `Confirm your withdrawal — ${MERCHANT_NAME}`,
      text: [
        'You asked to withdraw from the One Global Family.',
        '',
        `One click completes it: ${confirmUrl}`,
        '',
        'If you did not make this request, you can ignore this message and nothing changes.',
        '',
        `— ${MERCHANT_NAME}`,
      ].join('\n'),
    };
  }
  return {
    subject: `Your withdrawal is complete — ${MERCHANT_NAME}`,
    text: [
      'Your withdrawal is complete. Your record has been removed.',
      '',
      'Nothing further will be sent. Your reading and any transcript access you hold are',
      'unaffected.',
      '',
      `— ${MERCHANT_NAME}`,
    ].join('\n'),
  };
}

export const TEMPLATES = Object.freeze({
  beta_welcome: betaWelcomeTemplate,
  receipt: receiptTemplate,
  transcript_delivery: transcriptDeliveryTemplate,
  family_welcome: familyWelcomeTemplate,
  family_withdrawal: familyWithdrawalTemplate,
});

const FAMILY_TEMPLATES = new Set(['family_welcome', 'family_withdrawal']);

export function renderTemplate(name, input) {
  const template = TEMPLATES[name];
  if (!template) throw new TypeError(`renderTemplate: unknown template "${name}".`);
  const message = template(input);
  const assert = FAMILY_TEMPLATES.has(name) ? assertCleanFamilyCopy : assertCleanCopy;
  assert(message.subject, `${name}.subject`);
  assert(message.text, `${name}.text`);
  return message;
}

function createLogTransport(logger) {
  return {
    name: 'log',
    async send(message) {
      const record = {
        transport: 'log',
        from: message.from,
        to: maskEmail(message.to),
        subject: message.subject,
        bodyLength: message.text.length,
      };
      if (logger && typeof logger.info === 'function') {
        logger.info(record, 'mail (log transport — nothing was delivered)');
      }
      return { delivered: false, transport: 'log' };
    },
    async verify() {
      return { ok: true, transport: 'log', reason: null };
    },
  };
}

function createSmtpTransport({ smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, logger }) {
  if (typeof smtpHost !== 'string' || smtpHost === '') {
    throw new Error('mailer: EMAIL_TRANSPORT is "smtp" but SMTP_HOST is empty.');
  }

  const target = { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass };

  return {
    name: 'smtp',
    async send(message) {
      const result = await sendMail(
        {
          from: smtpFrom || message.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html ?? null,
          replyTo: message.replyTo ?? (smtpFrom && smtpFrom !== message.from ? message.from : null),
        },
        { ...target, logger },
      );
      if (!result.delivered) {
        const [first] = result.rejected;
        const error = new Error('mailer: the server accepted no recipient.');
        error.code = 'MAIL_RECIPIENT_REJECTED';
        error.statusCode = 502;
        error.reason = first?.reason ?? null;
        throw error;
      }
      logger?.info?.(
        { transport: 'smtp', to: maskEmail(message.to), subject: message.subject },
        'mail delivered',
      );
      return {
        delivered: true,
        transport: 'smtp',
        messageId: result.messageId,
        response: result.response,
      };
    },
    async verify() {
      const probe = await verifyConnection({ ...target, logger });
      return { ok: probe.ok, transport: 'smtp', reason: probe.reason };
    },
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createMailer(options = {}) {
  const transportName = options.transport ?? config.mail.transport;
  const from = options.from ?? config.mail.from;
  const smtpHost = options.smtpHost ?? config.mail.smtpHost;
  const smtpPort = options.smtpPort ?? config.mail.smtpPort;
  const smtpUser = options.smtpUser ?? config.mail.smtpUser;
  const smtpPass = options.smtpPass ?? config.mail.smtpPass;
  const smtpFrom = options.smtpFrom ?? config.mail.smtpFrom ?? from;
  const logger = options.logger ?? null;

  const transport =
    transportName === 'smtp' && smtpHost !== ''
      ? createSmtpTransport({ smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, logger })
      : createLogTransport(logger);

  async function send({ to, subject, text, html = null, replyTo = null }) {
    if (typeof to !== 'string' || !EMAIL_PATTERN.test(to)) {
      const error = new Error('mailer: a valid recipient address is required.');
      error.code = 'MAIL_BAD_RECIPIENT';
      error.statusCode = 400;
      throw error;
    }
    assertCleanCopy(subject, 'mail.subject');
    assertCleanCopy(text, 'mail.text');
    if (html) assertCleanCopy(html, 'mail.html');
    return transport.send({ to, subject, text, html, replyTo, from });
  }

  async function sendTemplate(name, to, input) {
    const message = renderTemplate(name, input);
    return send({ to, subject: message.subject, text: message.text });
  }

  async function verify() {
    try {
      return await transport.verify();
    } catch (error) {
      return { ok: false, transport: transport.name, reason: error.code ?? 'MAIL_UNAVAILABLE' };
    }
  }

  return { transportName: transport.name, send, sendTemplate, verify };
}
