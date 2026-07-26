/**
 * OCR benchmark harness (git-tracked; the images are NOT — see .gitignore).
 *
 * Drop card images under ./images/<country>/ (e.g. images/uk/, images/us/),
 * optionally with ground truth at ./expected/<image-basename>.json, then:
 *
 *   npx tsx engine/scripts/ocr-benchmark/run.ts --country GB [--type drivers_license]
 *
 * Prints per-image + aggregate field-extraction results and exits non-zero if any
 * image extracts zero target fields (so it can gate a pipeline later).
 */
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, extname, basename } from 'path'
import { OCRService } from '../../src/services/ocr.js'

const ROOT = join(import.meta.dirname, 'images')
const EXPECTED = join(import.meta.dirname, 'expected')
const FIELDS = ['name', 'date_of_birth', 'document_number', 'expiration_date'] as const
// ISO country → image subfolder.
const COUNTRY_DIR: Record<string, string> = { GB: 'uk', US: 'us' }

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const country = arg('--country')?.toUpperCase()
const docType = arg('--type') || 'auto'
const scanDir = country ? join(ROOT, COUNTRY_DIR[country] || country.toLowerCase()) : ROOT

function collectImages(base: string): string[] {
  if (!existsSync(base)) return []
  const out: string[] = []
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const p = join(base, entry.name)
    if (entry.isDirectory()) out.push(...collectImages(p))
    else if (/\.(png|jpe?g)$/i.test(entry.name)) out.push(p)
  }
  return out.sort()
}

function readExpected(imagePath: string): Record<string, string> | null {
  const p = join(EXPECTED, `${basename(imagePath, extname(imagePath))}.json`)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

async function main(): Promise<void> {
  const files = collectImages(scanDir)
  if (files.length === 0) {
    console.error(`No images under ${scanDir}. Drop cards there (see README.md).`)
    process.exit(2)
  }

  const ocr = new OCRService()
  let ok = true
  const totals: Record<string, number> = {}

  for (const file of files) {
    let data: any = null
    try {
      data = await ocr.processDocumentFromBuffer(readFileSync(file), docType, country)
    } catch (e) {
      console.log(`✗ ${basename(file)}: extraction threw — ${(e as Error).message}`)
      ok = false
      continue
    }

    const expected = readExpected(file)
    const found = FIELDS.filter(f => data?.[f])
    found.forEach(f => { totals[f] = (totals[f] || 0) + 1 })
    if (found.length === 0) ok = false

    const parts = FIELDS.map(f => {
      const got = data?.[f]
      if (!got) return `${f}=—`
      if (expected?.[f] != null) return `${f}=${got === expected[f] ? '✓' : `✗(${got})`}`
      return `${f}=${JSON.stringify(got)}`
    })
    console.log(`${found.length ? '•' : '✗'} ${basename(file)} [${data?.detected_document_type || docType}]  ${parts.join('  ')}`)
  }

  console.log(`\nAggregate over ${files.length} image(s)${country ? ` (${country})` : ''}:`)
  for (const f of FIELDS) console.log(`  ${f}: ${totals[f] || 0}/${files.length}`)
  process.exit(ok ? 0 : 1)
}

main()
