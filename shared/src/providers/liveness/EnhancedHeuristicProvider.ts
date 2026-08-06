import { LivenessProvider, LivenessAssessment, LivenessSignal } from '../types.js';
import { logger } from '@/utils/logger.js';

/**
 * EnhancedHeuristicProvider -- Multi-signal anti-spoofing liveness detection.
 *
 * Analyzes 8 independent signals from the image buffer to distinguish
 * real camera photos from screenshots, printed photos, and digital fakes.
 * Each signal produces a sub-score (0-1) that is combined via weighted average.
 *
 * Tuning notes (2026-08): this scorer was originally calibrated against native
 * camera JPEGs saved directly to disk, where missing EXIF and libjpeg quant
 * tables were strong spoof indicators. In practice the demo + hosted-verification
 * flows capture selfies via getUserMedia() → <canvas> → canvas.toBlob('image/jpeg'),
 * which strips EXIF and re-encodes with browser libjpeg tables even when the
 * source is a live webcam — so missing EXIF / generic quant tables are NOT
 * reliable spoof signals from the browser. Weights below reflect that reality:
 * moiré, double-compression artifacts, color bimodality and entropy carry the
 * load, while EXIF is treated as a bonus (not a penalty), file size is lenient,
 * and aspect ratio is nearly informational.
 *
 * Signals:
 *  1. File size heuristic -- screens/prints cluster at specific sizes
 *  2. Byte entropy -- natural photos have entropy > 7.0 bits/byte
 *  3. Pixel variance -- natural texture/lighting variance > 1000
 *  4. EXIF metadata -- bonus when present; neutral (0.5) when absent
 *  5. JPEG compression artifacts -- double-compression / heavy quant penalty
 *  6. Color histogram analysis -- screens show saturated, bimodal distributions
 *  7. Edge density / moire detection -- STRONG signal; re-photographed screens
 *     produce periodic moire patterns that natural photos do not
 *  8. Aspect ratio check -- loose; informational only
 */
export class EnhancedHeuristicProvider implements LivenessProvider {
  readonly name = 'enhanced-heuristic';

  /** Signal weights -- sum to 1.0. */
  private readonly weights = {
    fileSize: 0.06,
    entropy: 0.14,
    pixelVariance: 0.10,
    exif: 0.05,       // bonus-only; treat absence as neutral
    jpegArtifacts: 0.18,
    colorHistogram: 0.18,
    edgeDensity: 0.24, // moire/edge analysis — strongest spoof signal
    aspectRatio: 0.05,
  };

  private readonly signalLabels: Record<string, string> = {
    fileSize: 'File size',
    entropy: 'Byte entropy',
    pixelVariance: 'Pixel variance',
    exif: 'Camera EXIF',
    jpegArtifacts: 'JPEG compression',
    colorHistogram: 'Color distribution',
    edgeDensity: 'Edge density / moiré',
    aspectRatio: 'Aspect ratio',
  };

  async assessLiveness(imageData: {
    buffer: Buffer;
    width?: number;
    height?: number;
    pixelData?: number[];
  }): Promise<number> {
    return (await this.assessLivenessDetailed(imageData)).score;
  }

  async assessLivenessDetailed(imageData: {
    buffer: Buffer;
    width?: number;
    height?: number;
    pixelData?: number[];
  }): Promise<LivenessAssessment> {
    const { buffer, width, height, pixelData } = imageData;

    if (!buffer || buffer.length === 0) {
      logger.warn('EnhancedHeuristicProvider: empty buffer');
      return { score: 0, signals: [] };
    }

    // If dimensions not provided, try to extract from buffer metadata
    let resolvedWidth = width;
    let resolvedHeight = height;
    if (!resolvedWidth || !resolvedHeight) {
      try {
        const sharp = (await import('sharp')).default;
        const meta = await sharp(buffer).metadata();
        resolvedWidth = meta.width;
        resolvedHeight = meta.height;
      } catch {
        // sharp unavailable or corrupt image -- proceed without dimensions
      }
    }

    // Gather all signal scores in parallel where possible
    const [
      fileSizeScore,
      entropyScore,
      pixelVarianceScore,
      exifScore,
      jpegScore,
      colorScore,
      edgeScore,
      aspectScore,
      metaResolved,
    ] = await Promise.all([
      this.scoreFileSize(buffer),
      this.scoreEntropy(buffer),
      this.scorePixelVariance(pixelData),
      this.scoreExifMetadata(buffer),
      this.scoreJpegCompression(buffer),
      this.scoreColorHistogram(buffer),
      this.scoreEdgeDensity(buffer),
      this.scoreAspectRatio(buffer, resolvedWidth, resolvedHeight),
      this.readMetaForNotes(buffer).catch(() => null),
    ]);

    const scoreMap: Record<string, number> = {
      fileSize: fileSizeScore,
      entropy: entropyScore,
      pixelVariance: pixelVarianceScore,
      exif: exifScore,
      jpegArtifacts: jpegScore,
      colorHistogram: colorScore,
      edgeDensity: edgeScore,
      aspectRatio: aspectScore,
    };

    // Build per-signal notes
    const notes: Record<string, string | undefined> = {};
    const sizeKb = buffer.length / 1024;
    notes.fileSize = `${sizeKb.toFixed(1)} KB`;
    if (metaResolved?.hasExif) notes.exif = 'Camera EXIF present';
    else notes.exif = 'No EXIF metadata (normal for browser canvas)';
    if (metaResolved?.format) notes.exif = `${notes.exif} · ${metaResolved.format.toUpperCase()}`;
    if (metaResolved?.width && metaResolved?.height) {
      notes.aspectRatio = `${metaResolved.width}×${metaResolved.height}`;
    }
    if (edgeScore < 0.4) notes.edgeDensity = 'Moiré / periodic pattern detected';
    else if (edgeScore < 0.6) notes.edgeDensity = 'Some periodic noise';
    if (jpegScore < 0.5) notes.jpegArtifacts = 'Heavy JPEG re-compression';
    if (colorScore < 0.5) notes.colorHistogram = 'Bimodal / synthetic color distribution';
    if (entropyScore < 0.5) notes.entropy = 'Low entropy (flat or synthetic)';

    const signals: LivenessSignal[] = Object.entries(scoreMap).map(([key, score]) => ({
      key,
      label: this.signalLabels[key] ?? key,
      score: Math.max(0, Math.min(1, score)),
      weight: (this.weights as Record<string, number>)[key] ?? 0,
      note: notes[key],
    }));

    // Weighted average
    let weightedSum = 0;
    let totalWeight = 0;
    for (const s of signals) {
      weightedSum += s.score * s.weight;
      totalWeight += s.weight;
    }

    const finalScore = Math.max(0, Math.min(1, totalWeight > 0 ? weightedSum / totalWeight : 0));

    logger.info('EnhancedHeuristicProvider: liveness assessment', {
      signals: Object.fromEntries(signals.map(s => [s.key, +s.score.toFixed(3)])),
      finalScore: finalScore.toFixed(3),
    });

    return { score: finalScore, signals };
  }

  private async readMetaForNotes(buffer: Buffer): Promise<{ format?: string; width?: number; height?: number; hasExif: boolean } | null> {
    try {
      const sharp = (await import('sharp')).default;
      const meta = await sharp(buffer).metadata();
      return {
        format: meta.format,
        width: meta.width,
        height: meta.height,
        hasExif: !!meta.exif,
      };
    } catch {
      return null;
    }
  }

  // -- Signal 1: File Size ------------------------------------------

  private async scoreFileSize(buffer: Buffer): Promise<number> {
    const sizeKb = buffer.length / 1024;

    // Browser canvas.toBlob('image/jpeg', 0.8) for a cropped face viewfinder
    // commonly lands in the 15–90 KB range. Don't treat that as a spoof signal.
    if (sizeKb < 5) return 0.15;      // tiny thumbnail/icon
    if (sizeKb < 12) return 0.45;     // very heavily compressed
    if (sizeKb < 200) return 0.80;    // normal canvas selfie or native camera thumbnail
    if (sizeKb < 800) return 0.90;    // full-frame webcam / mid-res camera
    if (sizeKb < 3000) return 0.85;   // original camera JPEG
    if (sizeKb < 8000) return 0.75;   // very large raw capture
    return 0.65;                      // absurdly large (suspicious)
  }

  // -- Signal 2: Byte Entropy ---------------------------------------

  private async scoreEntropy(buffer: Buffer): Promise<number> {
    const entropy = this.computeByteEntropy(buffer);

    // Natural photos have high entropy (7.0-8.0 bits/byte)
    // Flat/synthetic images have lower entropy
    if (entropy >= 7.5) return 0.95;
    if (entropy >= 7.0) return 0.8;
    if (entropy >= 6.5) return 0.6;
    if (entropy >= 5.5) return 0.4;
    if (entropy >= 4.0) return 0.25;
    return 0.1;
  }

  // -- Signal 3: Pixel Variance -------------------------------------

  private async scorePixelVariance(pixelData?: number[]): Promise<number> {
    if (!pixelData || pixelData.length === 0) {
      // No pixel data available -- return neutral score
      return 0.5;
    }

    const variance = this.computePixelVariance(pixelData);

    // Natural photos have high variance from texture and lighting
    if (variance > 2000) return 0.9;
    if (variance > 1000) return 0.75;
    if (variance > 500) return 0.55;
    if (variance > 200) return 0.35;
    return 0.15;
  }

  // -- Signal 4: EXIF Metadata --------------------------------------

  private async scoreExifMetadata(buffer: Buffer): Promise<number> {
    try {
      const sharp = (await import('sharp')).default;
      const metadata = await sharp(buffer).metadata();

      // EXIF is a BONUS signal, not a penalty. Browser canvas.toBlob
      // intentionally strips EXIF (privacy), so its absence is neutral.
      // Start at 0.5 (neutral) and add small bonuses for known camera tags.
      let score = 0.5;

      if (metadata.exif) {
        score += 0.10;

        const exifStr = metadata.exif.toString('binary');

        if (exifStr.includes('FocalLength') || exifStr.includes('\x92\x0a')) score += 0.10;
        if (exifStr.includes('Make') || exifStr.includes('Model'))              score += 0.12;
        if (exifStr.includes('ExposureTime') || exifStr.includes('\x82\x9a'))   score += 0.08;
        if (exifStr.includes('Flash') || exifStr.includes('\x92\x09'))          score += 0.05;
      }

      if (metadata.orientation && metadata.orientation > 1) score += 0.05;

      return Math.min(1, score);
    } catch {
      return 0.5;
    }
  }

  // -- Signal 5: JPEG Compression Artifacts -------------------------

  private async scoreJpegCompression(buffer: Buffer): Promise<number> {
    // Check if file is JPEG (FF D8 FF magic bytes)
    const isJpeg = buffer.length >= 3 &&
      buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;

    if (!isJpeg) {
      // PNG screenshots are common -- slight penalty
      const isPng = buffer.length >= 4 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 &&
        buffer[2] === 0x4E && buffer[3] === 0x47;
      return isPng ? 0.4 : 0.3;
    }

    // Analyze JPEG quantization tables for compression quality
    // Camera JPEGs use specific quantization tables; re-compressed images differ
    const quantScore = this.analyzeJpegQuantization(buffer);

    // Check for double-compression artifacts (re-photographed / re-saved images)
    // Count JPEG markers -- re-saved images sometimes accumulate extra markers
    const markerCount = this.countJpegMarkers(buffer);

    // Browser canvas encodes produce 5–15 markers; camera JPEGs 8–35; editors
    // (Photoshop, GIMP, some messenger re-encodes) produce >40. Only the heavy
    // end is a real spoof signal.
    let markerScore: number;
    if (markerCount >= 5 && markerCount <= 40) {
      markerScore = 0.82;
    } else if (markerCount < 5) {
      markerScore = 0.55; // stripped / minimal encoder
    } else {
      markerScore = 0.40; // heavy re-processing
    }

    return quantScore * 0.65 + markerScore * 0.35;
  }

  // -- Signal 6: Color Histogram Analysis ---------------------------

  private async scoreColorHistogram(buffer: Buffer): Promise<number> {
    // Sample pixels from the raw buffer (skip headers)
    // For JPEG, we sample from the compressed stream -- patterns still detectable
    const sampleStart = Math.min(100, buffer.length);
    const sampleEnd = Math.min(buffer.length, 32768);
    const sample = buffer.subarray(sampleStart, sampleEnd);

    if (sample.length < 256) return 0.5;

    // Build byte-level histogram (proxy for color distribution)
    const histogram = new Uint32Array(256);
    for (let i = 0; i < sample.length; i++) {
      histogram[sample[i]]++;
    }

    // Compute histogram uniformity -- natural photos have smoother distributions
    const total = sample.length;
    const expected = total / 256;

    let chiSquared = 0;
    let peakCount = 0;
    let zeroCount = 0;

    for (let i = 0; i < 256; i++) {
      const observed = histogram[i];
      chiSquared += ((observed - expected) ** 2) / expected;
      if (observed > expected * 3) peakCount++;
      if (observed === 0) zeroCount++;
    }

    // Normalize chi-squared to 0-1 range
    // Screen photos tend to have spikier distributions (bimodal)
    const normalizedChi = Math.min(chiSquared / (total * 2), 1);

    // Natural photos: moderate chi-squared (not too uniform, not too spiky)
    // Screen captures: very spiky (high chi-squared) or very uniform (synthetic)
    let score: number;
    if (normalizedChi < 0.1) {
      score = 0.4; // Too uniform -- synthetic
    } else if (normalizedChi < 0.5) {
      score = 0.8; // Natural distribution
    } else if (normalizedChi < 0.8) {
      score = 0.6; // Somewhat spiky
    } else {
      score = 0.35; // Very spiky -- likely screen capture
    }

    // Penalize if too many zero or peak bins
    if (zeroCount > 100) score -= 0.1;
    if (peakCount > 20) score -= 0.1;

    return Math.max(0, Math.min(1, score));
  }

  // -- Signal 7: Edge Density / Moire Detection ---------------------

  private async scoreEdgeDensity(buffer: Buffer): Promise<number> {
    // Moire patterns from re-photographing a screen produce regular
    // high-frequency patterns. We detect this via byte-level autocorrelation.
    const sampleStart = Math.min(200, buffer.length);
    const sampleSize = Math.min(8192, buffer.length - sampleStart);

    if (sampleSize < 512) return 0.5;

    const sample = buffer.subarray(sampleStart, sampleStart + sampleSize);

    // Compute local differences (proxy for edge density)
    let edgeSum = 0;
    let edgeCount = 0;
    for (let i = 1; i < sample.length; i++) {
      edgeSum += Math.abs(sample[i] - sample[i - 1]);
      edgeCount++;
    }
    const avgEdge = edgeSum / edgeCount;

    // Check for periodic patterns (moire indicator)
    // Autocorrelation at small lags -- moire produces peaks at regular intervals
    const moireScore = this.detectMoirePattern(sample);

    let edgeScore: number;
    if (avgEdge > 80) {
      edgeScore = 0.30; // very noisy / over-sharpened
    } else if (avgEdge > 35) {
      edgeScore = 0.82; // natural edge density for a face photo
    } else if (avgEdge > 12) {
      edgeScore = 0.65; // soft/blurry but plausible
    } else {
      edgeScore = 0.30; // very flat — synthetic or extremely compressed
    }

    // Moire is the strongest screen-rephoto signal — apply a decisive penalty
    // but leave a tiny floor so a single spurious peak doesn't zero the score.
    if (moireScore >= 0.9) edgeScore = Math.min(edgeScore, 0.10);
    else if (moireScore >= 0.6) edgeScore -= 0.30;
    else if (moireScore >= 0.3) edgeScore -= 0.10;

    return Math.max(0.05, Math.min(1, edgeScore));
  }

  // -- Signal 8: Aspect Ratio --------------------------------------

  private async scoreAspectRatio(
    buffer: Buffer,
    width?: number,
    height?: number,
  ): Promise<number> {
    let w = width;
    let h = height;

    // Try to get dimensions from sharp if not provided
    if (!w || !h) {
      try {
        const sharp = (await import('sharp')).default;
        const meta = await sharp(buffer).metadata();
        w = meta.width;
        h = meta.height;
      } catch {
        return 0.5; // Can't determine -- neutral
      }
    }

    if (!w || !h) return 0.5;

    const ratio = w / h;

    // Common camera aspect ratios: 4:3 (1.333), 3:2 (1.5), 16:9 (1.778)
    // Phone selfie cameras are typically 4:3 or 3:2
    const cameraRatios = [
      { ratio: 4 / 3, label: '4:3' },
      { ratio: 3 / 2, label: '3:2' },
      { ratio: 16 / 9, label: '16:9' },
      { ratio: 3 / 4, label: '3:4 portrait' },
      { ratio: 2 / 3, label: '2:3 portrait' },
      { ratio: 9 / 16, label: '9:16 portrait' },
      { ratio: 1, label: '1:1 square' },
    ];

    // Find closest standard ratio
    let minDist = Infinity;
    for (const cam of cameraRatios) {
      const dist = Math.abs(ratio - cam.ratio);
      if (dist < minDist) minDist = dist;
    }

    // Selfie viewfinders crop to ovals and squares in the browser — keep this
    // signal very loose. It's informational only at weight 0.05.
    if (minDist < 0.05) return 0.85;
    if (minDist < 0.15) return 0.75;
    if (minDist < 0.30) return 0.60;
    return 0.45;
  }

  // -- Helper: Byte Entropy -----------------------------------------

  private computeByteEntropy(buffer: Buffer): number {
    const freq = new Float64Array(256).fill(0);
    const sampleSize = Math.min(buffer.length, 16384);
    const step = Math.max(1, Math.floor(buffer.length / sampleSize));

    for (let i = 0; i < buffer.length; i += step) freq[buffer[i]]++;

    const total = freq.reduce((a, b) => a + b, 0) || 1;
    let entropy = 0;
    for (const f of freq) {
      if (f > 0) {
        const p = f / total;
        entropy -= p * Math.log2(p);
      }
    }
    return entropy;
  }

  // -- Helper: Pixel Variance ---------------------------------------

  private computePixelVariance(pixels: number[]): number {
    const n = pixels.length;
    if (n === 0) return 0;
    const mean = pixels.reduce((a, b) => a + b, 0) / n;
    return pixels.reduce((sum, p) => sum + (p - mean) ** 2, 0) / n;
  }

  // -- Helper: JPEG Quantization Analysis ---------------------------

  private analyzeJpegQuantization(buffer: Buffer): number {
    // Look for DQT marker (FF DB) -- defines quantization tables
    let dqtCount = 0;
    let totalQValue = 0;
    let qValueCount = 0;

    for (let i = 0; i < buffer.length - 1; i++) {
      if (buffer[i] === 0xFF && buffer[i + 1] === 0xDB) {
        dqtCount++;
        const tableStart = i + 5; // marker(2) + length(2) + precision/id(1)
        const tableEnd = Math.min(tableStart + 64, buffer.length);
        for (let j = tableStart; j < tableEnd; j++) {
          totalQValue += buffer[j];
          qValueCount++;
        }
      }
    }

    if (dqtCount === 0) return 0.5; // not a standard JPEG

    const avgQValue = qValueCount > 0 ? totalQValue / qValueCount : 50;

    // Lower quantization values = higher quality (camera default, q≈95+).
    // Canvas toBlob('image/jpeg', 0.8) lands around 30–60 which is perfectly fine
    // for a live selfie. Only penalize clearly over-compressed (avg > 80) or
    // near-flat (avg < 5) tables.
    if (avgQValue < 15) return 0.92;
    if (avgQValue < 35) return 0.85;
    if (avgQValue < 65) return 0.78; // normal canvas jpeg at q=0.7–0.9
    if (avgQValue < 90) return 0.55; // low-quality jpeg (messenger-save style)
    if (avgQValue < 130) return 0.35;
    return 0.25;
  }

  // -- Helper: Count JPEG Markers -----------------------------------

  private countJpegMarkers(buffer: Buffer): number {
    let count = 0;
    for (let i = 0; i < buffer.length - 1; i++) {
      if (buffer[i] === 0xFF && buffer[i + 1] !== 0x00 && buffer[i + 1] !== 0xFF) {
        count++;
      }
    }
    return count;
  }

  // -- Helper: Moire Pattern Detection ------------------------------

  private detectMoirePattern(sample: Uint8Array): number {
    // Simple autocorrelation at small lags to detect periodic patterns
    // Moire from screen re-photography produces peaks at regular intervals
    const n = sample.length;
    if (n < 128) return 0;

    // Compute mean
    let mean = 0;
    for (let i = 0; i < n; i++) mean += sample[i];
    mean /= n;

    // Autocorrelation at lag 0 (normalization)
    let r0 = 0;
    for (let i = 0; i < n; i++) r0 += (sample[i] - mean) ** 2;
    if (r0 === 0) return 0;

    // Check lags 2-20 for periodic peaks (rise-then-fall detection)
    let peakCount = 0;
    let prevCorr = 0;
    let wasRising = false;

    for (let lag = 2; lag <= Math.min(20, n - 1); lag++) {
      let rk = 0;
      for (let i = 0; i < n - lag; i++) {
        rk += (sample[i] - mean) * (sample[i + lag] - mean);
      }
      const corr = rk / r0;

      // True peak detection: correlation was rising, now falling
      if (corr > prevCorr) {
        wasRising = true;
      } else if (wasRising && prevCorr > 0.15) {
        // Previous point was a peak (rose then fell, and was significant)
        peakCount++;
        wasRising = false;
      }
      prevCorr = corr;
    }

    // Multiple autocorrelation peaks = periodic pattern = moire
    if (peakCount >= 4) return 0.9;
    if (peakCount >= 2) return 0.6;
    if (peakCount >= 1) return 0.3;
    return 0.1;
  }
}
