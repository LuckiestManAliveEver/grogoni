import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { ProductCaptureJobSummary } from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { apiFetch } from "./lib/api";
import { invalidateApiCacheForMutation } from "./api-request-cache";
import { getUserFacingErrorMessage } from "./user-facing-error";

interface ProductSummary {
  id: string;
  name: string;
}

interface ProductCaptureDraft {
  title: string;
  category: string;
  description: string;
  visiblePrice: string;
  keepImageAsProductMedia: boolean;
  existingProductId: string;
  unit: string;
  quantity: string;
  aliases: string;
  extractedText: string;
}

interface GalleryPhotoDraft {
  id: string;
  file: File;
  previewUrl: string;
  title: string;
  category: string;
  description: string;
  price: string;
  shareInCatalogue: boolean;
}

const emptyProductCaptureDraft: ProductCaptureDraft = {
  title: "",
  category: "",
  description: "",
  visiblePrice: "",
  keepImageAsProductMedia: true,
  existingProductId: "",
  unit: "item",
  quantity: "",
  aliases: "",
  extractedText: ""
};

export default function ProductCapturePanel(props: {
  businessId: string;
  products: ProductSummary[];
  onPublished: () => Promise<void>;
}) {
  const { isPending, runAction } = useAsyncActions();
  const [job, setJob] = useState<ProductCaptureJobSummary | null>(null);
  const [draft, setDraft] = useState<ProductCaptureDraft>(emptyProductCaptureDraft);
  const [galleryPhotos, setGalleryPhotos] = useState<GalleryPhotoDraft[]>([]);
  const galleryPhotosRef = useRef<GalleryPhotoDraft[]>([]);
  const [selectedGalleryPhotoId, setSelectedGalleryPhotoId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [message, setMessage] = useState("");
  const storageKey = `grogoni-product-capture:${props.businessId}`;

  useEffect(() => {
    const captureJobId = localStorage.getItem(storageKey);
    if (captureJobId === null) return;

    let cancelled = false;
    void getJson<ProductCaptureJobSummary>(
      `/businesses/${props.businessId}/product-captures/${encodeURIComponent(captureJobId)}`
    )
      .then((savedJob) => {
        if (cancelled) return;
        if (savedJob.status === "PUBLISHED" || savedJob.status === "CANCELLED") {
          localStorage.removeItem(storageKey);
          return;
        }
        setJob(savedJob);
        setDraft(productCaptureDraftFromJob(savedJob));
        setMessage("Your unfinished photo capture was restored.");
      })
      .catch(() => localStorage.removeItem(storageKey));

    return () => {
      cancelled = true;
    };
  }, [props.businessId]);

  useEffect(() => {
    galleryPhotosRef.current = galleryPhotos;
  }, [galleryPhotos]);

  useEffect(
    () => () => {
      galleryPhotosRef.current.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
    },
    []
  );

  function importGalleryPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const acceptedPhotos: GalleryPhotoDraft[] = [];
    const rejectedPhotos: string[] = [];

    files.forEach((file) => {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        rejectedPhotos.push(file.name);
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        rejectedPhotos.push(file.name);
        return;
      }
      acceptedPhotos.push({
        id:
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `gallery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: URL.createObjectURL(file),
        title: nameWithoutExtension(file.name),
        category: "",
        description: "",
        price: "",
        shareInCatalogue: true
      });
    });

    if (acceptedPhotos.length > 0) {
      setGalleryPhotos((current) => [...acceptedPhotos, ...current]);
      setSelectedGalleryPhotoId(acceptedPhotos[0]?.id ?? null);
    }
    setMessage(
      rejectedPhotos.length > 0
        ? `Imported ${acceptedPhotos.length} photo${acceptedPhotos.length === 1 ? "" : "s"}. Skipped ${rejectedPhotos.length} unsupported or oversized file${rejectedPhotos.length === 1 ? "" : "s"}.`
        : `Imported ${acceptedPhotos.length} gallery photo${acceptedPhotos.length === 1 ? "" : "s"}.`
    );
    event.target.value = "";
  }

  function updateGalleryPhoto(photoId: string, updates: Partial<GalleryPhotoDraft>) {
    setGalleryPhotos((current) =>
      current.map((photo) => (photo.id === photoId ? { ...photo, ...updates } : photo))
    );
  }

  function removeGalleryPhoto(photoId: string) {
    setGalleryPhotos((current) => {
      const removed = current.find((photo) => photo.id === photoId);
      if (removed !== undefined) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((photo) => photo.id !== photoId);
    });
    setSelectedGalleryPhotoId((current) => (current === photoId ? null : current));
  }

  async function useGalleryPhotoForCapture(photo: GalleryPhotoDraft) {
    await startCapture(photo.file);
    setDraft((current) => ({
      ...current,
      title: photo.title.trim() || current.title,
      category: photo.category.trim() || current.category,
      description: photo.description.trim() || current.description,
      visiblePrice: photo.price.trim() || current.visiblePrice,
      keepImageAsProductMedia: photo.shareInCatalogue
    }));
  }

  async function shareGalleryPhotos() {
    const photosToShare = galleryPhotos.filter((photo) => photo.shareInCatalogue);
    if (photosToShare.length === 0) {
      setMessage("Choose at least one photo to share.");
      return;
    }

    const sharePayload = {
      title: `${props.businessId} gallery photos`,
      text: photosToShare
        .map((photo) => {
          const price = photo.price.trim().length > 0 ? ` - ${photo.price.trim()}` : "";
          return `${photo.title.trim() || photo.file.name}${price}`;
        })
        .join("\n"),
      files: photosToShare.map((photo) => photo.file)
    };

    if (navigator.canShare?.({ files: sharePayload.files }) === true) {
      await navigator.share(sharePayload);
      setMessage(
        `Shared ${photosToShare.length} gallery photo${photosToShare.length === 1 ? "" : "s"}.`
      );
      return;
    }

    if (navigator.share !== undefined) {
      await navigator.share({ title: sharePayload.title, text: sharePayload.text });
      setMessage("Shared the bound photo details. This browser does not share local files.");
      return;
    }

    await navigator.clipboard?.writeText(sharePayload.text);
    setMessage("Copied the bound photo details. This browser does not support native sharing.");
  }

  async function startCapture(file: File) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setMessage("Choose a JPEG, PNG, or WebP product photo.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setMessage("Product photos must be 10 MB or smaller.");
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    setPreviewUrl(dataUrl);
    const created = await postJson<ProductCaptureJobSummary>(
      `/businesses/${props.businessId}/product-captures`,
      {
        fileName: file.name,
        contentType: file.type,
        contentBase64: dataUrlPayload(dataUrl)
      }
    );
    localStorage.setItem(storageKey, created.id);
    setJob(created);
    setDraft(productCaptureDraftFromJob(created));
    setMessage(
      created.status === "EXTRACTION_FAILED"
        ? (created.failureMessage ?? "No product details were found. Add the visible text below.")
        : "Product details extracted. Review them before publishing."
    );
  }

  async function retryCapture() {
    if (job === null) return;
    const updated = await postJson<ProductCaptureJobSummary>(
      `/businesses/${props.businessId}/product-captures/${encodeURIComponent(job.id)}/retry`,
      { extractedText: draft.extractedText }
    );
    setJob(updated);
    setDraft((current) => ({
      ...productCaptureDraftFromJob(updated),
      extractedText: current.extractedText
    }));
    setMessage(
      updated.status === "EXTRACTION_FAILED"
        ? (updated.failureMessage ??
            "No details were found. Enter a product name and price manually.")
        : "Details extracted. Check every field before publishing."
    );
  }

  async function publishCapture() {
    if (job === null || draft.title.trim().length === 0) {
      setMessage("Enter a product name before publishing.");
      return;
    }
    const visiblePrice = optionalNumber(draft.visiblePrice, "Visible price");
    const quantity = optionalNumber(draft.quantity, "Quantity");
    const reviewed = await patchJson<ProductCaptureJobSummary>(
      `/businesses/${props.businessId}/product-captures/${encodeURIComponent(job.id)}/review`,
      {
        title: draft.title,
        category: draft.category.trim() || null,
        description: draft.description.trim() || null,
        visiblePrice,
        keepImageAsProductMedia: draft.keepImageAsProductMedia
      }
    );
    setJob(reviewed);
    const published = await postJson<{
      job: ProductCaptureJobSummary;
      product: ProductSummary;
    }>(`/businesses/${props.businessId}/product-captures/${encodeURIComponent(job.id)}/confirm`, {
      existingProductId: draft.existingProductId || null,
      unit: draft.unit.trim() || null,
      ...(quantity === null ? {} : { quantity }),
      aliases: draft.aliases
        .split(",")
        .map((alias) => alias.trim())
        .filter((alias) => alias.length > 0)
    });
    setJob(published.job);
    localStorage.removeItem(storageKey);
    await props.onPublished();
    setMessage(`${published.product.name} is now in the catalogue.`);
  }

  async function cancelCapture() {
    if (job !== null) {
      await postJson<ProductCaptureJobSummary>(
        `/businesses/${props.businessId}/product-captures/${encodeURIComponent(job.id)}/cancel`,
        {}
      );
    }
    localStorage.removeItem(storageKey);
    setJob(null);
    setDraft(emptyProductCaptureDraft);
    setPreviewUrl("");
    setMessage("Photo capture cancelled.");
  }

  const canReview = job !== null && ["REVIEW_REQUIRED", "EXTRACTION_FAILED"].includes(job.status);
  const possibleDuplicates = props.products.filter((product) =>
    job?.possibleDuplicateProductIds.includes(product.id)
  );
  const selectedGalleryPhoto =
    galleryPhotos.find((photo) => photo.id === selectedGalleryPhotoId) ?? galleryPhotos[0] ?? null;

  return (
    <section className="record-form product-capture-card" aria-label="Add product from photo">
      <div className="section-heading">
        <p className="eyebrow">Camera catalogue</p>
        <h3>Add a product from a photo</h3>
        <p>Connect your local gallery, bind product details, then publish or share the photos.</p>
      </div>
      <div className="local-gallery-panel" aria-label="Local gallery import">
        <div className="surface-header-row">
          <div>
            <p className="eyebrow">Local gallery</p>
            <strong>{galleryPhotos.length} imported</strong>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={galleryPhotos.length === 0 || isPending("product-gallery-share")}
            onClick={() =>
              void runAction("product-gallery-share", async () => {
                try {
                  await shareGalleryPhotos();
                } catch (error) {
                  setMessage(getUserFacingErrorMessage(error));
                }
              })
            }
          >
            Share selected
          </button>
        </div>
        <label>
          Connect gallery
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={importGalleryPhotos}
          />
        </label>
        {galleryPhotos.length > 0 ? (
          <div className="local-gallery-grid" aria-label="Imported gallery photos">
            {galleryPhotos.map((photo) => (
              <button
                key={photo.id}
                type="button"
                className={photo.id === selectedGalleryPhoto?.id ? "active" : ""}
                onClick={() => setSelectedGalleryPhotoId(photo.id)}
              >
                <img src={photo.previewUrl} alt={photo.title || photo.file.name} />
                <span>{photo.title || photo.file.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        {selectedGalleryPhoto === null ? null : (
          <div className="gallery-binding-editor" aria-label="Bind photo details">
            <img
              className="product-capture-preview"
              src={selectedGalleryPhoto.previewUrl}
              alt={selectedGalleryPhoto.title || selectedGalleryPhoto.file.name}
            />
            <div className="gallery-binding-fields">
              <label>
                Photo title
                <input
                  value={selectedGalleryPhoto.title}
                  onChange={(event) =>
                    updateGalleryPhoto(selectedGalleryPhoto.id, { title: event.target.value })
                  }
                />
              </label>
              <div className="form-row">
                <label>
                  Category
                  <input
                    value={selectedGalleryPhoto.category}
                    onChange={(event) =>
                      updateGalleryPhoto(selectedGalleryPhoto.id, {
                        category: event.target.value
                      })
                    }
                  />
                </label>
                <label>
                  Price
                  <input
                    inputMode="decimal"
                    value={selectedGalleryPhoto.price}
                    onChange={(event) =>
                      updateGalleryPhoto(selectedGalleryPhoto.id, { price: event.target.value })
                    }
                  />
                </label>
              </div>
              <label>
                Details
                <textarea
                  rows={2}
                  value={selectedGalleryPhoto.description}
                  onChange={(event) =>
                    updateGalleryPhoto(selectedGalleryPhoto.id, {
                      description: event.target.value
                    })
                  }
                />
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selectedGalleryPhoto.shareInCatalogue}
                  onChange={(event) =>
                    updateGalleryPhoto(selectedGalleryPhoto.id, {
                      shareInCatalogue: event.target.checked
                    })
                  }
                />
                Include when sharing and publishing
              </label>
              <div className="row-actions">
                <button
                  type="button"
                  disabled={isPending("product-gallery-capture")}
                  onClick={() =>
                    void runAction("product-gallery-capture", async () => {
                      try {
                        await useGalleryPhotoForCapture(selectedGalleryPhoto);
                      } catch (error) {
                        setMessage(getUserFacingErrorMessage(error));
                      }
                    })
                  }
                >
                  Import into product review
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => removeGalleryPhoto(selectedGalleryPhoto.id)}
                >
                  Remove photo
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <label>
        Product photo
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          disabled={isPending("product-capture-upload")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) {
              void runAction("product-capture-upload", async () => {
                try {
                  await startCapture(file);
                } catch (error) {
                  setMessage(getUserFacingErrorMessage(error));
                }
              });
            }
            event.target.value = "";
          }}
        />
      </label>
      {previewUrl.length > 0 ? (
        <img className="product-capture-preview" src={previewUrl} alt="Selected product" />
      ) : null}
      {message.length > 0 ? (
        <p className="shell-note" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
      {job === null ? null : (
        <>
          <div className="surface-header-row">
            <span className="model-badge">{job.status.replaceAll("_", " ")}</span>
            <small>Attempt {job.retryCount + 1}</small>
          </div>
          {job.status === "EXTRACTION_FAILED" ? (
            <div className="record-form">
              <label>
                Text visible in the photo
                <textarea
                  rows={3}
                  value={draft.extractedText}
                  placeholder="Example: Tomatoes KSh 150"
                  onChange={(event) => setDraft({ ...draft, extractedText: event.target.value })}
                />
              </label>
              <button
                type="button"
                className="secondary"
                disabled={isPending("product-capture-retry")}
                onClick={() =>
                  void runAction("product-capture-retry", async () => {
                    try {
                      await retryCapture();
                    } catch (error) {
                      setMessage(getUserFacingErrorMessage(error));
                    }
                  })
                }
              >
                Retry extraction
              </button>
            </div>
          ) : null}
          {canReview ? (
            <>
              <label>
                Product name
                <input
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </label>
              <div className="form-row">
                <label>
                  Category
                  <input
                    value={draft.category}
                    onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                  />
                </label>
                <label>
                  Selling price
                  <input
                    inputMode="decimal"
                    value={draft.visiblePrice}
                    onChange={(event) => setDraft({ ...draft, visiblePrice: event.target.value })}
                  />
                </label>
              </div>
              <label>
                Description
                <textarea
                  rows={2}
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              <div className="form-row">
                <label>
                  Unit
                  <input
                    value={draft.unit}
                    onChange={(event) => setDraft({ ...draft, unit: event.target.value })}
                  />
                </label>
                <label>
                  Starting quantity
                  <input
                    inputMode="decimal"
                    value={draft.quantity}
                    onChange={(event) => setDraft({ ...draft, quantity: event.target.value })}
                  />
                </label>
              </div>
              <label>
                Search aliases
                <input
                  value={draft.aliases}
                  placeholder="tomato, nyanya"
                  onChange={(event) => setDraft({ ...draft, aliases: event.target.value })}
                />
              </label>
              {possibleDuplicates.length > 0 ? (
                <label>
                  Possible duplicate
                  <select
                    value={draft.existingProductId}
                    onChange={(event) =>
                      setDraft({ ...draft, existingProductId: event.target.value })
                    }
                  >
                    <option value="">Create a new product</option>
                    {possibleDuplicates.map((product) => (
                      <option key={product.id} value={product.id}>
                        Update {product.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={draft.keepImageAsProductMedia}
                  onChange={(event) =>
                    setDraft({ ...draft, keepImageAsProductMedia: event.target.checked })
                  }
                />
                Show this photo in the public catalogue
              </label>
            </>
          ) : null}
          <div className="row-actions">
            {canReview ? (
              <button
                type="button"
                disabled={isPending("product-capture-publish") || draft.title.trim().length === 0}
                onClick={() =>
                  void runAction("product-capture-publish", async () => {
                    try {
                      await publishCapture();
                    } catch (error) {
                      setMessage(getUserFacingErrorMessage(error));
                    }
                  })
                }
              >
                {isPending("product-capture-publish") ? "Publishing…" : "Review and publish"}
              </button>
            ) : null}
            {job.status !== "PUBLISHED" && job.status !== "CANCELLED" ? (
              <button
                type="button"
                className="secondary"
                disabled={isPending("product-capture-cancel")}
                onClick={() =>
                  void runAction("product-capture-cancel", async () => {
                    try {
                      await cancelCapture();
                    } catch (error) {
                      setMessage(getUserFacingErrorMessage(error));
                    }
                  })
                }
              >
                Cancel capture
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function productCaptureDraftFromJob(job: ProductCaptureJobSummary): ProductCaptureDraft {
  return {
    ...emptyProductCaptureDraft,
    title: job.fields.title.value ?? "",
    category: job.fields.category.value ?? "",
    description: job.fields.description.value ?? "",
    visiblePrice:
      job.fields.visiblePrice.value === null ? "" : String(job.fields.visiblePrice.value)
  };
}

function optionalNumber(value: string, label: string): number | null {
  if (value.trim().length === 0) return null;
  return requiredNumber(value, label);
}

function requiredNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a number of zero or more.`);
  }
  return parsed;
}

async function postJson<TResponse>(
  path: string,
  body: Record<string, unknown>
): Promise<TResponse> {
  const response = await apiFetch<TResponse>(path, { method: "POST", body });
  invalidateApiCacheForMutation(path);
  return response;
}

async function patchJson<TResponse>(
  path: string,
  body: Record<string, unknown>
): Promise<TResponse> {
  const response = await apiFetch<TResponse>(path, { method: "PATCH", body });
  invalidateApiCacheForMutation(path);
  return response;
}

async function getJson<TResponse>(path: string): Promise<TResponse> {
  return apiFetch<TResponse>(path);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")), { once: true });
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("File could not be read")),
      { once: true }
    );
    reader.readAsDataURL(file);
  });
}

function dataUrlPayload(dataUrl: string): string {
  const separatorIndex = dataUrl.indexOf(",");
  return separatorIndex === -1 ? dataUrl : dataUrl.slice(separatorIndex + 1);
}

function nameWithoutExtension(fileName: string): string {
  const trimmed = fileName.trim();
  const extensionIndex = trimmed.lastIndexOf(".");
  return extensionIndex > 0 ? trimmed.slice(0, extensionIndex) : trimmed;
}
