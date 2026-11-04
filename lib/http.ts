export class RequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function readLocalJson(request: Request, limit = 16_384): Promise<unknown> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new RequestError("Cross-origin writes are not allowed.", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new RequestError("Send application/json.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("A JSON body is required.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RequestError("Request body is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestError("Invalid JSON.", 400); }
}
