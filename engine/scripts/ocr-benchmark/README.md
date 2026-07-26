# OCR Benchmark Harness

Measure document field-extraction accuracy against real cards. **The harness is
committed; the images are not** (`.gitignore` keeps `images/` and `expected/`
out of git — never commit real licences).

## Layout

```
scripts/ocr-benchmark/
  run.ts            # this harness (tracked)
  README.md         # this file (tracked)
  images/<country>/ # drop card images here, per country — gitignored
  expected/         # optional ground-truth JSON per image — gitignored
```

Country → folder mapping: `GB → images/uk/`, `US → images/us/`. Any other
`--country XX` maps to `images/xx/`.

## Use

1. Create the country folder if needed and drop images in, e.g.
   `images/uk/uk-01.jpg`. Formats: `.png`, `.jpg`, `.jpeg`.
2. (Optional) Add ground truth per image at `expected/<image-basename>.json`
   with any of: `name`, `date_of_birth`, `document_number`, `expiration_date`.
   Example `expected/uk-01.json`:
   ```json
   { "date_of_birth": "1985-05-29", "document_number": "..." }
   ```
3. Run (inside the engine environment — needs the OCR models):
   ```
   npx tsx engine/scripts/ocr-benchmark/run.ts --country GB --type drivers_license
   ```
   - Omit `--country` to scan all of `images/` recursively.
   - Omit `--type` for auto document-type detection.

## Output

- Per image: which of `name / date_of_birth / document_number / expiration_date`
  extracted (with `✓`/`✗` vs. ground truth when provided) + the detected type.
- Aggregate: hit count per field over all images.
- Exit code `1` if any image extracted **zero** fields (so CI/scripts can gate),
  `2` if no images were found.

## Notes

- Deterministic — the same image yields the same result.
- Privacy: real licence images stay local; only this harness is version-controlled.
