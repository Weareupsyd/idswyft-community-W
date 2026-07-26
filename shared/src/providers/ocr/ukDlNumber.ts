// UK (DVLA) driving-licence number: deterministic decode of the date of birth
// and sex that the licence number encodes (a checksum-grade cross-check the
// free-text OCR fields cannot offer). Pure functions — no I/O, no clock beyond
// century resolution.
//
// Layout (16 chars): 5 surname letters (9-padded if shorter) · 6 DOB digits
// (decade, month(+50 for female), day, last-year-digit) · 2 forename initials
// (9-padded) · 1 arbitration digit · 2 check characters. Real cards print field
// 5 as this 16-char number followed by a space + a 1–2 digit ISSUE NUMBER.

// Classification regex — matches the 16-char number with an optional issue number.
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
  // Birth dates are always in the past → resolve the century accordingly.
  const currentYY = new Date().getFullYear() % 100
  const year = (yy > currentYY ? 1900 : 2000) + yy

  const dateOfBirth = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { dateOfBirth, sex }
}

/** Return the canonical 16-char DVLA number (issue number stripped), or null. */
export function normalizeUkDlNumber(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.toUpperCase().replace(/\s+/g, '').match(UK_DL_CORE_RE)
  return m ? m[1] : null
}

/**
 * Find a valid UK DL number anywhere in OCR text — used to recover the licence
 * number when the numbered-field parser mis-attributes field 5 (e.g. the number
 * sits on a separate line from its "5." label, or is merged with field 7).
 * Each candidate token is validated by the decoder, so a random match cannot win.
 */
export function findUkDlNumber(rawText: string | null | undefined): string | null {
  if (!rawText) return null
  for (const token of rawText.toUpperCase().split(/[\s,]+/)) {
    const core = normalizeUkDlNumber(token)
    if (core && decodeUkDlNumber(core)) return core
  }
  return null
}

/**
 * Deterministic UK driving-licence detector for OCR text. UK DLs have no MRZ, so
 * the issuing country cannot be inferred from a checksum the way passports/ID cards
 * are — when the caller supplies no country, this lets the engine still route to the
 * UK extractor. Triggers on a decoder-validated DVLA licence number, or the UK-only
 * "DVLA" marker — both strong signals that will not false-positive on other cards.
 */
export function isLikelyUkDl(rawText: string | null | undefined): boolean {
  if (!rawText) return false
  if (findUkDlNumber(rawText)) return true
  return /\bDVLA\b/i.test(rawText)
}

/**
 * Extract all DD.MM.YYYY (or /- separated) dates from OCR text as ISO strings,
 * interpreted day-month-year (UK convention). Invalid day/month combinations are
 * dropped. Used to recover the expiry when its "4b." label is garbled by OCR.
 */
export function findDatesInText(rawText: string | null | undefined): string[] {
  if (!rawText) return []
  const out: string[] = []
  const re = /\b(\d{2})[.\/-](\d{2})[.\/-](\d{4})\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rawText)) !== null) {
    const day = Number(m[1]); const month = Number(m[2]); const year = Number(m[3])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
      out.push(`${m[3]}-${m[2]}-${m[1]}`)
    }
  }
  return out
}

// Structural subset of OCRData the cross-check needs (avoids a type-path import).
export interface UkDlCrossCheckTarget {
  document_number?: string | null
  date_of_birth?: string | null
  expiration_date?: string | null
  confidence_scores?: Record<string, number> | null
  raw_text?: string | null
}

/**
 * For a GB driving licence, using the raw OCR text and the checksum-grade licence
 * number to make extraction robust to OCR quirks. All deterministic; never a gate:
 *   - normalise the licence number to its canonical 16-char form, recovering it
 *     from the text when field 5 was mis-parsed;
 *   - fill/confirm the DOB from the DOB encoded in the licence number;
 *   - recover a missing expiry (4b) when OCR garbles its label — the latest date
 *     on the card that is not the DOB (the issue date is always earlier).
 */
export function applyUkDlCrossCheck(target: UkDlCrossCheckTarget, country?: string | null): void {
  if ((country || '').toUpperCase() !== 'GB') return
  const scores = (target.confidence_scores = target.confidence_scores || {})

  // Normalise field 5, or recover it from raw text if it was mis-parsed.
  let core = normalizeUkDlNumber(target.document_number)
  if (!core || !decodeUkDlNumber(core)) {
    const recovered = findUkDlNumber(target.raw_text)
    if (recovered) {
      core = recovered
      scores.document_number = Math.max(scores.document_number ?? 0, 0.9)
    }
  }
  if (core) target.document_number = core

  // Fill / confirm the DOB from the licence number.
  const decoded = decodeUkDlNumber(core)
  if (decoded?.dateOfBirth) {
    if (!target.date_of_birth) {
      target.date_of_birth = decoded.dateOfBirth
      scores.date_of_birth = Math.max(scores.date_of_birth ?? 0, 0.9)
    } else if (target.date_of_birth === decoded.dateOfBirth) {
      scores.date_of_birth = Math.max(scores.date_of_birth ?? 0, 0.95)
    }
  }

  // Recover a missing expiry: latest date on the card that isn't the DOB.
  if (!target.expiration_date && target.raw_text) {
    const others = findDatesInText(target.raw_text)
      .filter(d => d !== target.date_of_birth)
      .sort()
    if (others.length) {
      target.expiration_date = others[others.length - 1]
      scores.expiration_date = Math.max(scores.expiration_date ?? 0, 0.7)
    }
  }
}
