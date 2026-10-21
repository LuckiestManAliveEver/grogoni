import XCTest
@testable import GrogoniSMS

@MainActor
final class LocalSMSStoreTests: XCTestCase {
    private var directory: URL!
    private var file: URL { directory.appendingPathComponent("messages.json") }

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }

    override func tearDown() async throws {
        if let directory { try? FileManager.default.removeItem(at: directory) }
    }

    private func record(service: String = "SIM A", carrierID: UInt32 = 1,
                        direction: LocalSMS.Direction = .incoming,
                        status: LocalSMS.Status = .received) -> LocalSMS {
        LocalSMS(id: UUID(), service: service, carrierID: carrierID,
                 address: "+254712345678", body: "Offline message", date: Date(),
                 direction: direction, status: status, read: false)
    }

    func testHistoryAndReadStatePersistWithoutAnySession() throws {
        let store = try LocalSMSStore(file: file)
        let message = record()
        try store.insert(message)
        try store.update(message.id, read: true)
        let reopened = try LocalSMSStore(file: file)
        XCTAssertEqual(reopened.messages.count, 1)
        XCTAssertEqual(reopened.messages[0].body, message.body)
        XCTAssertTrue(reopened.messages[0].read)
    }

    func testCarrierReplaysDeduplicateButSIMsAndDirectionsRemainDistinct() throws {
        let store = try LocalSMSStore(file: file)
        XCTAssertTrue(try store.insert(record()))
        XCTAssertFalse(try store.insert(record()))
        XCTAssertTrue(try store.insert(record(service: "SIM B")))
        XCTAssertTrue(try store.insert(record(direction: .outgoing, status: .submitted)))
        XCTAssertEqual(store.messages.count, 3)
    }

    func testInterruptedSendBecomesUnknownWithoutCreatingARetry() throws {
        let store = try LocalSMSStore(file: file)
        try store.insert(record(direction: .outgoing, status: .sending))
        let recovered = try LocalSMSStore(file: file)
        XCTAssertEqual(recovered.messages.count, 1)
        XCTAssertEqual(recovered.messages[0].status, .unknown)
        XCTAssertEqual(try LocalSMSStore(file: file).messages[0].status, .unknown)
    }

    func testUnreadableHistoryIsNotOverwritten() throws {
        _ = try LocalSMSStore(file: file)
        let corrupt = Data("unreadable-history".utf8)
        try corrupt.write(to: file)
        XCTAssertThrowsError(try LocalSMSStore(file: file))
        XCTAssertEqual(try Data(contentsOf: file), corrupt)
    }
}
