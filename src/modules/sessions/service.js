/**
 * The anonymous reading session.
 *
 * A session is 256 bits of randomness returned once. The server keeps only the SHA-256
 * hash, so a database dump cannot be replayed as a reader. There is no account, no
 * password, no email and no forced signup wall between a reader and the manuscript.
 *
 * **The age band lives here and nowhere else.** It is overwritten on change — never
 * appended to — deleted with the session, and surfaces in analytics only as a
 * `contentLayer` aggregate. There is no birthdate field, no gender field, and no age
 * history, because "It is not used to profile you" has to be a property of the schema
 * rather than a promise in a document.
 *
 * **The gates are server-computed and never client-writable.** `computeGates` derives them
 * from content position and authored flags only: which unit the reader is in, whether it or
 * a recently completed unit is a no-share zone, whether a required decompression window has
 * been passed, and which immersion state the reader is in. No scroll speed, no dwell time,
 * no behavioural inference of any kind. The integer reader-state signals of the handoff
 * (`emotional_load`, `sharing_readiness`, `overload_risk`, …) stay unpopulated in Phase 1:
 * reader-state inference exists only to *suppress* prompts, so a signal that is never
 * measured can never be used to target.
 *
 * **Erasure is real.** `DELETE /sessions/current` removes the session document and severs
 * the `sessionId` reference on every collection that carries one, so the PII collections
 * keep no path back to reading behaviour.
 */

import {
  ENTRY_VIA,
  IMMERSION_STATES,
  MOTION_PREFERENCES,
  PACE_MODES,
  SCHEMA_VERSION,
  STATES,
  STATE_CODES,
  layerForAgeBand,
} from '../../config/constants.js';
import {
  COLLECTIONS,
  SEVERABLE_SESSION_REFERENCES,
  creationStamps,
  updateStamps,
} from '../../db/collections.js';
import { AUDIT_ACTIONS, writeAuditSafe } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';
import { hashSessionToken, mintSessionToken } from '../../lib/tokens.js';
import { DEFAULT_CONTENT_LAYER, createContentRepository } from '../manuscript/service.js';

/* -------------------------------------------------------------------------- */
/* Gate vocabulary                                                             */
/* -------------------------------------------------------------------------- */

/**
 * §3.6.4, verbatim: `allow_sharing = false` whenever the current or a recently completed
 * unit is a no-share zone, a required decompression window is unpassed, or
 * `immersion_state ∉ {reflection, decompression, return, convergence}`.
 *
 * This is *not* the same set as `SHARING_READY_IMMERSION_STATES` in `config/constants.js`.
 * That one is gate (3) of the share-*creation* order in §9.2.6
 * (`{sharing_ready, return, convergence}`). Both are enforced; they answer different
 * questions and must not be collapsed into one another.
 */
const GATE_SHARING_IMMERSION_STATES = Object.freeze([
  'reflection',
  'decompression',
  'return',
  'convergence',
]);

/** A required decompression window counts as passed only from these states. */
const DECOMPRESSION_SATISFIED_STATES = Object.freeze(['decompression', 'return', 'convergence']);

/** "Become Family." may only be reachable from the terminal immersion states (§5.5). */
const BECOME_FAMILY_IMMERSION_STATES = Object.freeze(['convergence', 'become_family_threshold']);

/**
 * How many completed units count as "recently completed" for the no-share look-back. The
 * corpus supplies no number; two is the conservative reading of "recently" — one unit is
 * effectively no look-back at all, and a longer window would suppress sharing for most of
 * the arc.
 */
const RECENTLY_COMPLETED_LOOKBACK = 2;

/** Hard ceilings so a misbehaving client cannot grow a session document without bound. */
const MAX_COMPLETED_UNIT_IDS = 1000;
const MAX_SAVED_PASSAGE_IDS = 1000;

const MS_PER_DAY = 86_400_000;

/**
 * Which field carries the severable session reference on each collection.
 * `share_tokens` names it `createdBySessionId`; everything else names it `sessionId`.
 */
const SEVERANCE_FIELDS = Object.freeze({
  [COLLECTIONS.DONATIONS]: 'sessionId',
  [COLLECTIONS.ORDERS]: 'sessionId',
  [COLLECTIONS.FAMILY_MEMBERS]: 'sessionId',
  [COLLECTIONS.QUESTIONNAIRE_RESPONSES]: 'sessionId',
  [COLLECTIONS.FEEDBACK]: 'sessionId',
  [COLLECTIONS.SHARE_TOKENS]: 'createdBySessionId',
});

/* -------------------------------------------------------------------------- */
/* Projection                                                                  */
/* -------------------------------------------------------------------------- */

function toIso(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

/**
 * The reader-facing progress projection.
 *
 * @param {object} document A `reading_sessions` document.
 * @returns {object} The progress state.
 */
export function toProgressResponse(document) {
  const progress = document?.progress ?? {};
  return {
    currentUnitId: progress.currentUnitId ?? null,
    completedUnitIds: Array.isArray(progress.completedUnitIds) ? progress.completedUnitIds : [],
    openingArcCompleted: progress.openingArcCompleted === true,
    chaptersCompleted: Array.isArray(progress.chaptersCompleted) ? progress.chaptersCompleted : [],
    savedPassageUnitIds: Array.isArray(progress.savedPassageUnitIds)
      ? progress.savedPassageUnitIds
      : [],
    scrollFraction: typeof progress.scrollFraction === 'number' ? progress.scrollFraction : null,
    readingMs: Number.isFinite(progress.readingMs) ? Math.trunc(progress.readingMs) : 0,
    lastReadAt: toIso(progress.lastReadAt),
  };
}

/**
 * The reader-facing session projection. `tokenHash` is never in scope here — the session
 * auth plugin projects it away before a document reaches this code.
 *
 * @param {object} document A `reading_sessions` document.
 * @returns {object} The session as the reader may see it.
 */
export function toSessionResponse(document) {
  const gates = document?.gates ?? {};
  const progress = toProgressResponse(document);
  return {
    sessionId: document._id,
    ageBand: document.ageBand ?? null,
    contentLayer: document.contentLayer ?? null,
    currentState: document.currentState ?? null,
    immersionState: document.immersion_state ?? null,
    paceMode: document.pace_mode ?? null,
    motionPreference: document.motionPreference ?? null,
    audioEnabled: document.audioEnabled ?? null,
    entryVia: document.entryVia ?? null,
    isFoundingReader: document.isFoundingReader === true,
    cohortId: document.cohortId ?? null,
    skipUsed: document.skipUsed ?? null,
    gates: {
      allowPrompting: gates.allow_prompting === true,
      allowSharing: gates.allow_sharing === true,
      allowBecomeFamily: gates.allow_become_family === true,
    },
    progress: {
      currentUnitId: progress.currentUnitId,
      completedUnitIds: progress.completedUnitIds,
      openingArcCompleted: progress.openingArcCompleted,
      chaptersCompleted: progress.chaptersCompleted,
      savedPassageUnitIds: progress.savedPassageUnitIds,
      lastReadAt: progress.lastReadAt,
    },
    expiresAt: toIso(document.expiresAt),
  };
}

/* -------------------------------------------------------------------------- */
/* Gates                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Derive the three boolean gates from content position and authored flags.
 *
 * Pure, synchronous and deliberately dull. Everything it reads is either a fact about the
 * manuscript (authored by an editor, reviewed by a human) or a fact about where the reader
 * is. Nothing it reads describes *how* the reader reads.
 *
 * @param {{ session: object, facts: object, config: object }} input Gate inputs.
 * @returns {{ allow_prompting: boolean, allow_sharing: boolean, allow_become_family: boolean }}
 *          The gates, in the snake_case form `reading_sessions` stores.
 */
export function computeGates({ session, facts, config }) {
  const immersion = session?.immersion_state ?? null;
  const units = Array.isArray(facts?.units) ? facts.units : [];

  const noShareZoneInPlay = units.some((unit) => unit.isNoShareZoneInherited);
  const highImpactInPlay = units.some((unit) => unit.isHighImpact);
  const decompressionOwed = units.some((unit) => unit.requiresDecompressionAfter);
  const decompressionPassed =
    DECOMPRESSION_SATISFIED_STATES.includes(immersion) &&
    session?.lastDecompressionAt instanceof Date;

  const allowSharing =
    config?.flags?.sharingEnabled === true &&
    !noShareZoneInPlay &&
    GATE_SHARING_IMMERSION_STATES.includes(immersion) &&
    (!decompressionOwed || decompressionPassed);

  // §3.7: sharing must never appear on, or immediately after, a high-impact unit before its
  // decompression window completes. `rare` is enforced as at most one system-initiated
  // prompt per session (§5.2).
  const allowPrompting =
    allowSharing &&
    (!highImpactInPlay || decompressionPassed) &&
    (Number(session?.promptsShown) || 0) === 0;

  // "Become Family." renders only at validated convergence thresholds, surrounded by
  // silence. With no validated resonance node it is simply false — and the S14 pathway
  // remains the other, separately guarded way to reach it.
  const allowBecomeFamily =
    facts?.hasValidatedConvergenceThreshold === true &&
    BECOME_FAMILY_IMMERSION_STATES.includes(immersion);

  return {
    allow_prompting: allowPrompting,
    allow_sharing: allowSharing,
    allow_become_family: allowBecomeFamily,
  };
}

/**
 * Gathers the content facts `computeGates` needs, and the validated resonance windows the
 * sharing module needs. Everything it returns is editorial metadata that never reaches a
 * reader-facing response.
 *
 * @param {{ db: import('mongodb').Db, content: object, config: object }} deps Dependencies.
 * @returns {{ collect: Function, evaluate: Function }} The evaluator.
 */
export function createGateEvaluator({ db, content, config }) {
  /**
   * @param {object} session A `reading_sessions` document.
   * @returns {Promise<object>} The gate facts.
   */
  async function collect(session) {
    const currentUnitId = session?.progress?.currentUnitId ?? null;
    const completed = Array.isArray(session?.progress?.completedUnitIds)
      ? session.progress.completedUnitIds
      : [];
    const recent = completed.slice(-RECENTLY_COMPLETED_LOOKBACK);
    const ids = [...new Set([currentUnitId, ...recent].filter((id) => typeof id === 'string'))];

    const resolved = await Promise.all(ids.map((id) => content.getUnitFacts(id)));
    const units = resolved.filter((unit) => unit !== null);
    const current = currentUnitId
      ? units.find((unit) => unit.unitId === currentUnitId) ?? null
      : null;

    let validatedNodeTypes = [];
    if (currentUnitId) {
      const nodes = await db
        .collection(COLLECTIONS.RESONANCE_NODES)
        .find(
          { manuscript_unit_id: currentUnitId, 'qa_status.validated': true },
          { projection: { node_type: 1 } },
        )
        .toArray();
      validatedNodeTypes = [...new Set(nodes.map((node) => node.node_type))];
    }

    return {
      units,
      current,
      validatedNodeTypes,
      hasValidatedConvergenceThreshold: validatedNodeTypes.includes('convergence_threshold'),
    };
  }

  return {
    collect,

    /**
     * @param {object} session A `reading_sessions` document.
     * @returns {Promise<{ gates: object, facts: object }>} Gates and the facts behind them.
     */
    async evaluate(session) {
      const facts = await collect(session);
      return { gates: computeGates({ session, facts, config }), facts };
    },
  };
}

/**
 * @param {object} a A gate set.
 * @param {object} b Another gate set.
 * @returns {boolean} True when the two are identical.
 */
function gatesEqual(a, b) {
  return (
    a?.allow_prompting === b?.allow_prompting &&
    a?.allow_sharing === b?.allow_sharing &&
    a?.allow_become_family === b?.allow_become_family
  );
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ db: import('mongodb').Db, config: object, logger?: object, content?: object,
 *           gates?: object }} deps Dependencies.
 * @returns {object} The sessions service.
 */
export function createSessionsService({ db, config, logger = null, content = null, gates = null }) {
  const repository = content ?? createContentRepository({ db, logger });
  const evaluator = gates ?? createGateEvaluator({ db, content: repository, config });
  const sessions = db.collection(COLLECTIONS.READING_SESSIONS);

  function expiryFrom(now) {
    return new Date(now.getTime() + config.session.ttlDays * MS_PER_DAY);
  }

  /**
   * Resolve the band and layer a new or updated session should carry.
   *
   * While `AGE_LAYER_ENABLED` is false the calibration screen does not exist and only
   * `full_manuscript` is certified. A band arriving anyway is *ignored*, not stored: a
   * `foundation` session that would then be served the full manuscript is precisely the
   * harm §14.4.3 forbids, and the protective failure is to keep no band at all.
   *
   * @param {string|null|undefined} band The requested band.
   * @returns {{ ageBand: string|null, contentLayer: string }} Band and derived layer.
   */
  function routeAgeBand(band) {
    if (!config.flags.ageLayerEnabled) {
      return { ageBand: null, contentLayer: DEFAULT_CONTENT_LAYER };
    }
    const layer = layerForAgeBand(band ?? null);
    if (layer === null) return { ageBand: null, contentLayer: DEFAULT_CONTENT_LAYER };
    return { ageBand: band, contentLayer: layer };
  }

  /**
   * Claim an invitation code for a session. Single-use: the filter requires an unclaimed
   * record, so two simultaneous redemptions cannot both succeed.
   *
   * @param {string} code The code.
   * @param {string} sessionId The claiming session.
   * @param {Date} now Timestamp.
   * @returns {Promise<object|null>} The claimed invitation, or null.
   */
  async function claimInvitation(code, sessionId, now) {
    return db.collection(COLLECTIONS.INVITATIONS).findOneAndUpdate(
      {
        code,
        redeemedBySessionId: null,
        status: { $nin: ['redeemed', 'questionnaire_completed', 'not_selected'] },
      },
      {
        $set: {
          status: 'redeemed',
          redeemedBySessionId: sessionId,
          redeemedAt: now,
          ...updateStamps(now),
        },
      },
      { returnDocument: 'after', projection: { cohortId: 1, status: 1 } },
    );
  }

  /**
   * Record that a share link was opened. `openCount` is a private operational counter and
   * is never returned to anyone; rendering it would be a share counter.
   *
   * @param {string} token The share token.
   * @param {Date} now Timestamp.
   * @returns {Promise<boolean>} True when the token was live.
   */
  async function touchShareToken(token, now) {
    const updated = await db.collection(COLLECTIONS.SHARE_TOKENS).findOneAndUpdate(
      { token, revoked: false },
      [
        {
          $set: {
            openCount: { $add: [{ $ifNull: ['$openCount', 0] }, 1] },
            firstOpenedAt: { $ifNull: ['$firstOpenedAt', now] },
            lastOpenedAt: now,
            updatedAt: now,
          },
        },
      ],
      { returnDocument: 'after', projection: { _id: 1 } },
    );
    return updated !== null;
  }

  return {
    content: repository,
    gates: evaluator,

    /**
     * Mint a session. The raw token is returned once and never stored.
     *
     * Provenance is redeemed before the session document is written, so a claimed
     * invitation and the session that claimed it can never disagree. A receiver of a share
     * link gets a session of their own and inherits nothing from the sender — no progress,
     * no band, no state, not even the sender's identifier.
     *
     * @param {object} input The request body.
     * @returns {Promise<{ sessionToken: string, session: object }>} Token and session.
     */
    async createSession(input = {}) {
      const now = new Date();
      const sessionId = newId();
      const token = mintSessionToken();
      const { ageBand, contentLayer } = routeAgeBand(input.ageBand);

      let entryVia = ENTRY_VIA.includes(input.entryVia) ? input.entryVia : 'direct';
      let cohortId = null;
      let invitationId = null;
      let isFoundingReader = false;
      let invitationClaimed = null;

      if (typeof input.invitationCode === 'string') {
        const invitation = await claimInvitation(input.invitationCode, sessionId, now);
        if (invitation) {
          invitationClaimed = invitation._id;
          invitationId = invitation._id;
          cohortId = invitation.cohortId ?? null;
          isFoundingReader = true;
          entryVia = 'invitation';
        }
      }

      if (!invitationClaimed && typeof input.shareToken === 'string') {
        const opened = await touchShareToken(input.shareToken, now);
        if (opened) entryVia = 'share_token';
      }

      const document = {
        _id: sessionId,
        tokenHash: hashSessionToken(token),
        ageBand,
        contentLayer,
        currentState: STATES.S0_SITE_ARRIVAL,
        immersion_state: 'entry',
        pace_mode: 'natural',
        progress: {
          currentUnitId: null,
          completedUnitIds: [],
          openingArcCompleted: false,
          chaptersCompleted: [],
          savedPassageUnitIds: [],
          scrollFraction: null,
          readingMs: 0,
          lastReadAt: now,
        },
        gates: { allow_prompting: false, allow_sharing: false, allow_become_family: false },
        lastDecompressionAt: null,
        lastPromptAt: null,
        promptsShown: 0,
        sharesCreated: 0,
        unitsSinceLastPrompt: 0,
        entryVia,
        cohortId,
        invitationId,
        isFoundingReader,
        motionPreference: MOTION_PREFERENCES.includes(input.motionPreference)
          ? input.motionPreference
          : null,
        audioEnabled: false,
        skipUsed: false,
        pathwaySelected: null,
        pathwaySelectedAt: null,
        expiresAt: expiryFrom(now),
        ...creationStamps(SCHEMA_VERSION, now),
      };

      try {
        await sessions.insertOne(document);
      } catch (error) {
        // The invitation was claimed for a session that will not exist. Hand it back rather
        // than burning a single-use code on a failed write.
        if (invitationClaimed) {
          await db
            .collection(COLLECTIONS.INVITATIONS)
            .updateOne(
              { _id: invitationClaimed, redeemedBySessionId: sessionId },
              {
                $set: {
                  status: 'reading_link_sent',
                  redeemedBySessionId: null,
                  redeemedAt: null,
                  ...updateStamps(new Date()),
                },
              },
            )
            .catch(() => undefined);
        }
        throw error;
      }

      return { sessionToken: token, session: toSessionResponse(document) };
    },

    /**
     * @param {object} session The authenticated session document.
     * @returns {object} The reader-facing projection.
     */
    current(session) {
      return toSessionResponse(session);
    },

    /**
     * Apply a session patch and recompute the derived state.
     *
     * `contentLayer` and `gates` are both derived here and are not writable by the client:
     * the request schema declares neither, and this method overwrites both from the routing
     * function and the gate evaluator respectively.
     *
     * @param {object} session The authenticated session document.
     * @param {object} patch The validated request body.
     * @returns {Promise<object>} The updated reader-facing projection.
     */
    async updateSession(session, patch = {}) {
      const now = new Date();
      const next = { ...session, progress: { ...session.progress } };
      const update = { ...updateStamps(now) };

      if ('ageBand' in patch) {
        const { ageBand, contentLayer } = routeAgeBand(patch.ageBand);
        next.ageBand = ageBand;
        next.contentLayer = contentLayer;
        update.ageBand = ageBand;
        update.contentLayer = contentLayer;
      }
      if ('currentState' in patch && (patch.currentState === null || STATE_CODES.includes(patch.currentState))) {
        next.currentState = patch.currentState;
        update.currentState = patch.currentState;
      }
      if ('immersionState' in patch && (patch.immersionState === null || IMMERSION_STATES.includes(patch.immersionState))) {
        next.immersion_state = patch.immersionState;
        update.immersion_state = patch.immersionState;
        // Entering decompression is how a required decompression window is satisfied. It is
        // recorded as a fact about position, not as a measurement of the reader.
        if (patch.immersionState === 'decompression') {
          next.lastDecompressionAt = now;
          update.lastDecompressionAt = now;
        }
      }
      if ('paceMode' in patch && (patch.paceMode === null || PACE_MODES.includes(patch.paceMode))) {
        next.pace_mode = patch.paceMode;
        update.pace_mode = patch.paceMode;
      }
      if ('motionPreference' in patch) {
        next.motionPreference = patch.motionPreference;
        update.motionPreference = patch.motionPreference;
      }
      if ('audioEnabled' in patch) {
        next.audioEnabled = patch.audioEnabled === true;
        update.audioEnabled = next.audioEnabled;
      }
      if ('currentUnitId' in patch && typeof patch.currentUnitId === 'string') {
        // An unknown identifier is ignored rather than rejected: the reading path degrades
        // quietly, and a stale client must never be shown a technical error.
        if (await repository.hasUnit(patch.currentUnitId)) {
          next.progress.currentUnitId = patch.currentUnitId;
          update['progress.currentUnitId'] = patch.currentUnitId;
        }
      }

      const { gates: computed } = await evaluator.evaluate(next);
      next.gates = computed;
      update.gates = computed;

      await sessions.updateOne({ _id: session._id }, { $set: update });
      return toSessionResponse(next);
    },

    /**
     * Record reading progress. Idempotent by construction: unit identifiers are added to
     * sets, elapsed time accumulates into one total, and re-sending the same write changes
     * nothing but the timestamp.
     *
     * @param {object} session The authenticated session document.
     * @param {object} input The validated request body.
     * @returns {Promise<object>} The updated progress state.
     */
    async recordProgress(session, input = {}) {
      const now = new Date();
      const set = { 'progress.lastReadAt': now, expiresAt: expiryFrom(now), ...updateStamps(now) };
      const addToSet = {};
      const inc = {};

      if (typeof input.scrollFraction === 'number') {
        set['progress.scrollFraction'] = input.scrollFraction;
      }
      if (Number.isInteger(input.readingMsDelta) && input.readingMsDelta > 0) {
        inc['progress.readingMs'] = input.readingMsDelta;
      }

      const completedIds = Array.isArray(session.progress?.completedUnitIds)
        ? session.progress.completedUnitIds
        : [];
      const savedIds = Array.isArray(session.progress?.savedPassageUnitIds)
        ? session.progress.savedPassageUnitIds
        : [];

      if (
        typeof input.completedUnitId === 'string' &&
        completedIds.length < MAX_COMPLETED_UNIT_IDS
      ) {
        const facts = await repository.getUnitFacts(input.completedUnitId);
        if (facts) {
          addToSet['progress.completedUnitIds'] = facts.unitId;
          set['progress.currentUnitId'] = facts.unitId;
          inc.unitsSinceLastPrompt = 1;
          if (Number.isInteger(facts.chapterNumber)) {
            addToSet['progress.chaptersCompleted'] = facts.chapterNumber;
          }
          if (facts.isFinalUnit) set['progress.openingArcCompleted'] = true;
        }
      }

      if (
        typeof input.savedPassageUnitId === 'string' &&
        savedIds.length < MAX_SAVED_PASSAGE_IDS &&
        (await repository.hasUnit(input.savedPassageUnitId))
      ) {
        addToSet['progress.savedPassageUnitIds'] = input.savedPassageUnitId;
      }

      const operations = { $set: set };
      if (Object.keys(addToSet).length > 0) operations.$addToSet = addToSet;
      if (Object.keys(inc).length > 0) operations.$inc = inc;

      const updated = await sessions.findOneAndUpdate({ _id: session._id }, operations, {
        returnDocument: 'after',
        projection: { tokenHash: 0 },
      });
      if (!updated) return toProgressResponse(session);

      // The gates move with the reader's position, so they are recomputed from the document
      // that actually exists after the write rather than from a local guess.
      const { gates: computed } = await evaluator.evaluate(updated);
      if (!gatesEqual(computed, updated.gates)) {
        updated.gates = computed;
        await sessions.updateOne(
          { _id: session._id },
          { $set: { gates: computed, ...updateStamps(new Date()) } },
        );
      }

      return toProgressResponse(updated);
    },

    /**
     * Erase a session and sever every reference to it.
     *
     * The session document is deleted outright — there is no soft delete and no tombstone.
     * The `sessionId` on donations, orders, family records, questionnaire responses,
     * feedback and share tokens is set to null, so a record that must keep existing for
     * accounting, fulfilment or research reasons keeps no path back to reading behaviour.
     *
     * `events` are deliberately untouched: the collection is append-only (§9.2.5), the rows
     * hold no PII and no age band, and the identifier they carry no longer resolves to any
     * document once this returns.
     *
     * @param {object} session The authenticated session document.
     * @param {{ correlationId?: string|null }} [options] Audit context.
     * @returns {Promise<{ severed: number }>} How many references were severed.
     */
    async eraseSession(session, options = {}) {
      const sessionId = session._id;
      await sessions.deleteOne({ _id: sessionId });

      let severed = 0;
      for (const collectionName of SEVERABLE_SESSION_REFERENCES) {
        const field = SEVERANCE_FIELDS[collectionName];
        if (!field) continue;
        try {
          const result = await db
            .collection(collectionName)
            .updateMany(
              { [field]: sessionId },
              { $set: { [field]: null, ...updateStamps(new Date()) } },
            );
          severed += result.modifiedCount ?? 0;
        } catch (error) {
          logger?.error?.(
            { err: error, collection: collectionName },
            'session reference could not be severed',
          );
        }
      }

      await writeAuditSafe(
        db,
        {
          actorType: 'system',
          action: AUDIT_ACTIONS.SESSION_ERASED,
          targetCollection: COLLECTIONS.READING_SESSIONS,
          targetId: sessionId,
          // No before-image: an erasure record that preserved what was erased would defeat
          // the erasure.
          after: { severedReferences: severed },
          correlationId: options.correlationId ?? null,
        },
        logger,
      );

      return { severed };
    },
  };
}

export default createSessionsService;
