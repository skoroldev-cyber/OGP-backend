import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGE_BANDS,
  CONTENT_LAYERS,
  AGE_BAND_TO_LAYER,
  layerForAgeBand,
  IMMERSION_STATES,
  PACE_MODES,
  STATES,
} from '../src/config/constants.js';
import { computeGates } from '../src/modules/sessions/service.js';
import { DEFAULT_CONTENT_LAYER } from '../src/modules/manuscript/service.js';
import {
  PROHIBITED_TERMS,
  PROHIBITED_MECHANICS,
  THRESHOLD_PHRASE,
  findProhibitedTerms,
  isCleanCopy,
  assertCleanCopy,
  assertCleanFamilyCopy,
} from '../src/lib/rulesLint.js';
import { parseNmiResponse, redactParams } from '../src/lib/nmiClient.js';

test('the age band routing map is the founder\'s, verbatim', () => {
  const expected = {
    '8-12': 'foundation',
    '13-16': 'awakening',
    '17-19': 'transition',
    '20-25': 'emerging_adult',
    '26-32': 'grounded_adult',
    '33+': 'full_manuscript',
  };

  for (const [band, layer] of Object.entries(expected)) {
    assert.equal(layerForAgeBand(band), layer, `${band} must route to ${layer}`);
    assert.equal(AGE_BAND_TO_LAYER[band], layer);
  }

  assert.equal(Object.keys(AGE_BAND_TO_LAYER).length, 6, 'there are exactly six bands');
  assert.equal(AGE_BANDS.length, 6);
  assert.equal(CONTENT_LAYERS.length, 6);
});

test('an unknown or absent band maps to no layer at all, never to a guess', () => {
  for (const band of [null, undefined, '', 'unknown', '99+', 0, {}]) {
    assert.equal(layerForAgeBand(band), null, `band: ${String(band)}`);
  }
});

test('the session default for an unanswered prompt is the untouched full manuscript', () => {
  assert.equal(DEFAULT_CONTENT_LAYER, 'full_manuscript');
});

test('the band vocabulary carries no birthdate and no gender', () => {
  for (const band of AGE_BANDS) {
    assert.match(band, /^\d+(-\d+|\+)$/, `"${band}" is not a range`);
  }
});

test('the Phase 1 state machine is S0 through S14 and nothing else', () => {
  const values = Object.values(STATES);
  for (let i = 0; i <= 14; i += 1) {
    assert.ok(values.includes(`S${i}`), `missing S${i}`);
  }
  assert.equal(values.length, 15);
});

test('the immersion sub-machine is the ten locked values', () => {
  const expected = [
    'entry',
    'orientation',
    'reading',
    'recognition',
    'reflection',
    'decompression',
    'sharing_ready',
    'return',
    'convergence',
    'become_family_threshold',
  ];
  for (const state of expected) assert.ok(IMMERSION_STATES.includes(state), `missing ${state}`);
  assert.equal(IMMERSION_STATES.length, 10);

  assert.deepEqual([...PACE_MODES].sort(), ['deep', 'natural', 'paused', 'returning', 'slow']);
});

const config = { flags: { sharingEnabled: true } };

const eligibleSession = () => ({
  immersion_state: 'decompression',
  lastDecompressionAt: new Date(),
  promptsShown: 0,
});

const calmFacts = () => ({
  units: [{ isNoShareZoneInherited: false, isHighImpact: false, requiresDecompressionAfter: false }],
  hasValidatedConvergenceThreshold: false,
});

test('sharing opens only after recognition, reflection, decompression and regulation', () => {
  const gates = computeGates({ session: eligibleSession(), facts: calmFacts(), config });
  assert.equal(gates.allow_sharing, true);
  assert.equal(gates.allow_prompting, true);
});

test('sharing is closed inside a no-share zone', () => {
  const facts = calmFacts();
  facts.units[0].isNoShareZoneInherited = true;

  const gates = computeGates({ session: eligibleSession(), facts, config });
  assert.equal(gates.allow_sharing, false);
  assert.equal(gates.allow_prompting, false);
});

test('sharing is closed while a required decompression window is unpassed', () => {
  const facts = calmFacts();
  facts.units[0].requiresDecompressionAfter = true;

  const session = eligibleSession();
  session.lastDecompressionAt = null;

  assert.equal(computeGates({ session, facts, config }).allow_sharing, false);
});

test('sharing is closed outside the permitted immersion states', () => {
  for (const state of ['entry', 'orientation', 'reading', 'recognition']) {
    const session = eligibleSession();
    session.immersion_state = state;
    assert.equal(
      computeGates({ session, facts: calmFacts(), config }).allow_sharing,
      false,
      `immersion_state "${state}" must not open a share window`,
    );
  }
});

test('a prompt is suppressed on a high-impact unit until decompression completes', () => {
  const facts = calmFacts();
  facts.units[0].isHighImpact = true;

  const session = eligibleSession();
  session.lastDecompressionAt = null;
  session.immersion_state = 'return';

  const gates = computeGates({ session, facts, config });
  assert.equal(gates.allow_prompting, false, 'no prompt immediately after a high-impact unit');
});

test('frequency is rare: one system-initiated prompt per session', () => {
  const session = eligibleSession();
  session.promptsShown = 1;

  const gates = computeGates({ session, facts: calmFacts(), config });
  assert.equal(gates.allow_sharing, true, 'the reader may still choose to share');
  assert.equal(gates.allow_prompting, false, 'but the system does not offer again');
});

test('the sharing feature flag closes the gate globally', () => {
  const gates = computeGates({
    session: eligibleSession(),
    facts: calmFacts(),
    config: { flags: { sharingEnabled: false } },
  });
  assert.equal(gates.allow_sharing, false);
});

test('"Become Family." requires a validated convergence threshold', () => {
  const facts = calmFacts();
  const session = eligibleSession();
  session.immersion_state = 'convergence';

  assert.equal(computeGates({ session, facts, config }).allow_become_family, false);

  facts.hasValidatedConvergenceThreshold = true;
  assert.equal(computeGates({ session, facts, config }).allow_become_family, true);
});

test('the gate degrades closed on missing or malformed input', () => {
  for (const args of [
    { session: null, facts: null, config },
    { session: {}, facts: {}, config },
    { session: undefined, facts: undefined, config: undefined },
  ]) {
    const gates = computeGates(args);
    assert.equal(gates.allow_sharing, false);
    assert.equal(gates.allow_prompting, false);
    assert.equal(gates.allow_become_family, false);
  }
});

const termsIn = (text) => findProhibitedTerms(text).map((hit) => hit.term);

test('rules.json is loaded whole: 17 terms, 13 mechanics, the threshold phrase', () => {
  assert.equal(PROHIBITED_TERMS.length, 17);
  assert.equal(PROHIBITED_MECHANICS.length, 13);
  assert.equal(THRESHOLD_PHRASE, 'Become Family.', 'the trailing period is part of the phrase');
});

test('findProhibitedTerms catches banned copy', () => {
  assert.deepEqual(termsIn('Sign up to become a member today'), ['sign up', 'become a member']);
  assert.deepEqual(termsIn('Act now — limited time'), ['act now', 'limited time']);
  assert.deepEqual(termsIn('Share if you care'), ['share if you care']);
});

test('findProhibitedTerms respects word boundaries', () => {
  assert.deepEqual(termsIn('The reservation was converted to an order.'), []);
  assert.deepEqual(termsIn('joint effort'), []);
  assert.deepEqual(termsIn('enlistment'), []);

  assert.deepEqual(termsIn('convert the reader'), ['convert']);
});

test('an overlapping phrase is reported once, at its longest match', () => {
  assert.deepEqual(termsIn('join us'), ['join us']);
  assert.deepEqual(termsIn('Join now'), ['join now']);
  assert.deepEqual(termsIn('join'), ['join']);
});

test('the locked copy the platform actually renders is clean', () => {
  const locked = [
    'Enter',
    'Begin the Journey',
    'Begin the Journey into the Immersive Reading Room.',
    'Become Family.',
    'Choose Your Path',
    'The Opening Arc is complete. What follows is yours to choose.',
    'Continue the Founder\'s Edition',
    'Donate for Digital Transcript Access',
    'Purchase / Reserve Hardcover Copy',
    'Support the Mission',
    'Share the Opening Arc',
    'Return Later',
    'Continue to Observations',
    'Your age range is used only to adjust reading depth, language, and emotional intensity. It is not used to profile you.',
    'Now or never. ONE Global People unites humanity as One Global Family to restore truth, rebuild trust, create accountability, and protect the Shared World.',
  ];

  for (const string of locked) {
    assert.equal(isCleanCopy(string), true, `locked string failed the lint: "${string}"`);
  }
});

test('assertCleanCopy throws on banned copy and passes clean copy', () => {
  assert.throws(() => assertCleanCopy('Sign up now', 'prompt_text'), /sign up/i);
  assert.doesNotThrow(() => assertCleanCopy('Offer someone their own journey.', 'prompt_text'));
});

test('the family pathway may not use member, membership, join or sign up', () => {
  assert.throws(() => assertCleanFamilyCopy('Become a Global Family Member'));
  assert.throws(() => assertCleanFamilyCopy('Your membership is confirmed'));
  assert.doesNotThrow(() => assertCleanFamilyCopy('Become Family.'));
  assert.doesNotThrow(() => assertCleanFamilyCopy('Continue with the One Global Family.'));
});

test('an approved sale parses as approved', () => {
  const parsed = parseNmiResponse(
    'response=1&responsetext=SUCCESS&authcode=123456&transactionid=9876543210&avsresponse=Y&cvvresponse=M&response_code=100',
  );
  assert.equal(parsed.status, 'approved');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.transactionId, '9876543210');
  assert.equal(parsed.authCode, '123456');
  assert.equal(parsed.avsResponse, 'Y');
  assert.equal(parsed.cvvResponse, 'M');
});

test('a decline parses as declined, not as an error', () => {
  const parsed = parseNmiResponse(
    'response=2&responsetext=DECLINE&transactionid=9876543211&response_code=200',
  );
  assert.equal(parsed.status, 'declined');
  assert.equal(parsed.ok, false);
});

test('a gateway error parses as an error', () => {
  const parsed = parseNmiResponse('response=3&responsetext=Invalid security key&response_code=300');
  assert.equal(parsed.status, 'error');
  assert.equal(parsed.ok, false);
});

test('a malformed gateway response is an error, never an approval', () => {
  for (const body of ['', 'garbage', 'response=', 'response=x']) {
    const parsed = parseNmiResponse(body);
    assert.equal(parsed.ok, false, `body: "${body}"`);
    assert.notEqual(parsed.status, 'approved', `body: "${body}"`);
  }
});

test('the security key and card data never survive redaction', () => {
  const redacted = redactParams({
    security_key: 'live_key_do_not_log_this',
    payment_token: 'tok_abc123',
    ccnumber: '4111111111111111',
    cvv: '123',
    amount: '25.00',
    orderid: 'ord_1',
  });

  const serialised = JSON.stringify(redacted);
  assert.ok(!serialised.includes('live_key_do_not_log_this'), 'the security key leaked');
  assert.ok(!serialised.includes('tok_abc123'), 'the payment token leaked');
  assert.ok(!serialised.includes('4111111111111111'), 'a card number leaked');
  assert.ok(!serialised.includes('123456'), 'a CVV leaked');

  assert.equal(redacted.amount, '25.00');
  assert.equal(redacted.orderid, 'ord_1');
});
