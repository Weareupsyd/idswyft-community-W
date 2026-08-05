/**
 * Gate 3 — Cross-Validation
 *
 * FAIL if:
 *   - Document expired
 *   - Any critical field failed comparison
 *   - Overall weighted score < 0.75 (THRESHOLD_REVIEW)
 *
 * PASS if:
 *   - Score >= 0.92 → PASS
 *   - Score >= 0.75 → REVIEW (still passes gate, flags for human review)
 */

import type { CrossValidationResult, GateResult } from '@idswyft/shared';

export function evaluateGate3(crossVal: CrossValidationResult): GateResult {
  // Document expired takes priority
  if (crossVal.document_expired) {
    return {
      passed: false,
      rejection_reason: 'DOCUMENT_EXPIRED',
      rejection_detail: `Document expiry date is in the past`,
      rejection_breakdown: {
        category: 'expiration',
        summary: 'Document expiration date is prior to current date',
        details: ['Document expiry date has passed. A valid, non-expired ID is required.'],
      },
      user_message: 'Your document has expired. Please use a valid, non-expired ID.',
    };
  }

  // Construct field mismatch list if cross-validation failed
  const fieldMismatches = crossVal.field_scores
    ? Object.entries(crossVal.field_scores)
        .filter(([, s]) => !s.passed)
        .map(([f, s]) => ({
          field: f,
          reason: `Field "${f}" failed comparison between front and back (score: ${(s.score * 100).toFixed(0)}%, weight: ${s.weight})`,
        }))
    : [];

  // Critical field failure
  if (crossVal.has_critical_failure) {
    return {
      passed: false,
      rejection_reason: 'CROSS_VALIDATION_FAILED',
      rejection_detail: `Critical field mismatch detected (score: ${crossVal.overall_score.toFixed(2)})`,
      rejection_breakdown: {
        category: 'data_mismatch',
        summary: 'Critical field mismatch detected between front and back of document',
        field_mismatches: fieldMismatches,
        score_details: {
          required_threshold: 0.75,
          actual_score: Math.round(crossVal.overall_score * 100) / 100,
          metric_name: 'cross_validation_score',
        },
        details: fieldMismatches.map(m => m.reason),
      },
      user_message: 'The information on the front and back of your document does not match. Please ensure both images are from the same ID.',
    };
  }

  // Score below REVIEW threshold → REJECT
  if (crossVal.verdict === 'REJECT') {
    return {
      passed: false,
      rejection_reason: 'CROSS_VALIDATION_FAILED',
      rejection_detail: `Overall cross-validation score ${crossVal.overall_score.toFixed(2)} below review threshold`,
      rejection_breakdown: {
        category: 'data_mismatch',
        summary: 'Overall cross-validation score is below the minimum review threshold',
        field_mismatches: fieldMismatches,
        score_details: {
          required_threshold: 0.75,
          actual_score: Math.round(crossVal.overall_score * 100) / 100,
          metric_name: 'cross_validation_score',
        },
        details: fieldMismatches.length > 0
          ? fieldMismatches.map(m => m.reason)
          : [`Overall cross-validation score ${(crossVal.overall_score * 100).toFixed(1)}% is below 75% threshold`],
      },
      user_message: 'We could not verify the consistency of your document. Please retake both sides of your ID.',
    };
  }

  // PASS or REVIEW both pass the gate (REVIEW flags for human review but doesn't block)
  return {
    passed: true,
    rejection_reason: null,
    rejection_detail: null,
    user_message: null,
  };
}
