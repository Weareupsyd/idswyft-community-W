import { OCRData } from '@/types/index.js';
import type { LLMProviderConfig } from './ocr/LLMFieldExtractor.js';

// -- OCR Provider ------------------------------------------
export interface OCRProvider {
  readonly name: string;
  processDocument(buffer: Buffer, documentType: string, issuingCountry?: string, llmConfig?: LLMProviderConfig): Promise<OCRData>;
}

// -- Face Matching Provider --------------------------------
export interface FaceMatchingProvider {
  readonly name: string;
  /** Returns a similarity score 0..1 */
  compareFaces(face1: Buffer, face2: Buffer): Promise<number>;
  /** Returns true if a human face is detected */
  detectFace(image: Buffer): Promise<boolean>;
}

// -- Liveness Provider -------------------------------------
export interface LivenessSignal {
  /** Short machine key (e.g. 'exif', 'moire', 'entropy'). */
  key: string;
  /** Human-readable label for UI. */
  label: string;
  /** 0..1 sub-score (1 = most live-like). */
  score: number;
  /** Weight contributed to the final weighted score. */
  weight: number;
  /** Optional note explaining the score. */
  note?: string;
}

export interface LivenessAssessment {
  /** Final weighted score 0..1. */
  score: number;
  /** Per-signal breakdown for transparency / manual review. */
  signals: LivenessSignal[];
}

export interface LivenessProvider {
  readonly name: string;
  /** Returns a liveness score 0..1 (1 = definitely live person). */
  assessLiveness(imageData: {
    buffer: Buffer;
    width?: number;
    height?: number;
    pixelData?: number[];
  }): Promise<number>;
  /** Returns score + per-signal breakdown (for reporting in status/webhooks). */
  assessLivenessDetailed?(imageData: {
    buffer: Buffer;
    width?: number;
    height?: number;
    pixelData?: number[];
  }): Promise<LivenessAssessment>;
}

// -- Provider Registry -------------------------------------
export interface ProviderConfig {
  ocr: 'paddle' | 'tesseract' | 'openai' | 'azure' | 'aws-textract' | 'custom';
  face: 'tensorflow' | 'aws-rekognition' | 'custom';
  liveness: 'enhanced-heuristic' | 'custom';
  // For custom providers: URL to HTTP endpoint implementing the interface
  customOcrEndpoint?: string;
  customFaceEndpoint?: string;
  customLivenessEndpoint?: string;
}
