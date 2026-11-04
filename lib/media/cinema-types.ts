/**
 * Shared contracts for owner clips, SAM 3.1 masklets and the local cinematic compositor.
 * Implementations live in lib/media/clip.ts, lib/media/masklets.ts, lib/meta/sam-video.ts
 * and lib/campaign/cinema/. Everything here is local data; nothing implies verified
 * product identity, publication rights or measured campaign performance.
 */

/** Half-open source-pixel bounds: right/bottom are exclusive. */
export interface PixelBounds { left: number; top: number; right: number; bottom: number }

/** An owner-supplied clip after local validation, metadata stripping and normalization. */
export interface NormalizedClip {
  version: 1;
  id: string;
  /** SHA-256 of the normalized tracking MP4 sent to SAM / Spark. */
  sha256: string;
  /** Absolute private path under .data/. Never exported or shown to the browser. */
  path: string;
  width: number;
  height: number;
  /** Constant frame rate after normalization. */
  fps: number;
  frameCount: number;
  durationSeconds: number;
  /** Poster (first usable frame) PNG, absolute private path. */
  posterPath: string;
  /** Owner audio, kept privately for later transcription; null when absent or dropped. */
  audioPath: string | null;
  original: { bytes: number; sha256: string; container: string; videoCodec: string; durationSeconds: number; width: number; height: number };
  provenance: "owner_upload";
  consent: OwnerMediaConsent;
  createdAt: string;
}

/** The owner's attestation captured with an upload. It is a record, not a legal review. */
export interface OwnerMediaConsent {
  ownsOrLicensedMedia: boolean;
  peopleVisibleHaveConsented: boolean | "no_people";
  attestedAt: string;
}

/** One decoded frame of a normalized clip. */
export interface ClipFrame { frame: number; width: number; height: number; rgba: Buffer }

/** One SAM mask for one object on one frame, cropped to its bounds. raster is 0/1, row-major. */
export interface FrameMask { objectId: string; frame: number; bounds: PixelBounds; confidence: number | null; raster: Uint8Array }

export interface TrackPoint { frame: number; cx: number; cy: number; area: number; bounds: PixelBounds; confidence: number | null }

export interface TrackedObjectSummary {
  objectId: string;
  /** Local label from the prompt (e.g. the offering name). Not a verified identity. */
  label: string;
  origin: "owner_tap" | "spark_grounding" | "concept_prompt" | "local_layout";
  firstFrame: number;
  lastFrame: number;
  framesPresent: number;
  meanCoverage: number;
  meanConfidence: number | null;
  /** Centroid and area per present frame, in tracking-clip pixels. */
  track: TrackPoint[];
}

/** Index of a completed SAM video segmentation, bound to the exact clip bytes. */
export interface MaskletSet {
  version: 1;
  model: "sam-3.1";
  responseId: string;
  clip: { sha256: string; width: number; height: number; fps: number; frameCount: number };
  promptKind: "geometry" | "concept";
  propagation: "forward" | "backward" | "both";
  objects: TrackedObjectSummary[];
  framesBilled: number | null;
  elapsedMs: number;
  createdAt: string;
  provenance: { kind: "meta_video_segmentation"; semanticIdentityVerified: false; requiresReview: true };
}

/** Random-access reader over a stored masklet set. */
export interface MaskletReader {
  readonly set: MaskletSet;
  frameMask(objectId: string, frame: number): Promise<FrameMask | null>;
}

/** Per-render accounting of where pixels came from. Used for honest provenance labels and QA. */
export interface CompositionLedger {
  frames: number;
  /** Mean fraction of each output frame occupied by unchanged-source subject pixels (alpha-weighted). */
  meanSubjectSourceFraction: number;
  /** Mean fraction covered by treated (blurred/darkened/recoloured) source background. */
  meanTreatedSourceFraction: number;
  /** Mean fraction covered by a generated Muse plate, if any. */
  meanGeneratedFraction: number;
  /** Mean fraction covered by local typography/graphics drawn in front of the subject. */
  meanForegroundGraphicsFraction: number;
  /** Worst-case fraction of the subject hidden by foreground graphics in any frame. */
  maxSubjectOcclusion: number;
  /** Frames where the subject was cropped by the output frame edge by more than 5% of its area. */
  framesSubjectCropped: number;
  /** Frames without a usable subject mask (tracking lost). */
  framesWithoutSubject: number;
  generatedPixelsOnSubject: 0;
}
