import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { jobs } from "@/lib/jobs/store";
import { jobError, requireId } from "@/lib/jobs/http";
import { RequestError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".zip": "application/zip", ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

export async function GET(request: Request, context: { params: Promise<{ id: string; filename: string }> }) {
  try {
    const { id, filename } = await context.params;
    requireId(id);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(filename) || filename.includes("..")) throw new RequestError("Asset not found.", 404);
    const run = await jobs.view(id);
    const asset = run.campaign?.assets.find((item) => item.filename === filename);
    if (!asset) throw new RequestError("Asset not found in this campaign manifest.", 404);
    const runsRoot = await realpath(resolve(".data/runs"));
    const directory = await realpath(resolve(runsRoot, id));
    if (!directory.startsWith(runsRoot + sep)) throw new RequestError("Asset directory failed its path integrity check.", 409);
    const pathname = resolve(directory, filename);
    const stats = await lstat(pathname);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 134_217_728 || stats.size !== asset.bytes
      || !(await realpath(pathname)).startsWith(directory + sep)) throw new RequestError("Asset failed its file integrity check.", 409);
    const bytes = await readFile(pathname);
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new RequestError("Asset bytes changed after the campaign manifest was saved. Download withheld.", 409);
    const contentType = MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
    const headers = new Headers({
      "Content-Type": contentType, "Content-Length": String(bytes.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `${["document", "archive"].includes(asset.mediaType) ? "attachment" : "inline"}; filename="${filename}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox", "Accept-Ranges": "bytes",
    });
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : -1;
      const end = match?.[2] ? Number(match[2]) : bytes.length - 1;
      if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= bytes.length || end < start || end >= bytes.length) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${bytes.length}` } });
      }
      headers.set("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
      headers.set("Content-Length", String(end - start + 1));
      return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers });
    }
    return new Response(new Uint8Array(bytes), { headers });
  } catch (error) { return jobError(error); }
}
