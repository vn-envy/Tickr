import { Series, useVideoConfig } from "remotion";
import { assertReelProps, type ReelProps } from "../lib/rendering/reel-contract";
import { ActionScene } from "./templates/ActionScene";
import { HookScene } from "./templates/HookScene";
import { OccasionScene } from "./templates/OccasionScene";
import { ProofScene } from "./templates/ProofScene";

/** Four distinct beats, 12 seconds total. All motion follows the video frame. */
export function Reel(props: ReelProps) {
  assertReelProps(props);
  const { fps } = useVideoConfig();

  return (
    <Series>
      <Series.Sequence name="Hook" durationInFrames={2 * fps} premountFor={fps}>
        <HookScene {...props.hook} businessName={props.businessName} diagnostic={props.diagnostic} />
      </Series.Sequence>
      <Series.Sequence name="Proof" durationInFrames={3 * fps} premountFor={fps}>
        <ProofScene {...props.proof} businessName={props.businessName} diagnostic={props.diagnostic} />
      </Series.Sequence>
      <Series.Sequence name="Occasion" durationInFrames={4 * fps} premountFor={fps}>
        <OccasionScene {...props.occasion} businessName={props.businessName} diagnostic={props.diagnostic} />
      </Series.Sequence>
      <Series.Sequence name="Action" durationInFrames={3 * fps} premountFor={fps}>
        <ActionScene {...props.cta} businessName={props.businessName} diagnostic={props.diagnostic} />
      </Series.Sequence>
    </Series>
  );
}
