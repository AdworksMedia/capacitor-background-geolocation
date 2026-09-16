// swiftlint:disable file_length
import CoreLocation
import Foundation
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

struct PersistentTrackStoreError: Error, LocalizedError {
    let code: String
    let message: String
    let cause: Error?

    init(_ code: String, _ message: String, cause: Error? = nil) {
        self.code = code
        self.message = message
        self.cause = cause
    }

    var errorDescription: String? { message }
}

struct PersistentTrackSession {
    let sessionId: String
    let state: String
    let startedAt: Int64
    let stoppedAt: Int64?
    let lastSequence: Int64
    let acknowledgedThrough: Int64
    let queuedPointCount: Int
    let maxPoints: Int
    let lastPersistedAt: Int64?
    let droppedPointCount: Int
    let errorCode: String?
    let errorMessage: String?

    func toPluginData() -> [String: Any] {
        [
            "sessionId": sessionId,
            "state": state,
            "startedAt": startedAt,
            "stoppedAt": stoppedAt ?? NSNull(),
            "lastSequence": lastSequence,
            "acknowledgedThrough": acknowledgedThrough,
            "queuedPointCount": queuedPointCount,
            "maxPoints": maxPoints,
            "lastPersistedAt": lastPersistedAt ?? NSNull(),
            "droppedPointCount": droppedPointCount,
            "errorCode": errorCode ?? NSNull(),
            "errorMessage": errorMessage ?? NSNull()
        ]
    }
}

struct PersistentTrackPoint {
    let sessionId: String
    let sequence: Int64
    let latitude: Double
    let longitude: Double
    let accuracy: Double?
    let altitude: Double?
    let altitudeAccuracy: Double?
    let simulated: Bool
    let speed: Double?
    let bearing: Double?
    let providerTime: Int64?
    let persistedAt: Int64

    func toPluginData() -> [String: Any] {
        [
            "sessionId": sessionId,
            "sequence": sequence,
            "latitude": latitude,
            "longitude": longitude,
            "accuracy": accuracy ?? NSNull(),
            "altitude": altitude ?? NSNull(),
            "altitudeAccuracy": altitudeAccuracy ?? NSNull(),
            "simulated": simulated,
            "speed": speed ?? NSNull(),
            "bearing": bearing ?? NSNull(),
            "time": providerTime ?? NSNull(),
            "persistedAt": persistedAt
        ]
    }
}

struct PersistentTrackPointPage {
    let points: [PersistentTrackPoint]
    let nextAfterSequence: Int64?
    let hasMore: Bool

    func toPluginData() -> [String: Any] {
        [
            "points": points.map { $0.toPluginData() },
            "nextAfterSequence": nextAfterSequence ?? NSNull(),
            "hasMore": hasMore
        ]
    }
}

struct PersistentTrackAppendResult {
    let sequence: Int64?
    let overflowed: Bool
}

struct PersistentTrackAcknowledgeResult {
    let deletedPointCount: Int
    let acknowledgedThrough: Int64

    func toPluginData() -> [String: Any] {
        [
            "deletedPointCount": deletedPointCount,
            "acknowledgedThrough": acknowledgedThrough
        ]
    }
}

// swiftlint:disable:next type_body_length
final class PersistentTrackStore {
    static let defaultMaxPoints = 100_000
    static let minMaxPoints = 2
    static let maxMaxPoints = 1_000_000
    static let defaultPageSize = 1_000
    static let maxPageSize = 5_000

    private static let schemaVersion: Int32 = 1
    private static let sessionIdPattern = try? NSRegularExpression(pattern: "^[A-Za-z0-9._:-]{1,128}$")

    private let queue = DispatchQueue(label: "com.capgo.background-geolocation.persistent-track-store")
    private var database: OpaquePointer?
    private let beforePointInsert: (() throws -> Void)?

    init(databaseURL: URL, beforePointInsert: (() throws -> Void)? = nil) throws {
        self.beforePointInsert = beforePointInsert
        try FileManager.default.createDirectory(
            at: databaseURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        var openedDatabase: OpaquePointer?
        let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(databaseURL.path, &openedDatabase, flags, nil) == SQLITE_OK,
              let openedDatabase else {
            if let openedDatabase {
                sqlite3_close(openedDatabase)
            }
            throw PersistentTrackStoreError("PERSISTENCE_ERROR", "Persistent track storage operation failed")
        }
        database = openedDatabase

        do {
            try execute("PRAGMA foreign_keys = ON")
            sqlite3_busy_timeout(openedDatabase, 5_000)
            try migrateIfNeeded()
        } catch {
            sqlite3_close(openedDatabase)
            database = nil
            throw normalized(error)
        }
    }

    deinit {
        if let database {
            sqlite3_close(database)
        }
    }

    static func defaultDatabaseURL() -> URL {
        let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return applicationSupport
            .appendingPathComponent("CapgoBackgroundGeolocation", isDirectory: true)
            .appendingPathComponent("CapgoBackgroundGeolocationTracks.db", isDirectory: false)
    }

    func startSession(sessionId: String, maxPoints: Int, startedAt: Int64) throws -> PersistentTrackSession {
        try queue.sync {
            try validateSessionId(sessionId)
            try validateMaxPoints(maxPoints)
            return try transaction {
                if let active = try readActiveSession() {
                    if active.sessionId == sessionId {
                        return active
                    }
                    throw PersistentTrackStoreError(
                        "ACTIVE_SESSION_EXISTS",
                        "Another persistent track session is already active"
                    )
                }
                if try readSession(sessionId: sessionId) != nil {
                    throw PersistentTrackStoreError("SESSION_CLOSED", "Persistent track session cannot be reopened")
                }
                try execute(
                    """
                    INSERT INTO persistent_track_sessions(session_id, state, started_at, max_points)
                    VALUES (?, 'active', ?, ?)
                    """,
                    bindings: [.text(sessionId), .int64(startedAt), .int64(Int64(maxPoints))]
                )
                guard let session = try readSession(sessionId: sessionId) else {
                    throw PersistentTrackStoreError("PERSISTENCE_ERROR", "Persistent track storage operation failed")
                }
                return session
            }
        }
    }

    // swiftlint:disable:next function_body_length
    func appendLocation(sessionId: String, location: CLLocation, persistedAt: Int64) throws -> PersistentTrackAppendResult {
        try queue.sync {
            try validateSessionId(sessionId)
            try validateLocation(location)
            return try transaction {
                guard let session = try readSession(sessionId: sessionId), session.state == "active" else {
                    throw PersistentTrackStoreError("SESSION_NOT_ACTIVE", "Persistent track session is not active")
                }

                if session.queuedPointCount >= session.maxPoints {
                    try execute(
                        """
                        UPDATE persistent_track_sessions
                        SET state = 'overflowed', stopped_at = ?, dropped_point_count = dropped_point_count + 1,
                            error_code = 'QUEUE_FULL',
                            error_message = 'Persistent track queue reached its configured point limit'
                        WHERE session_id = ?
                        """,
                        bindings: [.int64(persistedAt), .text(sessionId)]
                    )
                    return PersistentTrackAppendResult(sequence: nil, overflowed: true)
                }

                let sequence = session.lastSequence + 1
                try beforePointInsert?()
                try execute(
                    """
                    INSERT INTO persistent_track_points(
                        session_id, sequence, latitude, longitude, accuracy, altitude, altitude_accuracy,
                        simulated, speed, bearing, provider_time, persisted_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    bindings: [
                        .text(sessionId),
                        .int64(sequence),
                        .double(location.coordinate.latitude),
                        .double(location.coordinate.longitude),
                        nullableDouble(location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : nil),
                        nullableDouble(location.verticalAccuracy >= 0 ? location.altitude : nil),
                        nullableDouble(location.verticalAccuracy >= 0 ? location.verticalAccuracy : nil),
                        .int64(isSimulated(location) ? 1 : 0),
                        nullableDouble(location.speed >= 0 ? location.speed : nil),
                        nullableDouble(location.course >= 0 ? location.course : nil),
                        .int64(Int64(location.timestamp.timeIntervalSince1970 * 1_000)),
                        .int64(persistedAt)
                    ]
                )
                try execute(
                    """
                    UPDATE persistent_track_sessions
                    SET last_sequence = ?, last_persisted_at = ?, queued_point_count = queued_point_count + 1
                    WHERE session_id = ?
                    """,
                    bindings: [.int64(sequence), .int64(persistedAt), .text(sessionId)]
                )
                return PersistentTrackAppendResult(sequence: sequence, overflowed: false)
            }
        }
    }

    func failSession(sessionId: String, errorCode: String, errorMessage: String, stoppedAt: Int64) throws {
        try queue.sync {
            try validateSessionId(sessionId)
            try transaction {
                try execute(
                    """
                    UPDATE persistent_track_sessions
                    SET state = 'failed', stopped_at = ?, dropped_point_count = dropped_point_count + 1,
                        error_code = ?, error_message = ?
                    WHERE session_id = ? AND state = 'active'
                    """,
                    bindings: [.int64(stoppedAt), .text(errorCode), .text(errorMessage), .text(sessionId)]
                )
            }
        }
    }

    func stopSession(sessionId: String, stoppedAt: Int64) throws -> PersistentTrackSession {
        try queue.sync {
            try validateSessionId(sessionId)
            return try transaction {
                guard var session = try readSession(sessionId: sessionId) else {
                    throw PersistentTrackStoreError("SESSION_NOT_FOUND", "Persistent track session was not found")
                }
                if session.state == "active" {
                    try execute(
                        "UPDATE persistent_track_sessions SET state = 'stopped', stopped_at = ? WHERE session_id = ?",
                        bindings: [.int64(stoppedAt), .text(sessionId)]
                    )
                    guard let updated = try readSession(sessionId: sessionId) else {
                        throw PersistentTrackStoreError("PERSISTENCE_ERROR", "Persistent track storage operation failed")
                    }
                    session = updated
                }
                return session
            }
        }
    }

    func getActiveSession() throws -> PersistentTrackSession? {
        try queue.sync { try readActiveSession() }
    }

    func getSession(sessionId: String) throws -> PersistentTrackSession? {
        try queue.sync {
            try validateSessionId(sessionId)
            return try readSession(sessionId: sessionId)
        }
    }

    func getSessions() throws -> [PersistentTrackSession] {
        try queue.sync {
            let statement = try prepare(sessionSelect + " ORDER BY started_at DESC, session_id ASC")
            defer { sqlite3_finalize(statement) }
            var sessions: [PersistentTrackSession] = []
            var result = sqlite3_step(statement)
            while result == SQLITE_ROW {
                sessions.append(readSession(statement))
                result = sqlite3_step(statement)
            }
            guard result == SQLITE_DONE else { throw databaseError() }
            return sessions
        }
    }

    func getPoints(sessionId: String, afterSequence: Int64?, limit: Int) throws -> PersistentTrackPointPage {
        try queue.sync {
            try validateSessionId(sessionId)
            try validatePageSize(limit)
            return try transaction {
                guard let session = try readSession(sessionId: sessionId) else {
                    throw PersistentTrackStoreError("SESSION_NOT_FOUND", "Persistent track session was not found")
                }
                let cursor = afterSequence ?? session.acknowledgedThrough
                guard cursor >= 0 else {
                    throw PersistentTrackStoreError("INVALID_CURSOR", "afterSequence must be a non-negative integer")
                }
                let statement = try prepare(
                    """
                    SELECT session_id, sequence, latitude, longitude, accuracy, altitude, altitude_accuracy,
                           simulated, speed, bearing, provider_time, persisted_at
                    FROM persistent_track_points
                    WHERE session_id = ? AND sequence > ?
                    ORDER BY sequence ASC
                    LIMIT ?
                    """,
                    bindings: [.text(sessionId), .int64(cursor), .int64(Int64(limit + 1))]
                )
                defer { sqlite3_finalize(statement) }
                var points: [PersistentTrackPoint] = []
                var result = sqlite3_step(statement)
                while result == SQLITE_ROW {
                    points.append(readPoint(statement))
                    result = sqlite3_step(statement)
                }
                guard result == SQLITE_DONE else { throw databaseError() }
                let hasMore = points.count > limit
                if hasMore {
                    points.removeLast()
                }
                return PersistentTrackPointPage(
                    points: points,
                    nextAfterSequence: points.last?.sequence,
                    hasMore: hasMore
                )
            }
        }
    }

    func acknowledge(sessionId: String, throughSequence: Int64) throws -> PersistentTrackAcknowledgeResult {
        try queue.sync {
            try validateSessionId(sessionId)
            guard throughSequence >= 0 else {
                throw PersistentTrackStoreError("INVALID_CURSOR", "throughSequence must be a non-negative integer")
            }
            return try transaction {
                guard let session = try readSession(sessionId: sessionId) else {
                    throw PersistentTrackStoreError("SESSION_NOT_FOUND", "Persistent track session was not found")
                }
                guard throughSequence <= session.lastSequence else {
                    throw PersistentTrackStoreError(
                        "INVALID_CURSOR",
                        "throughSequence exceeds the last persisted sequence"
                    )
                }
                try execute(
                    "DELETE FROM persistent_track_points WHERE session_id = ? AND sequence <= ?",
                    bindings: [.text(sessionId), .int64(throughSequence)]
                )
                let deleted = Int(sqlite3_changes(database))
                let acknowledgedThrough = max(session.acknowledgedThrough, throughSequence)
                if acknowledgedThrough != session.acknowledgedThrough || deleted > 0 {
                    try execute(
                        """
                        UPDATE persistent_track_sessions
                        SET acknowledged_through = ?, queued_point_count = MAX(0, queued_point_count - ?)
                        WHERE session_id = ?
                        """,
                        bindings: [.int64(acknowledgedThrough), .int64(Int64(deleted)), .text(sessionId)]
                    )
                }
                return PersistentTrackAcknowledgeResult(
                    deletedPointCount: deleted,
                    acknowledgedThrough: acknowledgedThrough
                )
            }
        }
    }

    func resetSession(sessionId: String) throws -> Int {
        try queue.sync {
            try validateSessionId(sessionId)
            return try transaction {
                guard let session = try readSession(sessionId: sessionId) else { return 0 }
                guard session.state != "active" else {
                    throw PersistentTrackStoreError(
                        "SESSION_ACTIVE",
                        "Active persistent track session must be stopped before deletion"
                    )
                }
                try execute(
                    "DELETE FROM persistent_track_sessions WHERE session_id = ?",
                    bindings: [.text(sessionId)]
                )
                return session.queuedPointCount
            }
        }
    }

    // swiftlint:disable:next function_body_length
    private func migrateIfNeeded() throws {
        let version: Int32
        do {
            let statement = try prepare("PRAGMA user_version")
            defer { sqlite3_finalize(statement) }
            guard sqlite3_step(statement) == SQLITE_ROW else {
                throw databaseError()
            }
            version = sqlite3_column_int(statement, 0)
        }
        if version == Self.schemaVersion { return }
        guard version == 0 else {
            throw PersistentTrackStoreError(
                "PERSISTENCE_ERROR",
                "Unsupported persistent track schema upgrade from \(version) to \(Self.schemaVersion)"
            )
        }

        try transaction {
            try execute(
                """
                CREATE TABLE persistent_track_sessions (
                    session_id TEXT PRIMARY KEY NOT NULL,
                    state TEXT NOT NULL,
                    started_at INTEGER NOT NULL,
                    stopped_at INTEGER,
                    last_sequence INTEGER NOT NULL DEFAULT 0,
                    acknowledged_through INTEGER NOT NULL DEFAULT 0,
                    queued_point_count INTEGER NOT NULL DEFAULT 0,
                    max_points INTEGER NOT NULL,
                    last_persisted_at INTEGER,
                    dropped_point_count INTEGER NOT NULL DEFAULT 0,
                    error_code TEXT,
                    error_message TEXT
                )
                """
            )
            try execute(
                """
                CREATE UNIQUE INDEX one_active_persistent_track
                ON persistent_track_sessions(state) WHERE state = 'active'
                """
            )
            try execute(
                """
                CREATE TABLE persistent_track_points (
                    session_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    latitude REAL NOT NULL,
                    longitude REAL NOT NULL,
                    accuracy REAL,
                    altitude REAL,
                    altitude_accuracy REAL,
                    simulated INTEGER NOT NULL,
                    speed REAL,
                    bearing REAL,
                    provider_time INTEGER,
                    persisted_at INTEGER NOT NULL,
                    PRIMARY KEY (session_id, sequence),
                    FOREIGN KEY (session_id) REFERENCES persistent_track_sessions(session_id) ON DELETE CASCADE
                )
                """
            )
            try execute("PRAGMA user_version = 1")
        }
    }

    private var sessionSelect: String {
        """
        SELECT session_id, state, started_at, stopped_at, last_sequence, acknowledged_through,
               queued_point_count, max_points, last_persisted_at, dropped_point_count, error_code, error_message
        FROM persistent_track_sessions
        """
    }

    private func readActiveSession() throws -> PersistentTrackSession? {
        let statement = try prepare(sessionSelect + " WHERE state = 'active' LIMIT 1")
        defer { sqlite3_finalize(statement) }
        let result = sqlite3_step(statement)
        if result == SQLITE_ROW { return readSession(statement) }
        guard result == SQLITE_DONE else { throw databaseError() }
        return nil
    }

    private func readSession(sessionId: String) throws -> PersistentTrackSession? {
        let statement = try prepare(
            sessionSelect + " WHERE session_id = ? LIMIT 1",
            bindings: [.text(sessionId)]
        )
        defer { sqlite3_finalize(statement) }
        let result = sqlite3_step(statement)
        if result == SQLITE_ROW { return readSession(statement) }
        guard result == SQLITE_DONE else { throw databaseError() }
        return nil
    }

    private func readSession(_ statement: OpaquePointer?) -> PersistentTrackSession {
        PersistentTrackSession(
            sessionId: string(statement, 0) ?? "",
            state: string(statement, 1) ?? "",
            startedAt: sqlite3_column_int64(statement, 2),
            stoppedAt: int64(statement, 3),
            lastSequence: sqlite3_column_int64(statement, 4),
            acknowledgedThrough: sqlite3_column_int64(statement, 5),
            queuedPointCount: Int(sqlite3_column_int64(statement, 6)),
            maxPoints: Int(sqlite3_column_int64(statement, 7)),
            lastPersistedAt: int64(statement, 8),
            droppedPointCount: Int(sqlite3_column_int64(statement, 9)),
            errorCode: string(statement, 10),
            errorMessage: string(statement, 11)
        )
    }

    private func readPoint(_ statement: OpaquePointer?) -> PersistentTrackPoint {
        PersistentTrackPoint(
            sessionId: string(statement, 0) ?? "",
            sequence: sqlite3_column_int64(statement, 1),
            latitude: sqlite3_column_double(statement, 2),
            longitude: sqlite3_column_double(statement, 3),
            accuracy: double(statement, 4),
            altitude: double(statement, 5),
            altitudeAccuracy: double(statement, 6),
            simulated: sqlite3_column_int(statement, 7) != 0,
            speed: double(statement, 8),
            bearing: double(statement, 9),
            providerTime: int64(statement, 10),
            persistedAt: sqlite3_column_int64(statement, 11)
        )
    }

    private func validateSessionId(_ sessionId: String) throws {
        let range = NSRange(sessionId.startIndex..., in: sessionId)
        guard Self.sessionIdPattern?.firstMatch(in: sessionId, range: range)?.range == range else {
            throw PersistentTrackStoreError(
                "INVALID_SESSION_ID",
                "sessionId must match [A-Za-z0-9._:-]{1,128}"
            )
        }
    }

    private func validateMaxPoints(_ maxPoints: Int) throws {
        guard (Self.minMaxPoints...Self.maxMaxPoints).contains(maxPoints) else {
            throw PersistentTrackStoreError(
                "INVALID_MAX_POINTS",
                "maxPoints must be between \(Self.minMaxPoints) and \(Self.maxMaxPoints)"
            )
        }
    }

    private func validatePageSize(_ limit: Int) throws {
        guard (1...Self.maxPageSize).contains(limit) else {
            throw PersistentTrackStoreError("INVALID_LIMIT", "limit must be between 1 and \(Self.maxPageSize)")
        }
    }

    private func validateLocation(_ location: CLLocation) throws {
        let coordinate = location.coordinate
        guard coordinate.latitude.isFinite,
              (-90...90).contains(coordinate.latitude),
              coordinate.longitude.isFinite,
              (-180...180).contains(coordinate.longitude) else {
            throw PersistentTrackStoreError("INVALID_LOCATION", "Native provider returned invalid coordinates")
        }
    }

    private func transaction<T>(_ body: () throws -> T) throws -> T {
        do {
            try execute("BEGIN IMMEDIATE")
            let result = try body()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw normalized(error)
        }
    }

    private enum Binding {
        case int64(Int64)
        case double(Double)
        case text(String)
        case null
    }

    private func prepare(_ sql: String, bindings: [Binding] = []) throws -> OpaquePointer? {
        guard let database else { throw databaseError() }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
            throw databaseError()
        }
        do {
            for (offset, binding) in bindings.enumerated() {
                let index = Int32(offset + 1)
                let result: Int32
                switch binding {
                case .int64(let value):
                    result = sqlite3_bind_int64(statement, index, value)
                case .double(let value):
                    result = sqlite3_bind_double(statement, index, value)
                case .text(let value):
                    result = sqlite3_bind_text(statement, index, value, -1, sqliteTransient)
                case .null:
                    result = sqlite3_bind_null(statement, index)
                }
                guard result == SQLITE_OK else { throw databaseError() }
            }
            return statement
        } catch {
            sqlite3_finalize(statement)
            throw error
        }
    }

    private func execute(_ sql: String, bindings: [Binding] = []) throws {
        let statement = try prepare(sql, bindings: bindings)
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw databaseError() }
    }

    private func databaseError() -> PersistentTrackStoreError {
        let message = database.flatMap { sqlite3_errmsg($0) }.map { String(cString: $0) }
        return PersistentTrackStoreError(
            "PERSISTENCE_ERROR",
            "Persistent track storage operation failed",
            cause: message.map { NSError(domain: "SQLite3", code: Int(sqlite3_errcode(database)), userInfo: [
                NSLocalizedDescriptionKey: $0
            ]) }
        )
    }

    private func normalized(_ error: Error) -> PersistentTrackStoreError {
        if let error = error as? PersistentTrackStoreError { return error }
        return PersistentTrackStoreError(
            "PERSISTENCE_ERROR",
            "Persistent track storage operation failed",
            cause: error
        )
    }

    private func nullableDouble(_ value: Double?) -> Binding {
        guard let value, value.isFinite else { return .null }
        return .double(value)
    }

    private func string(_ statement: OpaquePointer?, _ index: Int32) -> String? {
        guard sqlite3_column_type(statement, index) != SQLITE_NULL,
              let value = sqlite3_column_text(statement, index) else { return nil }
        return String(cString: value)
    }

    private func int64(_ statement: OpaquePointer?, _ index: Int32) -> Int64? {
        sqlite3_column_type(statement, index) == SQLITE_NULL ? nil : sqlite3_column_int64(statement, index)
    }

    private func double(_ statement: OpaquePointer?, _ index: Int32) -> Double? {
        sqlite3_column_type(statement, index) == SQLITE_NULL ? nil : sqlite3_column_double(statement, index)
    }

    private func isSimulated(_ location: CLLocation) -> Bool {
        if #available(iOS 15, *) {
            return location.sourceInformation?.isSimulatedBySoftware ?? false
        }
        return false
    }
}
