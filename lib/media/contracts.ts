export type MediaCandidateKind = "product" | "logo" | "social_preview" | "page_image";

/** Metadata from a first-party page, not verified product identity or a reuse license. */
export interface MediaCandidate {
  id: string;
  imageUrl: string;
  sourcePageUrl: string;
  kind: MediaCandidateKind;
  discoveredVia: "json_ld" | "open_graph" | "html_image";
  label: string | null;
  productName: string | null;
  declaredWidth: number | null;
  declaredHeight: number | null;
  eligible: boolean;
  exclusionReason: "cross_origin" | "unsupported_url" | "interface_asset" | null;
  rights: "unknown";
}

export interface AcquiredMedia {
  id: string;
  candidateId: string;
  sourcePageUrl: string;
  sourceUrl: string;
  kind: MediaCandidateKind;
  label: string | null;
  productName: string | null;
  retrievedAt: string;
  sourceMimeType: string;
  mimeType: "image/png";
  filename: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  sourceSha256: string;
  normalization: "auto_orient_and_fit_1600_png";
  rights: "unknown";
  usage: "private_concept_review";
  requiresPublicationReview: true;
}

export interface MediaAcquisitionResult {
  status: "acquired" | "partial" | "no_candidates" | "unavailable";
  sourcePageUrl: string;
  candidates: MediaCandidate[];
  acquired: AcquiredMedia[];
  /** Private machine paths. Omit this map from API responses and export manifests. */
  localFiles: Record<string, string>;
  warnings: string[];
  retrievedAt: string;
}

export type PublicMediaAcquisitionResult = Omit<MediaAcquisitionResult, "localFiles">;

export function publicMediaMetadata(result: MediaAcquisitionResult): PublicMediaAcquisitionResult {
  const { localFiles: _privatePaths, ...metadata } = result;
  void _privatePaths;
  return metadata;
}

export interface RawMediaResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export type MediaTransport = (url: URL, options: {
  signal: AbortSignal;
  maxBytes: number;
  kind: "robots" | "page" | "image";
}) => Promise<RawMediaResponse>;

export class MediaReadError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "MediaReadError";
  }
}
