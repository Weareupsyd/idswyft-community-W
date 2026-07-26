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
