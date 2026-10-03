# Workspace file delivery

Grogoni agents deliver generated or located workspace files with the canonical runtime capability:

```text
#workspace.deliver {"path":"exports/orders.csv"}
```

Model-generated tool calls use the same `workspace.deliver` name. The model supplies only a path
and optional caption. Account, user, business, runtime, and conversation identity come from the
authenticated agent turn.

Up to ten ordered files can be delivered in one assistant message by supplying the first `path`
and an `additionalPaths` array. Every file is validated before any record is stored, so a failed
batch does not produce partial cards.

## Architecture

```text
workspace.deliver
  -> business workspace resolver
  -> private attachment blob + managed conversation attachment record
  -> existing ConversationMessageContent attachment
  -> existing conversation persistence and sync journal
  -> conversation attachment Business Card
```

This extends the existing text-message attachment array. It does not introduce another message
protocol. Historical data-URL and HTTPS attachments remain readable; new workspace deliveries
store only managed attachment IDs and safe metadata in message content.

## Workspace ownership and security

Set `GROGONI_WORKSPACE_ROOT` to the server runtime's workspace base. The active workspace is always:

```text
<GROGONI_WORKSPACE_ROOT>/<trusted-business-id>
```

The model cannot select either value. The resolver canonicalizes both the root and requested file,
checks path-component boundaries, resolves symlinks, rejects traversal/encoded traversal, Windows
drive and UNC paths, null bytes, missing files, directories, special files, unreadable files, and
files larger than `WORKSPACE_DELIVERY_MAX_FILE_BYTES` (10 MB by default). Absolute paths are
accepted only when their canonical target remains inside the active business workspace.

The source file is copied into private conversation blob storage and is not removed. Source paths
are neither stored in the managed attachment nor returned to the frontend. A missing configured
workspace returns `WORKSPACE_UNAVAILABLE`; browser/client runtimes never try to fetch `file://`
paths.

## Persistence and authorization

`cp2_conversation_attachments` owns durable metadata, while
`cp2_conversation_attachment_blobs` stores private bytes in a `bytea` object record. Bytes are not
embedded in JSONB or message content. The explicit in-memory store uses the same blob-store
contract with a process-local implementation. The assistant message owns the user-visible
reference. Creation is idempotent for the runtime action, and the attachment is associated with
the persisted assistant message before it becomes downloadable.

Preview and download endpoints are scoped by conversation and attachment ID. Both require an
authenticated account participant in that conversation and verify attachment ownership again.
Objects are never public, and responses use private, no-store caching.
Business/account deletion uses the existing snapshot cleanup lifecycle to remove the managed
records and bytes. Structured audit events cover requested, validated, stored, associated,
deduplicated, and failed delivery phases without recording source paths.

## Presentation

- PNG, JPEG, WebP, and GIF render inline with a download action.
- PDF and safe text/code files provide Preview and Download actions.
- DOCX, XLSX, PPTX, archives, and unknown binaries render as download-only cards.
- HTML, SVG, and unknown active/binary content are never injected into the Grogoni page.

Filename metadata is normalized and stripped of path separators and control characters before it
is persisted or used in `Content-Disposition`.

## Runtime behavior

When a file should be given to the user, agents call `workspace.deliver` and then refer naturally
to the delivered attachment. They must not expose the local path. Server and client-first model
inference share the same tool proposal and backend execution contract.

Backend runtimes resolve the file under `<GROGONI_WORKSPACE_ROOT>/<businessId>`. Browser-local
runtimes resolve app-owned files under OPFS `grogoni-workspaces/<businessId>/`. Application services
can write that workspace with `writeBrowserWorkspaceFile`. The installed-app bridge can implement
`GrogoniAgentModelRuntime.readWorkspaceFile({ businessId, path })` to supply its workspace bytes.

Local bytes travel only with the authenticated client inference completion. The API independently
parses the model output, requires an exact path match, checks SHA-256 and size, determines MIME
server-side, and injects the current account/business/conversation context. A client cannot choose
another conversation or turn an unrelated upload into an attachment. Missing local files may
still resolve from the server workspace, allowing mixed execution without a second tool protocol.
The API request-body allowance scales with `WORKSPACE_DELIVERY_MAX_FILE_BYTES`, so increasing that
setting applies to both server-resolved and browser/native transfers instead of being capped by a
second hard-coded 10 MB parser limit.
