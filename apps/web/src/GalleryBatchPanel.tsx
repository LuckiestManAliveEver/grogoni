import { useEffect, useRef, useState } from "react";
import type { ProductCaptureJobSummary } from "@grogoni/shared-types";
import { getJson, postJson, patchJson } from "./api-helpers";
import { ensureOcrEngineCached, isOcrEngineCached, runLocalOcr } from "./offline-ocr";
import { getUserFacingErrorMessage } from "./user-facing-error";

/** Only explicitly selected files are read. One image is decoded/uploaded at a time. */
export default function GalleryBatchPanel({ businessId }: { businessId: string }) {
  const [jobs, setJobs] = useState<ProductCaptureJobSummary[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);
  const fingerprints = useRef(new Set<string>());
  useEffect(() => {
    let disposed = false;
    void getJson<ProductCaptureJobSummary[]>(`/businesses/${businessId}/commerce-sources/gallery`)
      .then((v) => {
        if (!disposed) setJobs(v);
      })
      .catch((e) => {
        if (!disposed) setMessage(getUserFacingErrorMessage(e));
      });
    return () => {
      disposed = true;
      cancelled.current = true;
    };
  }, [businessId]);
  async function index(files: File[]) {
    if (files.length > 100) {
      setMessage("Select up to 100 photos per batch. You can add more batches.");
      return;
    }
    cancelled.current = false;
    setBusy(true);
    try {
      for (const [i, file] of files.entries()) {
        if (cancelled.current) break;
        if (
          !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
          file.size > 10 * 1024 * 1024
        ) {
          setMessage(`Skipped ${file.name}: use JPEG, PNG or WebP up to 10 MB.`);
          continue;
        }
        const bytes = await file.arrayBuffer();
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (fingerprints.current.has(hash)) continue;
        const image = await createImageBitmap(file);
        let data: string;
        try {
          const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
          data = canvas.toDataURL("image/jpeg", 0.82).split(",")[1]!;
        } finally {
          image.close();
        }
        if (cancelled.current) break;
        const extractedText = (await isOcrEngineCached())
          ? (
              await runLocalOcr({
                fileName: file.name,
                contentType: "image/jpeg",
                contentBase64: data
              })
            ).fullText
          : "";
        const job = await postJson<ProductCaptureJobSummary>(
          `/businesses/${businessId}/product-captures`,
          { fileName: file.name, contentType: "image/jpeg", contentBase64: data, extractedText }
        );
        fingerprints.current.add(hash);
        setJobs((current) => (current.some((j) => j.id === job.id) ? current : [...current, job]));
        setMessage(
          `Indexed ${i + 1} of ${files.length}. Photos remain private until reviewed and published.`
        );
      }
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove(job: ProductCaptureJobSummary) {
    try {
      await postJson(`/businesses/${businessId}/product-captures/${job.id}/cancel`, {});
      setJobs((v) => v.filter((j) => j.id !== job.id));
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
    }
  }
  return (
    <details>
      <summary>Phone gallery</summary>
      <p>
        Select photos to upload private, reduced images. This browser can access only files you
        choose. Image detection may be unavailable; review names and prices in product capture
        before publication.
      </p>
      <button
        disabled={busy}
        onClick={() =>
          void ensureOcrEngineCached((done, total) =>
            setMessage(`Installing local text scanner: ${done}/${total}`)
          )
            .then(() =>
              setMessage("Local scanner ready. Selected photos can now be read on this device.")
            )
            .catch((error) => setMessage(getUserFacingErrorMessage(error)))
        }
      >
        Enable local photo text extraction
      </button>
      <input
        aria-label="Select product photos"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        disabled={busy}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void index(files);
        }}
      />
      {busy ? (
        <button
          onClick={() => {
            cancelled.current = true;
          }}
        >
          Stop after current photo
        </button>
      ) : null}
      <p role="status">{message}</p>
      {jobs.map((j) => (
        <GalleryReview
          key={j.id}
          job={j}
          businessId={businessId}
          onError={setMessage}
          onDiscard={() => void remove(j)}
          onUpdated={(next) => setJobs((v) => v.map((old) => (old.id === next.id ? next : old)))}
        />
      ))}
    </details>
  );
}

function GalleryReview({
  job,
  businessId,
  onError,
  onDiscard,
  onUpdated
}: {
  job: ProductCaptureJobSummary;
  businessId: string;
  onError: (value: string) => void;
  onDiscard: () => void;
  onUpdated: (job: ProductCaptureJobSummary) => void;
}) {
  const [title, setTitle] = useState(job.fields.title.value ?? "");
  const [price, setPrice] = useState(job.fields.visiblePrice.value?.toString() ?? "");
  const [unit, setUnit] = useState("");
  const [busy, setBusy] = useState(false);
  async function publish() {
    setBusy(true);
    try {
      await patchJson(`/businesses/${businessId}/product-captures/${job.id}/review`, {
        title,
        visiblePrice: price.trim() ? Number(price) : null,
        keepImageAsProductMedia: false
      });
      const result = await postJson<{ job: ProductCaptureJobSummary }>(
        `/businesses/${businessId}/product-captures/${job.id}/confirm`,
        { unit: unit.trim() || "unit", quantity: 0 }
      );
      onUpdated(result.job);
    } catch (error) {
      onError(getUserFacingErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <p>
        {job.sourceFileName} · {job.status}
      </p>
      {job.status !== "PUBLISHED" ? (
        <>
          <label>
            Confirmed product name
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Selling price, leave blank if unknown
            <input type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <label>
            Unit, leave blank for generic unit
            <input value={unit} onChange={(e) => setUnit(e.target.value)} />
          </label>
          <button disabled={busy || !title.trim()} onClick={() => void publish()}>
            Confirm and publish product without photo
          </button>
          <button disabled={busy} onClick={onDiscard}>
            Discard private photo
          </button>
        </>
      ) : (
        <p>Published to your catalogue.</p>
      )}
    </div>
  );
}
