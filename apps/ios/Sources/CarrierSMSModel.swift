import Combine
import Foundation
import TelephonyMessagingKit
import UserNotifications

@MainActor
final class CarrierSMSModel: ObservableObject {
    static let shared = CarrierSMSModel()

    @Published private(set) var messages: [LocalSMS] = []
    @Published private(set) var services: [CellularServiceState] = []
    @Published private(set) var available = false
    @Published private(set) var sending = false
    @Published var notice = "Checking carrier SMS access."
    @Published var selectedService: CellularServiceID?

    private let session = TelephonyMessagingSession.shared
    private var store: LocalSMSStore?
    private var incomingTask: Task<Void, Never>?
    private var incomingGeneration = UUID()

    private init() { openStore() }

    private func openStore() {
        do {
            let directory = try FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true
            ).appendingPathComponent("CarrierSMS", isDirectory: true)
            store = try LocalSMSStore(file: directory.appendingPathComponent("messages.json"))
            reloadMessages()
        } catch {
            notice = "Local SMS history could not be opened. Carrier operations are disabled."
        }
    }

    func refresh() {
        // Protected history may be unavailable during a background launch before first unlock.
        if store == nil { openStore() }
        guard store != nil else { return }
        // This is the platform's authoritative entitlement, region, and default-app check.
        guard session.isConfiguredForCarrierMessaging else {
            available = false
            services = []
            selectedService = nil
            incomingTask?.cancel()
            incomingTask = nil
            incomingGeneration = UUID()
            notice = "Carrier SMS is unavailable. Eligible iPhones must select Grogoni SMS as the default carrier messaging app in Settings."
            return
        }
        do {
            services = try session.cellularServices
            if !services.contains(where: { $0.id == selectedService }) {
                selectedService = services.count == 1 ? services.first?.id : nil
            }
            available = true
            notice = "SMS uses your SIM. No internet, Grogoni account, or agents are needed. Carrier charges may apply."
            startReceiving()
        } catch {
            available = false
            notice = "Cellular services could not be read. Check carrier SMS setup in Settings."
        }
    }

    func requestNotifications() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }

    func markRead(_ message: LocalSMS) {
        do {
            try store?.update(message.id, read: true)
            reloadMessages()
        } catch {
            notice = "The local read status could not be saved."
        }
    }

    func send(to recipient: String, text: String) async -> Bool {
        let address = recipient.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sending, let store else { return false }
        guard address.range(of: #"^\+[1-9][0-9]{6,14}$"#, options: .regularExpression) != nil,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            notice = "Enter an international telephone number (+country code) and message."
            return false
        }
        refresh()
        guard available, let serviceID = selectedService,
              services.contains(where: { $0.id == serviceID }),
              session.smsService.isViable(for: serviceID) else {
            notice = "Select an available SMS SIM and check cellular service."
            return false
        }
        let serviceKey = String(describing: serviceID)
        var carrierID = UInt32.random(in: 1...UInt32.max)
        while store.messages.contains(where: {
            $0.service == serviceKey && $0.carrierID == carrierID && $0.direction == .outgoing
        }) { carrierID = UInt32.random(in: 1...UInt32.max) }
        let record = LocalSMS(
            id: UUID(), service: serviceKey, carrierID: carrierID, address: address,
            body: text, date: Date(), direction: .outgoing, status: .sending, read: true
        )
        do { try store.insert(record) } catch {
            notice = "The message could not be saved locally. No SMS was submitted."
            return false
        }
        reloadMessages()
        sending = true
        defer { sending = false }
        do {
            // Persist before invoking the carrier. Never retry automatically after interruption.
            try await session.smsService.sendMessage(SMSMessage(
                cellularServiceID: serviceID, handle: SMSHandle(phoneNumber: address),
                messageID: SMSMessageID(rawValue: carrierID), content: SMSContent(body: text)
            ))
            try store.update(record.id, status: .submitted)
            reloadMessages()
            notice = "SMS submitted to the carrier. Delivery is not confirmed."
            return true
        } catch {
            try? store.update(record.id, status: .unknown)
            reloadMessages()
            notice = "SMS submission could not be confirmed. Check before manually sending again; it may already have been sent."
            return false
        }
    }

    private func startReceiving() {
        guard incomingTask == nil else { return }
        let generation = UUID()
        incomingGeneration = generation
        incomingTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.incomingGeneration == generation { self.incomingTask = nil }
            }
            do {
                let notifications = try self.session.smsService.incomingMessageNotifications
                for await notification in notifications {
                    guard !Task.isCancelled, self.session.isConfiguredForCarrierMessaging,
                          let store = self.store else { break }
                    let message = notification.message
                    let inserted = try store.insert(LocalSMS(
                        id: UUID(), service: String(describing: message.cellularServiceID),
                        carrierID: message.messageID.rawValue, address: message.handle.phoneNumber,
                        body: message.content.body, date: Date(), direction: .incoming,
                        status: .received, read: false
                    ))
                    self.reloadMessages()
                    if inserted {
                        let content = UNMutableNotificationContent()
                        content.title = "New SMS"
                        content.body = "Open Grogoni SMS to read and reply."
                        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(
                            identifier: "sms-\(UUID().uuidString)", content: content, trigger: nil
                        ))
                    }
                }
            } catch {
                self.available = false
                self.notice = "SMS reception stopped. Check local storage and carrier SMS setup, then reopen the app."
            }
        }
    }

    private func reloadMessages() {
        messages = (store?.messages ?? []).sorted { $0.date > $1.date }
    }
}
