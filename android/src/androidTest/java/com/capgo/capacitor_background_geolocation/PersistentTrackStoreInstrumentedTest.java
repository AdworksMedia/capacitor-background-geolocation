package com.capgo.capacitor_background_geolocation;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.database.sqlite.SQLiteException;
import android.location.Location;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class PersistentTrackStoreInstrumentedTest {

    private Context context;
    private String databaseName;
    private PersistentTrackStore store;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        databaseName = "persistent-track-test-" + UUID.randomUUID() + ".db";
        store = new PersistentTrackStore(context, databaseName);
    }

    @After
    public void tearDown() {
        store.close();
        context.deleteDatabase(databaseName);
    }

    @Test
    public void createsAndReattachesOneActiveSession() throws Exception {
        PersistentTrackStore.Session created = store.startSession("session-1", 20, 1_000);
        PersistentTrackStore.Session reattached = store.startSession("session-1", 999, 2_000);

        assertEquals("active", created.state);
        assertEquals(1_000, created.startedAt);
        assertEquals(20, created.maxPoints);
        assertEquals(created.startedAt, reattached.startedAt);
        assertEquals(created.maxPoints, reattached.maxPoints);

        PersistentTrackStore.StoreException exception = assertThrows(PersistentTrackStore.StoreException.class, () ->
            store.startSession("session-2", 20, 2_000)
        );
        assertEquals("ACTIVE_SESSION_EXISTS", exception.code);
    }

    @Test
    public void persistsOrderedPagesAndNullableFields() throws Exception {
        store.startSession("session-1", 20, 1_000);
        store.appendLocation("session-1", location(44.1, 26.1, 10_000, null), 10_010);
        store.appendLocation("session-1", location(44.2, 26.2, 20_000, 5.5f), 20_010);
        store.appendLocation("session-1", location(44.3, 26.3, 30_000, 7.5f), 30_010);

        PersistentTrackStore.PointPage firstPage = store.getPoints("session-1", 0L, 2);
        assertEquals(2, firstPage.points.size());
        assertEquals(1, firstPage.points.get(0).sequence);
        assertEquals(2, firstPage.points.get(1).sequence);
        assertEquals(Long.valueOf(2), firstPage.nextAfterSequence);
        assertTrue(firstPage.hasMore);
        assertNull(firstPage.points.get(0).accuracy);
        assertEquals(Double.valueOf(5.5), firstPage.points.get(1).accuracy);

        PersistentTrackStore.PointPage secondPage = store.getPoints("session-1", firstPage.nextAfterSequence, 2);
        assertEquals(1, secondPage.points.size());
        assertEquals(3, secondPage.points.get(0).sequence);
        assertFalse(secondPage.hasMore);

        PersistentTrackStore.Session session = store.getSession("session-1");
        assertEquals(3, session.lastSequence);
        assertEquals(3, session.queuedPointCount);
        assertEquals(Long.valueOf(30_010), session.lastPersistedAt);
    }

    @Test
    public void acknowledgementIsInclusiveAndIdempotent() throws Exception {
        store.startSession("session-1", 20, 1_000);
        store.appendLocation("session-1", location(44.1, 26.1, 10_000, 4f), 10_010);
        store.appendLocation("session-1", location(44.2, 26.2, 20_000, 4f), 20_010);
        store.appendLocation("session-1", location(44.3, 26.3, 30_000, 4f), 30_010);

        PersistentTrackStore.AcknowledgeResult first = store.acknowledge("session-1", 2);
        assertEquals(2, first.deletedPointCount);
        assertEquals(2, first.acknowledgedThrough);
        assertEquals(1, store.getSession("session-1").queuedPointCount);

        PersistentTrackStore.AcknowledgeResult repeated = store.acknowledge("session-1", 2);
        assertEquals(0, repeated.deletedPointCount);
        assertEquals(2, repeated.acknowledgedThrough);

        PersistentTrackStore.PointPage remaining = store.getPoints("session-1", null, 10);
        assertEquals(1, remaining.points.size());
        assertEquals(3, remaining.points.get(0).sequence);
    }

    @Test
    public void stopPreventsReopenAndResetDeletesSession() throws Exception {
        store.startSession("session-1", 20, 1_000);
        store.appendLocation("session-1", location(44.1, 26.1, 10_000, 4f), 10_010);
        PersistentTrackStore.Session stopped = store.stopSession("session-1", 11_000);

        assertEquals("stopped", stopped.state);
        assertEquals(Long.valueOf(11_000), stopped.stoppedAt);
        assertNull(store.getActiveSession());

        PersistentTrackStore.StoreException exception = assertThrows(PersistentTrackStore.StoreException.class, () ->
            store.startSession("session-1", 20, 12_000)
        );
        assertEquals("SESSION_CLOSED", exception.code);

        assertEquals(1, store.resetSession("session-1"));
        assertNull(store.getSession("session-1"));
        assertEquals(0, store.resetSession("session-1"));
    }

    @Test
    public void listsStoppedSessionsForRecovery() throws Exception {
        store.startSession("older", 20, 1_000);
        store.stopSession("older", 2_000);
        store.startSession("newer", 20, 3_000);
        store.stopSession("newer", 4_000);

        List<PersistentTrackStore.Session> sessions = store.getSessions();
        assertEquals(2, sessions.size());
        assertEquals("newer", sessions.get(0).sessionId);
        assertEquals("older", sessions.get(1).sessionId);
    }

    @Test
    public void queueOverflowFailsClosedWithoutDeletingOlderPoints() throws Exception {
        store.startSession("session-1", 2, 1_000);
        store.appendLocation("session-1", location(44.1, 26.1, 10_000, 4f), 10_010);
        store.appendLocation("session-1", location(44.2, 26.2, 20_000, 4f), 20_010);

        PersistentTrackStore.AppendResult overflow = store.appendLocation("session-1", location(44.3, 26.3, 30_000, 4f), 30_010);
        PersistentTrackStore.Session session = store.getSession("session-1");

        assertTrue(overflow.overflowed);
        assertEquals("overflowed", session.state);
        assertEquals("QUEUE_FULL", session.errorCode);
        assertEquals(1, session.droppedPointCount);
        assertEquals(2, session.queuedPointCount);
        assertEquals(2, session.lastSequence);
        assertNull(store.getActiveSession());
    }

    @Test
    public void acknowledgementFreesCapacityForNewPoints() throws Exception {
        store.startSession("session-1", 2, 1_000);
        store.appendLocation("session-1", location(44.1, 26.1, 10_000, 4f), 10_010);
        store.appendLocation("session-1", location(44.2, 26.2, 20_000, 4f), 20_010);

        store.acknowledge("session-1", 1);
        PersistentTrackStore.AppendResult appended = store.appendLocation("session-1", location(44.3, 26.3, 30_000, 4f), 30_010);
        PersistentTrackStore.Session session = store.getSession("session-1");

        assertFalse(appended.overflowed);
        assertEquals(Long.valueOf(3), appended.sequence);
        assertEquals(2, session.queuedPointCount);
        assertEquals(3, session.lastSequence);
        assertEquals(1, session.acknowledgedThrough);
    }

    @Test
    public void writeFailureRollsBackPointAndCanFailSessionWithoutDeletingEarlierPoints() throws Exception {
        store.startSession("session-1", 20, 1_000);
        store.appendLocation("session-1", location(44.1, 26.1, 10_000, 4f), 10_010);
        store.close();

        store = new PersistentTrackStore(context, databaseName, (db) -> {
            throw new SQLiteException("injected write failure");
        });
        PersistentTrackStore.StoreException writeFailure = assertThrows(PersistentTrackStore.StoreException.class, () ->
            store.appendLocation("session-1", location(44.2, 26.2, 20_000, 4f), 20_010)
        );
        assertEquals("PERSISTENCE_ERROR", writeFailure.code);

        store.failSession("session-1", writeFailure.code, writeFailure.getMessage(), 20_020);
        PersistentTrackStore.Session session = store.getSession("session-1");
        assertEquals("failed", session.state);
        assertEquals(1, session.lastSequence);
        assertEquals(1, session.queuedPointCount);
        assertEquals(1, session.droppedPointCount);
        assertEquals(1, store.getPoints("session-1", 0L, 10).points.size());
    }

    @Test
    public void concurrentStopAndWriteHaveOneSerializedBoundary() throws Exception {
        store.startSession("session-1", 20, 1_000);
        store.appendLocation("session-1", location(44.1, 26.1, 10_000, 4f), 10_010);

        ExecutorService executor = Executors.newFixedThreadPool(2);
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch go = new CountDownLatch(1);
        try {
            Future<Boolean> append = executor.submit(() -> {
                ready.countDown();
                go.await();
                try {
                    store.appendLocation("session-1", location(44.2, 26.2, 20_000, 4f), 20_010);
                    return true;
                } catch (PersistentTrackStore.StoreException exception) {
                    assertEquals("SESSION_NOT_ACTIVE", exception.code);
                    return false;
                }
            });
            Future<?> stop = executor.submit(() -> {
                ready.countDown();
                go.await();
                store.stopSession("session-1", 20_020);
                return null;
            });
            ready.await();
            go.countDown();
            boolean appendWonBoundary = append.get();
            stop.get();

            PersistentTrackStore.Session session = store.getSession("session-1");
            assertEquals("stopped", session.state);
            assertEquals(appendWonBoundary ? 2 : 1, session.lastSequence);
            assertEquals(appendWonBoundary ? 2 : 1, session.queuedPointCount);
            PersistentTrackStore.StoreException afterStop = assertThrows(PersistentTrackStore.StoreException.class, () ->
                store.appendLocation("session-1", location(44.3, 26.3, 30_000, 4f), 30_010)
            );
            assertEquals("SESSION_NOT_ACTIVE", afterStop.code);
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    public void rejectsInvalidIdentifiersAndCursors() throws Exception {
        PersistentTrackStore.StoreException invalidId = assertThrows(PersistentTrackStore.StoreException.class, () ->
            store.startSession("invalid session", 20, 1_000)
        );
        assertEquals("INVALID_SESSION_ID", invalidId.code);

        store.startSession("session-1", 20, 1_000);
        PersistentTrackStore.StoreException invalidLimit = assertThrows(PersistentTrackStore.StoreException.class, () ->
            store.getPoints("session-1", 0L, PersistentTrackStore.MAX_PAGE_SIZE + 1)
        );
        assertEquals("INVALID_LIMIT", invalidLimit.code);

        PersistentTrackStore.StoreException invalidAck = assertThrows(PersistentTrackStore.StoreException.class, () ->
            store.acknowledge("session-1", 1)
        );
        assertEquals("INVALID_CURSOR", invalidAck.code);
    }

    private static Location location(double latitude, double longitude, long time, Float accuracy) {
        Location location = new Location("test");
        location.setLatitude(latitude);
        location.setLongitude(longitude);
        location.setTime(time);
        if (accuracy != null) {
            location.setAccuracy(accuracy);
        }
        return location;
    }
}
