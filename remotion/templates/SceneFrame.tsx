import {
  AbsoluteFill,
  CanvasImage,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  assertSceneProps,
  type StandaloneSceneProps,
} from "../../lib/rendering/reel-contract";

type SceneFrameProps = StandaloneSceneProps & {
  chapter: string;
  tone: "light" | "dark";
  layout: "hero" | "detail" | "occasion" | "action";
};

/** A shared deterministic template. No fetches, remote fonts or image generation. */
export function SceneFrame(props: SceneFrameProps) {
  assertSceneProps(props);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dark = props.tone === "dark";
  const foreground = dark ? "#f7f1e8" : "#282620";
  const background = dark ? "#282620" : "#f7f1e8";
  const asset = props.assetPath ? staticFile(props.assetPath) : null;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: background,
        color: foreground,
        fontFamily: "Arial, Helvetica, sans-serif",
        padding: "160px 80px 190px",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: "144px 64px 172px",
          border: `1px solid ${dark ? "#555047" : "#d9d0c2"}`,
          borderRadius: 32,
        }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 24,
          fontSize: 24,
          letterSpacing: 3,
          textTransform: "uppercase",
        }}
      >
        <span>{props.businessName}</span>
        <span style={{ color: "#dd7143", flexShrink: 0 }}>{props.chapter}</span>
      </div>

      <div
        style={{
          flex: 1,
          margin: "70px 0 60px",
          position: "relative",
          overflow: "hidden",
          borderRadius: props.layout === "detail" ? 8 : 200,
          backgroundColor: dark ? "#3c3831" : "#e7ddce",
          opacity: interpolate(frame, [0, 0.35 * fps], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          scale: interpolate(frame, [0, 4 * fps], [0.98, 1.03], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        {asset ? (
          <CanvasImage
            src={asset}
            premountFor={fps}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : (
          <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
            <div
              style={{
                width: props.layout === "action" ? 360 : 500,
                height: props.layout === "action" ? 360 : 500,
                borderRadius: props.layout === "occasion" ? 64 : "50%",
                border: "3px solid #dd7143",
                rotate: `${interpolate(frame, [0, 4 * fps], [-8, 8], {
                  extrapolateRight: "clamp",
                })}deg`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span
                style={{
                  fontSize: 28,
                  letterSpacing: 5,
                  textAlign: "center",
                  maxWidth: 300,
                  lineHeight: 1.8,
                  opacity: 0.7,
                }}
              >
                {props.diagnostic ? "LOCAL RENDER CHECK" : "ADD AN APPROVED PHOTO"}
              </span>
            </div>
          </AbsoluteFill>
        )}
      </div>

      <div
        style={{
          opacity: interpolate(frame, [0, 0.4 * fps], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          translate: `0px ${interpolate(frame, [0, 0.5 * fps], [28, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          })}px`,
        }}
      >
        <h1 style={{ fontSize: 84, lineHeight: 1.04, letterSpacing: -3, margin: 0 }}>
          {props.headline}
        </h1>
        <p style={{ fontSize: 34, lineHeight: 1.4, margin: "32px 0 0", opacity: 0.8 }}>
          {props.body}
        </p>
      </div>
      {props.diagnostic ? (
        <div
          style={{
            position: "absolute",
            bottom: 100,
            left: 80,
            right: 80,
            textAlign: "center",
            fontSize: 22,
            letterSpacing: 2,
            color: "#dd7143",
          }}
        >
          DIAGNOSTIC FIXTURE · NOT A GENERATED BUSINESS CAMPAIGN
        </div>
      ) : null}
    </AbsoluteFill>
  );
}
