import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Cp2Error } from "../services/api/src/cp2/cp2-error";
import {
  contentDispositionHeader,
  resolveTransferredWorkspaceFile,
  resolveWorkspaceFile
} from "../services/api/src/cp2/workspace-file-delivery";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("workspace file resolution", () => {
  it("resolves nested, spaced, Unicode, and workspace-prefixed paths", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "reports"));
    await writeFile(join(root, "reports", "August café.md"), "# August\nRevenue grew.");

    for (const requestedPath of [
      "reports/August café.md",
      "./reports/August café.md",
      "workspace/reports/August café.md"
    ]) {
      const file = await resolveWorkspaceFile({
        workspaceRoot: root,
        requestedPath,
        maxFileBytes: 1_000_000
      });
      expect(file).toMatchObject({
        filename: "August café.md",
        mimeType: "text/markdown",
        kind: "text",
        previewable: true
      });
      expect(file.bytes.toString("utf8")).toContain("Revenue grew");
    }
  });

  it.each([
    "../secret.txt",
    "../../secret.txt",
    "foo/../../../secret.txt",
    "%2e%2e/secret.txt",
    "%252e%252e/secret.txt",
    "/etc/passwd",
    "C:\\Windows\\system.ini",
    "\\\\server\\share\\secret.txt"
  ])("rejects paths outside the workspace: %s", async (requestedPath) => {
    const root = await temporaryRoot();
    await expect(
      resolveWorkspaceFile({ workspaceRoot: root, requestedPath, maxFileBytes: 1_000_000 })
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("rejects an escaping symlink and permits a symlink whose real target remains inside", async () => {
    const container = await temporaryRoot();
    const root = join(container, "workspace");
    await mkdir(root);
    await writeFile(join(root, "inside.txt"), "inside");
    await writeFile(join(container, "outside.txt"), "outside");
    await symlink(join(container, "outside.txt"), join(root, "outside-link"));
    await symlink(join(root, "inside.txt"), join(root, "inside-link"));

    await expect(
      resolveWorkspaceFile({
        workspaceRoot: root,
        requestedPath: "outside-link",
        maxFileBytes: 100
      })
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    await expect(
      resolveWorkspaceFile({ workspaceRoot: root, requestedPath: "inside-link", maxFileBytes: 100 })
    ).resolves.toMatchObject({ filename: "inside.txt", mimeType: "text/plain" });
  });

  it("returns typed errors for missing paths, directories, and oversized files", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "large.bin"), Buffer.alloc(11));

    await expectWorkspaceError(root, "missing.txt", "FILE_NOT_FOUND");
    await expectWorkspaceError(root, "folder", "PATH_NOT_FILE");
    await expectWorkspaceError(root, "large.bin", "FILE_TOO_LARGE", 10);
  });

  it.each([
    ["image.png", Buffer.from("89504e470d0a1a0a00000000", "hex"), "image/png", "image", true],
    ["photo.jpg", Buffer.from("ffd8ffe00000", "hex"), "image/jpeg", "image", true],
    ["animation.gif", Buffer.from("GIF89a"), "image/gif", "image", true],
    ["graphic.webp", Buffer.from("RIFF0000WEBP"), "image/webp", "image", true],
    ["report.pdf", Buffer.from("%PDF-1.7\n"), "application/pdf", "pdf", true],
    [
      "data.xlsx",
      Buffer.from("504b03040000", "hex"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "document",
      false
    ],
    ["archive.zip", Buffer.from("504b03040000", "hex"), "application/zip", "archive", false],
    ["unknown.bin", Buffer.from([0, 1, 2, 3]), "application/octet-stream", "file", false]
  ] as const)(
    "detects trusted presentation metadata for %s",
    async (name, bytes, mimeType, kind, previewable) => {
      const root = await temporaryRoot();
      await writeFile(join(root, name), bytes);
      await expect(
        resolveWorkspaceFile({ workspaceRoot: root, requestedPath: name, maxFileBytes: 1_000_000 })
      ).resolves.toMatchObject({ mimeType, kind, previewable });
    }
  );

  it("builds an RFC-compatible disposition without header-injection characters", () => {
    const header = contentDispositionHeader("attachment", 'café\r\nX-Evil: yes "report".pdf');
    expect(header).toContain('attachment; filename="caf_--X-Evil: yes -report-.pdf"');
    expect(header).toContain("filename*=UTF-8''caf%C3%A9--X-Evil%3A%20yes%20-report-.pdf");
    expect(header).not.toMatch(/[\r\n]/u);
  });

  it("accepts an integrity-checked local transfer and still determines MIME server-side", () => {
    const bytes = Buffer.from("89504e470d0a1a0a00000000", "hex");
    const file = resolveTransferredWorkspaceFile({
      requestedPath: "generated/catalogue.png",
      transfer: {
        path: "generated/catalogue.png",
        contentBase64: bytes.toString("base64"),
        checksum: createHash("sha256").update(bytes).digest("hex")
      },
      maxFileBytes: 1_000_000
    });
    expect(file).toMatchObject({ filename: "catalogue.png", mimeType: "image/png", kind: "image" });
    expect(file.bytes).toEqual(bytes);
  });

  it("rejects mismatched, escaping, corrupted, and oversized local transfers", () => {
    const bytes = Buffer.from("local file");
    const transfer = {
      path: "reports/report.txt",
      contentBase64: bytes.toString("base64"),
      checksum: createHash("sha256").update(bytes).digest("hex")
    };
    expect(() =>
      resolveTransferredWorkspaceFile({
        requestedPath: "reports/other.txt",
        transfer,
        maxFileBytes: 100
      })
    ).toThrowError(expect.objectContaining({ code: "LOCAL_FILE_TRANSFER_MISMATCH" }));
    expect(() =>
      resolveTransferredWorkspaceFile({
        requestedPath: "../report.txt",
        transfer: { ...transfer, path: "../report.txt" },
        maxFileBytes: 100
      })
    ).toThrowError(expect.objectContaining({ code: "PATH_OUTSIDE_WORKSPACE" }));
    expect(() =>
      resolveTransferredWorkspaceFile({
        requestedPath: transfer.path,
        transfer: { ...transfer, checksum: "0".repeat(64) },
        maxFileBytes: 100
      })
    ).toThrowError(expect.objectContaining({ code: "LOCAL_FILE_TRANSFER_CHECKSUM_MISMATCH" }));
    expect(() =>
      resolveTransferredWorkspaceFile({
        requestedPath: transfer.path,
        transfer,
        maxFileBytes: 2
      })
    ).toThrowError(expect.objectContaining({ code: "FILE_TOO_LARGE" }));
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "grogoni-workspace-delivery-"));
  temporaryRoots.push(root);
  return root;
}

async function expectWorkspaceError(
  root: string,
  requestedPath: string,
  code: string,
  maxFileBytes = 1_000_000
): Promise<void> {
  try {
    await resolveWorkspaceFile({ workspaceRoot: root, requestedPath, maxFileBytes });
    throw new Error("Expected workspace delivery to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(Cp2Error);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain(root);
  }
}
