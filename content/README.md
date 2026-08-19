# `Backend/content/` — certified manuscript releases

This directory holds the canonical content the Immersive Reading Room serves, and the rules that
govern how it may change. Read this before touching anything under `generated/`.

---

## 1. The law this directory exists to enforce

> **The Opening Arc text is immutable.** It is fetched, never bundled, never transformed
> client-side. Published `opening_arc` units reject any write touching `canonicalText`.
> — `BUILD_CONTRACT.md` §0.3

The manuscript is not application data. It is a certified artifact of a founder-approved edition.
Three consequences follow, and all three are non-negotiable:

1. **Nothing in `generated/` is ever hand-edited.** Not a typo, not a stray space, not a heading
   case. Files there are build output derived from the source `.docx` and reproduced by
   `scripts/ingest-manuscript.mjs`. A hand edit silently breaks the content hash, and a broken
   hash means the platform can no longer prove that a reader saw the certified text.
2. **Corrections never mutate a release.** A release is immutable once certified. A textual
   correction produces a *new* release identifier that **supersedes** the previous one
   (§3 below). The superseded release stays on disk and stays readable; readers already inside
   the arc are never re-based mid-session.
3. **Segmentation is derived, never asserted.** The twelve protected components are recovered
   from the document's own `Heading1` spine, not from hardcoded paragraph indices. The ingestion
   script verifies the derived spine against the locked sequence and refuses to write anything
   when it disagrees.

---

## 2. Layout

```
content/
├── README.md                     # this file
├── rules.json                    # prohibited terms + mechanics (CI checks copy against this)
└── generated/                    # BUILD OUTPUT — never hand-edited, safe to delete and rebuild
    ├── release.json              # the release manifest: identity, provenance, per-unit checksums
    └── units/
        ├── CU-NONO-OA-000.json   # one file per ManuscriptUnit
        ├── CU-NONO-OA-003-S01.json
        └── …
```

`generated/` is excluded from lint (`eslint.config.js` → `globalIgnores`). It is committed so that
the certified text and its checksums are reviewable in version control, and so a deployment never
depends on the source `.docx` being present.

---

## 3. The certified-release model

One **Work** (`WORK-NOW-OR-NEVER-ONE`) has many immutable **Releases**. A release is one edition of
the manuscript, fingerprinted end to end (master doc §3.5.1, §3.6.2).

| Field | Value in the current release |
|---|---|
| `releaseId` | `REL-NONO-BRE-20260803-V1` |
| `workId` | `WORK-NOW-OR-NEVER-ONE` |
| `edition` | `beta_reader_v2_0` — Beta Reader Edition v2.0, the governing display text for S10 |
| `branch` | `public` |
| `manuscriptVersion` | `v2.0` |
| `contentLayer` | `full_manuscript` — the only certified layer today |
| `contentHash` | sha256 over the ordered `(unitId, contentHash)` list |

### Release identifier grammar

```
REL-<WORK>-<EDITION>-<YYYYMMDD>-V<n>
     NONO    BRE       20260803   1
```

`BRE` = Beta Reader Edition. The Public Founding Edition, when the founder certifies it, becomes a
new release on the `PFE` edition code — for example `REL-NONO-PFE-YYYYMMDD-V1`. It does not
overwrite this one.

### How a correction is made

1. The correction is made **in the source manuscript**, by the people who hold textual authority.
   Never in this repository.
2. The corrected `.docx` is placed alongside the previous one; the previous one is not deleted.
3. `npm run ingest:manuscript -- --source=<new.docx> --release=<new REL id> --out=<new dir>`.
4. The new release is reviewed: locked sequence, word counts against the Founder Review Control
   Sheet, and the per-unit checksums that changed.
5. The founder certifies the new release. Only then does the platform point at it.
6. The superseded release stays in place. Sessions holding a `release_id` continue to resolve.

An age-calibrated rendering (Phase 1B) is a **derivative release**, not an edit: it maps 1:1 onto
the source units on the same sequence spine with different text. The certified layer today is
`full_manuscript`; the age layer ships behind a flag that defaults off.

---

## 4. Rebuilding

```bash
npm run ingest:manuscript                 # defaults below
node scripts/ingest-manuscript.mjs --dry-run   # verify without writing

# flags
--source=<path.docx>   default: ../portfolio-itom-main/Technical Document/
                                OGP_Opening_Arc_Beta_Reader_Edition_v2_0.docx
--out=<dir>            default: content/generated
--release=<id>         default: REL-NONO-BRE-20260803-V1
--dry-run              compute and report, write nothing
```

The script extracts the `.docx` itself (a dependency-free ZIP reader over `node:zlib`, with
PowerShell `Expand-Archive` as a fallback), so the build is reproducible from the source document
on any host. It prints a verification table — component index, unit id, unit type, word count,
drift against the locked table, block counts, title — plus the protection tagging.

**Expected output, verified:** 12 protected components, 37 units, 15,540 words, zero drift against
the locked word-count table in master doc §3.5.2. Word counts are computed over the *source
paragraph stream* precisely so they reconcile with that table.

The script **fails hard and writes nothing** when the derived component spine does not match the
locked sequence. It **reports but does not fail** on word-count drift — drift is a signal that the
source edition changed and needs founder reconciliation, not a build error.

---

## 5. Unit shape

Each file under `generated/units/` is one ManuscriptUnit. Renderable content lives in `blocks[]`,
which is the entire render contract (`BUILD_CONTRACT.md` §6) — no other shape may ever be emitted:

```jsonc
{ "type": "heading",    "level": 1|2|3, "text": "CHAPTER 1 — RELATIONSHIP" }
{ "type": "paragraph",  "runs": [ { "text": "…", "bold": false, "italic": false } ] }
{ "type": "stanza",     "lines": [ { "runs": [ … ] } ] }
{ "type": "epigraph",   "lines": [ { "runs": [ … ] } ], "attribution": "— One" }
{ "type": "microstory", "title": "Microstory — The Panama Papers (2016, global)", "blocks": [ … ] }
{ "type": "divider" }
{ "type": "cue",        "runs": [ … ] }
```

Classification rules applied by the ingestion script:

| Source | Block |
|---|---|
| `Heading1/2/3` paragraph style | `heading`, level 1–3, with the **exact authored string** — never normalized for case or punctuation |
| A quoted passage closing with the `— One` signature (same paragraph or a following one) | `epigraph`; the signature moves to `attribution`, the quotation marks stay in the text |
| Two or more consecutive breath-paced lines (≤ 12 words, no terminal colon) | `stanza` — one line per authored line, never re-wrapped |
| A lone short line between prose | `paragraph` |
| `Heading3` beginning "Microstory"/"Micro-Story" | `microstory`, absorbing everything up to the next heading at that level or above |
| A paragraph that is exactly `---` or `***` | `divider` |
| "Turn the page." / "Take a breath. Then turn the page. …" | `cue` — authored reader cues stay in the manuscript voice |
| everything else | `paragraph` |

**Bold and italic emphasis exists only in the `.docx`** — it is lost in any `.txt` extraction
(master doc §3.4.1). Ingestion recovers it as `runs[].bold` / `runs[].italic`. The current release
carries 14 bold runs and 24 italic runs; a rebuild that reports zero means the source or the parser
regressed.

Line breaks inside `lines` are **semantic**. They are authored breathing, not layout. The renderer
emits hard breaks and never re-flows them.

---

## 6. Protection tagging

`isHighImpact`, `isNoShareZone`, `requiresDecompressionAfter` and `contentNoticeKey` are
**build-time, human-governed** editorial flags (master doc §3.6.3). They are never inferred from a
reader at runtime; reader-state inference exists only to *suppress* prompts, never to target.

Current tagging — `[PROPOSED]`, pending the human-review gate:

- `isNoShareZone` + `requiresDecompressionAfter` + `isHighImpact` on **Chapter 1 §§4, 5, 7**
  (witness accounts of harm to children) and **Chapter 00 parts 2–7**.
- `isHighImpact` additionally on **Chapter 1 §8 — The Threshold**.
- `contentNoticeKey: "CONTENT_NOTICE_CH1"` on the Chapter 1 component unit only. One restrained
  notice before the chapter; no mid-chapter interstitials — pace control is the protection.
- A component unit inherits protection from any child it contains. This is deliberate and
  conservative: over-suppressing a share window is safe, under-suppressing is a law violation.

`emotionalMetadata` is emitted as `{}`. The corpus defines those integer signals with no scales and
no thresholds, so Phase 1 gates operate on boolean flags and node presence only. Fabricating
numbers here would be worse than leaving them empty.

---

## 7. Interpretation notes recorded during ingestion

These are resolutions of genuine ambiguity in the authority documents. They are written down so the
next person does not have to re-derive them.

1. **Component units carry full text; section units carry slices.** `BUILD_CONTRACT.md` §6 shows
   `CU-NONO-OA-008` with `wordCount: 7247` *and* `blocks[]`, so a chapter unit renders on its own.
   Section units (`-S01`…) are the finer S10 render granularity and repeat their slice of the
   chapter. The duplication is intentional; both granularities are independently renderable and
   independently checksummed.
2. **`sequenceIndex` vs. `readingOrder`.** The contract pins `sequenceIndex: 8` for component 8, so
   `sequenceIndex` is the twelve-component spine (0–11) and a section shares its parent's value,
   ordered within by `sectionNumber`. `readingOrder` (0–36) is the strict total order over every
   unit and is what a prefetcher should walk. The `units[]` array in `release.json` is already in
   reading order.
3. **Chapters "0" and "00".** Encoded as `chapterNumber: 0` and `chapterNumber: -1` per master doc
   §3.6.2 `[PROPOSED]`. Never render `chapterNumber`: `chapterLabel` (`"0"`, `"00"`, `"1"`) and
   `canonicalTitle` carry the authored display strings.
4. **"Hybridized Canonical Edition"** appears as a line under the Chapter 1 heading. Master doc
   §3.5.1 `[PROPOSED]` treats it as edition metadata and proposes not rendering it. It is retained
   verbatim as a `paragraph` block, because dropping text from an immutable manuscript is a larger
   violation than rendering one metadata line. Suppression belongs in the renderer, and only once
   the founder confirms. Removing it would also drop the component to 7,244 words, breaking
   reconciliation with the locked table.
5. **Component 0 has no authored heading.** Its `canonicalTitle` is the descriptive
   `"Title and Copyright"`, supplied by the ingestion plan. Every other component's title is the
   verbatim `Heading1` string.
6. **`rules.json` prohibited terms bind authored UI copy, not the manuscript.** The certified text
   legitimately contains words on that list — Chapter 0 §5 uses one of them to describe how elite
   circles hire. Any CI check over prohibited terms must scan `frontend/src/config/copy.js` and
   rendered UI strings, and must **exclude** `content/generated/`. Scanning the manuscript would
   produce false failures and create pressure to alter immutable text.
7. **Word counts are source-derived.** Counted over the source paragraph stream, including the
   `---` divider paragraphs and the `— One` signatures, because that is how the Founder Review
   Control Sheet counted them. This makes every component reconcile at zero drift.

---

## 8. Open items blocking public production

- **Founder certification of the governing release is undocumented** (master doc §3.5.1
  `[OPEN QUESTION]`). OGLCE Ground Zero requires one designated release fingerprint. Staging may
  carry `REL-NONO-BRE-20260803-V1`; public production is blocked until a release is certified.
- **The Public Founding Edition has not been produced.** The Beta Reader Edition still carries
  material that cannot appear on a public route. That edition is a launch prerequisite and becomes
  its own release.
- **Resonance mapping and the immersion QA pass** must validate every no-share zone and
  decompression window before the tagging above moves out of `[PROPOSED]`.
