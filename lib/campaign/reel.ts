import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, resolve } from "node:path";

const run = promisify(execFile);

export interface ReelRenderOptions { artDirected?: boolean }

/** Local deterministic encoding. There is no remote media or video-model request. */
export async function renderReel(scenePaths: readonly string[], outputPath: string, options: ReelRenderOptions = {}): Promise<void> {
  if (scenePaths.length !== 4 || ![...scenePaths, outputPath].every(isAbsolute)) {
    throw new Error("The Reel needs four local scenes and an absolute output path.");
  }
  const files = scenePaths.map((path) => resolve(path));
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-filter_complex_threads", "1"];
  for (const path of files) args.push("-protocol_whitelist", "file,pipe", "-loop", "1", "-framerate", "30", "-t", "3.3", "-i", path);
  // The composed scenes keep their original typography. Motion is restrained to
  // at most 3% enlargement; pan stays entirely inside that small crop margin.
  const motions = [
    "zoompan=z='1.015+0.015*on/98':x='(iw-iw/zoom)*(0.25+0.5*on/98)':y='(ih-ih/zoom)*0.5':d=1:s=1080x1920:fps=30",
    "zoompan=z='1.03-0.015*on/98':x='(iw-iw/zoom)*0.5':y='(ih-ih/zoom)*(0.7-0.4*on/98)':d=1:s=1080x1920:fps=30",
    "zoompan=z='1.02+0.006*sin(on/98*PI)':x='(iw-iw/zoom)*(0.7-0.4*on/98)':y='(ih-ih/zoom)*0.5':d=1:s=1080x1920:fps=30",
    "zoompan=z='1.018':x='(iw-iw/zoom)*(0.35+0.3*on/98)':y='(ih-ih/zoom)*0.5':d=1:s=1080x1920:fps=30",
  ];
  const filters = files.map((_, index) => options.artDirected
    ? `[${index}:v]scale=1080:1920,setsar=1,${motions[index]},format=yuv420p,setpts=PTS-STARTPTS,fps=30,settb=1/30${index === 0 ? ",fade=t=in:st=0:d=0.22" : ""}[s${index}]`
    : `[${index}:v]scale=1080:1920,setsar=1,format=yuv420p,setpts=PTS-STARTPTS,fps=30,settb=1/30[s${index}]`);
  // Entrance fade + smooth slide + circular reveal + fade through black create
  // four different transitions across the four art-directed scenes.
  const transitions = options.artDirected ? ["smoothleft", "circleopen", "fadeblack"] : ["wipeleft", "slideright", "fade"];
  filters.push(`[s0][s1]xfade=transition=${transitions[0]}:duration=0.4:offset=2.9,fps=30,settb=1/30[v1]`, `[v1][s2]xfade=transition=${transitions[1]}:duration=0.4:offset=5.8,fps=30,settb=1/30[v2]`, `[v2][s3]xfade=transition=${transitions[2]}:duration=0.4:offset=8.7[out]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-an", "-t", "12", "-r", "30", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "25", "-pix_fmt", "yuv420p", "-threads", "2", "-movflags", "+faststart", outputPath);
  try {
    await run("ffmpeg", args, { timeout: 120_000, maxBuffer: 256_000 });
    const result = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name,nb_frames,r_frame_rate:format=duration", "-of", "json", outputPath], { timeout: 10_000, maxBuffer: 32_000 });
    const probe = JSON.parse(result.stdout) as { streams?: { width: number; height: number; codec_name: string; nb_frames: string; r_frame_rate: string }[]; format?: { duration: string } };
    const video = probe.streams?.[0];
    const duration = Number(probe.format?.duration);
    if (!video || video.width !== 1080 || video.height !== 1920 || video.codec_name !== "h264" || video.r_frame_rate !== "30/1" || Number(video.nb_frames) !== 360 || Math.abs(duration - 12) > 0.1) {
      throw new Error("Encoded Reel did not meet its output contract.");
    }
  } catch {
    // Child-process errors may contain local paths; keep public errors concise.
    throw new Error("The local Reel could not be rendered and verified. Check FFmpeg availability and retry this stage.");
  }
}
