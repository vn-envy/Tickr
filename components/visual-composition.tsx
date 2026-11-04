import { ChevronDown, Download, Layers3 } from "lucide-react";
import type { CampaignKit, RunView } from "@/lib/research/contracts";

export function VisualComposition({ run, campaign }: { run: RunView; campaign: CampaignKit }) {
  const visual = campaign.visual;
  const direction = visual?.artDirection;
  if (!visual || !direction) return null;
  const { segmentation } = direction;
  const cutoutUsed = direction.composition === "subject_layers" && segmentation.status === "segmented";
  const status = cutoutUsed ? "SAM subject cutout used" : segmentation.status === "no_match" ? "No usable subject cutout" : segmentation.status === "failed" ? "Subject cutout unavailable" : segmentation.status === "skipped" ? "Subject cutout skipped" : "Composed image crop";
  const background = { palette: "Campaign palette background", meta_generated: "Meta-generated backdrop", source: "Source image background" }[direction.background];
  const files = [
    { filename: direction.foregroundFilename, label: "Subject cutout" },
    { filename: direction.maskFilename, label: "Selection mask" },
    { filename: direction.backgroundFilename, label: "Backdrop" },
  ].flatMap((file) => file.filename && campaign.assets.some((asset) => asset.filename === file.filename && asset.mediaType === "image") ? [{ filename: file.filename, label: file.label }] : []);

  return <div className="visual-composition">
    <div className="composition-summary"><Layers3 size={14} /><div><strong>{status}</strong><span>{background}</span></div></div>
    <p>{cutoutUsed ? visual.kind === "meta_illustration" ? "The illustrated subject was isolated for this layout. It remains an illustration, not a photograph of an actual product." : "The cutout retains pixels from the sourced photograph. This does not verify product identity or permission to publish." : "This layout uses a composed crop of the source image."}{direction.background === "meta_generated" && " The generated backdrop does not depict the business’s real premises."}</p>
    <details className="composition-details"><summary>Composition & layer files<ChevronDown size={13} /></summary><dl>
      <div><dt>Composition</dt><dd>{direction.composition === "subject_layers" ? "Separate subject and background layers" : "Image crop"}</dd></div>
      <div><dt>Subject selection</dt><dd>{segmentation.status === "segmented" ? "Selection produced" : segmentation.status === "no_match" ? "No usable match" : segmentation.status === "failed" ? "Unavailable" : "Not run"}</dd></div>
      {segmentation.model && <div><dt>Selection model</dt><dd>{segmentation.model}</dd></div>}
      {segmentation.prompt && <div><dt>Requested subject</dt><dd>{segmentation.prompt}</dd></div>}
      {segmentation.coverageFraction !== null && <div><dt>Selected image area</dt><dd>{(segmentation.coverageFraction * 100).toFixed(1)}% · mask coverage, not confidence</dd></div>}
      {segmentation.status === "segmented" && <div><dt>Selected regions</dt><dd>{segmentation.objectCount}</dd></div>}
      <div className="composition-checksum"><dt>Source image checksum</dt><dd><code>{direction.sourceSha256}</code></dd></div>
    </dl>{files.length > 0 && <div className="composition-files">{files.map((file) => <a key={file.filename} href={`/api/runs/${encodeURIComponent(run.id)}/files/${encodeURIComponent(file.filename)}`} download={file.filename}><Download size={12} />{file.label}</a>)}</div>}</details>
  </div>;
}
