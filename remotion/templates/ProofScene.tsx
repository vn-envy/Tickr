import type { StandaloneSceneProps } from "../../lib/rendering/reel-contract";
import { SceneFrame } from "./SceneFrame";

export function ProofScene(props: StandaloneSceneProps) {
  return <SceneFrame {...props} chapter="02 / Proof" tone="dark" layout="detail" />;
}
