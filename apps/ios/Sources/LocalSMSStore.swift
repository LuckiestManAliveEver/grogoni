import Foundation

struct LocalSMS: Codable, Identifiable, Equatable {
    enum Direction: String, Codable { case incoming, outgoing }
    enum Status: String, Codable { case received, sending, submitted, unknown }

    let id: UUID
    let service: String
    let carrierID: UInt32
    let address: String
    let body: String
    let date: Date
    let direction: Direction
    var status: Status
    var read: Bool
}

/// Local file protection allows background receipt after the device's first unlock.
/// There is no backend, agent invocation, or automatic carrier retry in this store.
@MainActor
final class LocalSMSStore {
    private let file: URL
    private(set) var messages: [LocalSMS]

    init(file: URL) throws {
        self.file = file
        let manager = FileManager.default
        try manager.createDirectory(
            at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        if manager.fileExists(atPath: file.path) {
            // Never replace unreadable history with an empty file.
            messages = try JSONDecoder().decode([LocalSMS].self, from: Data(contentsOf: file))
        } else {
            messages = []
        }
        if messages.contains(where: { $0.status == .sending }) {
            try commit(messages.map { record in
                var recovered = record
                if recovered.status == .sending { recovered.status = .unknown }
                return recovered
            })
        }
    }

    @discardableResult
    func insert(_ message: LocalSMS) throws -> Bool {
        guard !messages.contains(where: {
            $0.service == message.service && $0.carrierID == message.carrierID &&
            $0.direction == message.direction
        }) else { return false }
        try commit(messages + [message])
        return true
    }

    func update(_ id: UUID, status: LocalSMS.Status? = nil, read: Bool? = nil) throws {
        var updated = messages
        guard let index = updated.firstIndex(where: { $0.id == id }) else { return }
        if let status { updated[index].status = status }
        if let read { updated[index].read = read }
        try commit(updated)
    }

    private func commit(_ updated: [LocalSMS]) throws {
        try JSONEncoder().encode(updated).write(
            to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
        var protectedFile = file
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try protectedFile.setResourceValues(values)
        messages = updated
    }
}
