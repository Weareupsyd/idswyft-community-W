/**
 * Face cropping utilities shared between backend and engine.
 *
 * Two crop variants are produced from the detected face bounding box:
 *  - "standard" (`id_face_base64`) — a tight headshot with modest padding so ears,
 *    hairline and chin are included. This replaces the previous bare-bounding-box
 *    crop which was clipping ears on tightly-detected faces.
 *  - "full"     (`id_face_full_base64`) — a generously padded crop that then has
 *    surrounding whitespace/border trimmed back to the visible photo box on the
 *    ID card. This captures the full ID portrait (head + shoulders + photo frame)
 *    for downstream use where the tight headshot is insufficient.
 */
import type sharp from 'sharp';

export interface FaceBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropOptions {
  /** Fraction of the bbox width/height to add as padding on each side. */
  padding: number;
  /**
   * If true, after the padded extract, trim surrounding whitespace/background back
   * to the visible photo content (helps remove leftover ID card background when
   * padding spills outside the printed portrait box).
   */
  trimWhitespace: boolean;
  /** JPEG quality (1-100) for the output. */
  quality?: number;
  /** Threshold (0-255) for the trim operation — higher trims more aggressively. */
  trimThreshold?: number;
}

export const STANDARD_FACE_CROP: CropOptions = {
  padding: 0.45,         // 45% padding each side — keeps ears, hair, chin
  trimWhitespace: true,
  quality: 85,
  trimThreshold: 10,
};

export const FULL_FACE_CROP: CropOptions = {
  padding: 1.2,          // 120% padding — captures shoulders + full photo box
  trimWhitespace: true,
  quality: 88,
  trimThreshold: 18,
};

/**
 * Extract a face crop from an ID image.
 *
 * @param sharpModule The `sharp` module (passed in so this util doesn't add a
 *                    hard peer dependency import cost for consumers that don't
 *                    crop images).
 * @param imageBuffer Source image buffer (the full ID photo).
 * @param bbox        Face detection bounding box in source image coordinates.
 * @param options     Cropping options (padding + trim).
 * @returns           JPEG buffer of the cropped face, or null if the crop can't
 *                    be produced (bbox invalid / image unreadable / crop too small).
 */
export async function cropFaceFromBuffer(
  sharpModule: typeof sharp,
  imageBuffer: Buffer,
  bbox: FaceBoundingBox,
  options: CropOptions,
): Promise<Buffer | null> {
  try {
    const meta = await sharpModule(imageBuffer).metadata();
    if (!meta.width || !meta.height) return null;

    const pad = options.padding;
    const padX = bbox.width * pad;
    const padY = bbox.height * pad;

    const rawLeft = Math.floor(bbox.x - padX);
    const rawTop = Math.floor(bbox.y - padY);
    const rawRight = Math.ceil(bbox.x + bbox.width + padX);
    const rawBottom = Math.ceil(bbox.y + bbox.height + padY);

    const left = Math.max(0, rawLeft);
    const top = Math.max(0, rawTop);
    const right = Math.min(meta.width, rawRight);
    const bottom = Math.min(meta.height, rawBottom);

    const width = right - left;
    const height = bottom - top;

    if (width <= 10 || height <= 10) return null;

    let pipeline = sharpModule(imageBuffer).extract({ left, top, width, height });

    if (options.trimWhitespace) {
      // Trim to the visible portrait box — removes ID card background/whitespace
      // that was pulled in by the generous padding. lineArt:false prevents sharp
      // from treating the subject's outline as "background".
      pipeline = pipeline.trim({
        threshold: options.trimThreshold ?? 10,
        lineArt: false,
      });
    }

    const out = await pipeline.jpeg({ quality: options.quality ?? 85 }).toBuffer();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Convenience: produce both standard + full face crops in one pass. */
export async function cropBothFaceVariants(
  sharpModule: typeof sharp,
  imageBuffer: Buffer,
  bbox: FaceBoundingBox,
): Promise<{ standard: Buffer | null; full: Buffer | null }> {
  const [standard, full] = await Promise.all([
    cropFaceFromBuffer(sharpModule, imageBuffer, bbox, STANDARD_FACE_CROP),
    cropFaceFromBuffer(sharpModule, imageBuffer, bbox, FULL_FACE_CROP),
  ]);
  return { standard, full };
}

function toDataUri(buf: Buffer | null): string | null {
  return buf ? `data:image/jpeg;base64,${buf.toString('base64')}` : null;
}

/** Convenience: produce both crops as data URIs ready to store/return. */
export async function cropBothAsDataUris(
  sharpModule: typeof sharp,
  imageBuffer: Buffer,
  bbox: FaceBoundingBox,
): Promise<{ id_face_base64: string | null; id_face_full_base64: string | null }> {
  const { standard, full } = await cropBothFaceVariants(sharpModule, imageBuffer, bbox);
  return {
    id_face_base64: toDataUri(standard),
    id_face_full_base64: toDataUri(full),
  };
}
