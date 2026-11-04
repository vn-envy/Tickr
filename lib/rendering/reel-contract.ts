/** Local composition inputs. These are presentation data, not approved campaign claims. */
export type ReelScene = {
  headline: string;
  body: string;
  /** A locally prepared raster image under public/media/. Never a remote URL. */
  assetPath?: string;
};

export type ReelProps = {
  businessName: string;
  diagnostic: boolean;
  hook: ReelScene;
  proof: ReelScene;
  occasion: ReelScene;
  cta: ReelScene;
};

export type StandaloneSceneProps = ReelScene & {
  businessName: string;
  diagnostic: boolean;
};

export const REEL_COMPOSITION_ID = "TickrReel";
export const REEL_FPS = 30;
export const REEL_DURATION_SECONDS = 12;
export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;

/**
 * Only local raster assets are accepted. SVG is deliberately excluded because
 * untrusted SVG can contain references to external resources. Asset ingestion
 * must still validate the actual bytes and permissions before copying a file.
 */
export function assertLocalRasterAssetPath(value: string): void {
  if (
    !/^media\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp)$/i.test(value)
  ) {
    throw new Error("Reel assets must be local raster files under public/media/.");
  }
}

export function assertSceneProps(scene: ReelScene): void {
  if (!scene.headline.trim() || scene.headline.length > 100) {
    throw new Error("A reel scene needs a headline of 1–100 characters.");
  }
  if (scene.body.length > 220) {
    throw new Error("Reel scene body must not exceed 220 characters.");
  }
  if (scene.assetPath !== undefined) assertLocalRasterAssetPath(scene.assetPath);
}

export function assertReelProps(props: ReelProps): void {
  if (!props.businessName.trim() || props.businessName.length > 70) {
    throw new Error("A reel needs a business name of 1–70 characters.");
  }
  for (const scene of [props.hook, props.proof, props.occasion, props.cta]) {
    assertSceneProps(scene);
  }
}
