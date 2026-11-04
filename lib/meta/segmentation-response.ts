import { createPaidResponseStore, type StoredPaidResponse } from "./paid-response-store";

/**
 * SAM image-segmentation response store. File names, size limit and error codes are
 * unchanged from the original adapter so existing private checkpoints keep recovering.
 */
const samImageStore = createPaidResponseStore({ prefix: "sam", maxRecordBytes: 9 * 1024 * 1024, errorFamily: "SEGMENTATION", label: "SAM" });
export type StoredSegmentationResponse = StoredPaidResponse;

/** Null means no prior attempt. A pending/corrupt attempt never permits another paid call. */
export const readStoredSegmentationResponse = (directory: string, inputHash: string) => samImageStore.read(directory, inputHash);
/** Exclusive creation is the concurrency guard, before sending any request. */
export const markSegmentationRequested = (directory: string, inputHash: string) => samImageStore.mark(directory, inputHash);
/** Raw provider JSON and metering only: no request image, headers or credentials. */
export const storeSegmentationResponse = (directory: string, payload: StoredSegmentationResponse) => samImageStore.store(directory, payload);
