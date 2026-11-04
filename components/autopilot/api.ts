import type { RunView } from "@/lib/research/contracts";
import type { AutopilotPublicState } from "@/lib/autopilot/public-state";
import { uploadUrl, type PeopleVisible } from "./model";

/** Browser-side HTTP helpers for the Autopilot routes (same-origin, no credentials beyond the session). */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "HttpError"; }
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { cache: "no-store", ...init }); }
  catch { throw new HttpError("Tickr couldn’t reach the local app. Check that it is still running.", 0); }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new HttpError(typeof body?.error === "string" ? body.error : `The request could not be completed (${response.status}).`, response.status);
  if (!body) throw new HttpError("The server returned an unreadable response.", response.status);
  return body as T;
}
export const postJson = <T>(url: string, body: unknown) => requestJson<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export type MediaAsset = { id: string; kind: "image" | "video"; provenance: "owner_upload"; mimeType: string; width: number; height: number; durationSeconds: number | null; bytes: number; addedAt: string; thumbUrl: string };
export type MetaConnection = { status: "not_configured" | "disconnected" | "connected" | "expired"; provider: "meta"; accountName: string | null; instagramUsername: string | null; pageName: string | null; expiresAt: string | null; mediaCount: number | null };
export type BusinessMedia = { assets: MediaAsset[]; connection: MetaConnection };

export const createBusiness = (website: string, goal: string) => postJson<{ business: { id: string } }>("/api/businesses", goal ? { website, goal } : { website });
export const getBusiness = (id: string) => requestJson<{ business: { id: string; website: string | null; goal: string } }>(`/api/businesses/${encodeURIComponent(id)}`);
export const getBusinessMedia = (id: string) => requestJson<BusinessMedia>(`/api/businesses/${encodeURIComponent(id)}/media`);
export const deleteBusinessMedia = (id: string, assetId: string) => requestJson<{ ok: true }>(`/api/businesses/${encodeURIComponent(id)}/media/${encodeURIComponent(assetId)}`, { method: "DELETE" });
export const disconnectMeta = (id: string) => requestJson<{ ok: true }>(`/api/businesses/${encodeURIComponent(id)}/connection`, { method: "DELETE" });
export const startAutopilotRun = (businessId: string) => postJson<{ run: RunView }>(`/api/businesses/${encodeURIComponent(businessId)}/runs`, { mode: "live", readWebsite: true, sources: [], discoverFromLink: true, enrichFromLink: true, autopilot: true });
export const getRun = (id: string) => requestJson<{ run: RunView }>(`/api/runs/${encodeURIComponent(id)}`);
export const getAutopilotState = (id: string) => requestJson<{ state: AutopilotPublicState | null }>(`/api/runs/${encodeURIComponent(id)}/autopilot`);
export const retryRun = (id: string) => postJson<{ run: RunView }>(`/api/runs/${encodeURIComponent(id)}/retry`, {});
export const approveRun = (id: string, manifestDigest: string) => postJson<{ run: RunView }>(`/api/runs/${encodeURIComponent(id)}/approve`, { manifestDigest, confirm: true });

/** Raw-body upload with progress (fetch cannot report upload progress). Resolves with the stored asset. */
export function uploadMedia(businessId: string, file: File, mimeType: string, people: PeopleVisible, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<MediaAsset> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", uploadUrl(businessId, file.name, people));
    request.setRequestHeader("Content-Type", mimeType);
    request.responseType = "json";
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(1, event.loaded / event.total)); };
    request.onload = () => {
      const body = request.response as { asset?: MediaAsset; error?: unknown } | null;
      if (request.status >= 200 && request.status < 300 && body?.asset) { onProgress(1); resolve(body.asset); return; }
      const fallback = request.status === 413 ? "This file is larger than the upload limit." : request.status === 404 ? "Photo uploads aren’t available in this build yet." : `The upload could not be completed (${request.status}).`;
      reject(new HttpError(typeof body?.error === "string" ? body.error : fallback, request.status));
    };
    request.onerror = () => reject(new HttpError("The upload was interrupted. Check the connection and try again.", 0));
    request.onabort = () => reject(new HttpError("Upload cancelled.", 0));
    signal?.addEventListener("abort", () => request.abort(), { once: true });
    request.send(file);
  });
}
