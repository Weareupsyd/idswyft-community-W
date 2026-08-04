/**
 * Core types shared between backend and engine.
 * Superset of both backend/src/types/index.ts and engine/src/types/index.ts OCRData.
 */

export type DocumentType = 'passport' | 'drivers_license' | 'national_id' | 'other' | 'auto';

export interface OCRData {
  name?: string;
  first_name?: string;
  last_name?: string;
  middle_name?: string;
  date_of_birth?: string;
  expiration_date?: string;
  document_number?: string;
  nationality?: string;
  issuing_country?: string;
  issuing_authority?: string;
  // Uganda National ID fields (front and back are independent; no cross-match required)
  surname?: string;
  given_names?: string;
  full_name?: string;
  nin?: string;
  card_number?: string;
  nationality?: string;
  place_of_birth?: string;
  date_of_issue?: string;
  date_of_expiry?: string;
  holder_signature_present?: boolean;
  village?: string;
  parish?: string;
  sub_county?: string;
  county?: string;
  district?: string;
  right_thumb_present?: boolean;
  sex?: string;
  address?: string;
  height?: string;
  weight?: string;
  eye_color?: string;
  hair_color?: string;
  raw_text?: string;
  id_number?: string;
  expiry_date?: string;
  confidence_scores?: Record<string, number>;
  detected_document_type?: 'passport' | 'drivers_license' | 'national_id';
  classification_confidence?: number;
  [key: string]: any;
}
