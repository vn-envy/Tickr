import { Composition, Folder } from "remotion";
import { Reel } from "./Reel";
import { ActionScene } from "./templates/ActionScene";
import { HookScene } from "./templates/HookScene";
import { OccasionScene } from "./templates/OccasionScene";
import { ProofScene } from "./templates/ProofScene";

export function RemotionRoot() {
  return (
    <>
      <Composition
        id="TickrReel"
        component={Reel}
        fps={30}
        durationInFrames={360}
        width={1080}
        height={1920}
        defaultProps={{
          businessName: "Tickr renderer check",
          diagnostic: true,
          hook: { headline: "A working motion canvas.", body: "This is a synthetic setup fixture." },
          proof: { headline: "Four scenes. One story.", body: "Hook, proof, occasion and a clear action." },
          occasion: { headline: "Your real assets go here.", body: "No business evidence or generated imagery is implied." },
          cta: { headline: "Ready for the next build step.", body: "Campaign generation and approval are still to be connected." },
        }}
      />
      <Folder name="Scenes">
        <Composition
          id="HookScene"
          component={HookScene}
          fps={30}
          durationInFrames={60}
          width={1080}
          height={1920}
          defaultProps={{ businessName: "Tickr renderer check", diagnostic: true, headline: "A working motion canvas.", body: "This is a synthetic setup fixture." }}
        />
        <Composition
          id="ProofScene"
          component={ProofScene}
          fps={30}
          durationInFrames={90}
          width={1080}
          height={1920}
          defaultProps={{ businessName: "Tickr renderer check", diagnostic: true, headline: "Four scenes. One story.", body: "Hook, proof, occasion and a clear action." }}
        />
        <Composition
          id="OccasionScene"
          component={OccasionScene}
          fps={30}
          durationInFrames={120}
          width={1080}
          height={1920}
          defaultProps={{ businessName: "Tickr renderer check", diagnostic: true, headline: "Your real assets go here.", body: "No business evidence or generated imagery is implied." }}
        />
        <Composition
          id="ActionScene"
          component={ActionScene}
          fps={30}
          durationInFrames={90}
          width={1080}
          height={1920}
          defaultProps={{ businessName: "Tickr renderer check", diagnostic: true, headline: "Ready for the next build step.", body: "Campaign generation and approval are still to be connected." }}
        />
      </Folder>
    </>
  );
}
