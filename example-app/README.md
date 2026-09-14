# Background Geolocation Test Harness

This app exercises the locally linked `@capgo/background-geolocation` plugin and its native persistent track queue. It is intentionally separate from SGDMS.

The queue contract and lifecycle invariants are documented in [`../docs/native-track-queue-design.md`](../docs/native-track-queue-design.md).

Automatic Capgo bundle updates are disabled in this harness so an installed build always exercises the locally compiled source.

## What it records

- permission results;
- foreground/background start and stop actions;
- each JavaScript location callback, including provider and receipt timestamps;
- the gap between JavaScript callbacks;
- document visibility transitions and plugin errors;
- a bounded timeline in `localStorage`, retained across WebView reloads.
- native session recovery plus non-destructive read, acknowledgement, and reset operations.

The callback counters belong to the current JavaScript process. Native queue status is queried independently, so an active persistent session can be recovered after a WebView or app-process restart.

## Build and Android sync

From the plugin root:

```sh
bun run example:build
cd example-app
bunx cap sync android
```

Build the Android app with Java 21:

```sh
cd android
JAVA_HOME=/path/to/java-21 ./gradlew --no-daemon --console=plain assembleDebug
```

## Baseline modes

Use an empty **Native delivery URL** for the normal callback test. **Start foreground** omits `backgroundMessage`; **Start background** sets it and is the primary baseline for phone-track.

The example Android manifest declares `ACCESS_BACKGROUND_LOCATION` so the permission API can also be exercised. The foreground service used by the phone-track baseline is started while the app is visible; test and record the foreground location and notification grants separately from the all-the-time grant.

Setting a native delivery URL enables Capgo's separate native POST mode. On Android this also enables the persisted sticky-service path, so do not compare that run directly with an empty-URL callback-only run. Use only an endpoint controlled by the test team because location coordinates are sensitive.

The local timeline shows what reached JavaScript. The native queue is the independent durable record: each accepted point is committed before JavaScript callback or native HTTP delivery.

## Android persistent-queue test

1. Leave the native URL empty and keep **Persist track points** enabled.
2. Generate a fresh session ID, start a background run, and wait for several callbacks.
3. Tap **Refresh queue**, then **Read selected session**. The queued count and ordered sequences must match the run.
4. Swipe the app from Recents, wait several minutes, then reopen it. Refresh must recover the same active session and its queued count must have increased.
   The four queue indicators refresh automatically while the app is visible. JavaScript callback counters are process-local; use **Reconnect JS callback** if you also want callbacks again after reopening.
5. Read the session, acknowledge the displayed page, and confirm the queued count decreases without changing `lastSequence`.
6. Stop tracking. Refresh must show the same session as `stopped`, with no new points after the stop response.
7. Reset it. The session must become not found and a new session ID is generated for the next run.

Do not use Android **Force stop** as a recovery test: the OS intentionally prevents an app from restarting after force-stop until the user launches it again.

## Android baseline — 2026-09-14

Device: Samsung SM-S928B, Android 16 / API 36.

Configuration:

- background run with no native delivery URL;
- `distanceFilter: 0`;
- `minIntervalMs: 5000`;
- `networkFallback: true`;
- location, background location, and notification permissions granted.

Observed result:

- run duration: 26 minutes 39 seconds;
- 88 JavaScript location callbacks and no errors;
- approximately 83 callbacks arrived while the document was hidden;
- the document stayed hidden for a continuous period of approximately 24 minutes;
- provider and JavaScript receipt timestamps were usually separated by only a few milliseconds, showing that callbacks continued while hidden rather than being flushed only on resume;
- many stationary/indoor updates arrived approximately every 20 seconds with coarse accuracy, which is compatible with network fallback behaviour; `minIntervalMs` is a lower bound, not a delivery guarantee;
- stopping removed the active run and no further callback arrived during the following 1 minute 47 seconds before report export.

This closes the process-alive Android background baseline for the tested device. It does not cover reboot, force-stop, or offline durability. Those scenarios remain acceptance tests for the native persistent queue.

## Android persistent queue validation — 2026-09-14

Device: Samsung SM-S928B, Android 16 / API 36.

- all 10 native SQLite instrumentation tests passed, including pagination, acknowledgement, overflow, injected write failure, and concurrent stop/write serialization;
- an initial process-death test exposed that the first service start was registered as non-sticky because it ran before the binder persisted its configuration;
- after fixing the start order, Android reported `stopIfKilled=false`, killed process `27237` was replaced by process `28274`, and the same native session advanced from sequence 9 to sequence 13 without the harness UI being reopened;
- reopening the harness recovered the same session, callback reattachment worked, and explicit stop produced an inactive/stopped run;
- with `maxPoints: 2`, two points were retained and the third location attempt produced one callback error, removed the foreground notification, and stopped delivery;
- direct SQLite inspection confirmed `state=overflowed`, `lastSequence=2`, `queuedPointCount=2`, `droppedPointCount=1`, and `errorCode=QUEUE_FULL` without deleting the two retained points.

These results close the Android process-restart, reattach, explicit-stop, and overflow gates on this device. Reboot, explicit Android force-stop semantics, offline storage pressure, and the iOS implementation remain open.

## iOS handoff

The checked-in `Info.plist` includes both location usage descriptions and the `location` background mode. On macOS, sync and open the example project as documented in the SGDMS phone-track spike plan, then verify signing before running on a real iPhone.
