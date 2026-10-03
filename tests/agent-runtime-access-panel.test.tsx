// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContextSource } from "@grogoni/shared-types";

import { AgentRuntimeAccessPanel } from "../apps/web/src/AgentRuntimeAccessPanel";
import type { AgentSettings } from "../apps/web/src/grogoni-application-shared";

describe("agent runtime access panel - context source creation", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    host.id = "root";
    document.body.append(host);
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  function Harness(props: {
    submitContextSource: () => Promise<void>;
    runProfileAction: (key: string, action: () => Promise<void>) => Promise<void>;
    existingSources?: AgentContextSource[];
  }) {
    const draftAgent = { skillBindings: [] } as unknown as AgentSettings;
    return (
      <AgentRuntimeAccessPanel
        draftAgent={draftAgent}
        isEditing={false}
        updateAgent={vi.fn()}
        runtimeContextSources={props.existingSources ?? []}
        runtimeDetailsLoading={false}
        contextSourceTitle="Delivery policy"
        setContextSourceTitle={vi.fn()}
        contextSourceType="owner_note"
        setContextSourceType={vi.fn()}
        contextSourceContent="Deliveries within Nairobi are free above KSh 2,000."
        setContextSourceContent={vi.fn()}
        contextSourceSensitivity="internal"
        setContextSourceSensitivity={vi.fn()}
        contextSourceCustomerVisible={false}
        setContextSourceCustomerVisible={vi.fn()}
        pendingProfileAction={null}
        runProfileAction={props.runProfileAction}
        submitContextSource={props.submitContextSource}
      />
    );
  }

  it("submits a filled-in context source through the canonical runProfileAction pipeline", async () => {
    const submitContextSource = vi.fn().mockResolvedValue(undefined);
    const runProfileAction = vi.fn(
      async (_key: string, action: () => Promise<void>) => await action()
    );
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <Harness submitContextSource={submitContextSource} runProfileAction={runProfileAction} />
      )
    );

    const saveButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Save context source"
    )!;
    expect(saveButton.hasAttribute("disabled")).toBe(false);

    await act(async () => saveButton.click());

    expect(runProfileAction).toHaveBeenCalledWith("agent-context-source", submitContextSource);
    expect(submitContextSource).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("disables the save button until both title and content are filled in", async () => {
    const submitContextSource = vi.fn().mockResolvedValue(undefined);
    const runProfileAction = vi.fn(
      async (_key: string, action: () => Promise<void>) => await action()
    );

    function EmptyHarness(props: { title: string; content: string }) {
      const draftAgent = { skillBindings: [] } as unknown as AgentSettings;
      return (
        <AgentRuntimeAccessPanel
          draftAgent={draftAgent}
          isEditing={false}
          updateAgent={vi.fn()}
          runtimeContextSources={[]}
          runtimeDetailsLoading={false}
          contextSourceTitle={props.title}
          setContextSourceTitle={vi.fn()}
          contextSourceType="owner_note"
          setContextSourceType={vi.fn()}
          contextSourceContent={props.content}
          setContextSourceContent={vi.fn()}
          contextSourceSensitivity="internal"
          setContextSourceSensitivity={vi.fn()}
          contextSourceCustomerVisible={false}
          setContextSourceCustomerVisible={vi.fn()}
          pendingProfileAction={null}
          runProfileAction={runProfileAction}
          submitContextSource={submitContextSource}
        />
      );
    }

    const root = createRoot(host);
    await act(async () => root.render(<EmptyHarness title="" content="" />));
    const saveButton = () =>
      Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === "Save context source"
      )!;
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    await act(async () => root.render(<EmptyHarness title="Title only" content="" />));
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    await act(async () => root.render(<EmptyHarness title="" content="Content only" />));
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    await act(async () => root.render(<EmptyHarness title="Title" content="Content" />));
    expect(saveButton().hasAttribute("disabled")).toBe(false);
    await act(async () => root.unmount());
  });

  it("lists existing context sources alongside the creation form", async () => {
    const existingSources: AgentContextSource[] = [
      {
        id: "source-1",
        tenantId: "business-1",
        shopId: "business-1",
        type: "policy",
        title: "Structured business policy",
        status: "active",
        sensitivity: "internal",
        accessRules: {
          audiences: ["owner", "staff"],
          requiredPermission: "business:read",
          customerVisible: false
        },
        freshnessTimestamp: "2026-08-24T00:00:00.000Z",
        version: 1,
        retrievalMetadata: { keywords: [], sourceRecordId: null, content: "Some policy content" },
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
        deletedAt: null
      }
    ];
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <Harness
          submitContextSource={vi.fn().mockResolvedValue(undefined)}
          runProfileAction={vi.fn()}
          existingSources={existingSources}
        />
      )
    );
    expect(host.textContent).toContain("Structured business policy");
    expect(host.textContent).toContain("Save context source");
    await act(async () => root.unmount());
  });
});
