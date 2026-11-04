import type { StandaloneSceneProps } from "../../lib/rendering/reel-contract";
import { SceneFrame } from "./SceneFrame";

export function HookScene(props: StandaloneSceneProps) {
  return <SceneFrame {...props} chapter="01 / Hook" tone="light" layout="hero" />;
}
