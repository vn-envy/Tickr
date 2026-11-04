"use client";

import { useId, useRef, useState, type DragEvent, type RefObject } from "react";
import Image from "next/image";
import { CircleAlert, CircleCheck, ImagePlus, Film, LoaderCircle, Upload, X } from "lucide-react";
import { formatBytes, MAX_UPLOADS, UPLOAD_ACCEPT, type PeopleVisible } from "./model";
import type { MediaAsset } from "./api";

export type QueuedFile = {
  id: string; file: File; kind: "image" | "video"; mimeType: string; previewUrl: string;
  status: "queued" | "uploading" | "error"; progress: number; error: string | null;
};

type Props = {
  queue: QueuedFile[]; uploaded: MediaAsset[]; rejected: string[]; disabled: boolean;
  rights: boolean; people: PeopleVisible | null; consentError: boolean;
  onAdd: (files: File[]) => void; onRemoveQueued: (id: string) => void; onRemoveUploaded: (assetId: string) => void;
  onRights: (value: boolean) => void; onPeople: (value: PeopleVisible) => void;
  consentRef: RefObject<HTMLFieldSetElement | null>;
  /** The "Choose files" button, so the intake can focus it when the owner comes back to add photos. */
  pickRef?: RefObject<HTMLButtonElement | null>;
};

/** Optional owner photos & videos: drop or pick, preview, remove; consent is required before anything uploads. */
export function MediaDropzone({ queue, uploaded, rejected, disabled, rights, people, consentError, onAdd, onRemoveQueued, onRemoveUploaded, onRights, onPeople, consentRef, pickRef }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const helpId = useId();
  const total = queue.length + uploaded.length;
  const full = total >= MAX_UPLOADS;
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragging(false);
    if (disabled || full) return;
    onAdd(Array.from(event.dataTransfer.files));
  }
  return <section className="ap-media" aria-labelledby={`${helpId}-title`}>
    <div className="ap-card-heading"><span className="ap-card-icon" aria-hidden="true"><ImagePlus size={18} strokeWidth={1.7} /></span><div><h2 id={`${helpId}-title`}>Add your photos &amp; videos <span className="ap-optional">Optional</span></h2><p>Phone shots of your best products work beautifully. Autopilot studies every one.</p></div></div>
    <div className={`ap-dropzone ${dragging ? "is-dragging" : ""} ${disabled || full ? "is-disabled" : ""}`} onDragEnter={(event) => { event.preventDefault(); if (!disabled && !full) setDragging(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = disabled || full ? "none" : "copy"; }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={drop}>
      <Upload size={20} strokeWidth={1.6} aria-hidden="true" />
      <p><strong>Drop files here</strong> or</p>
      <button ref={pickRef} type="button" className="button button-secondary ap-pick" disabled={disabled || full} onClick={() => inputRef.current?.click()} aria-describedby={helpId}>Choose files</button>
      <input ref={inputRef} className="ap-visually-hidden" type="file" multiple accept={UPLOAD_ACCEPT} tabIndex={-1} aria-hidden="true" onChange={(event) => { onAdd(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      <p className="ap-drop-help" id={helpId}>{full ? `You’ve added the maximum of ${MAX_UPLOADS} files.` : "JPEG, PNG, WebP up to 20 MB · MP4, MOV, WebM up to 300 MB"}</p>
    </div>
    <p className="ap-help">Tip: you can download photos from your own Google Business Profile and add them here.</p>
    {rejected.length > 0 && <ul className="ap-rejected" role="alert">{rejected.map((message, index) => <li key={index}><CircleAlert size={14} />{message}</li>)}</ul>}
    {total > 0 && <ul className="ap-thumbs" aria-label="Your files">
      {uploaded.map((asset) => <li key={asset.id} className="ap-thumb is-uploaded">
        <div className="ap-thumb-media"><Image unoptimized src={asset.thumbUrl} alt="" fill sizes="120px" />{asset.kind === "video" && <span className="ap-thumb-kind"><Film size={11} />Video</span>}</div>
        <div className="ap-thumb-meta"><span className="ap-thumb-state is-done"><CircleCheck size={12} />Uploaded</span><span>{formatBytes(asset.bytes)}</span></div>
        <button type="button" className="ap-thumb-remove" disabled={disabled} onClick={() => onRemoveUploaded(asset.id)} aria-label={`Remove uploaded ${asset.kind}`}><X size={14} /></button>
      </li>)}
      {queue.map((item) => <li key={item.id} className={`ap-thumb is-${item.status}`}>
        <div className="ap-thumb-media">{item.kind === "image" ? <Image unoptimized src={item.previewUrl} alt="" fill sizes="120px" /> : <video src={`${item.previewUrl}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" />}{item.kind === "video" && <span className="ap-thumb-kind"><Film size={11} />Video</span>}</div>
        <div className="ap-thumb-meta"><span className="ap-thumb-name" title={item.file.name}>{item.file.name}</span>
          {item.status === "uploading" ? <span className="ap-thumb-state"><LoaderCircle size={12} className="spin" />{Math.round(item.progress * 100)}%</span> : item.status === "error" ? <span className="ap-thumb-state is-error" title={item.error ?? undefined}><CircleAlert size={12} />Failed</span> : <span>{formatBytes(item.file.size)}</span>}
        </div>
        <div className="ap-progress" role="progressbar" aria-label={`Upload progress for ${item.file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}><span style={{ transform: `scaleX(${item.progress})` }} /></div>
        {item.status === "error" && item.error && <p className="ap-thumb-error">{item.error}</p>}
        {/* Always available: removing a file skips it in a running batch, or cancels its upload in flight. */}
        <button type="button" className="ap-thumb-remove" onClick={() => onRemoveQueued(item.id)} aria-label={item.status === "uploading" ? `Cancel the upload and remove ${item.file.name}` : `Remove ${item.file.name}`}><X size={14} /></button>
      </li>)}
    </ul>}
    {queue.length > 0 && <fieldset ref={consentRef} tabIndex={-1} className={`ap-consent ${consentError ? "has-error" : ""}`} disabled={disabled} aria-describedby={consentError ? `${helpId}-consent-error` : undefined}>
      <legend>Before anything uploads</legend>
      <label className="ap-check"><input type="checkbox" checked={rights} onChange={(event) => onRights(event.target.checked)} required /><span>I own these files or have the rights to use them for my business’s marketing.</span></label>
      <div className="ap-people" role="radiogroup" aria-label="People in these files" aria-required="true">
        <label className="ap-check"><input type="radio" name={`${helpId}-people`} checked={people === "consented"} onChange={() => onPeople("consented")} /><span>People shown have agreed to appear.</span></label>
        <label className="ap-check"><input type="radio" name={`${helpId}-people`} checked={people === "no_people"} onChange={() => onPeople("no_people")} /><span>No people are shown.</span></label>
      </div>
      {consentError && <p className="ap-field-error" id={`${helpId}-consent-error`}>Confirm the rights and choose one people option to upload these files — or remove them.</p>}
    </fieldset>}
  </section>;
}
