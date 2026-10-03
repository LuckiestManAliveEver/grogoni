import { useState, type ChangeEvent } from "react";

import {
  defaultProductVocabularyContextScript,
  parseProductContextScriptCommand
} from "@grogoni/tool-core";

import { AuthenticationActionMessage } from "./AuthenticationActionMessage";
import { postJson } from "./api-helpers";
import { resolveContextScriptCommand } from "./agent-command-engine";
import { getErrorMessage } from "./chat-message-plumbing";
import { formatDate } from "./formatters";
import { sanitizeContextScripts } from "./owner-app-bootstrap";
import { defaultAgentContextScripts, type AgentSettings } from "./grogoni-application-shared";

export interface ProtectedContextFilesPanelProps {
  draftAgent: AgentSettings;
  isEditing: boolean;
  isSaving: boolean;
  updateAgent: (patch: Partial<AgentSettings>) => void;
  saveAgent: () => Promise<void>;
  contextPassword: string;
  setContextPassword: (value: string) => void;
  contextUnlocked: boolean;
  setContextUnlocked: (value: boolean) => void;
  contextUnlockError: string;
  setContextUnlockError: (value: string) => void;
}

export function ProtectedContextFilesPanel({
  draftAgent,
  isEditing,
  isSaving,
  updateAgent,
  saveAgent,
  contextPassword,
  setContextPassword,
  contextUnlocked,
  setContextUnlocked,
  contextUnlockError,
  setContextUnlockError
}: ProtectedContextFilesPanelProps) {
  const [contextTestPhrase, setContextTestPhrase] = useState("Show products");

  async function unlockContextScripts() {
    const pin = contextPassword.trim();
    if (!/^\d{4}$/u.test(pin)) {
      setContextUnlockError("Enter your 4-digit owner PIN.");
      return;
    }

    try {
      await postJson<{ verified: boolean }>("/auth/pin/verify", { pin });
      setContextUnlocked(true);
      setContextPassword("");
      setContextUnlockError("");
    } catch (error) {
      setContextUnlockError(getErrorMessage(error));
    }
  }

  function updateContextScript(index: number, value: string) {
    updateAgent({
      contextScripts: draftAgent.contextScripts.map((script, scriptIndex) =>
        scriptIndex === index ? value : script
      )
    });
  }

  function addContextScript() {
    updateAgent({
      contextScripts: [
        ...draftAgent.contextScripts,
        "# Local vocabulary\n\n- script: local_vocabulary\n- priority: required\n- allow: read, add, edit, remove\n"
      ]
    });
  }

  function addContextLanguage() {
    updateAgent({
      contextScripts: [
        ...draftAgent.contextScripts,
        "# Swahili local vocabulary\n\n- script: local_vocabulary_sw\n- language: sw\n- priority: required\n- allow: read, add, edit, remove\n"
      ]
    });
    setContextUnlockError("Swahili Markdown context file added. Review it before saving.");
  }

  async function importContextFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    const markdownFiles = files.filter(
      (file) => /\.(?:md|markdown)$/i.test(file.name) && file.size <= 1_000_000
    );
    if (markdownFiles.length !== files.length) {
      setContextUnlockError("Context files must be Markdown (.md) files no larger than 1 MB.");
      return;
    }

    try {
      const contents = sanitizeContextScripts(
        await Promise.all(markdownFiles.map((file) => file.text()))
      );
      updateAgent({
        contextScripts: [...draftAgent.contextScripts, ...contents].slice(0, 12)
      });
      setContextUnlockError(
        `Imported ${contents.length} Markdown context ${contents.length === 1 ? "file" : "files"}.`
      );
    } catch (error) {
      setContextUnlockError(getErrorMessage(error));
    }
  }

  function editFirstContextPhrase() {
    const editor = document.getElementById("agent-context-script-0");
    if (editor instanceof HTMLTextAreaElement) {
      editor.focus();
      editor.setSelectionRange(0, editor.value.length);
      setContextUnlockError("Edit the selected script, then save changes.");
      return;
    }
    setContextUnlockError("Add a phrase before editing.");
  }

  function testContextPhrase() {
    const phrase = contextTestPhrase.trim();
    if (phrase.length === 0) {
      setContextUnlockError("Enter a phrase to test.");
      return;
    }
    const result = resolveContextScriptCommand(draftAgent.contextScripts, phrase);
    setContextUnlockError(
      result === null
        ? "No product context-script match was found."
        : `Matched ${result.intent} with ${Math.round(result.confidence * 100)}% confidence.`
    );
  }

  function testProductVocabularyScript() {
    const enabledEntries = defaultProductVocabularyContextScript.entries.filter(
      (entry) => entry.enabled
    );
    const failedEntries = enabledEntries.filter((entry) => {
      const match = parseProductContextScriptCommand({
        message: entry.phrase,
        contextScripts: draftAgent.contextScripts,
        tenantId: "settings-validation"
      });
      return match === null || match.intent !== entry.intent;
    });

    setContextUnlockError(
      failedEntries.length === 0
        ? `Product vocabulary validation passed ${enabledEntries.length}/${enabledEntries.length} configured phrases.`
        : `Product vocabulary validation matched ${enabledEntries.length - failedEntries.length}/${enabledEntries.length} phrases. Review the context files before saving.`
    );
  }

  function removeContextScript(index: number) {
    updateAgent({
      contextScripts: draftAgent.contextScripts.filter((_, scriptIndex) => scriptIndex !== index)
    });
  }

  return (
    <div className="record-form agent-context-window advanced-context-window">
      <div className="section-heading">
        <p className="eyebrow">Advanced features</p>
        <h3>Protected context files</h3>
      </div>
      <p className="security-warning">
        Changes made here affect the response of the agent. Edit, write, or delete context files
        only with absolute necessity and skill. Context files are always Markdown so the agent can
        parse and follow them.
      </p>
      {!contextUnlocked ? (
        <div className="context-unlock-panel">
          <label>
            Owner PIN
            <input
              value={contextPassword}
              disabled={!isEditing}
              type="password"
              inputMode="numeric"
              maxLength={4}
              autoComplete="current-password"
              onChange={(event) => setContextPassword(event.target.value)}
              placeholder="4-digit PIN"
            />
          </label>
          <button type="button" onClick={() => void unlockContextScripts()} disabled={!isEditing}>
            Unlock context files
          </button>
          {contextUnlockError.length > 0 ? (
            <p>
              <AuthenticationActionMessage message={contextUnlockError} />
            </p>
          ) : null}
        </div>
      ) : (
        <div className="context-script-editor">
          <article className="product-vocabulary-card" aria-label="Product Vocabulary">
            <div className="storefront-card-header">
              <div>
                <span>Markdown context files</span>
                <strong>Product Vocabulary</strong>
              </div>
              <button
                className="secondary"
                type="button"
                disabled={!isEditing}
                onClick={testProductVocabularyScript}
              >
                Test script
              </button>
            </div>
            <div className="supplier-card-metrics">
              <span>
                Status: {defaultProductVocabularyContextScript.enabled ? "Active" : "Inactive"}
              </span>
              <span>Priority: Required</span>
              <span>
                Supported intents:{" "}
                {
                  Array.from(
                    new Set(
                      defaultProductVocabularyContextScript.entries.map((entry) => entry.intent)
                    )
                  ).length
                }
              </span>
              <span>
                Configured phrases: {defaultProductVocabularyContextScript.entries.length}
              </span>
              <span>
                Last updated: {formatDate(defaultProductVocabularyContextScript.lastUpdated)}
              </span>
            </div>
            <div className="context-vocabulary-intents" aria-label="Supported product intents">
              {Array.from(
                new Set(defaultProductVocabularyContextScript.entries.map((entry) => entry.intent))
              ).map((intent) => (
                <span key={intent}>{intent}</span>
              ))}
            </div>
            <div className="row-actions">
              <button type="button" disabled={!isEditing} onClick={addContextScript}>
                Add phrase
              </button>
              <button
                type="button"
                disabled={!isEditing || draftAgent.contextScripts.length === 0}
                onClick={editFirstContextPhrase}
              >
                Edit phrase
              </button>
              <button
                type="button"
                disabled={!isEditing || draftAgent.contextScripts.length === 0}
                onClick={() => removeContextScript(draftAgent.contextScripts.length - 1)}
              >
                Remove phrase
              </button>
              <button type="button" disabled={!isEditing} onClick={addContextLanguage}>
                Add language
              </button>
              <button
                type="button"
                disabled={!isEditing}
                onClick={() => updateAgent({ contextScripts: defaultAgentContextScripts })}
              >
                Restore defaults
              </button>
              <label className="secondary file-action">
                Import .md files
                <input
                  type="file"
                  multiple
                  accept=".md,.markdown,text/markdown"
                  disabled={!isEditing}
                  onChange={(event) => void importContextFiles(event)}
                />
              </label>
              <label>
                Phrase to test
                <input
                  value={contextTestPhrase}
                  disabled={!isEditing}
                  onChange={(event) => setContextTestPhrase(event.target.value)}
                />
              </label>
              <button type="button" disabled={!isEditing} onClick={testContextPhrase}>
                Test phrase
              </button>
              <button
                type="button"
                disabled={!isEditing || isSaving}
                onClick={() => void saveAgent()}
                aria-busy={isSaving}
              >
                {isSaving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </article>
          {draftAgent.contextScripts.map((script, index) => (
            <label key={`${index}-${script.slice(0, 12)}`}>
              context-{index + 1}.md
              <textarea
                id={`agent-context-script-${index}`}
                value={script}
                disabled={!isEditing}
                onChange={(event) => updateContextScript(index, event.target.value)}
                rows={7}
              />
              <button
                className="secondary"
                type="button"
                onClick={() => removeContextScript(index)}
                disabled={!isEditing}
              >
                Delete file
              </button>
            </label>
          ))}
          <button type="button" onClick={addContextScript} disabled={!isEditing}>
            Write new .md file
          </button>
        </div>
      )}
      <div className="context-script-examples">
        <span>Markdown shape</span>
        <code># Product catalogue commands</code>
        <code>- script: product_catalogue_commands</code>
        <code>- priority: required</code>
        <code>- allow: read, add, edit, remove</code>
        <code>- sw: ongeza bidhaa =&gt; add product</code>
      </div>
    </div>
  );
}
