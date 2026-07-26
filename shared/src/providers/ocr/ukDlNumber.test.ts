import { describe, it, expect } from 'vitest'
import { decodeUkDlNumber, applyUkDlCrossCheck, findUkDlNumber, normalizeUkDlNumber, isLikelyUkDl, UK_DL_NUMBER_RE } from './ukDlNumber.js'
import { getCountryFormat } from './internationalIdFormats.js'

// NOTE: all licence numbers below are SYNTHETIC — never real card data.

describe('decodeUkDlNumber', () => {
  // SMITH · 80 3125 · JM 9 AB → decade 8, month 03, day 12, year-digit 5 → 1985-03-12
  it('decodes a male licence number', () => {
    expect(decodeUkDlNumber('SMITH803125JM9AB')).toEqual({ dateOfBirth: '1985-03-12', sex: 'M' })
  })
  // month field 53 → female (53-50 = 03)
  it('decodes a female licence number (month +50)', () => {
    expect(decodeUkDlNumber('SMITH853125JM9AB')).toEqual({ dateOfBirth: '1985-03-12', sex: 'F' })
  })
  it('ignores spaces and lowercases', () => {
    expect(decodeUkDlNumber('smith 803125 jm9ab')).toEqual({ dateOfBirth: '1985-03-12', sex: 'M' })
  })
  // Real cards append a space + a 2-digit issue number after the 16-char number.
  it('strips the trailing issue number', () => {
    expect(decodeUkDlNumber('SMITH803125JM9AB 12')).toEqual({ dateOfBirth: '1985-03-12', sex: 'M' })
  })
  // Short surnames are 9-padded (e.g. a 3-letter surname → LEE99).
  it('decodes a 9-padded short surname', () => {
    expect(decodeUkDlNumber('LEE99803125JM9AB 12')).toEqual({ dateOfBirth: '1985-03-12', sex: 'M' })
  })
  it('returns null for non-UK / malformed input', () => {
    expect(decodeUkDlNumber('D1234567')).toBeNull()
    expect(decodeUkDlNumber('')).toBeNull()
    expect(decodeUkDlNumber(null)).toBeNull()
    expect(decodeUkDlNumber('SMITH809925JM9AB')).toBeNull() // month 99 invalid
    expect(decodeUkDlNumber('SMITH800032JM9AB')).toBeNull() // day 00 invalid
  })
  it('UK_DL_NUMBER_RE matches the structure incl. optional issue number', () => {
    expect(UK_DL_NUMBER_RE.test('SMITH803125JM9AB')).toBe(true)
    expect(UK_DL_NUMBER_RE.test('SMITH803125JM9AB 12')).toBe(true)
    expect(UK_DL_NUMBER_RE.test('LEE99803125JM9AB')).toBe(true)
    expect(UK_DL_NUMBER_RE.test('D1234567')).toBe(false)
  })
})

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
  it('does nothing for a non-GB country', () => {
    const o: any = { document_number: 'SMITH803125JM9AB', confidence_scores: {} }
    applyUkDlCrossCheck(o, 'DE')
    expect(o.date_of_birth).toBeUndefined()
  })
  // The numbered-field parser sometimes drops field 5 (separate line / merged with 7).
  it('recovers the licence number from raw OCR text when field 5 is missing', () => {
    const o: any = {
      document_number: null,
      raw_text: 'UK DRIVING LICENCE\n1. NAME\n3. 12.03.1985 IRAN\n 5. SMITH803125JM9AB 12   7. o\n9. AM/B',
      confidence_scores: {},
    }
    applyUkDlCrossCheck(o, 'GB')
    expect(o.document_number).toBe('SMITH803125JM9AB')
    expect(o.date_of_birth).toBe('1985-03-12')
  })
  it('normalizes an extracted number to its 16-char canonical form (issue no. stripped)', () => {
    const o: any = { document_number: 'SMITH803125JM9AB49', confidence_scores: {} }
    applyUkDlCrossCheck(o, 'GB')
    expect(o.document_number).toBe('SMITH803125JM9AB')
  })
})

describe('findUkDlNumber / normalizeUkDlNumber', () => {
  it('normalizeUkDlNumber strips the issue number', () => {
    expect(normalizeUkDlNumber('SMITH803125JM9AB 12')).toBe('SMITH803125JM9AB')
    expect(normalizeUkDlNumber('SMITH803125JM9AB49')).toBe('SMITH803125JM9AB')
    expect(normalizeUkDlNumber('not-a-number')).toBeNull()
  })
  it('findUkDlNumber locates a valid number in noisy OCR text', () => {
    expect(findUkDlNumber('5.\nSMITH803125JM9AB 12\n8. address')).toBe('SMITH803125JM9AB')
    expect(findUkDlNumber('no licence number here')).toBeNull()
  })
})

describe('isLikelyUkDl', () => {
  it('detects a UK DL from a licence number in the text', () => {
    expect(isLikelyUkDl('3. 12.03.1985 IRAN\n5. SMITH803125JM9AB 12')).toBe(true)
  })
  it('detects a UK DL from the DVLA marker', () => {
    expect(isLikelyUkDl('DRIVING LICENCE\n4c. DVLA\n8. address')).toBe(true)
  })
  it('does not fire on unrelated documents', () => {
    expect(isLikelyUkDl('CALIFORNIA DRIVER LICENSE DL D1234567')).toBe(false)
    expect(isLikelyUkDl('')).toBe(false)
    expect(isLikelyUkDl(null)).toBe(false)
  })
})

describe('GB driving-licence format', () => {
  const fmt = getCountryFormat('GB', 'drivers_license')!

  it('is registered', () => {
    expect(fmt).toBeTruthy()
    expect(fmt.date_format).toBe('DMY')
  })
  it('accepts a real-shaped UK licence number (incl. issue number + 9-padded surname)', () => {
    expect(fmt.id_number_regex.test('SMITH803125JM9AB 12')).toBe(true)
    expect(fmt.id_number_regex.test('LEE99803125JM9AB')).toBe(true)
  })
  it('exposes the UK numbered-field label markers', () => {
    expect(fmt.field_labels.name.some(r => r.test('1'))).toBe(true)
    expect(fmt.field_labels.date_of_birth.some(r => r.test('3'))).toBe(true)
    expect(fmt.field_labels.expiry_date.some(r => r.test('4b'))).toBe(true)
    expect(fmt.field_labels.id_number.some(r => r.test('5.'))).toBe(true)
    expect(fmt.field_labels.address.some(r => r.test('8'))).toBe(true)
  })
})
