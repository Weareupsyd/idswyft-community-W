/**
 * Extract "LABEL: value" style fields from a block of raw OCR / barcode text.
 *
 * Used to pick structured address fields (village, parish, sub-county, district)
 * out of raw_text lines like:
 *   VILLAGE: UPPER NSOOBA
 *   PARISH: MULAGO III
 *   S.COUNTY: KAWEMPE DIVISION
 *   DISTRICT: KAMPALA
 *
 * Returns only fields whose label was actually present in the text.
 */
export interface UgAddressFields {
  address?: string;
  district?: string;
  sub_county?: string;
  parish?: string;
  village?: string;
}

/** Normalize a key from "S.COUNTY" / "SUB-COUNTY" / "sub county" → canonical form. */
function normalizeKey(key: string): string | null {
  const k = key.toUpperCase().replace(/[^A-Z]/g, '');
  if (k === 'VILLAGE') return 'village';
  if (k === 'PARISH') return 'parish';
  if (k === 'DISTRICT') return 'district';
  if (k === 'SCOUNTY' || k === 'SUBCOUNTY' || k === 'COUNTY') return 'sub_county';
  if (k === 'ADDRESS' || k === 'ADDR') return 'address';
  return null;
}

/**
 * Parse labeled fields from arbitrary raw text.
 * Handles lines like `LABEL:VALUE`, `LABEL: VALUE`, `LABEL - VALUE`, etc.
 * Reads until the next known label or a line that looks like MRZ data
 * (long runs of uppercase letters/digits/`<`).
 */
export function extractLabeledFields(rawText: string): UgAddressFields {
  const out: UgAddressFields = {};
  if (!rawText) return out;

  // Known label keys (normalized form → pattern).
  const labelPattern = /\b(ADDRESS|ADDR|VILLAGE|PARISH|S\.?\s*COUNTY|SUB[\s\-]?COUNTY|COUNTY|DISTRICT)\s*[:\-=]\s*/gi;

  // Collect matches in document order.
  const matches: Array<{ key: string; start: number; labelEnd: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = labelPattern.exec(rawText)) !== null) {
    matches.push({
      key: normalizeKey(m[1]) as string,
      start: m.index,
      labelEnd: m.index + m[0].length,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    if (!cur.key) continue;
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : rawText.length;
    let value = rawText.slice(cur.labelEnd, nextStart);

    // Stop the value at the first MRZ-looking line (long run of A-Z, 0-9, `<` with no spaces)
    // e.g. "IDUGA0213337836CM88O8210G1JDF<"
    value = value
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0)
      // Drop lines that are clearly MRZ / machine-readable code
      .filter(l => !/^[A-Z0-9<]{20,}$/.test(l))
      .join(' ')
      .trim();

    // Trim common trailing junk left after slicing at the next label
    value = value.replace(/\s+/g, ' ').trim();

    if (value && !(out as any)[cur.key]) {
      (out as any)[cur.key] = value;
    }
  }

  return out;
}

/**
 * Merge extracted labeled address fields into a QR payload, filling in any
 * blank fields without overwriting ones already populated.
 */
export function mergeLabeledAddressFields<T extends UgAddressFields>(
  payload: T,
  rawText: string | undefined | null,
): T {
  if (!rawText) return payload;
  const labeled = extractLabeledFields(rawText);
  const merged: any = { ...payload };
  for (const k of ['address', 'district', 'sub_county', 'parish', 'village'] as const) {
    if (!merged[k] && labeled[k]) {
      merged[k] = labeled[k];
    }
  }
  // If address is still missing, build a composite from the Ugandan address parts
  if (!merged.address) {
    const parts = [merged.village, merged.parish, merged.sub_county, merged.district]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    if (parts.length > 0) {
      merged.address = parts.join(', ');
    }
  }
  return merged;
}
