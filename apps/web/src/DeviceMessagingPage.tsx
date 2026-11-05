import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deviceMessagingAdapter,
  mmsStatus,
  smsStatus,
  newDeviceCommandId,
  type DeviceAttachment,
  type DeviceCapabilities,
  type DeviceMessage,
  type DeviceMessagingAdapter,
  type DeviceMms,
  isNativeDeviceHost
} from "./device-messaging";
import DevicePermissionChecklist from "./DevicePermissionChecklist";
import {
  applySuggestion,
  buildContactIndex,
  contactLabel,
  parseDevicePhonebook,
  replyDestination,
  suggestContacts,
  type DevicePhonebook
} from "./device-contacts";
import {
  parseDevicePermissionChecklist,
  type DevicePermissionChecklist as PermissionChecklist
} from "./device-permissions";
import "./device-messaging.css";

export default function DeviceMessagingPage({
  adapter = deviceMessagingAdapter
}: {
  adapter?: DeviceMessagingAdapter;
}) {
  const initial = new URLSearchParams(window.location.search);
  const [channel, setChannel] = useState<"sms" | "mms">(
    initial.get("channel") === "mms" ? "mms" : "sms"
  );
  const [capabilities, setCapabilities] = useState<DeviceCapabilities | null>(null);
  const [messages, setMessages] = useState<DeviceMessage[]>([]);
  const [multimedia, setMultimedia] = useState<DeviceMms[]>([]);
  const [pending, setPending] = useState<{ sender: string; text: string }[]>([]);
  const [recipient, setRecipient] = useState(initial.get("to") ?? "");
  const [body, setBody] = useState(initial.get("body") ?? "");
  const [attachment, setAttachment] = useState<DeviceAttachment | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [address, setAddress] = useState<string | null>(null);
  const [older, setOlder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [opened, setOpened] = useState<DeviceMessage | null>(null);
  const [openedMms, setOpenedMms] = useState<
    (DeviceMms & { body: string; attachments: DeviceAttachment[] }) | null
  >(null);
  const [settings, setSettings] = useState(false);
  const [businesses, setBusinesses] = useState<{ id: string; name: string }[]>([]);
  // First launch shows the device access checklist before the inbox. Bridge failures never block it.
  const [permissionGate, setPermissionGate] = useState<"checking" | "ready">("checking");
  const [checklist, setChecklist] = useState<PermissionChecklist | null>(null);
  const [checklistSupported, setChecklistSupported] = useState(false);
  useEffect(() => {
    let current = true;
    adapter
      .call("permissionChecklist", {}, { timeoutMs: 5_000 })
      .then(
        (value) => {
          const parsed = parseDevicePermissionChecklist(value);
          if (current && parsed) setChecklistSupported(true);
          if (current && parsed && !parsed.completed) setChecklist(parsed);
        },
        () => undefined
      )
      .finally(() => {
        if (current) setPermissionGate("ready");
      });
    return () => {
      current = false;
    };
  }, [adapter]);
  // Phonebook names, once the checklist is out of the way. Without access the inbox shows numbers.
  const [phonebook, setPhonebook] = useState<DevicePhonebook>({ contacts: [], country: null });
  const inbox = permissionGate === "ready" && checklist === null;
  useEffect(() => {
    if (!inbox) return;
    let current = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      adapter.call("listContacts").then(
        (value) => {
          if (current) setPhonebook(parseDevicePhonebook(value));
        },
        () => undefined
      );
    };
    load();
    // Access can change in Android Settings, and contacts in the phone's own app.
    document.addEventListener("visibilitychange", load);
    return () => {
      current = false;
      document.removeEventListener("visibilitychange", load);
    };
  }, [adapter, inbox]);
  const suggestions = useMemo(
    () => suggestContacts(phonebook.contacts, recipient, phonebook.country),
    [phonebook, recipient]
  );
  // The keyboard covers the lower half of small phones; keep the first match reachable.
  const suggestionList = useRef<HTMLUListElement>(null);
  const hasSuggestions = suggestions.length > 0;
  useEffect(() => {
    if (hasSuggestions) suggestionList.current?.scrollIntoView?.({ block: "nearest" });
  }, [hasSuggestions]);
  const contactIndex = useMemo(() => buildContactIndex(phonebook), [phonebook]);
  const label = (value: string) => contactLabel(value, contactIndex, phonebook.country);

  const viewKey = JSON.stringify([channel, filter, address]);
  const activeView = useRef(viewKey);
  activeView.current = viewKey;
  const loadedOlder = useRef(false);
  const refresh = useCallback(async () => {
    const state = await adapter.call<DeviceCapabilities>("capabilities");
    if (activeView.current !== viewKey) return;
    setCapabilities(state);
    if (!state.available || !state.roleGranted) return;
    if (channel === "sms") {
      const page = await adapter.call<{
        messages: DeviceMessage[];
        pending: typeof pending;
        hasMore: boolean;
      }>("listSms", { query: filter, address });
      if (activeView.current !== viewKey) return;
      setMessages((current) =>
        loadedOlder.current
          ? [
              ...page.messages,
              ...current.filter(
                (message) => !page.messages.some((fresh) => fresh.id === message.id)
              )
            ]
          : page.messages
      );
      setPending(page.pending);
      if (!loadedOlder.current) setOlder(page.hasMore);
    } else {
      const page = await adapter.call<{ messages: DeviceMms[]; hasMore: boolean }>("listMms");
      if (activeView.current !== viewKey) return;
      setMultimedia((current) =>
        loadedOlder.current
          ? [
              ...page.messages,
              ...current.filter(
                (message) => !page.messages.some((fresh) => fresh.id === message.id)
              )
            ]
          : page.messages
      );
      if (!loadedOlder.current) setOlder(page.hasMore);
    }
  }, [adapter, channel, filter, address, viewKey]);
  useEffect(() => {
    loadedOlder.current = false;
    setMessages([]);
    setMultimedia([]);
    void refresh().catch((error: unknown) =>
      setNotice(error instanceof Error ? error.message : String(error))
    );
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh().catch(() => undefined);
    }, 10_000);
    const focused = () => {
      void refresh().catch(() => undefined);
    };
    window.addEventListener("focus", focused);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", focused);
    };
  }, [refresh]);

  async function operation(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  // This route scrolls inside .device-messenger; the window itself cannot scroll.
  const showComposer = () => document.querySelector(".device-messenger")?.scrollTo?.(0, 0);
  const reviewPermissions = () =>
    operation(async () => {
      const parsed = parseDevicePermissionChecklist(await adapter.call("permissionChecklist"));
      if (!parsed) throw new Error("Update the Android app to review permissions.");
      setChecklist(parsed);
    });
  async function loadOlder() {
    await operation(async () => {
      if (channel === "sms") {
        const last = messages[messages.length - 1];
        const page = await adapter.call<{ messages: DeviceMessage[]; hasMore: boolean }>(
          "listSms",
          { before: last && { id: last.id, date: last.date }, query: filter, address }
        );
        if (activeView.current !== viewKey) return;
        loadedOlder.current = true;
        setMessages((current) => [
          ...current,
          ...page.messages.filter((message) => !current.some((m) => m.id === message.id))
        ]);
        setOlder(page.hasMore);
      } else {
        const last = multimedia[multimedia.length - 1];
        const page = await adapter.call<{ messages: DeviceMms[]; hasMore: boolean }>("listMms", {
          before: last && { id: last.id, date: last.date }
        });
        if (activeView.current !== viewKey) return;
        loadedOlder.current = true;
        setMultimedia((current) => [
          ...current,
          ...page.messages.filter((message) => !current.some((m) => m.id === message.id))
        ]);
        setOlder(page.hasMore);
      }
    });
  }
  async function send() {
    if (!recipient.trim() || (!body.trim() && !attachment)) {
      setNotice("Enter a recipient and message or attachment.");
      return;
    }
    const targets = recipient
      .split(/[,;]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (channel === "sms" && targets.length !== 1) {
      setNotice("Choose MMS for a group message.");
      return;
    }
    if (
      !window.confirm(
        `Send ${channel.toUpperCase()} using SIM ${capabilities?.subscriptionId ?? "default"}? Carrier and roaming charges may apply.\nRecipients: ${targets.join(", ")}`
      )
    )
      return;
    await operation(async () => {
      await adapter.call(channel === "sms" ? "sendSms" : "sendMms", {
        id: newDeviceCommandId(),
        recipients: targets,
        text: body,
        subscriptionId: capabilities?.subscriptionId,
        attachmentId: attachment?.id ?? null
      });
      setBody("");
      setAttachment(null);
      setNotice(
        "Submitted to Android. Check message status; submission does not confirm delivery."
      );
      await refresh();
    });
  }
  async function open(message: DeviceMessage) {
    setOpened(message);
    await operation(async () => {
      await adapter.call("markRead", { id: message.id });
    });
  }

  if (permissionGate === "checking")
    return (
      <main className="device-messenger" data-testid="device-messenger">
        <p role="status">Checking device access…</p>
      </main>
    );
  if (checklist)
    return (
      <main className="device-messenger" data-testid="device-messenger">
        <DevicePermissionChecklist
          adapter={adapter}
          initial={checklist}
          onDone={() => {
            setChecklist(null);
            void refresh().catch((error: unknown) =>
              setNotice(error instanceof Error ? error.message : String(error))
            );
          }}
        />
      </main>
    );

  return (
    <main className="device-messenger" data-testid="device-messenger">
      <header className="device-messenger-header">
        <a href="/" aria-label="Open Grogoni">
          grogoni
        </a>
        <h1>Messages</h1>
        <button type="button" onClick={() => setSettings(!settings)} aria-expanded={settings}>
          Settings
        </button>
      </header>
      {notice && (
        <p role="status" className="device-messenger-notice">
          {notice}
        </p>
      )}
      {capabilities?.available === false ? (
        <section>
          <h2>Carrier messages on this device</h2>
          {isNativeDeviceHost() ? (
            <p>
              Android does not allow a default SMS app on this phone or profile. You can continue
              with internet conversations.
            </p>
          ) : (
            <>
              <p>
                Your browser cannot read the phone’s SMS inbox. Install Grogoni for Android to use
                carrier messages, or continue with internet conversations.
              </p>
              <a href="/install">Install Android app</a>
            </>
          )}
          <a href="/marketplace">Open internet conversations</a>
          {checklistSupported && (
            <button type="button" disabled={busy} onClick={() => void reviewPermissions()}>
              Review app permissions
            </button>
          )}
        </section>
      ) : (
        <>
          {!capabilities?.roleGranted && (
            <section>
              <p>Choose Grogoni as your default SMS app to read and send carrier messages.</p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void operation(async () => {
                    await adapter.call("requestSmsRole");
                    await refresh();
                  })
                }
              >
                Set up carrier messages
              </button>
            </section>
          )}
          {capabilities?.roleGranted && !capabilities.ready && (
            <p>Grant SMS access and select a default SMS SIM in Android settings.</p>
          )}
          <nav className="device-messenger-tabs" aria-label="Message channel">
            <button
              type="button"
              aria-pressed={channel === "sms"}
              onClick={() => {
                setChannel("sms");
                setOpenedMms(null);
              }}
            >
              SMS
            </button>
            <button
              type="button"
              aria-pressed={channel === "mms"}
              onClick={() => {
                setChannel("mms");
                setOpened(null);
              }}
            >
              MMS · pictures & groups
            </button>
          </nav>
          {settings && (
            <section className="device-messenger-settings">
              <h2>Device settings</h2>
              <p>
                Incoming carrier messages stay on this phone. Only messages you explicitly share are
                uploaded.
              </p>
              <p>Default SMS SIM: {capabilities?.subscriptionId ?? "Not selected"}</p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void operation(async () => {
                    await adapter.call("requestSmsRole");
                    await refresh();
                  })
                }
              >
                Review Android SMS permissions
              </button>
              <button type="button" disabled={busy} onClick={() => void reviewPermissions()}>
                Review app permissions
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void operation(async () => {
                    await adapter.call("recover");
                    await refresh();
                    setNotice("Inbox recovery retried.");
                  })
                }
              >
                Retry local inbox recovery
              </button>
              <h3>Business sharing</h3>
              <a href="/login">Sign in through Grogoni</a>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void operation(async () => {
                    const result = await adapter.call<{ businesses: typeof businesses }>(
                      "connectWebSession"
                    );
                    setBusinesses(result.businesses);
                    await refresh();
                  })
                }
              >
                Connect signed-in account to this device
              </button>
              {businesses.length > 0 && (
                <label>
                  Business
                  <select
                    value={capabilities?.businessId ?? ""}
                    onChange={(event) =>
                      void operation(async () => {
                        await adapter.call("chooseBusiness", { id: event.target.value });
                        await refresh();
                      })
                    }
                  >
                    <option value="">Choose a business</option>
                    {businesses.map((business) => (
                      <option key={business.id} value={business.id}>
                        {business.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={capabilities?.syncEnabled ?? false}
                  disabled={busy || !capabilities?.accountId || !capabilities.businessId}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    if (
                      enabled &&
                      !window.confirm(
                        "Enable business sharing and remote sends through this SIM? Carrier charges may apply. Existing queued work resumes. Incoming messages are never automatically uploaded."
                      )
                    )
                      return;
                    void operation(async () => {
                      await adapter.call("setBusinessFeatures", { enabled });
                      await refresh();
                    });
                  }}
                />
                Enable business sharing and remote SIM sends
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void operation(async () => {
                    await adapter.call("disconnect");
                    setBusinesses([]);
                    await refresh();
                  })
                }
              >
                Disconnect business features
              </button>
            </section>
          )}
          <section className="device-messenger-compose" aria-label="Compose carrier message">
            <label>
              To
              <input
                value={recipient}
                onChange={(event) => setRecipient(event.target.value)}
                placeholder={
                  channel === "sms"
                    ? "Phone number or short code"
                    : "Phone numbers, separated by commas"
                }
                autoComplete="tel"
              />
            </label>
            {suggestions.length > 0 && (
              <ul
                ref={suggestionList}
                className="device-contact-suggestions"
                aria-label="Phonebook suggestions"
              >
                {suggestions.map((contact) => (
                  <li key={contact.destination}>
                    <button
                      type="button"
                      onClick={() => setRecipient(applySuggestion(recipient, contact.destination))}
                    >
                      {contact.name} <small>{contact.destination}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label>
              Message
              <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={3} />
            </label>
            {channel === "mms" && (
              <>
                <p>
                  MMS needs carrier mobile data. Up to 300 KiB per message; downloads require your
                  confirmation.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void operation(async () => {
                      setAttachment(await adapter.call<DeviceAttachment | null>("pickAttachment"));
                    })
                  }
                >
                  Choose attachment
                </button>
                {attachment && (
                  <p>
                    {attachment.name}
                    <button type="button" onClick={() => setAttachment(null)}>
                      Remove attachment
                    </button>
                  </p>
                )}
              </>
            )}
            <button
              className="device-messenger-send"
              type="button"
              disabled={busy || !capabilities?.ready}
              onClick={() => void send()}
            >
              Send {channel.toUpperCase()} via SIM
            </button>
          </section>
          {channel === "sms" && (
            <form
              className="device-messenger-search"
              onSubmit={(event) => {
                event.preventDefault();
                setFilter(query);
                setAddress(null);
              }}
            >
              <label>
                Search all messages
                <input value={query} onChange={(event) => setQuery(event.target.value)} />
              </label>
              <button type="submit">Search</button>
              <button
                type="button"
                onClick={() => {
                  setFilter("");
                  setQuery("");
                  setAddress(null);
                }}
              >
                All messages
              </button>
            </form>
          )}
          <section aria-label="Message history" className="device-messenger-history">
            <h2>
              {address ? `Conversation with ${label(address)}` : `${channel.toUpperCase()} history`}
            </h2>
            <button type="button" disabled={busy} onClick={() => void operation(refresh)}>
              Refresh messages
            </button>
            {pending.map((message, index) => (
              <article key={index}>
                <strong>{message.sender}</strong>
                <p>{message.text}</p>
                <p>Saved locally · waiting for inbox recovery</p>
              </article>
            ))}
            {channel === "sms"
              ? messages.map((message) => (
                  <button
                    className="device-message"
                    type="button"
                    key={message.id}
                    onClick={() => void open(message)}
                  >
                    <span>
                      <strong>{label(message.address)}</strong>
                      <small>
                        {smsStatus(message.type)}
                        {message.type === 1 && !message.read ? " · unread" : ""}
                      </small>
                    </span>
                    <p>{message.body}</p>
                    <time>{new Date(message.date).toLocaleString()}</time>
                  </button>
                ))
              : multimedia.map((message) => (
                  <button
                    className="device-message"
                    type="button"
                    key={message.id}
                    onClick={() =>
                      void operation(async () => {
                        if (message.type === 130) {
                          if (
                            window.confirm(
                              `Download this MMS using SIM ${message.subscriptionId}? Mobile data and roaming charges may apply.`
                            )
                          ) {
                            await adapter.call("downloadMms", {
                              id: message.id,
                              subscriptionId: message.subscriptionId
                            });
                            setNotice("Download requested. Refresh to check its status.");
                          }
                        } else setOpenedMms(await adapter.call("readMms", { id: message.id }));
                      })
                    }
                  >
                    <strong>{message.addresses.map(label).join(", ") || "MMS"}</strong>
                    <p>{mmsStatus(message)}</p>
                    <time>{new Date(message.date).toLocaleString()}</time>
                  </button>
                ))}
            {capabilities?.roleGranted &&
              (channel === "sms" ? messages.length === 0 : multimedia.length === 0) && (
                <p>No messages match this view.</p>
              )}
            {older && (
              <button type="button" disabled={busy} onClick={() => void loadOlder()}>
                Load older messages
              </button>
            )}
          </section>
        </>
      )}
      {opened && (
        <section
          className="device-message-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="SMS message"
        >
          <h2>{label(opened.address)}</h2>
          <p>{opened.body}</p>
          <button
            type="button"
            onClick={() => {
              setRecipient(replyDestination(opened.address, phonebook.country));
              setOpened(null);
              showComposer();
            }}
          >
            Reply
          </button>
          <button
            type="button"
            onClick={() => {
              setAddress(opened.address);
              setFilter("");
              setOpened(null);
            }}
          >
            Conversation
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  "Upload the sender and full message to the selected business for possible agent processing? Do not share personal messages, passwords or verification codes."
                )
              )
                return;
              void operation(async () => {
                await adapter.call("shareSms", { id: opened.id });
                setOpened(null);
                setNotice("Message queued for explicit business sharing.");
              });
            }}
          >
            Share with business
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Permanently delete this SMS from this phone?"))
                void operation(async () => {
                  await adapter.call("deleteSms", { id: opened.id });
                  setMessages((current) => current.filter((message) => message.id !== opened.id));
                  setOpened(null);
                  await refresh();
                });
            }}
          >
            Delete
          </button>
          <button type="button" onClick={() => setOpened(null)}>
            Close
          </button>
        </section>
      )}
      {openedMms && (
        <section
          className="device-message-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="MMS message"
        >
          <h2>{openedMms.addresses.map(label).join(", ") || "MMS"}</h2>
          <p>{openedMms.body}</p>
          {openedMms.attachments.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() =>
                void operation(async () => {
                  await adapter.call("openAttachment", { id: item.id });
                })
              }
            >
              Open {item.type} attachment
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setRecipient(
                openedMms.addresses
                  .map((value) => replyDestination(value, phonebook.country))
                  .join(", ")
              );
              setBody(openedMms.box === 3 ? openedMms.body : "");
              setAttachment(openedMms.box === 3 ? (openedMms.attachments[0] ?? null) : null);
              setOpenedMms(null);
              showComposer();
            }}
          >
            Reply / retry
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Permanently delete this MMS?"))
                void operation(async () => {
                  await adapter.call("deleteMms", { id: openedMms.id });
                  setMultimedia((current) =>
                    current.filter((message) => message.id !== openedMms.id)
                  );
                  setOpenedMms(null);
                  await refresh();
                });
            }}
          >
            Delete
          </button>
          <button type="button" onClick={() => setOpenedMms(null)}>
            Close
          </button>
        </section>
      )}
    </main>
  );
}
