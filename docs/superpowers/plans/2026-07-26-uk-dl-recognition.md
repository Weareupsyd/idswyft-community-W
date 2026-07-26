# UK Driving Licence Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the engine recognise UK (DVLA) driving licences reliably by hardening the deterministic extraction rules, and rebuild a git-tracked OCR benchmark harness.

**Architecture:** All logic is deterministic (no probabilistic model decides fields/pass-fail). A pure decoder recovers DOB + sex from the DVLA licence number and cross-checks the OCR'd DOB; the `GB` format entry gains UK numbered-field labels and a tolerant licence-number regex. A committed benchmark script scores field extraction over a local (gitignored) image folder. Mirrors the v1.12.18 community pattern: rules in `shared`, consumed by `engine` + `backend`, with unit tests.

**Tech Stack:** TypeScript (ESM), vitest, tsx. npm workspaces: `shared`, `backend`, `engine`.

## Global Constraints

- **Deterministic only** — the decoder, regex, and cross-check are pure functions of input; the cross-check adjusts confidence but MUST NOT by itself flip a pass/fail (it is a signal, not a gate).
- **No new runtime dependency.** Reuse existing OCR service + `tsx` for the harness.
- **No real licence images committed** — images stay gitignored (privacy).
- **Verification gates:** `cd shared && npx tsc --noEmit`, `cd backend && npx tsc --noEmit && npx vitest run`. Engine `tsc` is CI-only (ML deps ~1.5 GB). Run `tsc` before every commit.
- **DVLA licence-number layout (16 chars, 1-based):** `1–5` surname (padded with `9`), `6` decade digit of birth year, `7–8` month of birth (+50 for female → 51–62), `9–10` day of birth, `11` last digit of birth year, `12–13` forename initials (`9` if none), `14` arbitration digit, `15–16` two check characters.

## File structure

- `shared/src/providers/ocr/ukDlNumber.ts` — **new**: `decodeUkDlNumber` + `applyUkDlCrossCheck` (pure).
- `shared/src/providers/ocr/ukDlNumber.test.ts` — **new**: decoder + cross-check tests.
- `shared/src/index.ts` — export the two new functions.
- `shared/src/providers/ocr/internationalIdFormats.ts` — `GB` DL `field_labels` + regex.
- `backend/src/providers/ocr/extractors/InternationalExtractor.ts` — call `applyUkDlCrossCheck` at the end of `extract`.
- `engine/src/providers/ocr/PaddleOCRProvider.ts` — call `applyUkDlCrossCheck` where international extraction finishes.
- `engine/scripts/ocr-benchmark/run.ts`, `engine/scripts/ocr-benchmark/README.md` — **new**: harness.
- `engine/.gitignore` — ignore the harness `images/` + `expected/`.

---

### Task 1: UK DL number decoder (pure, shared)

**Files:**
- Create: `shared/src/providers/ocr/ukDlNumber.ts`
- Test: `shared/src/providers/ocr/ukDlNumber.test.ts`
- Modify: `shared/src/index.ts`

**Interfaces:**
- Produces: `decodeUkDlNumber(raw: string | null | undefined): { dateOfBirth: string | null; sex: 'M' | 'F' | null } | null` and `UK_DL_NUMBER_RE: RegExp`.

- [ ] **Step 1: Write the failing test** — `shared/src/providers/ocr/ukDlNumber.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decodeUkDlNumber, UK_DL_NUMBER_RE } from './ukDlNumber.js'

describe('decodeUkDlNumber', () => {
  // MORGA 657054 SM9IJ → surname MORGA, DOB digits 657054, initials SM
  //   decade 6, month 57 (>50 → female, real month 07), day 05, year-last 4 → 1964-07-05, F
  it('decodes a female licence number (month +50)', () => {
    expect(decodeUkDlNumber('MORGA657054SM9IJ')).toEqual({ dateOfBirth: '1964-07-05', sex: 'F' })
  })

  // decade 8, month 03, day 12, year-last 5 → 1985-03-12, male
  it('decodes a male licence number', () => {
    expect(decodeUkDlNumber('SMITH803125JM9AB')).toEqual({ dateOfBirth: '1985-03-12', sex: 'M' })
  })

  it('ignores spaces and lowercases', () => {
    expect(decodeUkDlNumber('smith 803125 jm9ab')).toEqual({ dateOfBirth: '1985-03-12', sex: 'M' })
  })

  // Real UK cards print field 5 as the 16-char number + space + a 2-digit issue number.
  it('strips the trailing issue number', () => {
    expect(decodeUkDlNumber('SMITH803125JM9AB 12')).toEqual({ dateOfBirth: '1985-03-12', sex: 'M' })
  })

  // Short surnames are padded with 9 (e.g. a 4-letter surname → NAME9).
  it('decodes a 9-padded short surname', () => {
    expect(decodeUkDlNumber('JANI9961031S99TP 69')).toEqual({ dateOfBirth: '1991-11-03', sex: 'F' })
  })

  it('returns null for non-UK / malformed input', () => {
    expect(decodeUkDlNumber('D1234567')).toBeNull()      // German-style
    expect(decodeUkDlNumber('')).toBeNull()
    expect(decodeUkDlNumber(null)).toBeNull()
    expect(decodeUkDlNumber('SMITH809925JM9AB')).toBeNull() // month 99 invalid
  })

  it('UK_DL_NUMBER_RE matches the 16-char structure with a tolerant tail', () => {
    expect(UK_DL_NUMBER_RE.test('MORGA657054SM9IJ')).toBe(true)
    expect(UK_DL_NUMBER_RE.test('SMITH80312 5JM9AB')).toBe(false) // internal space (pre-strip form)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (module missing).

Run: `cd shared && npx vitest run src/providers/ocr/ukDlNumber.test.ts`
Expected: FAIL — cannot find `./ukDlNumber.js`.

- [ ] **Step 3: Implement** `shared/src/providers/ocr/ukDlNumber.ts`:

```ts
// UK (DVLA) driving-licence number: deterministic decode of the DOB + sex that
// the licence number encodes (see the Global Constraints layout). This gives a
// checksum-grade cross-check the free-text OCR fields cannot. Pure functions.

// 5 surname chars (9-padded) · 6 DOB digits · 2 initials (9-padded) · arbitration
// digit · 2 check chars (tolerant tail). Real cards print field 5 as this 16-char
// number + a space + a 1-2 digit ISSUE NUMBER, which must be ignored.
export const UK_DL_NUMBER_RE = /^[A-Z9]{5}\d{6}[A-Z0-9]{2}\d[A-Z0-9]{2}(?:\s*\d{1,2})?$/
// Captures just the 16-char DVLA number, dropping any trailing issue number.
const UK_DL_CORE_RE = /^([A-Z9]{5}\d{6}[A-Z0-9]{2}\d[A-Z0-9]{2})\d{0,2}$/

export interface UkDlDecoded {
  dateOfBirth: string | null // ISO YYYY-MM-DD
  sex: 'M' | 'F' | null
}

export function decodeUkDlNumber(raw: string | null | undefined): UkDlDecoded | null {
  if (!raw) return null
  const m = raw.toUpperCase().replace(/\s+/g, '').match(UK_DL_CORE_RE)
  if (!m) return null
  const n = m[1] // 16-char DVLA number, issue number stripped

  const decade = Number(n[5])
  let month = Number(n.slice(6, 8))
  const day = Number(n.slice(8, 10))
  const yearLast = Number(n[10])
  if ([decade, month, day, yearLast].some(Number.isNaN)) return null

  let sex: 'M' | 'F' = 'M'
  if (month > 50) { sex = 'F'; month -= 50 }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  const yy = decade * 10 + yearLast
  // Birth dates are always in the past → resolve century accordingly.
  const currentYY = new Date().getFullYear() % 100
  const year = (yy > currentYY ? 1900 : 2000) + yy

  const dateOfBirth = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { dateOfBirth, sex }
}
```

- [ ] **Step 4: Add exports** to `shared/src/index.ts` — after the `internationalIdFormats.js` export block (line ~45-52), add:

```ts
export { decodeUkDlNumber, applyUkDlCrossCheck, UK_DL_NUMBER_RE } from './providers/ocr/ukDlNumber.js';
export type { UkDlDecoded } from './providers/ocr/ukDlNumber.js';
```

(`applyUkDlCrossCheck` is added in Task 3; add the export name now so the block is written once — Task 3 makes it resolve. If your tooling errors on the missing symbol before Task 3, split this line so only `decodeUkDlNumber` + `UK_DL_NUMBER_RE` + the type export here, and add `applyUkDlCrossCheck` in Task 3.)

- [ ] **Step 5: Run tests — expect PASS.** `cd shared && npx vitest run src/providers/ocr/ukDlNumber.test.ts`
- [ ] **Step 6: tsc + commit.**

```bash
cd shared && npx tsc --noEmit
git add shared/src/providers/ocr/ukDlNumber.ts shared/src/providers/ocr/ukDlNumber.test.ts shared/src/index.ts
git commit -m "feat(ocr): deterministic UK DVLA licence-number decoder"
```

---

### Task 2: Harden the `GB` driving-licence format (regex + numbered labels)

**Files:**
- Modify: `shared/src/providers/ocr/internationalIdFormats.ts` (the `GB` entry, ~line 101)
- Test: `shared/src/providers/ocr/ukDlNumber.test.ts` (append a format assertion)

**Interfaces:**
- Consumes: `UK_DL_NUMBER_RE` (Task 1). Produces: no new symbols (mutates the `GB` registry entry).

- [ ] **Step 1: Write the failing test** — append to `ukDlNumber.test.ts`:

```ts
import { getCountryFormat } from './internationalIdFormats.js'

describe('GB driving-licence format', () => {
  it('accepts a real UK licence number and exposes numbered-field labels', () => {
    const fmt = getCountryFormat('GB', 'drivers_license')!
    expect(fmt).toBeTruthy()
    expect(fmt.id_number_regex.test('MORGA657054SM9IJ')).toBe(true)
    // numbered-field label for field 4b (expiry) present
    expect(fmt.field_labels.expiry_date.some(r => r.test('4b'))).toBe(true)
    expect(fmt.field_labels.id_number.some(r => r.test('5.'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`4b` / `5.` labels not present; regex may already pass or fail).

Run: `cd shared && npx vitest run src/providers/ocr/ukDlNumber.test.ts`

- [ ] **Step 3: Update the `GB` `drivers_license` entry** in `internationalIdFormats.ts`. Replace its `id_number_regex` and `field_labels` with (import `UK_DL_NUMBER_RE` at the top of the file — `import { UK_DL_NUMBER_RE } from './ukDlNumber.js'`):

```ts
      {
        type: 'drivers_license',
        id_number_regex: UK_DL_NUMBER_RE,
        field_labels: {
          ...ENGLISH_LABELS,
          // UK/EU numbered layout: 1 surname · 2 forenames · 3 DOB/place ·
          // 4a issue · 4b expiry · 4c authority · 5 licence no · 8 address
          name: [/^1\.?$/, /^2\.?$/, /surname/i, ...ENGLISH_LABELS.name],
          date_of_birth: [/^3\.?$/, ...ENGLISH_LABELS.date_of_birth],
          expiry_date: [/^4b\.?$/i, /valid\s*to/i, ...ENGLISH_LABELS.expiry_date],
          id_number: [/^5\.?$/, /driving\s*licence/i, /dvla/i, ...ENGLISH_LABELS.id_number],
          address: [/^8\.?$/, ...ENGLISH_LABELS.address],
          issuing_authority: [/^4c\.?$/i, /dvla/i, ...ENGLISH_LABELS.issuing_authority],
        },
        date_format: 'DMY',
        has_mrz: false,
      },
```

- [ ] **Step 4: Run tests — expect PASS.** `cd shared && npx vitest run src/providers/ocr/ukDlNumber.test.ts`
- [ ] **Step 5: tsc + commit.**

```bash
cd shared && npx tsc --noEmit
git add shared/src/providers/ocr/internationalIdFormats.ts shared/src/providers/ocr/ukDlNumber.test.ts
git commit -m "feat(ocr): harden GB DL format — DVLA regex + numbered-field labels"
```

---

### Task 3: DOB/sex cross-check + wire into both extractors

**Files:**
- Modify: `shared/src/providers/ocr/ukDlNumber.ts` (add `applyUkDlCrossCheck`)
- Test: `shared/src/providers/ocr/ukDlNumber.test.ts` (append cross-check tests)
- Modify: `backend/src/providers/ocr/extractors/InternationalExtractor.ts` (end of `extract`)
- Modify: `engine/src/providers/ocr/PaddleOCRProvider.ts` (after `extractInternationalDocument` runs)

**Interfaces:**
- Consumes: `decodeUkDlNumber` (Task 1). Produces: `applyUkDlCrossCheck(target, country?): void`.

- [ ] **Step 1: Write the failing test** — append to `ukDlNumber.test.ts`:

```ts
import { applyUkDlCrossCheck } from './ukDlNumber.js'

describe('applyUkDlCrossCheck', () => {
  it('fills a missing DOB from the licence number', () => {
    const o: any = { document_number: 'SMITH803125JM9AB', confidence_scores: {} }
    applyUkDlCrossCheck(o, 'GB')
    expect(o.date_of_birth).toBe('1985-03-12')
    expect(o.confidence_scores.date_of_birth).toBeGreaterThanOrEqual(0.9)
  })
  it('raises confidence when OCR DOB agrees with the number', () => {
    const o: any = { document_number: 'SMITH803125JM9AB', date_of_birth: '1985-03-12', confidence_scores: { date_of_birth: 0.6 } }
    applyUkDlCrossCheck(o, 'GB')
    expect(o.confidence_scores.date_of_birth).toBeGreaterThanOrEqual(0.95)
  })
  it('leaves a mismatch untouched (soft signal, not a gate)', () => {
    const o: any = { document_number: 'SMITH803125JM9AB', date_of_birth: '1990-01-01', confidence_scores: { date_of_birth: 0.6 } }
    applyUkDlCrossCheck(o, 'GB')
    expect(o.date_of_birth).toBe('1990-01-01')
    expect(o.confidence_scores.date_of_birth).toBe(0.6)
  })
  it('does nothing for non-GB country', () => {
    const o: any = { document_number: 'SMITH803125JM9AB', confidence_scores: {} }
    applyUkDlCrossCheck(o, 'DE')
    expect(o.date_of_birth).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`applyUkDlCrossCheck` not exported).
- [ ] **Step 3: Implement** — append to `ukDlNumber.ts`:

```ts
// Structural subset of OCRData the cross-check needs (avoids a type-path import).
export interface UkDlCrossCheckTarget {
  document_number?: string | null
  date_of_birth?: string | null
  confidence_scores?: Record<string, number> | null
}

/**
 * When a GB driving licence is detected, use the DOB encoded in the licence
 * number to (a) fill a missing DOB, or (b) raise confidence when it agrees with
 * the OCR'd DOB. A disagreement is left untouched — a soft signal, never a gate.
 */
export function applyUkDlCrossCheck(target: UkDlCrossCheckTarget, country?: string | null): void {
  if ((country || '').toUpperCase() !== 'GB') return
  const decoded = decodeUkDlNumber(target.document_number)
  if (!decoded?.dateOfBirth) return
  const scores = (target.confidence_scores = target.confidence_scores || {})
  if (!target.date_of_birth) {
    target.date_of_birth = decoded.dateOfBirth
    scores.date_of_birth = Math.max(scores.date_of_birth ?? 0, 0.9)
  } else if (target.date_of_birth === decoded.dateOfBirth) {
    scores.date_of_birth = Math.max(scores.date_of_birth ?? 0, 0.95)
  }
}
```

- [ ] **Step 4: Run shared tests — expect PASS.** `cd shared && npx vitest run src/providers/ocr/ukDlNumber.test.ts`
- [ ] **Step 5: Wire into the backend extractor.** In `backend/src/providers/ocr/extractors/InternationalExtractor.ts`: add `import { applyUkDlCrossCheck } from '@idswyft/shared';` at the top, and as the LAST statement of the `extract(flatLines, ocrData, format, country)` method body (after all field extraction), add:

```ts
    // UK DL: cross-check DOB against the licence number (deterministic, non-gating)
    applyUkDlCrossCheck(ocrData, country);
```

- [ ] **Step 6: Wire into the engine extractor.** In `engine/src/providers/ocr/PaddleOCRProvider.ts`: add `applyUkDlCrossCheck` to the existing `@idswyft/shared` import, and immediately AFTER the `this.extractInternationalDocument(result.lines, ocrData, effectiveFormat, country)` call (the international branch), add:

```ts
      applyUkDlCrossCheck(ocrData, country);
```

- [ ] **Step 7: Verify + commit.**

```bash
cd shared && npx tsc --noEmit
cd ../backend && npx tsc --noEmit && npx vitest run
git add shared/src/providers/ocr/ukDlNumber.ts shared/src/providers/ocr/ukDlNumber.test.ts \
        backend/src/providers/ocr/extractors/InternationalExtractor.ts \
        engine/src/providers/ocr/PaddleOCRProvider.ts
git commit -m "feat(ocr): UK DL DOB/sex cross-check wired into both extractors"
```

(Engine tsc is verified by CI.)

---

### Task 4: Tracked OCR benchmark harness

**Files:**
- Create: `engine/scripts/ocr-benchmark/run.ts`
- Create: `engine/scripts/ocr-benchmark/README.md`
- Modify: `engine/.gitignore` (create if absent)

**Interfaces:**
- Consumes: the engine's existing `OCRService.processDocumentFromBuffer`. Produces: a runnable script (no exported symbols).

- [ ] **Step 1: Confirm the OCR entrypoint.** Run: `grep -n "processDocumentFromBuffer" engine/src/services/ocr.ts` — note the exact signature `(buffer, documentType, issuingCountry?, llmConfig?)`. If it differs, adapt the call in Step 2.

- [ ] **Step 2: Create `engine/scripts/ocr-benchmark/run.ts`:**

```ts
/**
 * OCR benchmark harness (git-tracked; images are NOT).
 *
 * Drop card images into ./images/ (optionally ./expected/<name>.json ground truth),
 * then:  npx tsx engine/scripts/ocr-benchmark/run.ts [--country GB] [--type drivers_license]
 *
 * Prints per-image + aggregate field-extraction results and exits non-zero if any
 * image extracts zero target fields (so it can gate later).
 */
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, extname, basename } from 'path'
import { OCRService } from '../../src/services/ocr.js'

const DIR = join(import.meta.dirname, 'images')
const EXPECTED = join(import.meta.dirname, 'expected')
const FIELDS = ['name', 'date_of_birth', 'document_number', 'expiration_date'] as const

const arg = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined }
const country = arg('--country')
const docType = arg('--type') || 'auto'

async function main() {
  if (!existsSync(DIR)) { console.error(`No images dir: ${DIR} (create it and add cards).`); process.exit(2) }
  const files = readdirSync(DIR).filter(f => /\.(png|jpe?g)$/i.test(f))
  if (files.length === 0) { console.error(`No images in ${DIR}.`); process.exit(2) }

  const ocr = new OCRService()
  let ok = true
  const totals: Record<string, number> = {}

  for (const file of files) {
    const buf = readFileSync(join(DIR, file))
    let data: any
    try { data = await ocr.processDocumentFromBuffer(buf, docType, country) }
    catch (e) { console.log(`✗ ${file}: extraction threw — ${(e as Error).message}`); ok = false; continue }

    const expected = readExpected(file)
    const found = FIELDS.filter(f => data?.[f])
    found.forEach(f => { totals[f] = (totals[f] || 0) + 1 })
    if (found.length === 0) ok = false

    const parts = FIELDS.map(f => {
      const got = data?.[f]
      if (!got) return `${f}=—`
      if (expected && expected[f] != null) return `${f}=${got === expected[f] ? '✓' : `✗(${got})`}`
      return `${f}=${JSON.stringify(got)}`
    })
    console.log(`${found.length ? '•' : '✗'} ${file} [${data?.detected_document_type || docType}] ${parts.join('  ')}`)
  }

  console.log(`\nAggregate over ${files.length} image(s):`)
  for (const f of FIELDS) console.log(`  ${f}: ${totals[f] || 0}/${files.length}`)
  process.exit(ok ? 0 : 1)
}

function readExpected(imageFile: string): Record<string, string> | null {
  const p = join(EXPECTED, `${basename(imageFile, extname(imageFile))}.json`)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

main()
```

- [ ] **Step 3: Create `engine/scripts/ocr-benchmark/README.md`:**

```markdown
# OCR Benchmark Harness

Measure document field-extraction accuracy. The harness is committed; images are not.

## Use
1. Put card images in `images/` (`.png`/`.jpg`). Never commit real licences.
2. (Optional) Add ground truth per image: `expected/<same-name>.json` with keys
   `name`, `date_of_birth`, `document_number`, `expiration_date`.
3. Run:
   ```
   npx tsx engine/scripts/ocr-benchmark/run.ts --country GB --type drivers_license
   ```
   Omit flags for auto-detection. Output shows per-image + aggregate field hits;
   with ground truth, ✓/✗ per field. Exit code 1 if any image extracts 0 fields.

## Notes
- Requires the engine's OCR models (run inside the engine env).
- Deterministic — same image yields the same result.
```

- [ ] **Step 4: Ignore the images.** Append to `engine/.gitignore` (create if missing):

```
# OCR benchmark inputs (never commit real licence images)
scripts/ocr-benchmark/images/
scripts/ocr-benchmark/expected/
```

- [ ] **Step 5: Verify + commit.** (The script needs the engine env to *run*; here just confirm it is committed and the gitignore holds.)

```bash
git check-ignore engine/scripts/ocr-benchmark/images/x.png   # prints the path = ignored ✓
git add engine/scripts/ocr-benchmark/run.ts engine/scripts/ocr-benchmark/README.md engine/.gitignore
git commit -m "feat(engine): tracked OCR benchmark harness (images gitignored)"
```

---

## Self-Review

- **Spec coverage:** A1 decoder → Task 1; A1 cross-check → Task 3; A2 regex tolerance → Tasks 1-2 (`UK_DL_NUMBER_RE`); A3 numbered labels → Task 2; A4 dates/classification → Task 2 (`date_format: 'DMY'`, format returned by `getCountryFormat`); A5 tests → Tasks 1-3; Part B harness → Task 4. ✓
- **Placeholders:** none — every code step has literal code; the harness OCR call is confirmed in Task 4 Step 1. ✓
- **Type consistency:** `decodeUkDlNumber` / `applyUkDlCrossCheck` / `UK_DL_NUMBER_RE` / `UkDlDecoded` / `UkDlCrossCheckTarget` are defined in Task 1/3 and consumed by exact name in Tasks 2-3 and the extractors. ✓
- **Determinism:** cross-check only fills-or-raises-confidence, never lowers/rejects — consistent with the invariant. ✓
- **Risk:** the two extractor edits are one-line calls at the end of existing methods (behaviour-additive); backend covered by `tsc` + vitest, engine by CI.
