/**
 * Gate 5 — Face Match
 *
 * FAIL if:
 *   - Face similarity score < threshold (default 0.60)
 *
 * PASS if similarity >= threshold → VERIFICATION SUCCESS.
 */

import type { FaceMatchResult, GateResult } from '@idswyft/shared';

export function evaluateGate5(faceMatch: FaceMatchResult): GateResult {
  if (!faceMatch.passed) {
    return {
      passed: false,
      rejection_reason: 'FACE_MATCH_FAILED',
      rejection_detail: `Face similarity ${faceMatch.similarity_score.toFixed(2)} below threshold ${faceMatch.threshold_used.toFixed(2)}`,
      rejection_breakdown: {
        category: 'face_mismatch',
        summary: 'Selfie face does not match the photo on the government ID',
        score_details: {
          required_threshold: Math.round(faceMatch.threshold_used * 100) / 100,
          actual_score: Math.round(faceMatch.similarity_score * 100) / 100,
          metric_name: 'face_similarity_score',
        },
        details: [
          `Facial similarity score of ${(faceMatch.similarity_score * 100).toFixed(1)}% is below the required ${(faceMatch.threshold_used * 100).toFixed(0)}% threshold`,
          'Biometric features extracted from the selfie do not match the ID card photo',
        ],
      },
      user_message: 'Your selfie does not match the photo on your ID. Please try again.',
    };
  }

  return {
    passed: true,
    rejection_reason: null,
    rejection_detail: null,
    user_message: null,
  };
}
