/**
 * ONNX-based Deepfake Detector
 *
 * Uses an EfficientNet-B0 binary classifier (trained on FaceForensics++)
 * to detect AI-generated or manipulated face images.
 *
 * The model expects a 224x224 face crop with ImageNet normalization.
 * Runs ~50-150ms on CPU via onnxruntime-node.
 *
 * Lazy-init singleton pattern -- model loads once on first call, reused after.
 */

import { logger } from '@/utils/logger.js';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import type { FaceBufferDetectionResult } from '@/types/faceRecognition.js';

// Dynamic import to avoid hard crash if onnxruntime-node not available
let ort: typeof import('onnxruntime-node') | null = null;

export interface DeepfakeDetectionResult {
  /** Whether the face is likely real */
  isReal: boolean;
  /** Probability that the face is real (0-1) */
  realProbability: number;
  /** Probability that the face is fake/generated (0-1) */
  fakeProbability: number;
}

/** Reuse the canonical bounding box shape from face detection */
export type BoundingBox = FaceBufferDetectionResult['boundingBox'];

// ImageNet normalization constants
const IMAGENET_MEAN = [0.485, 0.456, 0.406]; // RGB
const IMAGENET_STD = [0.229, 0.224, 0.225];
const INPUT_SIZE = 224;

/** Guess which class index is the "fake" class from an id2label map. */
function findFakeLabelIndex(id2label: Record<string, string> | undefined): number | null {
  if (!id2label) return null;
  const entries = Object.entries(id2label);
  if (entries.length !== 2) return null;

  const fakeMatch = entries.find(([, label]) => /fake|deep|synthe|gan|ai[-_ ]?generated|manipulat/i.test(label));
  if (fakeMatch) return Number(fakeMatch[0]);

  // No explicit fake label — fall back to index 0 being the negative class
  return null;
}

export class OnnxDeepfakeDetector {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ort.InferenceSession loaded dynamically
  private session: any = null;
  private initPromise: Promise<void> | null = null;
  private available = true;

  private modelPath: string;

  // Preprocessing + label mapping. Defaults match the original
  // EfficientNet-B0 (ImageNet normalization, [fake, real] logits). When
  // config.json / preprocessor_config.json sidecars exist next to the model
  // (standard for HuggingFace ONNX exports), these are overwritten from them
  // so any public model works without code changes.
  private inputSize = INPUT_SIZE;
  private mean = IMAGENET_MEAN;
  private std = IMAGENET_STD;
  private rescaleFactor = 1 / 255;
  private fakeLogitIndex = 0;
  private realLogitIndex = 1;

  constructor(modelPath?: string) {
    this.modelPath = modelPath || path.join(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
      '..', '..', '..', 'models', 'deepfake-detector.onnx'
    );
  }

  /**
   * Lazily initialize the ONNX runtime and load the model.
   */
  private async initialize(): Promise<void> {
    if (this.session) return;
    if (!this.available) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // Dynamic import -- avoids crash if onnxruntime-node isn't installed
        if (!ort) {
          ort = await import('onnxruntime-node');
        }

        // Check if model file exists
        if (!fs.existsSync(this.modelPath)) {
          logger.warn('Deepfake detector model not found, disabling', { modelPath: this.modelPath });
          this.available = false;
          return;
        }

        // Read sidecar configs (HuggingFace-style) so preprocessing + label
        // mapping adapt to whatever ONNX model is deployed. Missing/invalid
        // sidecars are non-fatal — legacy ImageNet defaults are kept.
        this.loadSidecarConfigs();

        this.session = await ort.InferenceSession.create(this.modelPath, {
          executionProviders: ['cpu'],
          graphOptimizationLevel: 'all',
        });

        logger.info('Deepfake detector model loaded', {
          modelPath: this.modelPath,
          inputNames: this.session.inputNames,
          outputNames: this.session.outputNames,
          inputSize: this.inputSize,
          mean: this.mean,
          std: this.std,
          fakeLogitIndex: this.fakeLogitIndex,
          realLogitIndex: this.realLogitIndex,
        });
      } catch (err) {
        logger.warn('Deepfake detector initialization failed, disabling', {
          error: err instanceof Error ? err.message : 'Unknown',
        });
        this.available = false;
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /** Parse config.json + preprocessor_config.json next to the model file. */
  private loadSidecarConfigs(): void {
    const modelDir = path.dirname(this.modelPath);

    // preprocessor_config.json — normalization constants
    try {
      const ppPath = path.join(modelDir, 'preprocessor_config.json');
      if (fs.existsSync(ppPath)) {
        const pp = JSON.parse(fs.readFileSync(ppPath, 'utf8'));
        const mean = pp.image_mean as number[] | undefined;
        const std = pp.image_std as number[] | undefined;
        if (Array.isArray(mean) && mean.length === 3) this.mean = mean;
        if (Array.isArray(std) && std.length === 3) this.std = std;
        if (typeof pp.rescale_factor === 'number' && pp.rescale_factor > 0) {
          this.rescaleFactor = pp.rescale_factor;
        }
        if (pp.do_normalize === false) {
          this.mean = [0, 0, 0];
          this.std = [1, 1, 1];
        }
        if (pp.do_rescale === false) {
          this.rescaleFactor = 1;
        }
      }
    } catch (err) {
      logger.warn('Deepfake detector: failed to parse preprocessor_config.json, using defaults', {
        error: err instanceof Error ? err.message : 'Unknown',
      });
    }

    // config.json — input size + label order
    try {
      const cfgPath = path.join(modelDir, 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const size = cfg.image_size ?? cfg.input_size;
        if (typeof size === 'number' && size > 0) this.inputSize = size;

        const id2label = cfg.id2label as Record<string, string> | undefined;
        const fakeIdx = findFakeLabelIndex(id2label);
        if (fakeIdx !== null && fakeIdx >= 0 && fakeIdx <= 1) {
          this.fakeLogitIndex = fakeIdx;
          this.realLogitIndex = fakeIdx === 0 ? 1 : 0;
        }
      }
    } catch (err) {
      logger.warn('Deepfake detector: failed to parse config.json, using defaults', {
        error: err instanceof Error ? err.message : 'Unknown',
      });
    }
  }

  /**
   * Detect whether a face crop is real or AI-generated.
   *
   * @param faceCropBuffer  Buffer containing a face-cropped image
   * @returns Detection result with real/fake probabilities
   */
  async detect(faceCropBuffer: Buffer): Promise<DeepfakeDetectionResult> {
    await this.initialize();

    if (!this.session || !this.available || !ort) {
      // Model not available -- return neutral result
      return { isReal: true, realProbability: 0.5, fakeProbability: 0.5 };
    }

    try {
      const tensor = await this.preprocessToTensor(faceCropBuffer);
      const feeds: Record<string, any> = {};
      feeds[this.session.inputNames[0]] = tensor;

      const results = await this.session.run(feeds);
      const output = results[this.session.outputNames[0]];
      const data = output.data as Float32Array;

      // Output: logits — map to real/fake via the configured label indices
      // (default [fake, real] for the original model; sidecar config.json may
      // flip it, e.g. [Realism, Deepfake] for the HuggingFace ViT export).
      let realProb: number;
      let fakeProb: number;

      if (data.length >= 2) {
        // Binary classifier with 2 outputs -- softmax
        const fakeLogit = data[this.fakeLogitIndex] ?? data[0];
        const realLogit = data[this.realLogitIndex] ?? data[1];
        const maxVal = Math.max(fakeLogit, realLogit);
        const expFake = Math.exp(fakeLogit - maxVal);
        const expReal = Math.exp(realLogit - maxVal);
        const sum = expFake + expReal;
        fakeProb = expFake / sum;
        realProb = expReal / sum;
      } else {
        // Single sigmoid output
        realProb = 1 / (1 + Math.exp(-data[0]));
        fakeProb = 1 - realProb;
      }

      return {
        isReal: realProb > 0.5,
        realProbability: realProb,
        fakeProbability: fakeProb,
      };
    } catch (err) {
      logger.warn('Deepfake detection inference failed', {
        error: err instanceof Error ? err.message : 'Unknown',
      });
      return { isReal: true, realProbability: 0.5, fakeProbability: 0.5 };
    }
  }

  /**
   * Extract a face crop from a full image using the detected bounding box.
   * Adds 20% margin around the face for context.
   */
  async extractFaceCrop(fullImage: Buffer, bbox: BoundingBox): Promise<Buffer> {
    const meta = await sharp(fullImage).metadata();
    const imgW = meta.width || 0;
    const imgH = meta.height || 0;

    // Add 20% margin
    const margin = 0.20;
    const marginX = Math.round(bbox.width * margin);
    const marginY = Math.round(bbox.height * margin);

    const left = Math.max(0, Math.round(bbox.x) - marginX);
    const top = Math.max(0, Math.round(bbox.y) - marginY);
    const right = Math.min(imgW, Math.round(bbox.x + bbox.width) + marginX);
    const bottom = Math.min(imgH, Math.round(bbox.y + bbox.height) + marginY);

    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) {
      throw new Error('Invalid face crop dimensions');
    }

    return sharp(fullImage)
      .extract({ left, top, width, height })
      .resize(this.inputSize, this.inputSize, { fit: 'cover' })
      .removeAlpha()
      .toBuffer();
  }

  /**
   * Preprocess a face crop to an NCHW tensor.
   *
   * Pipeline: resize inputSize x inputSize -> raw RGB -> rescale -> normalize
   * per-channel -> [1, 3, inputSize, inputSize]. Normalization constants come
   * from preprocessor_config.json sidecar when present, else ImageNet
   * defaults (original EfficientNet-B0 model).
   */
  private async preprocessToTensor(crop: Buffer): Promise<any> {
    if (!ort) throw new Error('onnxruntime-node not loaded');

    const n = this.inputSize;
    const { data } = await sharp(crop)
      .resize(n, n, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Convert HWC uint8 -> NCHW float32 with configured normalization
    const float32Data = new Float32Array(3 * n * n);
    const pixelCount = n * n;

    for (let i = 0; i < pixelCount; i++) {
      const r = data[i * 3] * this.rescaleFactor;
      const g = data[i * 3 + 1] * this.rescaleFactor;
      const b = data[i * 3 + 2] * this.rescaleFactor;

      // NCHW layout: channel-first
      float32Data[i] = (r - this.mean[0]) / this.std[0];                    // R channel
      float32Data[pixelCount + i] = (g - this.mean[1]) / this.std[1];       // G channel
      float32Data[2 * pixelCount + i] = (b - this.mean[2]) / this.std[2];   // B channel
    }

    return new ort.Tensor('float32', float32Data, [1, 3, n, n]);
  }

  /** Check if the model is loaded and ready */
  isAvailable(): boolean {
    return this.available && this.session !== null;
  }
}
