"use client";

import { useEffect, useState } from "react";
import { Camera, ImagePlus, PlugZap } from "lucide-react";
import type { RunView } from "@/lib/research/contracts";
import type { AutopilotPublicState } from "@/lib/autopilot/public-state";
import { getBusinessMedia } from "./api";
import { isActiveRun, noRealMedia, type IntakeFocus } from "./model";

/** Whether the Meta connector can be offered: only when this install has it configured and it isn't already connected. */
function useConnectOffer(businessId: string, enabled: boolean): boolean {
  const [offer, setOffer] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    getBusinessMedia(businessId)
      .then((body) => { if (!stopped) setOffer(body.connection.status === "disconnected" || body.connection.status === "expired"); })
      .catch(() => { if (!stopped) setOffer(false); });
    return () => { stopped = true; };
  }, [businessId, enabled]);
  return offer;
}

/**
 * Shown when Autopilot had no real photos or videos of the business to work with. It explains what
 * happened and invites the owner to add media they own (or connect their accounts), then run again.
 * Tickr never reads Google listings; photos from the owner's own Business Profile are added by them.
 */
export function RealMediaCard({ run, state, onAddMedia }: { run: RunView; state: AutopilotPublicState | null; onAddMedia: (focus: IntakeFocus) => void }) {
  const missing = noRealMedia(state, run.quality);
  const offerConnect = useConnectOffer(run.businessId, Boolean(missing));
  if (!missing) return null;
  const running = isActiveRun(run);
  const visuals = running ? "so the visuals will be clearly-labelled illustrations" : "so the visuals are clearly-labelled illustrations";
  const what = missing.reason === "none_gathered"
    ? missing.connected
      ? `Autopilot couldn’t use any real photos of your business this time: the website and your connected account didn’t provide usable photos, and there were no uploads — ${visuals}.`
      : `Autopilot couldn’t use any real photos of your business this time: the website didn’t give it usable photos, and there were no uploads or connected accounts — ${visuals}.`
    : missing.reason === "none_usable" ? `Autopilot found some media, but none of it was usable for this campaign, ${visuals}.`
    : `Autopilot didn’t use any real photos of your business this time, ${visuals}.`;
  return <section className="ap-panel" aria-labelledby="ap-real-media-title" style={{ marginBottom: 22 }}>
    <div className="ap-card-heading">
      <span className="ap-card-icon" aria-hidden="true"><Camera size={18} strokeWidth={1.7} /></span>
      <div>
        <h2 id="ap-real-media-title">Add real photos for a stronger campaign</h2>
        <p>{what}</p>
      </div>
    </div>
    <p className="ap-help">Why it matters: real product photos let SAM cut out your actual products and make the cinematic Reel possible.</p>
    <p className="ap-help">Phone shots work well. You can also download photos from your own Google Business Profile and add them. Only add photos you own or have the rights to use.</p>
    <div className="ap-error-actions" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      <button type="button" className="button button-primary" onClick={() => onAddMedia("media")}><ImagePlus size={15} />Add your photos</button>
      {offerConnect && <button type="button" className="button button-secondary" onClick={() => onAddMedia("connect")}><PlugZap size={15} />Connect Instagram / Facebook</button>}
    </div>
    <p className="ap-fineprint">Your link and goal stay as they are. Add your media, then press Run Autopilot again{running ? ". Leaving this view doesn’t stop the current run; it keeps going in the background" : ""}.</p>
  </section>;
}
