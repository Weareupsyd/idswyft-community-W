/**
 * Gate 4 — Liveness
 *
 * FAIL if:
 *   - Liveness check failed (anti-spoofing)
 *   - No face detected in live capture (low confidence AND no embedding)
 *
 * PASS if liveness passed and face is detected (embedding present OR confidence > 0.5).
 *
 * Note: Face embeddings require TensorFlow (optional dependency).
 * When TF isn't available, face_confidence from detectFacePresence()
 * is the only signal. Gate 4 passes on confidence alone; Gate 5
 * handles the missing-embedding case separately.
 */

import type { LiveCaptureResult, GateResult } from '@idswyft/shared';

const FACE_CONFIDENCE_THRESHOLD = 0.5;
/** Default liveness threshold — kept in sync with verificationThresholds.LIVENESS.
 *  The route handler passes the environment-appropriate value via
 *  SessionDeps.livenessThreshold (0.55 prod / 0.45 sandbox). */
const DEFAULT_LIVENESS_THRESHOLD = 0.55;

export function evaluateGate4(
  liveCapture: LiveCaptureResult,
  livenessThreshold: number = DEFAULT_LIVENESS_THRESHOLD,
): GateResult {
  // Liveness failure takes precedence
  if (!liveCapture.liveness_passed) {
    return {
      passed: false,
      rejection_reason: 'LIVENESS_FAILED',
      rejection_detail: `Liveness score ${liveCapture.liveness_score.toFixed(2)} — anti-spoofing check failed (threshold ${livenessThreshold.toFixed(2)})`,
      rejection_breakdown: {
        category: 'liveness_spoof',
        summary: 'Live capture failed anti-spoofing check',
        score_details: {
          required_threshold: Math.round(livenessThreshold * 100) / 100,
          actual_score: Math.round(liveCapture.liveness_score * 100) / 100,
          metric_name: 'liveness_score',
        },
        details: [
          `Liveness score ${(liveCapture.liveness_score * 100).toFixed(1)}% is below the required ${(livenessThreshold * 100).toFixed(0)}% threshold`,
          'Screen photo, printed paper photo, or video injection attempt detected',
        ],
      },
      user_message: 'We could not verify that you are present. Please try again with a live photo, not a printed picture or screen.',
    };
  }

  // Face detection: pass if embedding exists OR confidence is high enough.
  const hasEmbedding = liveCapture.face_embedding && liveCapture.face_embedding.length > 0;
  const hasHighConfidence = liveCapture.face_confidence >= FACE_CONFIDENCE_THRESHOLD;

  if (!hasEmbedding && !hasHighConfidence) {
    return {
      passed: false,
      rejection_reason: 'FACE_NOT_DETECTED',
      rejection_detail: `No face detected in live capture (confidence: ${liveCapture.face_confidence.toFixed(2)}, threshold: ${FACE_CONFIDENCE_THRESHOLD})`,
      rejection_breakdown: {
        category: 'document_quality',
        summary: 'No human face detected in live capture',
        score_details: {
          required_threshold: FACE_CONFIDENCE_THRESHOLD,
          actual_score: Math.round(liveCapture.face_confidence * 100) / 100,
          metric_name: 'face_confidence',
        },
        details: ['Ensure your face is centered, unobstructed, and well-lit in the camera viewfinder'],
      },
      user_message: 'We could not detect your face. Please ensure your face is clearly visible and well-lit.',
    };
  }

  return {
    passed: true,
    rejection_reason: null,
    rejection_detail: null,
    user_message: null,
  };
}
