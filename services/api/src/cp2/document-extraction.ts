import { createHash } from "node:crypto";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { DocumentImportSourceInput } from "@grogoni/business-core";
import { Cp2Error } from "./store.js";

const maxDocumentBytes = 10 * 1024 * 1024;
const maxExtractedCharacters = 250_000;

export interface DocumentUploadInput {
  fileName: string;
  contentType?: string | null;
  content?: string;
  contentBase64?: string;
  sourceType?: "upload" | "paste" | "database";
  sourceLocator?: string | null;
  originalStorageKey?: string | null;
}

export interface ExtractedDocument {
  text: string;
  format: "text" | "pdf" | "word" | "spreadsheet";
  warnings: string[];
}

export interface DocumentExtractionResult extends ExtractedDocument {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
}

export async function extractDocumentImportSource(
  input: DocumentUploadInput
): Promise<DocumentImportSourceInput> {
  const extracted = await extractUploadedDocument(input);

  return {
    fileName: extracted.fileName,
    contentType: input.contentType?.trim() || null,
    content: extracted.text,
    ...(input.sourceType === undefined ? {} : { sourceType: input.sourceType }),
    ...(input.sourceLocator === undefined ? {} : { sourceLocator: input.sourceLocator }),
    ...(input.originalStorageKey === undefined
      ? {}
      : { originalStorageKey: input.originalStorageKey }),
    ...(input.contentBase64 === undefined
      ? {}
      : {
          originalSizeBytes: extracted.sizeBytes,
          originalChecksum: extracted.checksum
        })
  };
}

export async function extractUploadedDocument(
  input: DocumentUploadInput
): Promise<DocumentExtractionResult> {
  const fileName = input.fileName.trim();
  const contentType = normalizeContentType(input.contentType);

  if (input.content !== undefined && input.content.trim().length > 0) {
    if (input.contentBase64 !== undefined) {
      throw new Cp2Error(
        400,
        "document_content_ambiguous",
        "Send either document text or base64 file content, not both."
      );
    }

    const buffer = Buffer.from(input.content, "utf8");
    return {
      fileName,
      contentType,
      text: validateExtractedText(input.content),
      format: "text",
      warnings: [],
      sizeBytes: buffer.byteLength,
      checksum: createHash("sha256").update(buffer).digest("hex")
    };
  }

  if (input.contentBase64 === undefined) {
    throw new Cp2Error(
      400,
      "document_content_required",
      "Document text or base64 file content is required."
    );
  }

  const buffer = decodeDocumentBase64(input.contentBase64);
  validateDocumentSignature(fileName, contentType, buffer);
  const extracted = await extractDocumentBuffer({
    fileName,
    contentType,
    buffer
  });

  return {
    fileName,
    contentType,
    text: validateExtractedText(extracted.text),
    format: extracted.format,
    warnings: extracted.warnings,
    sizeBytes: buffer.byteLength,
    checksum: createHash("sha256").update(buffer).digest("hex")
  };
}

export async function extractDocumentBuffer(input: {
  fileName: string;
  contentType?: string | null;
  buffer: Buffer;
}): Promise<ExtractedDocument> {
  const extension = fileExtension(input.fileName);
  const contentType = normalizeContentType(input.contentType);

  if (isPdf(extension, contentType)) {
    const { PDFParse } = await import("pdf-parse");
    const edgeWorkerUrl = (globalThis as typeof globalThis & { __edgePdfWorkerUrl?: string })
      .__edgePdfWorkerUrl;
    if (edgeWorkerUrl) PDFParse.setWorker(edgeWorkerUrl);
    const parser = new PDFParse({ data: new Uint8Array(input.buffer) });

    try {
      const result = await parser.getText();
      return {
        text: result.text,
        format: "pdf",
        warnings: []
      };
    } finally {
      await parser.destroy();
    }
  }

  if (isWord(extension, contentType)) {
    const result = await mammoth.extractRawText({ buffer: input.buffer });
    return {
      text: result.value,
      format: "word",
      warnings: result.messages.map((message) => message.message)
    };
  }

  if (isSpreadsheet(extension, contentType)) {
    const workbook = XLSX.read(input.buffer, {
      type: "buffer",
      cellDates: false,
      cellText: true
    });
    const sheets = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      return sheet === undefined ? "" : XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    }).filter((sheet) => sheet.trim().length > 0);

    return {
      text: sheets.join("\n"),
      format: "spreadsheet",
      warnings:
        sheets.length > 1
          ? ["Multiple sheets were combined in workbook order for the import preview."]
          : []
    };
  }

  if (isText(extension, contentType)) {
    return {
      text: input.buffer.toString("utf8"),
      format: "text",
      warnings: []
    };
  }

  throw new Cp2Error(
    415,
    "document_type_unsupported",
    "Upload PDF, DOCX, XLS, XLSX, ODS, CSV, TSV, JSON, SQL, or plain text."
  );
}

function decodeDocumentBase64(value: string): Buffer {
  const normalized = value.includes(",") ? (value.split(",", 2)[1] ?? "") : value;

  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[a-z0-9+/]*={0,2}$/iu.test(normalized)
  ) {
    throw new Cp2Error(400, "document_base64_invalid", "Document base64 content is invalid.");
  }

  const buffer = Buffer.from(normalized, "base64");

  if (buffer.byteLength === 0) {
    throw new Cp2Error(400, "document_content_required", "Uploaded document is empty.");
  }

  if (buffer.byteLength > maxDocumentBytes) {
    throw new Cp2Error(413, "document_too_large", "Uploaded document must be 10 MB or smaller.");
  }

  return buffer;
}

function validateDocumentSignature(fileName: string, contentType: string, buffer: Buffer): void {
  const extension = fileExtension(fileName);
  const prefix = buffer.subarray(0, 8).toString("hex").toLowerCase();
  const zipBased = ["docx", "xlsx", "ods"].includes(extension);
  const legacyOffice = extension === "xls";
  const pdf = isPdf(extension, contentType);

  if (pdf && !prefix.startsWith("25504446")) {
    throw signatureError();
  }

  if (zipBased && !prefix.startsWith("504b")) {
    throw signatureError();
  }

  if (legacyOffice && !prefix.startsWith("d0cf11e0a1b11ae1")) {
    throw signatureError();
  }
}

function signatureError(): Cp2Error {
  return new Cp2Error(
    400,
    "document_signature_mismatch",
    "Document contents do not match the file name or content type."
  );
}

function normalizeExtractedText(value: string): string {
  return value
    .split("\u0000")
    .join("")
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\S\n]+$/gmu, "")
    .trim();
}

function validateExtractedText(value: string): string {
  const text = normalizeExtractedText(value);

  if (text.length === 0) {
    throw new Cp2Error(
      422,
      "document_text_not_found",
      "The document did not contain readable text. Scanned PDFs require OCR before import."
    );
  }

  if (text.length > maxExtractedCharacters) {
    throw new Cp2Error(
      413,
      "document_text_too_large",
      "Extracted document text must be 250KB or smaller."
    );
  }

  return text;
}

function normalizeContentType(value: string | null | undefined): string {
  return value?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function fileExtension(fileName: string): string {
  return fileName.toLowerCase().split(".").pop() ?? "";
}

function isPdf(extension: string, contentType: string): boolean {
  return extension === "pdf" || contentType === "application/pdf";
}

function isWord(extension: string, contentType: string): boolean {
  return (
    extension === "docx" ||
    contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

function isSpreadsheet(extension: string, contentType: string): boolean {
  return (
    ["xls", "xlsx", "ods"].includes(extension) ||
    [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.oasis.opendocument.spreadsheet"
    ].includes(contentType)
  );
}

function isText(extension: string, contentType: string): boolean {
  return (
    ["csv", "tsv", "txt", "json", "sql"].includes(extension) ||
    contentType.startsWith("text/") ||
    ["application/csv", "application/json", "application/sql"].includes(contentType)
  );
}
