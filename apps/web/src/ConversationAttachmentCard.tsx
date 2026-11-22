import { useEffect, useState } from "react";

import type { ChatAttachment } from "./app-shell";
import { formatAttachmentCategory, formatFileSize } from "./formatters";
import { dataUrlToBlob } from "./messaging/voice-note";

/**
 * A playable source for an audio attachment. The page plays media from https: and blob: only, so
 * a data URL (a received or just-recorded file) becomes a blob URL, released on unmount.
 */
function usePlayableAudio(attachment: ChatAttachment): string | undefined {
  const source = attachment.downloadUrl ?? attachment.dataUrl;
  const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined);
  const isData = source?.startsWith("data:") === true;
  useEffect(() => {
    if (attachment.category !== "audio" || !isData || source === undefined) return;
    const blob = dataUrlToBlob(source);
    if (blob === null || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setBlobUrl(undefined);
    };
  }, [attachment.category, isData, source]);
  if (attachment.category !== "audio" || source === undefined) return undefined;
  return isData ? blobUrl : source;
}

export function ConversationAttachmentCard({ attachment }: { attachment: ChatAttachment }) {
  const [imageFailed, setImageFailed] = useState(false);
  const previewUrl = attachment.previewUrl ?? attachment.dataUrl;
  const downloadUrl = attachment.downloadUrl ?? attachment.dataUrl;
  const inlineImage = attachment.category === "image" && previewUrl !== undefined && !imageFailed;
  const typeLabel = attachment.kind?.toUpperCase() ?? formatAttachmentCategory(attachment.category);
  const audioSource = usePlayableAudio(attachment);

  return (
    <article className="conversation-attachment-card" title={attachment.name}>
      {inlineImage ? (
        <img
          className="conversation-attachment-image"
          src={previewUrl}
          alt={attachment.caption?.trim() || attachment.name}
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="conversation-attachment-file-icon" aria-hidden="true">
          {attachment.kind === "pdf" ? "PDF" : attachment.category === "audio" ? "AUDIO" : "FILE"}
        </div>
      )}
      {audioSource !== undefined ? (
        <audio
          className="conversation-attachment-audio"
          controls
          preload="metadata"
          src={audioSource}
          aria-label={`Play ${attachment.name}`}
        />
      ) : null}
      <div className="conversation-attachment-details">
        <strong>{attachment.name}</strong>
        {attachment.caption ? <span>{attachment.caption}</span> : null}
        <small>
          {typeLabel} · {formatFileSize(attachment.size)}
        </small>
      </div>
      <div className="conversation-attachment-actions">
        {!inlineImage && attachment.previewable && previewUrl ? (
          <a
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Preview ${attachment.name}`}
          >
            Preview
          </a>
        ) : null}
        {downloadUrl ? (
          <a
            href={downloadUrl}
            {...(attachment.dataUrl ? { download: attachment.name } : {})}
            aria-label={`Download ${attachment.name}`}
          >
            Download
          </a>
        ) : null}
      </div>
      {attachment.category === "image" && imageFailed ? (
        <small role="status">Image preview unavailable. Download the original file instead.</small>
      ) : null}
    </article>
  );
}
