/**
 * SMTP client — real delivery over `node:net` and `node:tls`.
 *
 * The locked dependency set (§9.1) has no room for a mail library, and the previous seam
 * refused to send rather than pretend. This is the client that seam was waiting for:
 * EHLO, STARTTLS (or implicit TLS on 465), AUTH PLAIN / AUTH LOGIN, MAIL FROM, RCPT TO,
 * DATA, QUIT — spoken directly.
 *
 * Three rules hold throughout, and each is a privacy or security requirement rather than a
 * style preference:
 *
 * 1. **No credential is ever logged.** AUTH exchanges are never written to a log record at
 *    any level; the log line for a failed delivery carries the host, the port and the SMTP
 *    reply code, and nothing that could be replayed.
 * 2. **No message body is ever logged.** §9.10's "no PII in logs" covers the body of a
 *    message to a named Founding Reader as surely as it covers their address. Only the
 *    encoded byte count is reported.
 * 3. **Credentials never cross a plaintext channel.** If the server offers no STARTTLS and
 *    `SMTP_PASS` is set, delivery is refused rather than downgraded. Loopback hosts
 *    (`127.0.0.1`, `localhost`) are the only place TLS may be skipped — that is how a
 *    local catcher such as Mailpit is reached.
 *
 * A per-recipient rejection is data, not an exception: RCPT TO failures are collected and
 * returned, and delivery continues for whoever the server did accept. Only a failure that
 * makes the whole conversation meaningless — no connection, no greeting, refused DATA —
 * raises.
 */

import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

import config from '../config/index.js';

/** Implicit-TLS submission port. `SMTP_PORT=465` starts TLS from the first byte. */
const IMPLICIT_TLS_PORT = 465;

/** Hosts that may speak SMTP without TLS — local catchers only. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** How long one command may wait for its reply. */
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;

const CRLF = '\r\n';

/** RFC 2045: a quoted-printable line may not exceed 76 characters *including* the soft break. */
const QP_LINE_LIMIT = 75;

/** RFC 2047: `=?UTF-8?B?` + payload + `?=` must fit in 75 characters, leaving 45 raw bytes. */
const ENCODED_WORD_PAYLOAD_BYTES = 45;

/** Reply codes that mean "the command succeeded". */
const OK_CODES = Object.freeze([250, 251]);

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Build the error shape the mail layer surfaces. The SMTP reply text is preserved because
 * it is the server's own diagnosis ("relay access denied", "mailbox full") and carries no
 * credential; the message body and the AUTH exchange are never attached.
 *
 * @param {string} message Human-readable summary.
 * @param {{ code?: string, statusCode?: number, reply?: object|null }} [options] Details.
 * @returns {Error} The error.
 */
function smtpError(message, options = {}) {
  const error = new Error(message);
  error.code = options.code ?? 'MAIL_DELIVERY_FAILED';
  error.statusCode = options.statusCode ?? 502;
  if (options.reply) error.smtpReply = { code: options.reply.code, text: options.reply.text };
  return error;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Resolve discrete SMTP settings into a connection target.
 *
 * `SMTP_PORT=465` is TLS from the first byte. Any other port upgrades through STARTTLS.
 * Loopback hosts skip the TLS requirement so a local catcher can run without certificates.
 *
 * @param {{ host?: string, port?: number, user?: string, pass?: string }} [options]
 *        Overrides; defaults come from `config.mail`.
 * @returns {{ host: string, port: number, implicitTls: boolean, requireTls: boolean,
 *             username: string, password: string }} The target. Never logged.
 * @throws {TypeError} When the host is absent or the port is not a valid number.
 */
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

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * True when every character is printable US-ASCII, so it may travel in a header unencoded.
 *
 * @param {string} value Candidate text.
 * @returns {boolean} Whether the value is header-safe as written.
 */
function isPrintableAscii(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Remove CR, LF and every other control character.
 *
 * Header injection is the reason this exists: a display name carrying `\r\nBcc:` would
 * otherwise become a header of its own. Stripping happens before any header is built.
 *
 * @param {unknown} value Any value.
 * @returns {string} The value with control characters removed and whitespace collapsed.
 */
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

/**
 * Encode a header value per RFC 2047 when it is not plain ASCII.
 *
 * Encoded words are split on character boundaries, never inside a multi-byte sequence, and
 * folded with CRLF + space so no header line exceeds the 78-character guidance.
 *
 * @param {string} value The header value.
 * @returns {string} The encoded value.
 */
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

/**
 * One quoted-printable token for a byte.
 *
 * @param {number} byte A byte value.
 * @returns {string} Its quoted-printable representation.
 */
function qpToken(byte) {
  if (byte === 0x3d) return '=3D';
  if (byte === 0x09 || byte === 0x20) return String.fromCharCode(byte);
  if (byte >= 0x21 && byte <= 0x7e) return String.fromCharCode(byte);
  return `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Quoted-printable body encoding (RFC 2045).
 *
 * Line endings are normalised to CRLF hard breaks; trailing whitespace is encoded so a
 * relay cannot strip it; long lines are folded with soft breaks at 75 characters.
 *
 * @param {string} text The body text.
 * @returns {string} The encoded body, CRLF-delimited.
 */
export function encodeQuotedPrintable(text) {
  const normalised = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const encodedLines = [];

  for (const sourceLine of normalised.split('\n')) {
    const tokens = [...Buffer.from(sourceLine, 'utf8')].map(qpToken);
    // A space or tab immediately before a line break is invisible and removable in transit;
    // encoding it keeps the message byte-exact.
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

/**
 * Escape a leading dot on every line (RFC 5321 §4.5.2) so a body line of `.` cannot end the
 * DATA phase early.
 *
 * @param {string} raw The message.
 * @returns {string} The transparent form.
 */
export function dotStuff(raw) {
  return raw.replace(/^\./gm, '..');
}

/* -------------------------------------------------------------------------- */
/* Addresses and message assembly                                              */
/* -------------------------------------------------------------------------- */

const ADDRESS_PATTERN = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/**
 * Split `Display Name <address@host>` or a bare address.
 *
 * @param {string|{ name?: string|null, address: string }} input The address.
 * @returns {{ name: string|null, address: string }} The parts.
 * @throws {TypeError} When no usable address is present.
 */
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

/**
 * Render an address for a header, quoting or RFC 2047-encoding the display name as needed.
 *
 * @param {string|{ name?: string|null, address: string }} input The address.
 * @returns {string} The header form.
 */
export function formatAddress(input) {
  const { name, address } = parseAddress(input);
  if (!name) return address;
  const encoded = encodeHeaderValue(name);
  const needsQuoting = isPrintableAscii(encoded) && /[",:;<>@[\]\\.]/.test(encoded);
  return `${needsQuoting ? `"${encoded.replace(/(["\\])/g, '\\$1')}"` : encoded} <${address}>`;
}

/**
 * @param {string|{ address: string }} input An address.
 * @returns {string} The bare envelope address.
 * @throws {TypeError} When the address is not well formed.
 */
export function envelopeAddress(input) {
  const { address } = parseAddress(input);
  if (!ADDRESS_PATTERN.test(address)) {
    throw new TypeError('smtp: an envelope address must be a bare mailbox.');
  }
  return address;
}

/**
 * RFC 5322 date, always in UTC. `toUTCString` is close but spells the zone `GMT`.
 *
 * @param {Date} date The instant.
 * @returns {string} The formatted date.
 */
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

/**
 * Mint a Message-ID. Random rather than sequential: a predictable id would let a recipient
 * estimate how many messages a cohort received.
 *
 * @param {string} domain The sending domain.
 * @returns {string} The identifier, without angle brackets.
 */
export function newMessageId(domain) {
  return `${Date.now().toString(36)}.${randomBytes(12).toString('hex')}@${domain}`;
}

/**
 * Assemble an RFC 5322 message with a multipart/alternative body when HTML is supplied.
 *
 * @param {{ from: string, to: string|string[], subject: string, text: string,
 *           html?: string|null, replyTo?: string|null, messageId?: string|null,
 *           date?: Date, boundary?: string|null }} input The message.
 * @returns {{ raw: string, messageId: string }} The encoded message and its identifier.
 */
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
      // A reader whose client renders plain text must receive the same message, not a
      // placeholder telling them to switch clients.
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

/* -------------------------------------------------------------------------- */
/* Conversation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A line-oriented SMTP channel over one socket. Replaced, not mutated, when STARTTLS
 * upgrades the connection.
 */
class SmtpChannel {
  /**
   * @param {import('node:net').Socket} socket An open socket.
   * @param {number} timeoutMs Per-command timeout.
   */
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

  /** Record a terminal failure and reject anything waiting on a reply. */
  fail(error) {
    this.failure = this.failure ?? error;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
  }

  /** Hand a complete reply to a waiting reader, if one has arrived. */
  settle() {
    if (!this.waiter) return;
    const reply = this.takeReply();
    if (!reply) return;
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(reply);
  }

  /**
   * Pull one complete reply out of the buffer. A multiline reply ends at the first line
   * whose code is followed by a space rather than a hyphen.
   *
   * @returns {{ code: number, lines: string[], text: string }|null} The reply, or null.
   */
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

  /**
   * @returns {Promise<{ code: number, lines: string[], text: string }>} The next reply.
   */
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

  /**
   * Send one command line and await its reply.
   *
   * The command text is never logged: `AUTH PLAIN <base64>` and the two AUTH LOGIN
   * continuation lines are credentials in transit.
   *
   * @param {string} line The command, without CRLF.
   * @returns {Promise<{ code: number, lines: string[], text: string }>} The reply.
   */
  async command(line) {
    if (this.failure) throw this.failure;
    this.socket.write(`${line}${CRLF}`);
    return this.read();
  }

  /**
   * @param {string} payload Raw bytes to write, already CRLF-delimited.
   * @returns {void}
   */
  write(payload) {
    this.socket.write(payload);
  }

  /** Detach the listeners so the socket can be handed to the TLS layer. */
  detach() {
    for (const [event, handler] of Object.entries(this.listeners)) {
      this.socket.removeListener(event, handler);
    }
    return this.socket;
  }

  /** Close without treating the resulting `close` event as a failure. */
  end() {
    const socket = this.detach();
    if (typeof socket.end === 'function') socket.end();
  }
}

/**
 * @param {object} target A resolved SMTP target (`resolveSmtpTarget`).
 * @param {{ createSocket?: Function }} options Connection overrides (a test seam).
 * @returns {import('node:net').Socket} The socket.
 */
function openSocket(target, options) {
  if (typeof options.createSocket === 'function') return options.createSocket(target);
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const socket = target.implicitTls
    ? tls.connect({ host: target.host, port: target.port, servername: target.host })
    : net.connect({ host: target.host, port: target.port });
  if (typeof socket.setTimeout === 'function') socket.setTimeout(timeoutMs);
  return socket;
}

/**
 * @param {object} reply An SMTP reply.
 * @param {number[]} accepted Acceptable codes.
 * @param {string} stage What was being attempted.
 * @returns {object} The reply, when acceptable.
 * @throws {Error} With the server's own diagnosis attached.
 */
function expect(reply, accepted, stage) {
  if (accepted.includes(reply.code)) return reply;
  throw smtpError(`smtp: the server refused ${stage}.`, { reply });
}

/**
 * Parse the EHLO capability lines into an uppercase set plus the AUTH mechanisms.
 *
 * @param {string[]} lines Reply lines, greeting first.
 * @returns {{ has: (name: string) => boolean, authMechanisms: string[] }} The capabilities.
 */
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

/**
 * Greet the server and return the negotiated capabilities.
 *
 * @param {SmtpChannel} channel The channel.
 * @param {string} clientName The EHLO argument.
 * @returns {Promise<object>} The capabilities.
 */
async function greet(channel, clientName) {
  const ehlo = await channel.command(`EHLO ${clientName}`);
  if (OK_CODES.includes(ehlo.code)) return readCapabilities(ehlo.lines);
  // A server too old for EHLO is still a server. HELO advertises nothing, so no STARTTLS
  // and no AUTH are available on that path — which the caller then refuses if it needs them.
  expect(await channel.command(`HELO ${clientName}`), OK_CODES, 'the greeting');
  return readCapabilities([]);
}

/**
 * Authenticate. PLAIN when the server offers it, LOGIN otherwise — both are implemented
 * because real submission hosts differ on which they advertise.
 *
 * @param {SmtpChannel} channel The channel.
 * @param {{ username: string, password: string }} credentials The credentials.
 * @param {string[]} mechanisms Advertised mechanisms.
 * @returns {Promise<void>} Resolves when authenticated.
 */
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
  // Some hosts answer 334 to `AUTH PLAIN` with an inline token and expect it repeated.
  if (reply.code === 334) {
    expect(await channel.command(token), [235], 'the sign-in');
    return;
  }
  expect(reply, [235], 'the sign-in');
}

/**
 * Upgrade a plaintext channel to TLS.
 *
 * @param {SmtpChannel} channel The plaintext channel.
 * @param {{ host: string }} target The connection target.
 * @param {number} timeoutMs Per-command timeout.
 * @returns {Promise<SmtpChannel>} The secure channel.
 */
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

/**
 * Open a connection, greet, upgrade and authenticate. The caller receives a channel ready
 * for MAIL FROM.
 *
 * @param {object} target A resolved SMTP target (`resolveSmtpTarget`).
 * @param {{ timeoutMs: number, clientName: string, createSocket?: Function }} options Options.
 * @returns {Promise<{ channel: SmtpChannel, secure: boolean, authenticated: boolean,
 *                     greeting: string }>} The prepared session.
 */
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

/* -------------------------------------------------------------------------- */
/* Public surface                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Deliver one message.
 *
 * A recipient the server refuses is reported in `rejected` and does not abort the delivery
 * for the others; a delivery with no accepted recipient returns `delivered: false` rather
 * than raising, so a caller sending to a list can record the outcome per address.
 *
 * @param {{ from: string, to: string|string[], subject: string, text: string,
 *           html?: string|null, replyTo?: string|null }} message The message.
 * @param {{ host?: string, port?: number, user?: string, pass?: string,
 *           timeoutMs?: number, clientName?: string, logger?: object,
 *           createSocket?: Function }} [options] Overrides; defaults come from `config.mail`.
 * @returns {Promise<{ delivered: boolean, messageId: string, response: string,
 *                     accepted: string[], rejected: Array<{ address: string, reason: string }> }>}
 *          The delivery result.
 */
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
      // RSET rather than DATA: the transaction is abandoned cleanly and the connection can
      // still be closed politely.
      await channel.command('RSET').catch(() => null);
      channel.end();
      return { delivered: false, messageId, response: '', accepted, rejected };
    }

    expect(await channel.command('DATA'), [354], 'the message');
    channel.write(`${dotStuff(raw)}${CRLF}.${CRLF}`);
    const queued = expect(await channel.read(), OK_CODES, 'the message');

    await channel.command('QUIT').catch(() => null);
    channel.end();

    // Byte count only. The body of a message to a named Founding Reader is exactly the kind
    // of content §9.10 keeps out of logs.
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

/**
 * Probe the configured SMTP host for the admin health view: connect, greet, upgrade, sign
 * in, and disconnect without sending anything.
 *
 * Nothing identifying the credential is returned — the host is reported because an operator
 * needs to know which relay answered, and nothing else is.
 *
 * @param {{ host?: string, port?: number, user?: string, pass?: string,
 *           timeoutMs?: number, clientName?: string, logger?: object,
 *           createSocket?: Function }} [options] Overrides.
 * @returns {Promise<{ ok: boolean, secure: boolean, authenticated: boolean,
 *                     reason: string|null }>} The probe result. Never throws.
 */
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
    // The code, not the message: a server reply can quote the sender address it refused.
    return { ok: false, secure: false, authenticated: false, reason: error.code ?? 'MAIL_UNAVAILABLE' };
  }
}

export default { sendMail, verifyConnection, resolveSmtpTarget, buildMessage };
