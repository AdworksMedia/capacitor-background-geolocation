package com.capgo.capacitor_background_geolocation;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import android.database.sqlite.SQLiteOpenHelper;
import android.location.Location;
import androidx.core.location.LocationCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import org.json.JSONObject;

final class PersistentTrackStore extends SQLiteOpenHelper {

    static final int DEFAULT_MAX_POINTS = 100_000;
    static final int MIN_MAX_POINTS = 2;
    static final int MAX_MAX_POINTS = 1_000_000;
    static final int DEFAULT_PAGE_SIZE = 1_000;
    static final int MAX_PAGE_SIZE = 5_000;

    private static final String DATABASE_NAME = "CapgoBackgroundGeolocationTracks.db";
    private static final int DATABASE_VERSION = 1;
    private static final Pattern SESSION_ID_PATTERN = Pattern.compile("^[A-Za-z0-9._:-]{1,128}$");
    private static volatile PersistentTrackStore instance;
    private final PointInsertHook pointInsertHook;

    static PersistentTrackStore getInstance(Context context) {
        if (instance == null) {
            synchronized (PersistentTrackStore.class) {
                if (instance == null) {
                    instance = new PersistentTrackStore(context.getApplicationContext(), DATABASE_NAME);
                }
            }
        }
        return instance;
    }

    PersistentTrackStore(Context context, String databaseName) {
        this(context, databaseName, null);
    }

    PersistentTrackStore(Context context, String databaseName, PointInsertHook pointInsertHook) {
        super(context.getApplicationContext(), databaseName, null, DATABASE_VERSION);
        this.pointInsertHook = pointInsertHook;
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.setForeignKeyConstraintsEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(
            "CREATE TABLE persistent_track_sessions (" +
                "session_id TEXT PRIMARY KEY NOT NULL," +
                "state TEXT NOT NULL," +
                "started_at INTEGER NOT NULL," +
                "stopped_at INTEGER," +
                "last_sequence INTEGER NOT NULL DEFAULT 0," +
                "acknowledged_through INTEGER NOT NULL DEFAULT 0," +
                "queued_point_count INTEGER NOT NULL DEFAULT 0," +
                "max_points INTEGER NOT NULL," +
                "last_persisted_at INTEGER," +
                "dropped_point_count INTEGER NOT NULL DEFAULT 0," +
                "error_code TEXT," +
                "error_message TEXT" +
                ")"
        );
        db.execSQL("CREATE UNIQUE INDEX one_active_persistent_track " + "ON persistent_track_sessions(state) WHERE state = 'active'");
        db.execSQL(
            "CREATE TABLE persistent_track_points (" +
                "session_id TEXT NOT NULL," +
                "sequence INTEGER NOT NULL," +
                "latitude REAL NOT NULL," +
                "longitude REAL NOT NULL," +
                "accuracy REAL," +
                "altitude REAL," +
                "altitude_accuracy REAL," +
                "simulated INTEGER NOT NULL," +
                "speed REAL," +
                "bearing REAL," +
                "provider_time INTEGER," +
                "persisted_at INTEGER NOT NULL," +
                "PRIMARY KEY (session_id, sequence)," +
                "FOREIGN KEY (session_id) REFERENCES persistent_track_sessions(session_id) ON DELETE CASCADE" +
                ")"
        );
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new SQLiteException("Unsupported persistent track schema upgrade from " + oldVersion + " to " + newVersion);
    }

    synchronized Session startSession(String sessionId, int maxPoints, long startedAt) throws StoreException {
        validateSessionId(sessionId);
        validateMaxPoints(maxPoints);
        SQLiteDatabase db = null;
        try {
            db = getWritableDatabase();
            db.beginTransaction();
            Session active = readActiveSession(db);
            if (active != null) {
                if (active.sessionId.equals(sessionId)) {
                    db.setTransactionSuccessful();
                    return active;
                }
                throw new StoreException("ACTIVE_SESSION_EXISTS", "Another persistent track session is already active");
            }

            Session existing = readSession(db, sessionId);
            if (existing != null) {
                throw new StoreException("SESSION_CLOSED", "Persistent track session cannot be reopened");
            }

            ContentValues values = new ContentValues();
            values.put("session_id", sessionId);
            values.put("state", "active");
            values.put("started_at", startedAt);
            values.put("max_points", maxPoints);
            db.insertOrThrow("persistent_track_sessions", null, values);
            Session created = readSession(db, sessionId);
            db.setTransactionSuccessful();
            return created;
        } catch (StoreException exception) {
            throw exception;
        } catch (SQLiteException exception) {
            throw persistenceException(exception);
        } finally {
            if (db != null && db.inTransaction()) {
                db.endTransaction();
            }
        }
    }

    synchronized AppendResult appendLocation(String sessionId, Location location, long persistedAt) throws StoreException {
        validateSessionId(sessionId);
        validateLocation(location);
        SQLiteDatabase db = null;
        try {
            db = getWritableDatabase();
            db.beginTransaction();
            Session session = readSession(db, sessionId);
            if (session == null || !"active".equals(session.state)) {
                throw new StoreException("SESSION_NOT_ACTIVE", "Persistent track session is not active");
            }

            if (session.queuedPointCount >= session.maxPoints) {
                ContentValues overflow = new ContentValues();
                overflow.put("state", "overflowed");
                overflow.put("stopped_at", persistedAt);
                overflow.put("dropped_point_count", session.droppedPointCount + 1);
                overflow.put("error_code", "QUEUE_FULL");
                overflow.put("error_message", "Persistent track queue reached its configured point limit");
                db.update("persistent_track_sessions", overflow, "session_id = ?", new String[] { sessionId });
                db.setTransactionSuccessful();
                return AppendResult.overflowed();
            }

            long sequence = session.lastSequence + 1;
            ContentValues point = new ContentValues();
            point.put("session_id", sessionId);
            point.put("sequence", sequence);
            point.put("latitude", location.getLatitude());
            point.put("longitude", location.getLongitude());
            putNullable(point, "accuracy", location.hasAccuracy(), location.getAccuracy());
            putNullable(point, "altitude", location.hasAltitude(), location.getAltitude());
            putNullable(
                point,
                "altitude_accuracy",
                android.os.Build.VERSION.SDK_INT >= 26 && location.hasVerticalAccuracy(),
                android.os.Build.VERSION.SDK_INT >= 26 ? location.getVerticalAccuracyMeters() : 0
            );
            point.put("simulated", LocationCompat.isMock(location) ? 1 : 0);
            putNullable(point, "speed", location.hasSpeed(), location.getSpeed());
            putNullable(point, "bearing", location.hasBearing(), location.getBearing());
            point.put("provider_time", location.getTime());
            point.put("persisted_at", persistedAt);
            if (pointInsertHook != null) {
                pointInsertHook.beforeInsert(db);
            }
            db.insertOrThrow("persistent_track_points", null, point);

            ContentValues sessionUpdate = new ContentValues();
            sessionUpdate.put("last_sequence", sequence);
            sessionUpdate.put("last_persisted_at", persistedAt);
            sessionUpdate.put("queued_point_count", session.queuedPointCount + 1);
            db.update("persistent_track_sessions", sessionUpdate, "session_id = ?", new String[] { sessionId });
            db.setTransactionSuccessful();
            return AppendResult.appended(sequence);
        } catch (StoreException exception) {
            throw exception;
        } catch (SQLiteException exception) {
            throw persistenceException(exception);
        } finally {
            if (db != null && db.inTransaction()) {
                db.endTransaction();
            }
        }
    }

    synchronized void failSession(String sessionId, String errorCode, String errorMessage, long stoppedAt) throws StoreException {
        validateSessionId(sessionId);
        SQLiteDatabase db = null;
        try {
            db = getWritableDatabase();
            db.beginTransaction();
            Session session = readSession(db, sessionId);
            if (session != null && "active".equals(session.state)) {
                ContentValues values = new ContentValues();
                values.put("state", "failed");
                values.put("stopped_at", stoppedAt);
                values.put("dropped_point_count", session.droppedPointCount + 1);
                values.put("error_code", errorCode);
                values.put("error_message", errorMessage);
                db.update("persistent_track_sessions", values, "session_id = ?", new String[] { sessionId });
            }
            db.setTransactionSuccessful();
        } catch (SQLiteException exception) {
            throw persistenceException(exception);
        } finally {
            if (db != null && db.inTransaction()) {
                db.endTransaction();
            }
        }
    }

    synchronized Session stopSession(String sessionId, long stoppedAt) throws StoreException {
        validateSessionId(sessionId);
        SQLiteDatabase db = null;
        try {
            db = getWritableDatabase();
            db.beginTransaction();
            Session session = readSession(db, sessionId);
            if (session == null) {
                throw new StoreException("SESSION_NOT_FOUND", "Persistent track session was not found");
            }
            if ("active".equals(session.state)) {
                ContentValues values = new ContentValues();
                values.put("state", "stopped");
                values.put("stopped_at", stoppedAt);
                db.update("persistent_track_sessions", values, "session_id = ?", new String[] { sessionId });
                session = readSession(db, sessionId);
            }
            db.setTransactionSuccessful();
            return session;
        } catch (StoreException exception) {
            throw exception;
        } catch (SQLiteException exception) {
            throw persistenceException(exception);
        } finally {
            if (db != null && db.inTransaction()) {
                db.endTransaction();
            }
        }
    }

    synchronized Session getActiveSession() throws StoreException {
        try {
            return readActiveSession(getReadableDatabase());
        } catch (SQLiteException exception) {
            throw persistenceException(exception);
        }
    }

    synchronized Session getSession(String sessionId) throws StoreException {
        validateSessionId(sessionId);
        try {
            return readSession(getReadableDatabase(), sessionId);
        } catch (SQLiteException exception) {
            throw persistenceException(exception);
        }
    }

    synchronized List<Session> getSessions() throws StoreException {
        List<Session> sessions = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().rawQuery(sessionSelect() + " ORDER BY s.started_at DESC, s.session_id ASC", null)) {
            while (cursor.moveToNext()) {
                sessions.add(readSession(cursor));
            }
            return sessions;
        } catch (SQLiteException exception) {
            throw persistenceException(exception);
        }
    }

    synchronized PointPage getPoints(String sessionId, Long requestedAfterSequence, int limit) throws StoreException {
        validateSessionId(sessionId);
        validatePageSize(limit);
        SQLiteDatabase db = null;
        try {
            db = getReadableDatabase();
            db.beginTransaction();
            Session session = readSession(db, sessionId);
            if (session == null) {
                throw new StoreException("SESSION_NOT_FOUND", "Persistent track session was not found");
            }
            long afterSequence = requestedAfterSequence == null ? session.acknowledgedThrough : requestedAfterSequence;
            if (afterSequence < 0) {
                throw new StoreException("INVALID_CURSOR", "afterSequence must be a non-negative integer");
            }

            List<Point> points = new ArrayList<>();
            boolean hasMore = false;
            try (
                Cursor cursor = db.query(
                    "persistent_track_points",
                    null,
                    "session_id = ? AND sequence > ?",
                    new String[] { sessionId, String.valueOf(afterSequence) },
                    null,
                    null,
                    "sequence ASC",
                    String.valueOf(limit + 1)
                )
            ) {
                while (cursor.moveToNext()) {
                    if (points.size() == limit) {
                        hasMore = true;
                        break;
                    }
                    points.add(readPoint(cursor));
                }
            }
            db.setTransactionSuccessful();
            Long nextAfterSequence = points.isEmpty() ? null : points.get(points.size() - 1).sequence;
            return new PointPage(points, nextAfterSequence, hasMore);
        } catch (StoreException exception) {
            throw exception;
        } catch (SQLiteException exception) {
            throw persistenceException(exception);
        } finally {
            if (db != null && db.inTransaction()) {
                db.endTransaction();
            }
        }
    }

    synchronized AcknowledgeResult acknowledge(String sessionId, long throughSequence) throws StoreException {
        validateSessionId(sessionId);
        if (throughSequence < 0) {
            throw new StoreException("INVALID_CURSOR", "throughSequence must be a non-negative integer");
        }
        SQLiteDatabase db = null;
        try {
            db = getWritableDatabase();
            db.beginTransaction();
            Session session = readSession(db, sessionId);
            if (session == null) {
                throw new StoreException("SESSION_NOT_FOUND", "Persistent track session was not found");
            }
            if (throughSequence > session.lastSequence) {
                throw new StoreException("INVALID_CURSOR", "throughSequence exceeds the last persisted sequence");
            }
            int deleted = db.delete(
                "persistent_track_points",
                "session_id = ? AND sequence <= ?",
                new String[] { sessionId, String.valueOf(throughSequence) }
            );
            long acknowledgedThrough = Math.max(session.acknowledgedThrough, throughSequence);
            if (acknowledgedThrough != session.acknowledgedThrough || deleted > 0) {
                ContentValues values = new ContentValues();
                values.put("acknowledged_through", acknowledgedThrough);
                values.put("queued_point_count", Math.max(0, session.queuedPointCount - deleted));
                db.update("persistent_track_sessions", values, "session_id = ?", new String[] { sessionId });
            }
            db.setTransactionSuccessful();
            return new AcknowledgeResult(deleted, acknowledgedThrough);
        } catch (StoreException exception) {
            throw exception;
        } catch (SQLiteException exception) {
            throw persistenceException(exception);
        } finally {
            if (db != null && db.inTransaction()) {
                db.endTransaction();
            }
        }
    }

    synchronized int resetSession(String sessionId) throws StoreException {
        validateSessionId(sessionId);
        SQLiteDatabase db = null;
        try {
            db = getWritableDatabase();
            db.beginTransaction();
            Session session = readSession(db, sessionId);
            if (session == null) {
                db.setTransactionSuccessful();
                return 0;
            }
            if ("active".equals(session.state)) {
                throw new StoreException("SESSION_ACTIVE", "Active persistent track session must be stopped before deletion");
            }
            int pointCount = session.queuedPointCount;
            db.delete("persistent_track_sessions", "session_id = ?", new String[] { sessionId });
            db.setTransactionSuccessful();
            return pointCount;
        } catch (StoreException exception) {
            throw exception;
        } catch (SQLiteException exception) {
            throw persistenceException(exception);
        } finally {
            if (db != null && db.inTransaction()) {
                db.endTransaction();
            }
        }
    }

    private static Session readActiveSession(SQLiteDatabase db) {
        try (Cursor cursor = db.rawQuery(sessionSelect() + " WHERE s.state = 'active' LIMIT 1", null)) {
            return cursor.moveToFirst() ? readSession(cursor) : null;
        }
    }

    private static Session readSession(SQLiteDatabase db, String sessionId) {
        try (Cursor cursor = db.rawQuery(sessionSelect() + " WHERE s.session_id = ? LIMIT 1", new String[] { sessionId })) {
            return cursor.moveToFirst() ? readSession(cursor) : null;
        }
    }

    private static String sessionSelect() {
        return (
            "SELECT s.session_id, s.state, s.started_at, s.stopped_at, s.last_sequence, " +
            "s.acknowledged_through, s.queued_point_count, s.max_points, s.last_persisted_at, " +
            "s.dropped_point_count, s.error_code, s.error_message " +
            "FROM persistent_track_sessions s"
        );
    }

    private static Session readSession(Cursor cursor) {
        return new Session(
            cursor.getString(cursor.getColumnIndexOrThrow("session_id")),
            cursor.getString(cursor.getColumnIndexOrThrow("state")),
            cursor.getLong(cursor.getColumnIndexOrThrow("started_at")),
            nullableLong(cursor, "stopped_at"),
            cursor.getLong(cursor.getColumnIndexOrThrow("last_sequence")),
            cursor.getLong(cursor.getColumnIndexOrThrow("acknowledged_through")),
            cursor.getInt(cursor.getColumnIndexOrThrow("queued_point_count")),
            cursor.getInt(cursor.getColumnIndexOrThrow("max_points")),
            nullableLong(cursor, "last_persisted_at"),
            cursor.getInt(cursor.getColumnIndexOrThrow("dropped_point_count")),
            nullableString(cursor, "error_code"),
            nullableString(cursor, "error_message")
        );
    }

    private static Point readPoint(Cursor cursor) {
        return new Point(
            cursor.getString(cursor.getColumnIndexOrThrow("session_id")),
            cursor.getLong(cursor.getColumnIndexOrThrow("sequence")),
            cursor.getDouble(cursor.getColumnIndexOrThrow("latitude")),
            cursor.getDouble(cursor.getColumnIndexOrThrow("longitude")),
            nullableDouble(cursor, "accuracy"),
            nullableDouble(cursor, "altitude"),
            nullableDouble(cursor, "altitude_accuracy"),
            cursor.getInt(cursor.getColumnIndexOrThrow("simulated")) != 0,
            nullableDouble(cursor, "speed"),
            nullableDouble(cursor, "bearing"),
            nullableLong(cursor, "provider_time"),
            cursor.getLong(cursor.getColumnIndexOrThrow("persisted_at"))
        );
    }

    private static void validateSessionId(String sessionId) throws StoreException {
        if (sessionId == null || !SESSION_ID_PATTERN.matcher(sessionId).matches()) {
            throw new StoreException("INVALID_SESSION_ID", "sessionId must match [A-Za-z0-9._:-]{1,128}");
        }
    }

    private static void validateMaxPoints(int maxPoints) throws StoreException {
        if (maxPoints < MIN_MAX_POINTS || maxPoints > MAX_MAX_POINTS) {
            throw new StoreException("INVALID_MAX_POINTS", "maxPoints must be between " + MIN_MAX_POINTS + " and " + MAX_MAX_POINTS);
        }
    }

    private static void validatePageSize(int limit) throws StoreException {
        if (limit < 1 || limit > MAX_PAGE_SIZE) {
            throw new StoreException("INVALID_LIMIT", "limit must be between 1 and " + MAX_PAGE_SIZE);
        }
    }

    private static void validateLocation(Location location) throws StoreException {
        if (
            location == null ||
            !Double.isFinite(location.getLatitude()) ||
            location.getLatitude() < -90 ||
            location.getLatitude() > 90 ||
            !Double.isFinite(location.getLongitude()) ||
            location.getLongitude() < -180 ||
            location.getLongitude() > 180
        ) {
            throw new StoreException("INVALID_LOCATION", "Native provider returned invalid coordinates");
        }
    }

    private static void putNullable(ContentValues values, String key, boolean present, double value) {
        if (present && Double.isFinite(value)) {
            values.put(key, value);
        } else {
            values.putNull(key);
        }
    }

    private static Long nullableLong(Cursor cursor, String column) {
        int index = cursor.getColumnIndexOrThrow(column);
        return cursor.isNull(index) ? null : cursor.getLong(index);
    }

    private static Double nullableDouble(Cursor cursor, String column) {
        int index = cursor.getColumnIndexOrThrow(column);
        return cursor.isNull(index) ? null : cursor.getDouble(index);
    }

    private static String nullableString(Cursor cursor, String column) {
        int index = cursor.getColumnIndexOrThrow(column);
        return cursor.isNull(index) ? null : cursor.getString(index);
    }

    private static StoreException persistenceException(SQLiteException exception) {
        return new StoreException("PERSISTENCE_ERROR", "Persistent track storage operation failed", exception);
    }

    interface PointInsertHook {
        void beforeInsert(SQLiteDatabase db) throws SQLiteException;
    }

    static final class StoreException extends Exception {

        final String code;

        StoreException(String code, String message) {
            super(message);
            this.code = code;
        }

        StoreException(String code, String message, Throwable cause) {
            super(message, cause);
            this.code = code;
        }
    }

    static final class AppendResult {

        final Long sequence;
        final boolean overflowed;

        private AppendResult(Long sequence, boolean overflowed) {
            this.sequence = sequence;
            this.overflowed = overflowed;
        }

        static AppendResult appended(long sequence) {
            return new AppendResult(sequence, false);
        }

        static AppendResult overflowed() {
            return new AppendResult(null, true);
        }
    }

    static final class Session {

        final String sessionId;
        final String state;
        final long startedAt;
        final Long stoppedAt;
        final long lastSequence;
        final long acknowledgedThrough;
        final int queuedPointCount;
        final int maxPoints;
        final Long lastPersistedAt;
        final int droppedPointCount;
        final String errorCode;
        final String errorMessage;

        Session(
            String sessionId,
            String state,
            long startedAt,
            Long stoppedAt,
            long lastSequence,
            long acknowledgedThrough,
            int queuedPointCount,
            int maxPoints,
            Long lastPersistedAt,
            int droppedPointCount,
            String errorCode,
            String errorMessage
        ) {
            this.sessionId = sessionId;
            this.state = state;
            this.startedAt = startedAt;
            this.stoppedAt = stoppedAt;
            this.lastSequence = lastSequence;
            this.acknowledgedThrough = acknowledgedThrough;
            this.queuedPointCount = queuedPointCount;
            this.maxPoints = maxPoints;
            this.lastPersistedAt = lastPersistedAt;
            this.droppedPointCount = droppedPointCount;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
        }

        JSObject toJSObject() {
            JSObject result = new JSObject();
            result.put("sessionId", sessionId);
            result.put("state", state);
            result.put("startedAt", startedAt);
            result.put("stoppedAt", stoppedAt == null ? JSONObject.NULL : stoppedAt);
            result.put("lastSequence", lastSequence);
            result.put("acknowledgedThrough", acknowledgedThrough);
            result.put("queuedPointCount", queuedPointCount);
            result.put("maxPoints", maxPoints);
            result.put("lastPersistedAt", lastPersistedAt == null ? JSONObject.NULL : lastPersistedAt);
            result.put("droppedPointCount", droppedPointCount);
            result.put("errorCode", errorCode == null ? JSONObject.NULL : errorCode);
            result.put("errorMessage", errorMessage == null ? JSONObject.NULL : errorMessage);
            return result;
        }
    }

    static final class Point {

        final String sessionId;
        final long sequence;
        final double latitude;
        final double longitude;
        final Double accuracy;
        final Double altitude;
        final Double altitudeAccuracy;
        final boolean simulated;
        final Double speed;
        final Double bearing;
        final Long providerTime;
        final long persistedAt;

        Point(
            String sessionId,
            long sequence,
            double latitude,
            double longitude,
            Double accuracy,
            Double altitude,
            Double altitudeAccuracy,
            boolean simulated,
            Double speed,
            Double bearing,
            Long providerTime,
            long persistedAt
        ) {
            this.sessionId = sessionId;
            this.sequence = sequence;
            this.latitude = latitude;
            this.longitude = longitude;
            this.accuracy = accuracy;
            this.altitude = altitude;
            this.altitudeAccuracy = altitudeAccuracy;
            this.simulated = simulated;
            this.speed = speed;
            this.bearing = bearing;
            this.providerTime = providerTime;
            this.persistedAt = persistedAt;
        }

        JSObject toJSObject() {
            JSObject result = new JSObject();
            result.put("sessionId", sessionId);
            result.put("sequence", sequence);
            result.put("latitude", latitude);
            result.put("longitude", longitude);
            result.put("accuracy", accuracy == null ? JSONObject.NULL : accuracy);
            result.put("altitude", altitude == null ? JSONObject.NULL : altitude);
            result.put("altitudeAccuracy", altitudeAccuracy == null ? JSONObject.NULL : altitudeAccuracy);
            result.put("simulated", simulated);
            result.put("speed", speed == null ? JSONObject.NULL : speed);
            result.put("bearing", bearing == null ? JSONObject.NULL : bearing);
            result.put("time", providerTime == null ? JSONObject.NULL : providerTime);
            result.put("persistedAt", persistedAt);
            return result;
        }
    }

    static final class PointPage {

        final List<Point> points;
        final Long nextAfterSequence;
        final boolean hasMore;

        PointPage(List<Point> points, Long nextAfterSequence, boolean hasMore) {
            this.points = points;
            this.nextAfterSequence = nextAfterSequence;
            this.hasMore = hasMore;
        }

        JSObject toJSObject() {
            JSArray pointArray = new JSArray();
            for (Point point : points) {
                pointArray.put(point.toJSObject());
            }
            JSObject result = new JSObject();
            result.put("points", pointArray);
            result.put("nextAfterSequence", nextAfterSequence == null ? JSONObject.NULL : nextAfterSequence);
            result.put("hasMore", hasMore);
            return result;
        }
    }

    static final class AcknowledgeResult {

        final int deletedPointCount;
        final long acknowledgedThrough;

        AcknowledgeResult(int deletedPointCount, long acknowledgedThrough) {
            this.deletedPointCount = deletedPointCount;
            this.acknowledgedThrough = acknowledgedThrough;
        }

        JSObject toJSObject() {
            JSObject result = new JSObject();
            result.put("deletedPointCount", deletedPointCount);
            result.put("acknowledgedThrough", acknowledgedThrough);
            return result;
        }
    }
}
