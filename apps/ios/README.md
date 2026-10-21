# Native offline SMS for eligible iPhones

This is an iOS 26 SMS-only native client using Apple's TelephonyMessagingKit. It stores messages
locally and sends through an explicitly selected SIM, with no Grogoni account, backend, agents,
web composer, or internet connection in the carrier path.

Status: source implementation and XCTest cases added. It has not been compiled with Xcode, signed,
or tested on a carrier device. This Linux workspace has neither Swift nor the Apple SDKs. It is not
a release-ready replacement for Apple's full messaging app: MMS/RCS and their storage/UI are not
implemented. Do not use it as the default app on a primary phone during SMS-only testing.

## Platform access

Apple currently requires iOS 26, an iPhone, the Default Carrier Messaging App entitlement, the user
selecting the app as the default carrier messaging app, and production account/location eligibility
in the EU. Development testing in other regions needs Apple's provisioning profile. The runtime
checks `isConfiguredForCarrierMessaging` before accessing services and disables carrier operations
when the platform denies access. This does not enable native SMS for Kenyan production iPhones,
iPads, Macs, browsers, or other devices where Apple does not offer this capability.

Only messages received by this client through the carrier API are stored here. There is no import
of the existing Apple Messages inbox. Received timestamps in this first implementation reflect
local ingestion time, because the SMS API message does not expose a carrier timestamp.

## Build and test on macOS

Use Xcode 26 or later with the iOS 26 SDK, and XcodeGen. Generate the project:

```sh
cd apps/ios
xcodegen generate
open GrogoniSMS.xcodeproj
```

Select your development team and a provisioning profile that includes
`com.apple.developer.carrier-messaging-app`. The bundle ID is `market.grogoni.sms`; change it to an
ID registered to your Apple team if necessary. The entitlement file declares the capability; it
does not grant the entitlement or create a provisioning profile.

Run the `GrogoniSMS` scheme tests on an available iOS 26 simulator for the local store tests.
Carrier messaging needs an eligible physical iPhone, carrier service, provisioning, and default-app
selection. Configure the default carrier messaging app in the device's Settings; the app's settings
button alone cannot assign the default role.

## Persistence and delivery semantics

The app starts its incoming message sequence at native launch, including carrier-triggered
background launch, and persists each incoming SMS before posting a generic local notification.
Notification permission is optional and requested by a user action; denial does not block SMS.
History uses atomic writes with iOS file protection and is excluded from backup. Local history
remains accessible when carrier messaging is unavailable. Storage failures stop receipt and show
an error rather than silently resetting history.

Incoming deduplication uses service ID, carrier message ID, and direction. Carrier IDs are 32-bit,
so extremely long histories may need a richer identity policy if the carrier reuses an incoming ID.
Outgoing sends persist `sending` before invoking the carrier. A successful API call records
`submitted`, not delivered. An interrupted or uncertain send records `unknown` and is never
automatically retried. SIM availability is checked again before each send, and multiple SIMs require
an explicit choice; there is no silent subscription fallback.

## Required device verification

- Disable Wi-Fi and mobile data while retaining cellular SMS service; send and receive SMS.
- Relaunch after a received message and verify history and read state.
- Test carrier-triggered background launch, locked-device receipt, and notification denial.
- Revoke the default role, remove a SIM, switch services, and test a device outside eligibility.
- Interrupt a send and confirm that relaunch never automatically submits it again.
- Verify Unicode/multipart SMS and carrier error behavior before any release.

Official references:

- [Creating a carrier messaging app](https://developer.apple.com/documentation/telephonymessagingkit/creating-a-carrier-messaging-app)
- [Carrier messaging entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.carrier-messaging-app)
- [SMS service](https://developer.apple.com/documentation/telephonymessagingkit/smsservice)
