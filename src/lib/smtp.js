import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

import config from '../config/index.js';

const IMPLICIT_TLS_PORT = 465;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;

const CRLF = '\r\n';

const QP_LINE_LIMIT = 75;

const ENCODED_WORD_PAYLOAD_BYTES = 45;

const OK_CODES = Object.freeze([250, 251]);

function smtpError(message, options = {}) {
  const error = new Error(message);
  error.code = options.code ?? 'MAIL_DELIVERY_FAILED';
  error.statusCode = options.statusCode ?? 502;
  if (options.reply) error.smtpReply = { code: options.reply.code, text: options.reply.text };
  return error;
}

export function resolveSmtpTarget(options = {}) {
  const host = String(options.host ?? config.mail.smtpHost ?? '').trim();
  if (host === '') {
    throw new TypeError('smtp: SMTP_HOST is required.');
  }

  const port = Number(options.port ?? config.mail.smtpPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('smtp: SMTP_PORT must be a port number between 1 and 65535.');
  }

  const username = String(options.user ?? config.mail.smtpUser ?? '');
  const password = String(options.pass ?? config.mail.smtpPass ?? '');
  const implicitTls = port === IMPLICIT_TLS_PORT;
  const loopback = LOOPBACK_HOSTS.has(host.toLowerCase());

  return {
    host,
    port,
    implicitTls,
    requireTls: implicitTls || !loopback,
    username,
    password,
  };
}

function isPrintableAscii(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

export function sanitizeHeaderText(value) {
  const text = value === null || value === undefined ? '' : String(value);
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) {
      out += ' ';
      continue;
    }
    out += character;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function encodeHeaderValue(value) {
  const clean = sanitizeHeaderText(value);
  if (clean === '' || isPrintableAscii(clean)) return clean;

  const words = [];
  let chunk = '';
  let bytes = 0;
  for (const character of clean) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > ENCODED_WORD_PAYLOAD_BYTES) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk !== '') {
    words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  }
  return words.join(`${CRLF} `);
}

function qpToken(byte) {
  if (byte === 0x3d) return '=3D';
  if (byte === 0x09 || byte === 0x20) return String.fromCharCode(byte);
  if (byte >= 0x21 && byte <= 0x7e) return String.fromCharCode(byte);
  return `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
}

export function encodeQuotedPrintable(text) {
  const normalised = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const encodedLines = [];

  for (const sourceLine of normalised.split('\n')) {
    const tokens = [...Buffer.from(sourceLine, 'utf8')].map(qpToken);
    const last = tokens.length - 1;
    if (last >= 0 && (tokens[last] === ' ' || tokens[last] === '\t')) {
      tokens[last] = tokens[last] === ' ' ? '=20' : '=09';
    }

    let current = '';
    for (const token of tokens) {
      if (current.length + token.length > QP_LINE_LIMIT) {
        encodedLines.push(`${current}=`);
        current = '';
      }
      current += token;
    }
    encodedLines.push(current);
  }

  return encodedLines.join(CRLF);
}

export function dotStuff(raw) {
  return raw.replace(/^\./gm, '..');
}

const ADDRESS_PATTERN = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function parseAddress(input) {
  if (input && typeof input === 'object' && typeof input.address === 'string') {
    return { name: input.name ? sanitizeHeaderText(input.name) : null, address: input.address.trim() };
  }
  const text = sanitizeHeaderText(input);
  const angled = text.match(/^(.*)<([^<>]+)>$/);
  if (angled) {
    const name = angled[1].trim().replace(/^"(.*)"$/, '$1').trim();
    return { name: name === '' ? null : name, address: angled[2].trim() };
  }
  if (text === '') throw new TypeError('smtp: an address is required.');
  return { name: null, address: text };
}

export function formatAddress(input) {
  const { name, address } = parseAddress(input);
  if (!name) return address;
  const encoded = encodeHeaderValue(name);
  const needsQuoting = isPrintableAscii(encoded) && /[",:;<>@[\]\\.]/.test(encoded);
  return `${needsQuoting ? `"${encoded.replace(/(["\\])/g, '\\$1')}"` : encoded} <${address}>`;
}

export function envelopeAddress(input) {
  const { address } = parseAddress(input);
  if (!ADDRESS_PATTERN.test(address)) {
    throw new TypeError('smtp: an envelope address must be a bare mailbox.');
  }
  return address;
}

function formatDate(date) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

export function newMessageId(domain) {
  return `${Date.now().toString(36)}.${randomBytes(12).toString('hex')}@${domain}`;
}

export function buildMessage(input) {
  const from = parseAddress(input.from);
  const recipients = (Array.isArray(input.to) ? input.to : [input.to]).map(parseAddress);
  if (recipients.length === 0) throw new TypeError('smtp: at least one recipient is required.');

  const domain = from.address.split('@')[1] ?? 'localhost';
  const messageId = input.messageId ?? newMessageId(domain);
  const boundary = input.boundary ?? `ogp-${randomBytes(16).toString('hex')}`;
  const html = typeof input.html === 'string' && input.html !== '' ? input.html : null;

  const headers = [
    `From: ${formatAddress(from)}`,
    `To: ${recipients.map(formatAddress).join(', ')}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${formatDate(input.date ?? new Date())}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
  ];
  if (input.replyTo) headers.push(`Reply-To: ${formatAddress(input.replyTo)}`);

  const parts = [];
  if (html === null) {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable');
    parts.push(encodeQuotedPrintable(input.text ?? ''));
  } else {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    parts.push(
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      encodeQuotedPrintable(input.text ?? ''),
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      encodeQuotedPrintable(html),
      `--${boundary}--`,
    );
  }

  return { raw: `${headers.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}${CRLF}`, messageId };
}

class SmtpChannel {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.waiter = null;
    this.failure = null;

    this.listeners = {
      data: (chunk) => {
        this.buffer += chunk.toString('utf8');
        this.settle();
      },
      error: (error) => this.fail(smtpError(`smtp: ${error.message}`, { code: 'MAIL_CONNECTION_FAILED' })),
      close: () => this.fail(smtpError('smtp: the connection closed unexpectedly.', {
        code: 'MAIL_CONNECTION_FAILED',
      })),
      timeout: () => this.fail(smtpError('smtp: the server did not answer in time.', {
        code: 'MAIL_TIMEOUT',
        statusCode: 504,
      })),
    };
    for (const [event, handler] of Object.entries(this.listeners)) socket.on(event, handler);
    if (typeof socket.setTimeout === 'function') socket.setTimeout(timeoutMs);
  }

  fail(error) {
    this.failure = this.failure ?? error;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
  }

  settle() {
    if (!this.waiter) return;
    const reply = this.takeReply();
    if (!reply) return;
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(reply);
  }

  takeReply() {
    let cursor = 0;
    const raw = [];
    for (;;) {
      const end = this.buffer.indexOf(CRLF, cursor);
      if (end === -1) return null;
      const line = this.buffer.slice(cursor, end);
      cursor = end + CRLF.length;
      raw.push(line);
      if (/^\d{3} /.test(line) || !/^\d{3}-/.test(line)) {
        this.buffer = this.buffer.slice(cursor);
        const code = /^\d{3}/.test(line) ? Number(line.slice(0, 3)) : 0;
        return {
          code,
          lines: raw.map((entry) => (/^\d{3}[ -]/.test(entry) ? entry.slice(4) : entry)),
          text: raw.join(' | '),
        };
      }
    }
  }

  read() {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(smtpError('smtp: the server did not answer in time.', {
          code: 'MAIL_TIMEOUT',
          statusCode: 504,
        }));
      }, this.timeoutMs);
      this.waiter = { resolve, reject, timer };
      this.settle();
    });
  }

  async command(line) {
    if (this.failure) throw this.failure;
    this.socket.write(`${line}${CRLF}`);
    return this.read();
  }

  write(payload) {
    this.socket.write(payload);
  }

  detach() {
    for (const [event, handler] of Object.entries(this.listeners)) {
      this.socket.removeListener(event, handler);
    }
    return this.socket;
  }

  end() {
    const socket = this.detach();
    if (typeof socket.end === 'function') socket.end();
  }
}

function openSocket(target, options) {
  if (typeof options.createSocket === 'function') return options.createSocket(target);
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const socket = target.implicitTls
    ? tls.connect({ host: target.host, port: target.port, servername: target.host })
    : net.connect({ host: target.host, port: target.port });
  if (typeof socket.setTimeout === 'function') socket.setTimeout(timeoutMs);
  return socket;
}

function expect(reply, accepted, stage) {
  if (accepted.includes(reply.code)) return reply;
  throw smtpError(`smtp: the server refused ${stage}.`, { reply });
}

function readCapabilities(lines) {
  const names = new Set();
  let authMechanisms = [];
  for (const line of lines.slice(1)) {
    const [keyword, ...rest] = line.trim().split(/\s+/);
    if (!keyword) continue;
    names.add(keyword.toUpperCase());
    if (keyword.toUpperCase() === 'AUTH') authMechanisms = rest.map((entry) => entry.toUpperCase());
  }
  return { has: (name) => names.has(name.toUpperCase()), authMechanisms };
}

async function greet(channel, clientName) {
  const ehlo = await channel.command(`EHLO ${clientName}`);
  if (OK_CODES.includes(ehlo.code)) return readCapabilities(ehlo.lines);
  expect(await channel.command(`HELO ${clientName}`), OK_CODES, 'the greeting');
  return readCapabilities([]);
}

async function authenticate(channel, credentials, mechanisms) {
  const prefersLogin = mechanisms.includes('LOGIN') && !mechanisms.includes('PLAIN');

  if (prefersLogin) {
    const start = await channel.command('AUTH LOGIN');
    expect(start, [334], 'the sign-in');
    const user = await channel.command(Buffer.from(credentials.username, 'utf8').toString('base64'));
    expect(user, [334], 'the sign-in');
    const done = await channel.command(Buffer.from(credentials.password, 'utf8').toString('base64'));
    expect(done, [235], 'the sign-in');
    return;
  }

  const token = Buffer.from(`\0${credentials.username}\0${credentials.password}`, 'utf8').toString('base64');
  const reply = await channel.command(`AUTH PLAIN ${token}`);
  if (reply.code === 235) return;
  if (reply.code === 334) {
    expect(await channel.command(token), [235], 'the sign-in');
    return;
  }
  expect(reply, [235], 'the sign-in');
}

async function startTls(channel, target, timeoutMs) {
  expect(await channel.command('STARTTLS'), [220], 'the TLS upgrade');
  const plain = channel.detach();
  const secure = tls.connect({ socket: plain, servername: target.host });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      secure.removeListener('secureConnect', onReady);
      reject(smtpError(`smtp: the TLS handshake failed (${error.message}).`, {
        code: 'MAIL_TLS_FAILED',
      }));
    };
    const onReady = () => {
      secure.removeListener('error', onError);
      resolve();
    };
    secure.once('error', onError);
    secure.once('secureConnect', onReady);
  });
  return new SmtpChannel(secure, timeoutMs);
}

async function openSession(target, options) {
  const timeoutMs = options.timeoutMs;
  let channel = new SmtpChannel(openSocket(target, options), timeoutMs);
  let secure = target.implicitTls;

  const greeting = expect(await channel.read(), [220], 'the connection');
  let capabilities = await greet(channel, options.clientName);

  if (!secure && capabilities.has('STARTTLS')) {
    channel = await startTls(channel, target, timeoutMs);
    secure = true;
    capabilities = await greet(channel, options.clientName);
  }

  const hasCredentials = target.username !== '' || target.password !== '';
  if (hasCredentials && !secure && target.requireTls) {
    channel.end();
    throw smtpError(
      'smtp: the server offers no TLS, so the credentials were not sent.',
      { code: 'MAIL_TLS_REQUIRED', statusCode: 502 },
    );
  }

  let authenticated = false;
  if (hasCredentials) {
    await authenticate(channel, target, capabilities.authMechanisms);
    authenticated = true;
  }

  return { channel, secure, authenticated, greeting: greeting.lines[0] ?? '' };
}

export async function sendMail(message, options = {}) {
  const target = resolveSmtpTarget(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const logger = options.logger ?? null;

  const from = parseAddress(message.from);
  const recipients = (Array.isArray(message.to) ? message.to : [message.to]).map(envelopeAddress);
  const { raw, messageId } = buildMessage({
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html ?? null,
    replyTo: message.replyTo ?? null,
  });
  const clientName = options.clientName ?? from.address.split('@')[1] ?? 'localhost';

  const session = await openSession(target, { timeoutMs, clientName, createSocket: options.createSocket });
  const channel = session.channel;

  try {
    expect(await channel.command(`MAIL FROM:<${envelopeAddress(from)}>`), OK_CODES, 'the sender');

    const accepted = [];
    const rejected = [];
    for (const address of recipients) {
      const reply = await channel.command(`RCPT TO:<${address}>`);
      if (OK_CODES.includes(reply.code)) accepted.push(address);
      else rejected.push({ address, reason: `${reply.code} ${reply.lines[0] ?? ''}`.trim() });
    }

    if (accepted.length === 0) {
      await channel.command('RSET').catch(() => null);
      channel.end();
      return { delivered: false, messageId, response: '', accepted, rejected };
    }

    expect(await channel.command('DATA'), [354], 'the message');
    channel.write(`${dotStuff(raw)}${CRLF}.${CRLF}`);
    const queued = expect(await channel.read(), OK_CODES, 'the message');

    await channel.command('QUIT').catch(() => null);
    channel.end();

    logger?.debug?.(
      { host: target.host, port: target.port, bodyBytes: raw.length, recipients: accepted.length },
      'mail delivered over smtp',
    );

    return {
      delivered: true,
      messageId,
      response: queued.lines[0] ?? '',
      accepted,
      rejected,
    };
  } catch (error) {
    channel.end();
    logger?.error?.(
      { host: target.host, port: target.port, reason: error.code ?? 'MAIL_DELIVERY_FAILED' },
      'mail could not be delivered',
    );
    throw error;
  }
}

export async function verifyConnection(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  try {
    const target = resolveSmtpTarget(options);
    const clientName = options.clientName ?? new URL(config.origins.publicOrigin).hostname;
    const session = await openSession(target, {
      timeoutMs,
      clientName,
      createSocket: options.createSocket,
    });
    await session.channel.command('QUIT').catch(() => null);
    session.channel.end();
    return {
      ok: true,
      secure: session.secure,
      authenticated: session.authenticated,
      reason: null,
    };
  } catch (error) {
    options.logger?.warn?.({ reason: error.code ?? 'MAIL_UNAVAILABLE' }, 'smtp probe failed');
    return { ok: false, secure: false, authenticated: false, reason: error.code ?? 'MAIL_UNAVAILABLE' };
  }
}

export default { sendMail, verifyConnection, resolveSmtpTarget, buildMessage };
