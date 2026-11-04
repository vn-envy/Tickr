/**
 * Shared hardening for local FFmpeg/ffprobe children.
 *
 * A child parses media that is often fully untrusted (owner uploads, Meta CDN downloads, website
 * images). If a demuxer or decoder bug were ever exploited, the child must not hold server
 * credentials: it receives only what it needs to start, never META_API_KEY, META_APP_SECRET,
 * TICKR_SECRET_KEY or any other server variable.
 */

/** Demuxers allowed for untrusted owner/Meta video (MP4/MOV family, Matroska/WebM). */
export const MEDIA_DEMUXER_ALLOWLIST = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm";

/** Minimal child environment: PATH (to find the tool), NODE_ENV and an optional LD_LIBRARY_PATH. */
export function mediaToolEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV, PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  if (source.LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = source.LD_LIBRARY_PATH;
  return env;
}
