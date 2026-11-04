import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

function cssRules(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((match) => match[1]);
}

describe("Autopilot phone mockup (h-phone-crop)", () => {
  const css = read("app/globals.css");

  it("shows the whole 9:16 Reel frame instead of cropping it to the taller screen", () => {
    const rules = cssRules(css, ".ap-phone video");
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).not.toMatch(/object-fit\s*:\s*(cover|fill|none|scale-down)/);
    expect(rules.some((rule) => /object-fit\s*:\s*contain/.test(rule))).toBe(true);
    // The letterbox around the contained frame stays dark, matching the device screen.
    expect(rules.some((rule) => /background\s*:\s*#000\b/.test(rule))).toBe(true);
  });

  it("does not reintroduce cropping for the phone video at any breakpoint", () => {
    expect(css).not.toMatch(/\.ap-phone[^{]*video[^{]*\{[^}]*object-fit\s*:\s*cover/);
  });
});

describe("Modal deployment docs and startup (h-readme)", () => {
  const readme = read("deploy/README.md");
  const start = read("deploy/modal-start.sh");

  it("tells operators to use the printed URL, which may carry a region, for TICKR_ALLOWED_HOSTS", () => {
    expect(readme).toContain("<workspace>--tickr[.<region>].modal.run");
    expect(readme).toMatch(/Always use the URL `modal deploy` prints/);
    expect(readme).not.toMatch(/the host is then `<workspace>--tickr\.modal\.run`/);
    expect(readme).not.toMatch(/^HOST=<workspace>--tickr\.modal\.run$/m);
  });

  it("keeps the modal_app.py URL comment consistent with the region-aware README", () => {
    const app = read("deploy/modal_app.py");
    expect(app).toContain("<workspace>--tickr[.<region>].modal.run");
    expect(app).not.toMatch(/https:\/\/<workspace>--tickr\.modal\.run/);
  });

  it("documents the modal proxy extra for HTTPS proxies, pinned to the checked SDK version", () => {
    expect(readme).toContain("'modal[api-proxy-support]==1.6.3'");
  });

  it("logs a single success line after the Volume probe passes, before linking .data", () => {
    const matches = start.match(/volume hard-link probe ok/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(start).toMatch(/if probe_volume; then\n\s*log "volume hard-link probe ok"\n\s*\[\[ -L \.data \]\] \|\| ln -s/);
  });
});
