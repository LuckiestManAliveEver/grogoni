# SMS across devices

SMS recipients can use any SMS-capable phone, including feature phones. They text the business's
ordinary phone number and do not need Grogoni, an agent, or a shared Grogoni number.

Direct offline SMS is the native path on supported platforms. Android source is in `apps/android`.
An iOS 26 source implementation for eligible iPhones is now in `apps/ios`; it includes a local inbox,
manual carrier sending, SIM selection, and runtime eligibility checks. The iOS source has not been
compiled, signed, or tested on a device. See `apps/ios/README.md` for its access and SMS-only limits.
It does not import pre-existing Apple Messages history.

For the person using Grogoni, the available experience depends on the operating system:

| Device                                                  | Current implementation                                                                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android native app                                      | Local recent-message list, manual SIM sending/replying, and optional backend sync.                                                                   |
| iPhone/iPad web app                                     | Open the system SMS handler with the recipient; keep the message available to copy. Cellular SMS availability depends on the device or linked phone. |
| Other browsers, tablets, and computers                  | Attempt the standard `sms:` handler, including connected-phone handlers; retain the recipient and text for manual use if unavailable.                |
| Feature phones without a compatible Grogoni browser/app | Use the built-in SMS app directly to text the business. No Grogoni client is installed by this implementation.                                       |

Browser identity does not prove that a device has an SMS handler. The web helper therefore attempts
dispatch without an Android/mobile/desktop allowlist. It records only a handoff request, never
proof of sending or delivery. Standard handlers receive an encoded RFC 5724 body; Apple browser
links use the documented recipient-only format, with a visible copy fallback for message text.

Native wrappers may implement `window.GrogoniDevice.openSmsComposer`. The existing
`window.GrogoniAndroid` contract remains a fallback. These are adapter contracts, not additional
native apps shipped by this change.

Direct cellular SMS does not need internet or agents. A browser-based Grogoni screen must already
be loaded or cached to be available offline. Connected-phone services may require internet. The
web client cannot read the system SMS inbox or receive carrier broadcasts. Full in-app carrier
messaging on other platforms needs a native integration and the platform's permitted capabilities;
SMS-capable hardware alone does not grant those capabilities to a web app.

References:

- [SMS URI standard](https://datatracker.ietf.org/doc/html/rfc5724)
- [Apple SMS links](https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/SMSLinks/SMSLinks.html)
- [Apple carrier messaging framework](https://developer.apple.com/documentation/telephonymessagingkit)
