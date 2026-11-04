import type { StandaloneSceneProps } from "../../lib/rendering/reel-contract";
import { SceneFrame } from "./SceneFrame";

export function ActionScene(props: StandaloneSceneProps) {
  return <SceneFrame {...props} chapter="04 / Action" tone="dark" layout="action" />;
}
