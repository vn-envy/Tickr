import type { CompositionLedger } from "../../media/cinema-types";

/**
 * Pixel-provenance accounting for the local compositor. Every frame is replayed at
 * reduced resolution as a stack of per-layer alpha maps; standard "over" compositing
 * tracks how much of each output pixel is visibly owed to each layer class. The
 * resulting CompositionLedger feeds honest provenance labels and QA gates.
 *
 * Invariant: a generated plate may only ever be drawn where no subject pixel is
 * visible yet (it sits underneath the real subject). Drawing it over subject pixels
 * throws, so `generatedPixelsOnSubject` is 0 by construction rather than by policy.
 */

export type LedgerLayerClass =
  /** Real subject pixels: resized source RGB × SAM mask alpha. */
  | "subject"
  /** Source background that was filled, blurred, darkened or recoloured. */
  | "treated_source"
  /** A generated (Muse) plate. Never on the subject. */
  | "generated"
  /** Local typography/graphics drawn in front of the subject layer. */
  | "foreground_graphics"
  /** Local graphics drawn behind the subject (paper, gradients, shadows, depth type). */
  | "background_graphics"
  /** Full-frame transition washes (e.g. a fade through the accent colour). */
  | "transition";

const CLASSES = ["subject", "treated_source", "generated", "foreground_graphics", "background_graphics", "transition"] as const;
/** A subject instance cropped by more than this fraction of its area marks the frame as cropped. */
export const SUBJECT_CROP_TOLERANCE = 0.05;
/** Below this mean visible subject weight a frame counts as having no subject. */
export const SUBJECT_PRESENCE_EPSILON = 0.001;
/** A frame whose mean transition-wash weight exceeds this share hides the subject by design, not by tracking loss. */
export const TRANSITION_WASH_SHARE = 0.5;
/** In a mix, one side's subject draws count toward crop accounting only when at least this share of them stays visible. */
export const MIX_VISIBILITY_SHARE = 0.05;
const EPSILON = 1e-6;

export class LedgerInvariantError extends Error {
  constructor(message: string) { super(message); this.name = "LedgerInvariantError"; }
}

/** One subject draw: output-pixel area inside the frame vs. the full transformed mask area. */
export interface SubjectInstance { insideArea: number; totalArea: number }

/** Reduced-resolution class-weight canvas for one frame (or one scene before a transition mix). */
export class LedgerCanvas {
  readonly width: number;
  readonly height: number;
  /** Visible weight per class; for every pixel the weights sum to ≤ 1. */
  readonly weights: Record<LedgerLayerClass, Float32Array>;
  /** Subject coverage before foreground graphics (denominator of the occlusion ratio). */
  readonly subjectPresent: Float32Array;
  readonly subjectInstances: SubjectInstance[] = [];

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 4_000_000) throw new LedgerInvariantError("Ledger canvas geometry is invalid.");
    this.width = width; this.height = height;
    const n = width * height;
    this.weights = Object.fromEntries(CLASSES.map((name) => [name, new Float32Array(n)])) as Record<LedgerLayerClass, Float32Array>;
    this.subjectPresent = new Float32Array(n);
  }

  /** Composites one layer's alpha map (same size as the canvas, values 0–1) over the stack. */
  over(layerClass: LedgerLayerClass, alpha: Float32Array, opacity = 1): void {
    if (alpha.length !== this.width * this.height) throw new LedgerInvariantError("Ledger alpha map does not match the canvas.");
    if (!(opacity >= 0 && opacity <= 1)) throw new LedgerInvariantError("Ledger layer opacity is out of range.");
    if (opacity === 0) return;
    const w = this.weights, present = this.subjectPresent;
    const [subject, treated, generated, foreground, background, transition] = CLASSES.map((name) => w[name]);
    const target = w[layerClass];
    const isGenerated = layerClass === "generated", isSubject = layerClass === "subject", isForeground = layerClass === "foreground_graphics";
    for (let i = 0; i < alpha.length; i++) {
      const value = alpha[i];
      if (!(value > 0)) continue;
      const a = (value >= 1 ? 1 : value) * opacity;
      if (isGenerated && subject[i] > EPSILON) throw new LedgerInvariantError("A generated layer was composited over subject pixels.");
      const keep = 1 - a;
      subject[i] *= keep; treated[i] *= keep; generated[i] *= keep; foreground[i] *= keep; background[i] *= keep; transition[i] *= keep;
      target[i] += a;
      if (isSubject) present[i] = present[i] * keep + a;
      else if (!isForeground) present[i] *= keep;
    }
  }

  /** Records the frame-edge crop accounting for one subject draw. */
  addSubjectInstance(instance: SubjectInstance): void {
    if (!(instance.totalArea >= 0) || !(instance.insideArea >= 0) || !Number.isFinite(instance.totalArea)) throw new LedgerInvariantError("Subject instance area is invalid.");
    this.subjectInstances.push({ insideArea: Math.min(instance.insideArea, instance.totalArea), totalArea: instance.totalArea });
  }

  /**
   * this ← this·(1−mask) + other·mask, used by mask/silhouette and cross-fade transitions.
   * Frame-edge crop records follow visibility: a side whose subject is (almost) entirely
   * masked away no longer marks the mixed frame as cropped.
   */
  mix(other: LedgerCanvas, mask: Float32Array): void {
    if (other.width !== this.width || other.height !== this.height || mask.length !== this.width * this.height) throw new LedgerInvariantError("Ledger mix geometry does not match.");
    const mine = CLASSES.map((name) => this.weights[name]), theirs = CLASSES.map((name) => other.weights[name]);
    let maskSum = 0, minePresent = 0, mineVisible = 0, theirPresent = 0, theirVisible = 0;
    for (let i = 0; i < mask.length; i++) {
      const m = Math.min(1, Math.max(0, mask[i]));
      maskSum += m;
      minePresent += this.subjectPresent[i]; mineVisible += this.subjectPresent[i] * (1 - m);
      theirPresent += other.subjectPresent[i]; theirVisible += other.subjectPresent[i] * m;
      if (m <= 0) continue;
      for (let c = 0; c < mine.length; c++) mine[c][i] = mine[c][i] * (1 - m) + theirs[c][i] * m;
      this.subjectPresent[i] = this.subjectPresent[i] * (1 - m) + other.subjectPresent[i] * m;
    }
    // A subject drawn entirely off-canvas has no presence; the mask's mean area stands in for its visibility.
    const meanMask = maskSum / mask.length;
    const mineShare = minePresent > EPSILON ? mineVisible / minePresent : 1 - meanMask;
    const theirShare = theirPresent > EPSILON ? theirVisible / theirPresent : meanMask;
    if (mineShare < MIX_VISIBILITY_SHARE) this.subjectInstances.length = 0;
    if (theirShare >= MIX_VISIBILITY_SHARE) this.subjectInstances.push(...other.subjectInstances);
  }
}

export interface LedgerFrameStats {
  subjectFraction: number;
  treatedFraction: number;
  generatedFraction: number;
  foregroundFraction: number;
  /** Fraction of the subject's (pre-foreground) coverage hidden by foreground graphics. */
  subjectOcclusion: number;
  subjectCropped: boolean;
  /** Mean weight of full-frame transition washes. */
  transitionFraction: number;
  /** No visible subject and no transition wash explains it (the ledger's "tracking lost"). */
  withoutSubject: boolean;
  /** No visible subject because a deliberate transition wash covers most of the frame. */
  subjectHiddenByTransition: boolean;
}

/** Measures one finished frame canvas. Exposed for per-frame QA and tests. */
export function measureLedgerFrame(canvas: LedgerCanvas): LedgerFrameStats {
  const n = canvas.width * canvas.height;
  const w = canvas.weights;
  let subject = 0, treated = 0, generated = 0, foreground = 0, transition = 0, present = 0;
  for (let i = 0; i < n; i++) {
    const total = w.subject[i] + w.treated_source[i] + w.generated[i] + w.foreground_graphics[i] + w.background_graphics[i] + w.transition[i];
    if (total > 1 + 1e-3) throw new LedgerInvariantError("Ledger weights exceed full coverage.");
    subject += w.subject[i]; treated += w.treated_source[i]; generated += w.generated[i]; foreground += w.foreground_graphics[i]; transition += w.transition[i]; present += canvas.subjectPresent[i];
  }
  const occlusion = present > EPSILON * n ? Math.min(1, Math.max(0, (present - subject) / present)) : 0;
  const absent = subject / n < SUBJECT_PRESENCE_EPSILON, washed = transition / n > TRANSITION_WASH_SHARE;
  return {
    subjectFraction: subject / n, treatedFraction: treated / n, generatedFraction: generated / n, foregroundFraction: foreground / n,
    subjectOcclusion: occlusion,
    subjectCropped: canvas.subjectInstances.some((item) => item.totalArea > 0 && 1 - item.insideArea / item.totalArea > SUBJECT_CROP_TOLERANCE),
    transitionFraction: transition / n,
    withoutSubject: absent && !washed,
    subjectHiddenByTransition: absent && washed,
  };
}

/** Accumulates per-frame canvases into the shared CompositionLedger contract. */
export class CompositionLedgerAccumulator {
  private frames = 0;
  private sums = { subject: 0, treated: 0, generated: 0, foreground: 0 };
  private maxOcclusion = 0;
  private cropped = 0;
  private missing = 0;
  private washed = 0;

  /**
   * Frames whose subject was deliberately hidden by a transition wash (e.g. the middle
   * of a fade through a colour). They are not counted in `framesWithoutSubject`, which
   * keeps its shared meaning of "no usable subject" (tracking lost / subject absent).
   */
  get framesSubjectHiddenByTransition(): number { return this.washed }

  addFrame(canvas: LedgerCanvas): LedgerFrameStats {
    const stats = measureLedgerFrame(canvas);
    this.frames++;
    this.sums.subject += stats.subjectFraction; this.sums.treated += stats.treatedFraction;
    this.sums.generated += stats.generatedFraction; this.sums.foreground += stats.foregroundFraction;
    this.maxOcclusion = Math.max(this.maxOcclusion, stats.subjectOcclusion);
    if (stats.subjectCropped) this.cropped++;
    if (stats.withoutSubject) this.missing++;
    if (stats.subjectHiddenByTransition) this.washed++;
    return stats;
  }

  finish(): CompositionLedger {
    if (!this.frames) throw new LedgerInvariantError("A composition ledger needs at least one frame.");
    const mean = (value: number) => Number((value / this.frames).toFixed(6));
    const ledger: CompositionLedger = {
      frames: this.frames,
      meanSubjectSourceFraction: mean(this.sums.subject),
      meanTreatedSourceFraction: mean(this.sums.treated),
      meanGeneratedFraction: mean(this.sums.generated),
      meanForegroundGraphicsFraction: mean(this.sums.foreground),
      maxSubjectOcclusion: Number(this.maxOcclusion.toFixed(6)),
      framesSubjectCropped: this.cropped,
      framesWithoutSubject: this.missing,
      generatedPixelsOnSubject: 0,
    };
    assertLedger(ledger);
    return ledger;
  }
}

/** Structural invariants of a ledger, including the generated-on-subject guarantee. */
export function assertLedger(ledger: CompositionLedger): void {
  const fractions = [ledger.meanSubjectSourceFraction, ledger.meanTreatedSourceFraction, ledger.meanGeneratedFraction, ledger.meanForegroundGraphicsFraction, ledger.maxSubjectOcclusion];
  if (!Number.isInteger(ledger.frames) || ledger.frames < 1 || fractions.some((value) => !(value >= 0 && value <= 1))) throw new LedgerInvariantError("Composition ledger values are out of range.");
  if (fractions.slice(0, 4).reduce((sum, value) => sum + value, 0) > 1 + 1e-3) throw new LedgerInvariantError("Composition ledger fractions exceed full coverage.");
  if (![ledger.framesSubjectCropped, ledger.framesWithoutSubject].every((value) => Number.isInteger(value) && value >= 0 && value <= ledger.frames)) throw new LedgerInvariantError("Composition ledger frame counts are invalid.");
  if (ledger.generatedPixelsOnSubject !== 0) throw new LedgerInvariantError("Generated pixels were placed on the subject.");
}
