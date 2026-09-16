import CoreLocation
import XCTest
@testable import CapgoBackgroundGeolocationPlugin

// swiftlint:disable:next type_body_length
final class PersistentTrackStoreTests: XCTestCase {
    // swiftlint:disable:next implicitly_unwrapped_optional
    private var directoryURL: URL!
    // swiftlint:disable:next implicitly_unwrapped_optional
    private var databaseURL: URL!
    // swiftlint:disable:next implicitly_unwrapped_optional
    private var store: PersistentTrackStore!

    override func setUpWithError() throws {
        directoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("persistent-track-\(UUID().uuidString)", isDirectory: true)
        databaseURL = directoryURL.appendingPathComponent("tracks.db")
        store = try PersistentTrackStore(databaseURL: databaseURL)
    }

    override func tearDownWithError() throws {
        store = nil
        if FileManager.default.fileExists(atPath: directoryURL.path) {
            try FileManager.default.removeItem(at: directoryURL)
        }
    }

    func testCreatesAndReattachesOneActiveSession() throws {
        let created = try store.startSession(sessionId: "session-1", maxPoints: 20, startedAt: 1_000)
        let reattached = try store.startSession(sessionId: "session-1", maxPoints: 999, startedAt: 2_000)

        XCTAssertEqual(created.state, "active")
        XCTAssertEqual(created.startedAt, 1_000)
        XCTAssertEqual(created.maxPoints, 20)
        XCTAssertEqual(reattached.startedAt, created.startedAt)
        XCTAssertEqual(reattached.maxPoints, created.maxPoints)

        XCTAssertStoreError("ACTIVE_SESSION_EXISTS") {
            _ = try store.startSession(sessionId: "session-2", maxPoints: 20, startedAt: 2_000)
        }
    }

    func testPersistsOrderedPagesAndNullableFieldsAcrossReopen() throws {
        try startSession()
        _ = try store.appendLocation(
            sessionId: "session-1",
            location: location(latitude: 44.1, longitude: 26.1, time: 10_000),
            persistedAt: 10_010
        )
        _ = try store.appendLocation(
            sessionId: "session-1",
            location: location(latitude: 44.2, longitude: 26.2, time: 20_000, accuracy: 5.5),
            persistedAt: 20_010
        )
        _ = try store.appendLocation(
            sessionId: "session-1",
            location: location(latitude: 44.3, longitude: 26.3, time: 30_000, accuracy: 7.5),
            persistedAt: 30_010
        )

        store = nil
        store = try PersistentTrackStore(databaseURL: databaseURL)

        let firstPage = try store.getPoints(sessionId: "session-1", afterSequence: 0, limit: 2)
        XCTAssertEqual(firstPage.points.map(\.sequence), [1, 2])
        XCTAssertEqual(firstPage.nextAfterSequence, 2)
        XCTAssertTrue(firstPage.hasMore)
        XCTAssertNil(firstPage.points[0].accuracy)
        XCTAssertEqual(firstPage.points[1].accuracy, 5.5)

        let secondPage = try store.getPoints(
            sessionId: "session-1",
            afterSequence: firstPage.nextAfterSequence,
            limit: 2
        )
        XCTAssertEqual(secondPage.points.map(\.sequence), [3])
        XCTAssertFalse(secondPage.hasMore)
        XCTAssertEqual(try store.getSession(sessionId: "session-1")?.queuedPointCount, 3)
    }

    func testAcknowledgementIsInclusiveIdempotentAndFreesCapacity() throws {
        _ = try store.startSession(sessionId: "session-1", maxPoints: 2, startedAt: 1_000)
        try append(latitude: 44.1, persistedAt: 10_010)
        try append(latitude: 44.2, persistedAt: 20_010)

        let first = try store.acknowledge(sessionId: "session-1", throughSequence: 1)
        XCTAssertEqual(first.deletedPointCount, 1)
        XCTAssertEqual(first.acknowledgedThrough, 1)

        let repeated = try store.acknowledge(sessionId: "session-1", throughSequence: 1)
        XCTAssertEqual(repeated.deletedPointCount, 0)
        XCTAssertEqual(repeated.acknowledgedThrough, 1)

        try append(latitude: 44.3, persistedAt: 30_010)
        let session = try XCTUnwrap(store.getSession(sessionId: "session-1"))
        XCTAssertEqual(session.lastSequence, 3)
        XCTAssertEqual(session.queuedPointCount, 2)
    }

    func testStopPreventsReopenAndResetIsRetrySafe() throws {
        try startSession()
        try append(latitude: 44.1, persistedAt: 10_010)
        let stopped = try store.stopSession(sessionId: "session-1", stoppedAt: 11_000)

        XCTAssertEqual(stopped.state, "stopped")
        XCTAssertEqual(stopped.stoppedAt, 11_000)
        XCTAssertNil(try store.getActiveSession())
        XCTAssertStoreError("SESSION_CLOSED") {
            _ = try store.startSession(sessionId: "session-1", maxPoints: 20, startedAt: 12_000)
        }
        XCTAssertEqual(try store.resetSession(sessionId: "session-1"), 1)
        XCTAssertNil(try store.getSession(sessionId: "session-1"))
        XCTAssertEqual(try store.resetSession(sessionId: "session-1"), 0)
    }

    func testListsStoppedSessionsNewestFirst() throws {
        _ = try store.startSession(sessionId: "older", maxPoints: 20, startedAt: 1_000)
        _ = try store.stopSession(sessionId: "older", stoppedAt: 2_000)
        _ = try store.startSession(sessionId: "newer", maxPoints: 20, startedAt: 3_000)
        _ = try store.stopSession(sessionId: "newer", stoppedAt: 4_000)

        XCTAssertEqual(try store.getSessions().map(\.sessionId), ["newer", "older"])
    }

    func testQueueOverflowFailsClosedWithoutDeletingPoints() throws {
        _ = try store.startSession(sessionId: "session-1", maxPoints: 2, startedAt: 1_000)
        try append(latitude: 44.1, persistedAt: 10_010)
        try append(latitude: 44.2, persistedAt: 20_010)
        let overflow = try store.appendLocation(
            sessionId: "session-1",
            location: location(latitude: 44.3, longitude: 26.3, time: 30_000, accuracy: 4),
            persistedAt: 30_010
        )

        XCTAssertTrue(overflow.overflowed)
        let session = try XCTUnwrap(store.getSession(sessionId: "session-1"))
        XCTAssertEqual(session.state, "overflowed")
        XCTAssertEqual(session.errorCode, "QUEUE_FULL")
        XCTAssertEqual(session.droppedPointCount, 1)
        XCTAssertEqual(session.queuedPointCount, 2)
        XCTAssertEqual(session.lastSequence, 2)
        XCTAssertNil(try store.getActiveSession())
        XCTAssertEqual(try store.getPoints(sessionId: "session-1", afterSequence: 0, limit: 10).points.count, 2)
    }

    func testInjectedWriteFailureRollsBackAndPreservesEarlierPoints() throws {
        try startSession()
        try append(latitude: 44.1, persistedAt: 10_010)
        store = nil
        store = try PersistentTrackStore(databaseURL: databaseURL) {
            throw PersistentTrackStoreError("PERSISTENCE_ERROR", "Injected write failure")
        }

        XCTAssertStoreError("PERSISTENCE_ERROR") {
            _ = try store.appendLocation(
                sessionId: "session-1",
                location: location(latitude: 44.2, longitude: 26.2, time: 20_000, accuracy: 4),
                persistedAt: 20_010
            )
        }
        try store.failSession(
            sessionId: "session-1",
            errorCode: "PERSISTENCE_ERROR",
            errorMessage: "Persistent track storage operation failed",
            stoppedAt: 20_020
        )

        let session = try XCTUnwrap(store.getSession(sessionId: "session-1"))
        XCTAssertEqual(session.state, "failed")
        XCTAssertEqual(session.lastSequence, 1)
        XCTAssertEqual(session.queuedPointCount, 1)
        XCTAssertEqual(session.droppedPointCount, 1)
    }

    func testConcurrentStopAndWriteHaveOneSerializedBoundary() throws {
        try startSession()
        try append(latitude: 44.1, persistedAt: 10_010)

        let group = DispatchGroup()
        let lock = NSLock()
        var appendSucceeded = false
        var appendError: Error?
        var stopError: Error?

        group.enter()
        DispatchQueue.global().async {
            defer { group.leave() }
            do {
                _ = try self.store.appendLocation(
                    sessionId: "session-1",
                    location: self.location(latitude: 44.2, longitude: 26.2, time: 20_000, accuracy: 4),
                    persistedAt: 20_010
                )
                lock.lock()
                appendSucceeded = true
                lock.unlock()
            } catch {
                lock.lock()
                appendError = error
                lock.unlock()
            }
        }
        group.enter()
        DispatchQueue.global().async {
            defer { group.leave() }
            do {
                _ = try self.store.stopSession(sessionId: "session-1", stoppedAt: 20_020)
            } catch {
                lock.lock()
                stopError = error
                lock.unlock()
            }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 5), .success)
        XCTAssertNil(stopError)
        if let appendError {
            XCTAssertEqual((appendError as? PersistentTrackStoreError)?.code, "SESSION_NOT_ACTIVE")
        }

        let session = try XCTUnwrap(store.getSession(sessionId: "session-1"))
        XCTAssertEqual(session.state, "stopped")
        XCTAssertEqual(session.lastSequence, appendSucceeded ? 2 : 1)
        XCTAssertStoreError("SESSION_NOT_ACTIVE") {
            try append(latitude: 44.3, persistedAt: 30_010)
        }
    }

    func testRejectsInvalidIdentifiersLimitsAndCursors() throws {
        XCTAssertStoreError("INVALID_SESSION_ID") {
            _ = try store.startSession(sessionId: "invalid session", maxPoints: 20, startedAt: 1_000)
        }
        try startSession()
        XCTAssertStoreError("INVALID_LIMIT") {
            _ = try store.getPoints(
                sessionId: "session-1",
                afterSequence: 0,
                limit: PersistentTrackStore.maxPageSize + 1
            )
        }
        XCTAssertStoreError("INVALID_CURSOR") {
            _ = try store.acknowledge(sessionId: "session-1", throughSequence: 1)
        }
    }

    private func startSession() throws {
        _ = try store.startSession(sessionId: "session-1", maxPoints: 20, startedAt: 1_000)
    }

    private func append(latitude: Double, persistedAt: Int64) throws {
        _ = try store.appendLocation(
            sessionId: "session-1",
            location: location(
                latitude: latitude,
                longitude: 26.1,
                time: persistedAt - 10,
                accuracy: 4
            ),
            persistedAt: persistedAt
        )
    }

    private func location(
        latitude: Double,
        longitude: Double,
        time: Int64,
        accuracy: Double? = nil
    ) -> CLLocation {
        CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
            altitude: 0,
            horizontalAccuracy: accuracy ?? -1,
            verticalAccuracy: -1,
            course: -1,
            speed: -1,
            timestamp: Date(timeIntervalSince1970: Double(time) / 1_000)
        )
    }

    private func XCTAssertStoreError(
        _ expectedCode: String,
        file: StaticString = #filePath,
        line: UInt = #line,
        operation: () throws -> Void
    ) {
        do {
            try operation()
            XCTFail("Expected \(expectedCode)", file: file, line: line)
        } catch let error as PersistentTrackStoreError {
            XCTAssertEqual(error.code, expectedCode, file: file, line: line)
        } catch {
            XCTFail("Unexpected error: \(error)", file: file, line: line)
        }
    }
}
