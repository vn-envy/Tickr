"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";

/** Calm, full-width frame for the Autopilot experience (the studio keeps its own sidebar shell). */
export function AutopilotShell({ onStudio, children }: { onStudio: () => void; children: ReactNode }) {
  return <div className="ap-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="ap-topbar">
      <Link href="/" className="brand ap-brand" aria-label="Tickr home"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span>tickr<span className="brand-period">.</span></span></Link>
      <div className="ap-topbar-right">
        <span className="local-badge ap-hide-small"><span className="status-dot" />Private workspace</span>
        <button type="button" className="ap-studio-switch" onClick={onStudio}><SlidersHorizontal size={13} /><span><span className="ap-hide-small">Advanced: </span>step-by-step studio</span></button>
      </div>
    </header>
    <main id="main-content" className="ap-main">{children}</main>
    <footer className="ap-footer"><span>Made for the businesses behind the neighbourhood.</span><span>Tickr · Meta AI · nothing is published without you</span></footer>
  </div>;
}
