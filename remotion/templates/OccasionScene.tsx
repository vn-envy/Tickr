import type { StandaloneSceneProps } from "../../lib/rendering/reel-contract";
import { SceneFrame } from "./SceneFrame";

export function OccasionScene(props: StandaloneSceneProps) {
  return <SceneFrame {...props} chapter="03 / Occasion" tone="light" layout="occasion" />;
}
