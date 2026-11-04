/**
 * Browser-safe sequential upload loop for the Autopilot intake, kept free of React so its
 * cancellation and removal rules are testable. The owner's choices always win:
 * - a file removed before its turn is never sent;
 * - removing the file that is uploading aborts its request;
 * - a file that finished uploading although it was removed is handed back for undoing;
 * - cancelling the batch aborts the request in flight and nothing after it is attempted.
 */
export class UploadCancelledError extends Error {
  constructor() { super("Upload cancelled. Autopilot was not started; your files are still here."); this.name = "UploadCancelledError"; }
}

export type UploadBatchHooks<Item extends { id: string }, Asset> = {
  /** Checked synchronously before and after each upload: true once the owner removed the item. */
  isRemoved: (id: string) => boolean;
  upload: (item: Item, signal: AbortSignal) => Promise<Asset>;
  /** Registers (or clears, with null) the controller that aborts this item's request. */
  track?: (id: string, controller: AbortController | null) => void;
  onStart?: (item: Item) => void;
  onUploaded: (item: Item, asset: Asset) => void;
  /** The request completed before the removal could abort it: the stored asset must be undone. */
  onRemovedAfterUpload: (item: Item, asset: Asset) => Promise<void>;
  onFailed: (item: Item, error: unknown) => void;
  /** The batch was cancelled while this item was uploading. */
  onCancelled?: (item: Item) => void;
  /** Stop the batch after this failure (e.g. uploads are unavailable). */
  stopAfter?: (error: unknown) => boolean;
};

/** Uploads items one at a time. Resolves with the failure count; rejects with UploadCancelledError when cancelled. */
export async function uploadBatch<Item extends { id: string }, Asset>(items: readonly Item[], signal: AbortSignal, hooks: UploadBatchHooks<Item, Asset>): Promise<{ failures: number }> {
  let failures = 0;
  for (const item of items) {
    if (signal.aborted) throw new UploadCancelledError();
    if (hooks.isRemoved(item.id)) continue;
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal.addEventListener("abort", relay, { once: true });
    hooks.track?.(item.id, controller);
    let asset: Asset;
    try {
      hooks.onStart?.(item);
      asset = await hooks.upload(item, controller.signal);
    } catch (cause) {
      if (signal.aborted) { hooks.onCancelled?.(item); throw new UploadCancelledError(); }
      if (controller.signal.aborted || hooks.isRemoved(item.id)) continue; // Removed while uploading.
      failures += 1;
      hooks.onFailed(item, cause);
      if (hooks.stopAfter?.(cause)) break;
      continue;
    } finally {
      signal.removeEventListener("abort", relay);
      hooks.track?.(item.id, null);
    }
    if (hooks.isRemoved(item.id)) { await hooks.onRemovedAfterUpload(item, asset); continue; }
    hooks.onUploaded(item, asset);
  }
  if (signal.aborted) throw new UploadCancelledError();
  return { failures };
}
