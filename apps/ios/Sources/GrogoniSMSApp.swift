import SwiftUI
import TelephonyMessagingKit
import UIKit

/// Start receiving at native launch, including background carrier-triggered launches.
@MainActor
final class SMSAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        CarrierSMSModel.shared.refresh()
        return true
    }
}

@main
struct GrogoniSMSApp: App {
    @UIApplicationDelegateAdaptor(SMSAppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            SMSInboxView()
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { CarrierSMSModel.shared.refresh() }
                }
        }
    }
}

struct SMSInboxView: View {
    @ObservedObject private var model = CarrierSMSModel.shared
    @State private var recipient = ""
    @State private var text = ""
    @State private var confirmingSend = false
    @State private var openedMessage: LocalSMS?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(model.notice)
                    Button("Review carrier SMS setup") {
                        model.refresh()
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    }
                    Button("Enable SMS notifications") {
                        Task { await model.requestNotifications() }
                    }
                }
                Section("Compose SMS") {
                    TextField("Recipient (+country code)", text: $recipient)
                        .keyboardType(.phonePad)
                    TextField("Message", text: $text, axis: .vertical)
                        .lineLimit(3...8)
                    Picker("SMS SIM", selection: $model.selectedService) {
                        Text("Select SIM").tag(nil as CellularServiceID?)
                        ForEach(model.services, id: \.id) { service in
                            Text(service.label).tag(Optional(service.id))
                        }
                    }
                    Button(model.sending ? "Submitting…" : "Send via SIM") {
                        confirmingSend = true
                    }
                    .disabled(!model.available || model.selectedService == nil ||
                              model.sending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Section("SMS stored on this iPhone") {
                    if model.messages.isEmpty {
                        Text("Messages received by Grogoni SMS will appear here.")
                    }
                    ForEach(model.messages) { message in
                        Button {
                            openedMessage = message
                            model.markRead(message)
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(message.address).fontWeight(message.read ? .regular : .bold)
                                Text(message.body).lineLimit(3)
                                Text("\(message.direction.rawValue) · \(message.status.rawValue)")
                                    .font(.caption)
                                Text(message.date, style: .date).font(.caption)
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                }
            }
            .navigationTitle("Grogoni SMS")
            .confirmationDialog("Send SMS to \(recipient)? Carrier charges may apply.",
                                isPresented: $confirmingSend, titleVisibility: .visible) {
                Button("Send SMS") {
                    let draftRecipient = recipient
                    let draftText = text
                    Task {
                        if await model.send(to: draftRecipient, text: draftText), text == draftText {
                            text = ""
                        }
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
            .sheet(item: $openedMessage) { message in
                NavigationStack {
                    ScrollView { Text(message.body).textSelection(.enabled).padding() }
                        .navigationTitle(message.address)
                        .toolbar {
                            Button("Reply") { recipient = message.address; openedMessage = nil }
                            Button("Close") { openedMessage = nil }
                        }
                }
            }
        }
    }
}
