# UK Driving Licence Recognition — Hardening + Benchmark Harness — Design

**Date:** 2026-07-26
**Status:** Approved (brainstorming) → pending spec review → writing-plans

## Goal

Make the engine recognise **UK (DVLA) driving licences** reliably, and rebuild a **git-tracked benchmark harness** so document-extraction accuracy can be measured repeatably (UK, US, or any country) whenever sample images are available.

Two parts, independent enough to land separately but scoped together:

- **Part A — Harden UK DL extraction rules** (deterministic; no dataset required).
- **Part B — Rebuild a tracked OCR benchmark harness** (the prior one was untracked and lost with a deleted local repo).

## Context

- UK DL support already partly exists: `shared/src/providers/ocr/internationalIdFormats.ts` has a `GB` entry with a `drivers_license` format (licence-number regex, English field labels, `DMY`, `has_mrz: false`), and the EU driving-licence header regex (`InternationalExtractor.ts` / `PaddleOCRProvider.ts`) already matches "DRIVING LICENCE".
- The recent community fix (v1.12.18, `internationalIdFormats.ts` + engine/backend `mrz.ts` + `extract.ts`) established the pattern this work mirrors: deterministic rules in `shared`, consumed by `engine` + `backend`, with unit tests.
- **No sample dataset is currently available** (lost). Part A therefore works from the public DVLA licence specification; Part B rebuilds the ability to validate against images once they exist.

## Architectural invariant

All extraction/decision logic stays **deterministic** — no probabilistic model decides field mapping or pass/fail. The UK licence-number decoder, regex, and cross-checks are pure functions of the input. (OCR text-reading remains the only ML step, unchanged, behind its provider interface.)

---

## Part A — Harden UK DL extraction rules

### A1. Licence-number decoder + cross-check (the highest-value addition)

The DVLA 16-character licence number is deterministically structured; the birth date and sex are encoded in it, giving a self-consistency check no free-text OCR field offers:

```
Positions (1-based):
  1–5    First five letters of surname (padded with 9s if shorter)
  6      Decade digit of year of birth
  7–8    Month of birth (+50 added for female → 51–62)
  9–10   Day of birth
  11     Last digit of year of birth
  12–13  Initials of first two forenames (9 if only one)
  14     Arbitrary digit disambiguating identical details (usually 9)
  15–16  Two computer check characters
```

**Deliverable:** a pure function
`decodeUkDlNumber(number: string): { dateOfBirth: string | null; sex: 'M' | 'F' | null } | null`
in `shared/src/providers/ocr/` (co-located with the id-format registry). It:
- Returns `null` for anything not matching the UK structure.
- Extracts sex from the month field (`>50` → female, subtract 50 to recover the month).
- Reconstructs DOB — the two-digit-year century resolved with the same field-semantic rule the community fix introduced for MRZ birth dates (birth dates are always in the past).

**Cross-check usage:** when a UK DL is detected, if the decoded DOB/sex is available it is compared against the OCR-extracted `date_of_birth`; agreement raises confidence for those fields (deterministic), disagreement is surfaced as a soft signal. This is a consistency check, **not** a new gate — it must not, by itself, flip a pass/fail.

### A2. Regex tolerance

The existing `GB` licence-number regex (`^[A-Z]{5}\d{6}[A-Z0-9]{2}\d[A-Z]{2}$`) encodes an assumption about the trailing check characters that a real card may not match (the last two are often digits, not letters). Without a sample we do not guess blindly: the **decoder** (A1) is authoritative for structure, and the regex is loosened to accept the well-established prefix (5 letters + 6 DOB digits + 2 initials) with a tolerant tail, so classification does not fail on trailing-character variation. The exact tail is refined in Part B once images exist.

### A3. UK numbered-field labels

EU licences (UK included) use the harmonised numbered layout. Add UK/English label patterns so the EU numbered-field extractor maps them:

```
1  surname            2  first names        3  DOB + place of birth
4a issue date         4b expiry date        4c issuing authority (DVLA)
5  licence number     8  address
```

Extend the `GB` `drivers_license` `field_labels` (building on `ENGLISH_LABELS`) with these numbered markers and DVLA-specific terms (`DVLA`, `licence no`, `driving licence`).

### A4. Dates + classification

Confirm `DMY` handling for UK dates and that a card with the EU DL header + a matching licence number classifies as `drivers_license` / `GB`. No change expected here beyond verification; note any gap found.

### A5. Tests

Unit tests (deterministic, mirroring the MRZ tests) for:
- `decodeUkDlNumber` — valid male/female numbers decode to the right DOB + sex; malformed input → `null`; the century rule.
- The loosened regex accepts representative UK numbers and rejects clearly non-UK ones.

### Part A files

- `shared/src/providers/ocr/internationalIdFormats.ts` — `GB` DL `field_labels` + regex; export the decoder.
- `shared/src/providers/ocr/ukDlNumber.ts` — **new**: `decodeUkDlNumber` (+ re-export from `shared/src/index.ts`).
- `shared/src/providers/ocr/ukDlNumber.test.ts` — **new**: decoder + regex tests.
- `engine/src/providers/ocr/PaddleOCRProvider.ts` and/or `backend/src/providers/ocr/extractors/InternationalExtractor.ts` — apply the DOB/sex cross-check where UK DL fields are assembled (mirrors where MRZ enrichment happens).

---

## Part B — Tracked OCR benchmark harness

A committed, runnable harness so extraction accuracy is measurable — never lost again.

### Structure

```
engine/scripts/ocr-benchmark/
  run.ts          # runs each image in a folder through the engine extract path, scores fields
  README.md       # how to add images, run, read the score
  images/         # gitignored (.gitignore entry); place UK/US/etc. cards here
  expected/       # optional per-image ground-truth JSON (gitignored) for scoring
```

- **`run.ts`** iterates `images/`, calls the engine's front-extraction (`/extract/front`, or the in-process `OCRService` if simpler), and prints per-image + aggregate results: which of {name, date_of_birth, document_number, expiry, classification} were extracted, and — when an `expected/<image>.json` exists — whether they match ground truth. Exit non-zero if a target score is missed (so it can gate later).
- **The harness is committed; images/ground-truth are gitignored** (add `.gitignore` entries). A README documents dropping images in and running (`npx tsx engine/scripts/ocr-benchmark/run.ts`).
- No new heavy dependency — reuse the engine's existing OCR service + `tsx`.

### Part B files

- `engine/scripts/ocr-benchmark/run.ts`, `README.md` — **new**.
- `engine/.gitignore` (or root) — ignore `scripts/ocr-benchmark/images/` + `expected/`.

---

## Testing & verification

- `shared` + `backend` tsc; `backend` vitest (existing suite + new `ukDlNumber` tests). Engine tsc via CI (ML deps too large locally).
- The benchmark harness is exercised manually once images exist; it is not part of CI (no committed images).

## Success criteria

- `decodeUkDlNumber` correctly decodes DOB + sex from UK licence numbers (unit-tested), and the UK DL cross-check runs where fields are assembled.
- UK DL classification + numbered-field labels no longer fail on trailing-character or label variation.
- A committed, documented benchmark harness exists; dropping images into `images/` and running it produces a per-field score.

## Out of scope

- Fine-tuning / retraining the PaddleOCR model (a separate, much larger effort; not how extraction rules are decided).
- Non-UK countries (the harness is generic, but rule work here is UK-only).
- Committing any real licence images (privacy; images stay gitignored).

## Open items (resolved once a sample exists)

- Exact trailing-character pattern of the DVLA number (A2) — refined against a real card via the harness.
- Any UK-specific OCR misreads (e.g. merged lines) — identified from real `raw_text`.
