"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";
import { clampBox, type PublicBox } from "./model";

export type BoxTone = "subject" | "critical" | "major" | "minor";
export type DrawnBox = { id: string; box: PublicBox | null; tone: BoxTone };

/**
 * An image fitted inside its frame with outline overlays in the asset's own pixel space.
 * SVG keeps every box exactly aligned at any size without measuring the layout.
 */
export function BoxedImage({ src, width, height, label, boxes = [], fit = "meet", className = "" }: { src: string | null; width: number; height: number; label: string; boxes?: DrawnBox[]; fit?: "meet" | "slice"; className?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const failed = Boolean(src) && failedSrc === src;
  const drawn = boxes.flatMap((item) => { const box = clampBox(item.box, width, height); return box ? [{ ...item, box }] : []; });
  if (!src || failed || width <= 0 || height <= 0) return <div className={`ap-boxed ap-boxed-missing ${className}`} role="img" aria-label={`${label} (preview unavailable)`}><ImageOff size={20} strokeWidth={1.5} /></div>;
  return <svg className={`ap-boxed ${loadedSrc === src ? "is-loaded" : ""} ${className}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio={`xMidYMid ${fit}`} role="img" aria-label={label}>
    <image href={src} x={0} y={0} width={width} height={height} preserveAspectRatio="none" onLoad={() => setLoadedSrc(src)} onError={() => setFailedSrc(src)} />
    {drawn.map((item) => <rect key={item.id} className={`ap-box ap-box-${item.tone}`} x={item.box.x1} y={item.box.y1} width={item.box.x2 - item.box.x1 + 1} height={item.box.y2 - item.box.y1 + 1} vectorEffect="non-scaling-stroke" />)}
  </svg>;
}
