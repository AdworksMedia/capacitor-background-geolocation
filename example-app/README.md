# Background Geolocation Test Harness

This app exercises the locally linked `@capgo/background-geolocation` plugin before the native persistent queue is added. It is intentionally separate from SGDMS.

Automatic Capgo bundle updates are disabled in this harness so an installed build always exercises the locally compiled source.

## What it records

- permission results;
- foreground/background start and stop actions;
- each JavaScript location callback, including provider and receipt timestamps;
- the gap between JavaScript callbacks;
- document visibility transitions and plugin errors;
- a bounded timeline in `localStorage`, retained across WebView reloads.

The displayed active/inactive state belongs to the current JavaScript process. The plugin does not expose a native `isRunning` API, so a reload makes the native state unknown.

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

The persistent timeline proves only what reached JavaScript. An independent native observer is still required to distinguish a suspended WebView from stopped native location delivery. Until the native queue exists, use a controlled native POST endpoint or Android service/location diagnostics for that observation.

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

This closes the process-alive Android background baseline for the tested device. It does not cover process death, swipe from Recents, reboot, force-stop, offline durability, or recovery after relaunch. Those scenarios remain acceptance tests for the native persistent queue.

## iOS handoff

The checked-in `Info.plist` includes both location usage descriptions and the `location` background mode. On macOS, sync and open the example project as documented in the SGDMS phone-track spike plan, then verify signing before running on a real iPhone.
