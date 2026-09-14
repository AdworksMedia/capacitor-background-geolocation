import { Capacitor } from '@capacitor/core';
import { BackgroundGeolocation } from '@capgo/background-geolocation';
import './style.css';

const MAX_EVENTS = 500;
const EVENTS_STORAGE_KEY = 'background-geolocation-harness-events-v1';
const CONFIG_STORAGE_KEY = 'background-geolocation-harness-config-v1';

const defaultConfig = {
  distanceFilter: 0,
  minIntervalMs: 5000,
  networkFallback: true,
  nativeUrl: '',
  persistentTrack: true,
  sessionId: createSessionId(),
  maxPoints: 100000,
};

const state = {
  active: false,
  mode: 'inactive',
  startedAt: null,
  callbackCount: 0,
  errorCount: 0,
  lastCallbackAt: null,
  lastGapMs: null,
  lastLocation: null,
  permissions: null,
  nativeSession: null,
  queuePage: null,
  events: readStoredJson(EVENTS_STORAGE_KEY, []),
  config: { ...defaultConfig, ...readStoredJson(CONFIG_STORAGE_KEY, {}) },
};

document.querySelector('#app').innerHTML = `
  <header class="hero">
    <div>
      <p class="eyebrow">Capgo plugin test harness</p>
      <h1>Background Geolocation</h1>
      <p class="lead">Exercise background delivery and the native persistent track queue.</p>
    </div>
    <span id="platform-badge" class="badge"></span>
  </header>

  <section class="panel status-panel" aria-labelledby="status-heading">
    <div class="section-heading">
      <h2 id="status-heading">Live status</h2>
      <span id="visibility-badge" class="badge badge-muted"></span>
    </div>
    <dl class="metrics">
      <div><dt>Harness state</dt><dd id="tracking-status">Inactive</dd></div>
      <div><dt>Run duration</dt><dd id="run-duration">—</dd></div>
      <div><dt>Callbacks</dt><dd id="callback-count">0</dd></div>
      <div><dt>Errors</dt><dd id="error-count">0</dd></div>
      <div><dt>Last JS gap</dt><dd id="last-gap">—</dd></div>
      <div><dt>Provider time</dt><dd id="provider-time">—</dd></div>
    </dl>
    <pre id="last-location" class="location-output">No location received in this app process.</pre>
    <p class="hint">Callback counters are process-local. Persistent queue state is queried independently from native storage.</p>
  </section>

  <section class="panel" aria-labelledby="config-heading">
    <h2 id="config-heading">Run configuration</h2>
    <div class="form-grid">
      <label>
        <span>Distance filter (metres)</span>
        <input id="distance-filter" type="number" min="0" step="1" inputmode="decimal" />
      </label>
      <label>
        <span>Minimum interval (milliseconds)</span>
        <input id="min-interval" type="number" min="0" step="1000" inputmode="numeric" />
      </label>
      <label class="checkbox-field">
        <input id="network-fallback" type="checkbox" />
        <span>Use Android network fallback when GPS is silent</span>
      </label>
      <label class="checkbox-field">
        <input id="persistent-track" type="checkbox" />
        <span>Persist track points in the native SQLite queue</span>
      </label>
      <label>
        <span>Persistent session ID</span>
        <input id="session-id" type="text" maxlength="128" autocomplete="off" />
      </label>
      <label>
        <span>Maximum queued points</span>
        <input id="max-points" type="number" min="2" max="1000000" step="1" inputmode="numeric" />
      </label>
      <label class="wide-field">
        <span>Native delivery URL (optional)</span>
        <input id="native-url" type="url" inputmode="url" autocomplete="off" placeholder="https://your-test-endpoint.example/locations" />
        <small>Leave empty for the normal callback test. Setting a URL enables Capgo’s distinct native POST/sticky-service path.</small>
      </label>
    </div>
  </section>

  <section class="panel" aria-labelledby="queue-heading">
    <div class="section-heading">
      <h2 id="queue-heading">Native persistent queue</h2>
      <span id="queue-badge" class="badge badge-muted">Unknown</span>
    </div>
    <dl class="metrics queue-metrics">
      <div><dt>Last sequence</dt><dd id="queue-last-sequence">—</dd></div>
      <div><dt>Acknowledged through</dt><dd id="queue-acknowledged">—</dd></div>
      <div><dt>Queued points</dt><dd id="queue-count">—</dd></div>
      <div><dt>Last persisted</dt><dd id="queue-last-persisted">—</dd></div>
    </dl>
    <div class="button-grid">
      <button id="refresh-queue" class="secondary">Refresh queue</button>
      <button id="read-queue" class="secondary">Read selected session</button>
      <button id="reconnect-callback" class="secondary" disabled>Reconnect JS callback</button>
      <button id="ack-queue" class="secondary" disabled>Acknowledge displayed page</button>
      <button id="reset-queue" class="danger">Reset selected session</button>
      <button id="new-session" class="secondary">Generate new session ID</button>
    </div>
    <pre id="queue-output" class="location-output">Native queue state has not been queried.</pre>
    <p class="hint">The four values above refresh automatically while this page is visible. Read is non-destructive. Acknowledge deletes only the displayed points after a host has durably imported them.</p>
  </section>

  <section class="panel" aria-labelledby="actions-heading">
    <h2 id="actions-heading">Actions</h2>
    <div class="button-grid">
      <button id="check-permissions" class="secondary">Check permissions</button>
      <button id="request-permissions" class="secondary">Request permissions</button>
      <button id="open-settings" class="secondary">Open app settings</button>
      <button id="start-foreground">Start foreground</button>
      <button id="start-background">Start background</button>
      <button id="stop" class="danger" disabled>Stop tracking</button>
    </div>
    <p id="permission-status" class="hint">Permissions have not been checked in this app process.</p>
  </section>

  <section class="panel" aria-labelledby="timeline-heading">
    <div class="section-heading timeline-heading">
      <div>
        <h2 id="timeline-heading">Persistent timeline</h2>
        <p class="hint">Newest first; retained across reloads, up to ${MAX_EVENTS} events.</p>
      </div>
      <div class="compact-actions">
        <button id="copy-report" class="secondary compact">Copy report</button>
        <button id="clear-timeline" class="secondary compact">Clear</button>
      </div>
    </div>
    <ol id="timeline" class="timeline"></ol>
  </section>
`;

const elements = {
  platformBadge: document.getElementById('platform-badge'),
  visibilityBadge: document.getElementById('visibility-badge'),
  trackingStatus: document.getElementById('tracking-status'),
  runDuration: document.getElementById('run-duration'),
  callbackCount: document.getElementById('callback-count'),
  errorCount: document.getElementById('error-count'),
  lastGap: document.getElementById('last-gap'),
  providerTime: document.getElementById('provider-time'),
  lastLocation: document.getElementById('last-location'),
  permissionStatus: document.getElementById('permission-status'),
  distanceFilter: document.getElementById('distance-filter'),
  minInterval: document.getElementById('min-interval'),
  networkFallback: document.getElementById('network-fallback'),
  nativeUrl: document.getElementById('native-url'),
  persistentTrack: document.getElementById('persistent-track'),
  sessionId: document.getElementById('session-id'),
  maxPoints: document.getElementById('max-points'),
  startForeground: document.getElementById('start-foreground'),
  startBackground: document.getElementById('start-background'),
  stop: document.getElementById('stop'),
  queueBadge: document.getElementById('queue-badge'),
  queueLastSequence: document.getElementById('queue-last-sequence'),
  queueAcknowledged: document.getElementById('queue-acknowledged'),
  queueCount: document.getElementById('queue-count'),
  queueLastPersisted: document.getElementById('queue-last-persisted'),
  queueOutput: document.getElementById('queue-output'),
  reconnectCallback: document.getElementById('reconnect-callback'),
  acknowledgeQueue: document.getElementById('ack-queue'),
  timeline: document.getElementById('timeline'),
};

elements.platformBadge.textContent = `${Capacitor.getPlatform()} / ${Capacitor.isNativePlatform() ? 'native' : 'web'}`;
elements.distanceFilter.value = String(state.config.distanceFilter);
elements.minInterval.value = String(state.config.minIntervalMs);
elements.networkFallback.checked = Boolean(state.config.networkFallback);
elements.nativeUrl.value = state.config.nativeUrl;
elements.persistentTrack.checked = Boolean(state.config.persistentTrack);
elements.sessionId.value = state.config.sessionId;
elements.maxPoints.value = String(state.config.maxPoints);

document.getElementById('check-permissions').addEventListener('click', checkPermissions);
document.getElementById('request-permissions').addEventListener('click', requestPermissions);
document.getElementById('open-settings').addEventListener('click', runAction('open settings', () => BackgroundGeolocation.openSettings()));
elements.startForeground.addEventListener('click', () => startTracking('foreground'));
elements.startBackground.addEventListener('click', () => startTracking('background'));
elements.stop.addEventListener('click', stopTracking);
document.getElementById('refresh-queue').addEventListener('click', refreshNativeQueue);
document.getElementById('read-queue').addEventListener('click', readSelectedQueue);
elements.reconnectCallback.addEventListener('click', () => startTracking('background'));
elements.acknowledgeQueue.addEventListener('click', acknowledgeDisplayedQueue);
document.getElementById('reset-queue').addEventListener('click', resetSelectedQueue);
document.getElementById('new-session').addEventListener('click', generateNewSession);
document.getElementById('copy-report').addEventListener('click', copyReport);
document.getElementById('clear-timeline').addEventListener('click', clearTimeline);

document.addEventListener('visibilitychange', () => {
  renderVisibility();
  addEvent('lifecycle', `Document visibility changed to ${document.visibilityState}`);
});
window.addEventListener('pageshow', (event) => addEvent('lifecycle', `Page shown${event.persisted ? ' from cache' : ''}`));
window.addEventListener('pagehide', (event) => addEvent('lifecycle', `Page hidden${event.persisted ? ' into cache' : ''}`));

addEvent('lifecycle', 'Harness booted; native tracking state is unknown until this process starts a run');
render();
void refreshNativeQueue();
window.setInterval(renderStatus, 1000);
window.setInterval(() => {
  if (Capacitor.isNativePlatform() && document.visibilityState === 'visible' && state.nativeSession?.state === 'active') {
    void refreshNativeQueue(true);
  }
}, 5000);

async function checkPermissions() {
  await performAction('check permissions', async () => {
    state.permissions = await BackgroundGeolocation.checkPermissions();
    addEvent('permissions', `Permission status: ${JSON.stringify(state.permissions)}`);
    renderStatus();
  });
}

async function requestPermissions() {
  await performAction('request permissions', async () => {
    state.permissions = await BackgroundGeolocation.requestPermissions({
      permissions: ['location', 'backgroundLocation', 'notification'],
    });
    addEvent('permissions', `Permission request result: ${JSON.stringify(state.permissions)}`);
    renderStatus();
  });
}

async function startTracking(mode) {
  if (state.active) {
    addEvent('error', `Cannot start ${mode}: this harness already has an active run`);
    return;
  }

  let config;
  try {
    config = readConfig();
  } catch (error) {
    state.errorCount += 1;
    addEvent('error', normalizeError(error).message);
    renderStatus();
    return;
  }

  const options = {
    requestPermissions: false,
    stale: false,
    distanceFilter: config.distanceFilter,
    minIntervalMs: config.minIntervalMs,
    networkFallback: config.networkFallback,
  };

  if (mode === 'background') {
    options.backgroundTitle = 'Background geolocation test';
    options.backgroundMessage = 'Recording a test location track';
  }
  if (config.nativeUrl) {
    options.url = config.nativeUrl;
  }
  if (config.persistentTrack) {
    options.persistentTrack = {
      sessionId: config.sessionId,
      maxPoints: config.maxPoints,
    };
  }

  addEvent('action', `Starting ${mode} run with ${JSON.stringify(options)}`);
  try {
    await BackgroundGeolocation.start(options, handleLocationCallback);
    state.active = true;
    state.mode = mode;
    state.startedAt = Date.now();
    state.callbackCount = 0;
    state.errorCount = 0;
    state.lastCallbackAt = null;
    state.lastGapMs = null;
    state.lastLocation = null;
    addEvent('action', `${capitalize(mode)} run registered`);
    await loadQueueState(config.sessionId, false);
  } catch (error) {
    state.errorCount += 1;
    const normalized = normalizeError(error);
    addEvent('error', `Start ${mode} failed: ${normalized.message}`, { error: normalized });
  }
  renderStatus();
}

function handleLocationCallback(location, error) {
  const receivedAt = Date.now();
  if (error) {
    state.errorCount += 1;
    const normalized = normalizeError(error);
    addEvent('error', `Location callback error: ${normalized.message}`, { error: normalized });
    state.active = false;
    state.mode = 'inactive';
    state.startedAt = null;
    void loadQueueState(state.config.sessionId, false).finally(renderStatus);
  }
  if (location) {
    state.callbackCount += 1;
    state.lastGapMs = state.lastCallbackAt === null ? null : receivedAt - state.lastCallbackAt;
    state.lastCallbackAt = receivedAt;
    state.lastLocation = location;
    addEvent(
      'location',
      `#${state.callbackCount} ${formatCoordinate(location.latitude)}, ${formatCoordinate(location.longitude)} ±${formatAccuracy(location.accuracy)}m`,
      { location, receivedAt, gapMs: state.lastGapMs },
    );
  }
  renderStatus();
}

async function stopTracking() {
  await performAction('stop tracking', async () => {
    await BackgroundGeolocation.stop();
    const durationMs = state.startedAt === null ? null : Date.now() - state.startedAt;
    addEvent('action', `Tracking stopped after ${formatDuration(durationMs)} with ${state.callbackCount} callbacks`);
    state.active = false;
    state.mode = 'inactive';
    state.startedAt = null;
    await loadQueueState(state.config.sessionId, false);
    renderStatus();
  });
}

async function refreshNativeQueue(silent = false) {
  if (!Capacitor.isNativePlatform()) {
    state.nativeSession = null;
    state.queuePage = null;
    renderQueue();
    return;
  }
  await performAction('refresh native queue', async () => {
    const activeResult = await BackgroundGeolocation.getActivePersistentTrackSession();
    if (activeResult.session) {
      state.nativeSession = activeResult.session;
      elements.sessionId.value = activeResult.session.sessionId;
      state.config.sessionId = activeResult.session.sessionId;
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(state.config));
      if (!state.active) {
        state.mode = 'recovered-native';
      }
    } else {
      await loadQueueState(elements.sessionId.value.trim(), false);
    }
    if (!silent) {
      addEvent(
        'queue',
        activeResult.session
          ? `Active native session recovered: ${activeResult.session.sessionId}`
          : 'No active native persistent session',
      );
    }
    renderStatus();
  });
}

async function readSelectedQueue() {
  await performAction('read native queue', async () => {
    const sessionId = selectedSessionId();
    await loadQueueState(sessionId, true);
  });
}

async function loadQueueState(sessionId, logResult) {
  if (!sessionId) {
    state.nativeSession = null;
    state.queuePage = null;
    renderQueue();
    return;
  }
  const [sessionResult, page] = await Promise.all([
    BackgroundGeolocation.getPersistentTrackSession({ sessionId }),
    BackgroundGeolocation.getPersistentTrackPoints({ sessionId, limit: 1000 }).catch((error) => {
      if (normalizeError(error).code === 'SESSION_NOT_FOUND') {
        return null;
      }
      throw error;
    }),
  ]);
  state.nativeSession = sessionResult.session;
  state.queuePage = page;
  if (logResult) {
    addEvent(
      'queue',
      sessionResult.session
        ? `Read ${page?.points.length ?? 0} queued points from ${sessionId}`
        : `Persistent session ${sessionId} was not found`,
    );
  }
  renderQueue();
}

async function acknowledgeDisplayedQueue() {
  await performAction('acknowledge native queue', async () => {
    const throughSequence = state.queuePage?.nextAfterSequence;
    if (throughSequence === null || throughSequence === undefined) {
      throw new Error('Read a non-empty queue page before acknowledging it');
    }
    const sessionId = selectedSessionId();
    const result = await BackgroundGeolocation.acknowledgePersistentTrackPoints({ sessionId, throughSequence });
    addEvent(
      'queue',
      `Acknowledged through #${result.acknowledgedThrough}; deleted ${result.deletedPointCount} points`,
    );
    await loadQueueState(sessionId, false);
  });
}

async function resetSelectedQueue() {
  await performAction('reset native queue', async () => {
    const sessionId = selectedSessionId();
    const result = await BackgroundGeolocation.resetPersistentTrackSession({ sessionId });
    addEvent('queue', `Reset ${sessionId}; deleted ${result.deletedPointCount} points`);
    state.active = false;
    state.mode = 'inactive';
    state.startedAt = null;
    state.nativeSession = null;
    state.queuePage = null;
    generateNewSession(false);
    renderStatus();
  });
}

function generateNewSession(logResult = true) {
  const sessionId = createSessionId();
  elements.sessionId.value = sessionId;
  state.config.sessionId = sessionId;
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(state.config));
  state.nativeSession = null;
  state.queuePage = null;
  if (logResult) {
    addEvent('action', `Generated session ID ${sessionId}`);
  }
  renderQueue();
}

function selectedSessionId() {
  const sessionId = elements.sessionId.value.trim();
  if (!sessionId) {
    throw new Error('Persistent session ID is required');
  }
  return sessionId;
}

function runAction(label, action) {
  return () => performAction(label, action);
}

async function performAction(label, action) {
  try {
    await action();
  } catch (error) {
    state.errorCount += 1;
    const normalized = normalizeError(error);
    addEvent('error', `${capitalize(label)} failed: ${normalized.message}`, { error: normalized });
    renderStatus();
  }
}

function readConfig() {
  const distanceFilter = parseNonNegativeNumber(elements.distanceFilter.value, 'Distance filter');
  const minIntervalMs = parseNonNegativeNumber(elements.minInterval.value, 'Minimum interval');
  const nativeUrl = elements.nativeUrl.value.trim();
  if (nativeUrl) {
    const parsedUrl = new URL(nativeUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Native delivery URL must use HTTP or HTTPS');
    }
  }
  state.config = {
    distanceFilter,
    minIntervalMs,
    networkFallback: elements.networkFallback.checked,
    nativeUrl,
    persistentTrack: elements.persistentTrack.checked,
    sessionId: selectedSessionId(),
    maxPoints: parseIntegerInRange(elements.maxPoints.value, 'Maximum queued points', 2, 1000000),
  };
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(state.config));
  return state.config;
}

function parseIntegerInRange(rawValue, label, minimum, maximum) {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseNonNegativeNumber(rawValue, label) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a number greater than or equal to zero`);
  }
  return value;
}

function addEvent(type, message, details = undefined) {
  state.events.unshift({
    at: new Date().toISOString(),
    type,
    message,
    visibility: document.visibilityState,
    details,
  });
  state.events = state.events.slice(0, MAX_EVENTS);
  localStorage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(state.events));
  renderTimeline();
}

function clearTimeline() {
  state.events = [];
  localStorage.removeItem(EVENTS_STORAGE_KEY);
  addEvent('action', 'Timeline cleared');
}

async function copyReport() {
  const report = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      platform: Capacitor.getPlatform(),
      native: Capacitor.isNativePlatform(),
      visibility: document.visibilityState,
      harnessState: {
        active: state.active,
        mode: state.mode,
        startedAt: state.startedAt === null ? null : new Date(state.startedAt).toISOString(),
        callbackCount: state.callbackCount,
        errorCount: state.errorCount,
        lastCallbackAt: state.lastCallbackAt === null ? null : new Date(state.lastCallbackAt).toISOString(),
      },
      config: state.config,
      permissions: state.permissions,
      nativeSession: state.nativeSession,
      queuePage: state.queuePage,
      events: state.events,
    },
    null,
    2,
  );

  try {
    await navigator.clipboard.writeText(report);
    addEvent('action', 'Report copied to clipboard');
  } catch (error) {
    state.errorCount += 1;
    addEvent('error', `Could not copy report: ${normalizeError(error).message}`);
    renderStatus();
  }
}

function render() {
  renderVisibility();
  renderStatus();
  renderTimeline();
  renderQueue();
}

function renderVisibility() {
  elements.visibilityBadge.textContent = document.visibilityState;
  elements.visibilityBadge.dataset.state = document.visibilityState;
}

function renderStatus() {
  const nativeActive = state.nativeSession?.state === 'active';
  elements.trackingStatus.textContent = state.active
    ? `Active (${state.mode})`
    : nativeActive
      ? 'Active (recovered native session)'
      : 'Inactive';
  elements.trackingStatus.dataset.active = String(state.active || nativeActive);
  elements.runDuration.textContent = state.startedAt === null ? '—' : formatDuration(Date.now() - state.startedAt);
  elements.callbackCount.textContent = String(state.callbackCount);
  elements.errorCount.textContent = String(state.errorCount);
  elements.lastGap.textContent = state.lastGapMs === null ? '—' : formatDuration(state.lastGapMs);
  elements.providerTime.textContent = state.lastLocation?.time ? formatTimestamp(state.lastLocation.time) : '—';
  elements.lastLocation.textContent = state.lastLocation
    ? JSON.stringify(
        {
          latitude: state.lastLocation.latitude,
          longitude: state.lastLocation.longitude,
          accuracy: state.lastLocation.accuracy,
          altitude: state.lastLocation.altitude,
          speed: state.lastLocation.speed,
          bearing: state.lastLocation.bearing,
          simulated: state.lastLocation.simulated,
          providerTime: state.lastLocation.time ? new Date(state.lastLocation.time).toISOString() : null,
          receivedAt: state.lastCallbackAt === null ? null : new Date(state.lastCallbackAt).toISOString(),
        },
        null,
        2,
      )
    : 'No location received in this app process.';
  elements.permissionStatus.textContent = state.permissions
    ? `Permissions: ${JSON.stringify(state.permissions)}`
    : 'Permissions have not been checked in this app process.';
  elements.startForeground.disabled = state.active || nativeActive;
  elements.startBackground.disabled = state.active || nativeActive;
  elements.stop.disabled = !state.active && !nativeActive;
  renderQueue();
}

function renderQueue() {
  const session = state.nativeSession;
  const page = state.queuePage;
  elements.queueBadge.textContent = session?.state ?? 'Not found';
  elements.queueBadge.dataset.state = session?.state ?? 'missing';
  elements.queueLastSequence.textContent = session ? String(session.lastSequence) : '—';
  elements.queueAcknowledged.textContent = session ? String(session.acknowledgedThrough) : '—';
  elements.queueCount.textContent = session ? String(session.queuedPointCount) : '—';
  elements.queueLastPersisted.textContent = session?.lastPersistedAt ? formatTimestamp(session.lastPersistedAt) : '—';
  elements.queueOutput.textContent = session
    ? JSON.stringify(
        {
          displayedPointCount: page?.points.length ?? null,
          firstDisplayedSequence: page?.points[0]?.sequence ?? null,
          lastDisplayedSequence: page?.nextAfterSequence ?? null,
          hasMore: page?.hasMore ?? null,
          latestDisplayedPoints: page?.points.slice(-10).reverse() ?? [],
        },
        null,
        2,
      )
    : 'No native persistent session loaded for the selected ID.';
  elements.acknowledgeQueue.disabled = !page?.points.length;
  elements.reconnectCallback.disabled = state.active || session?.state !== 'active';
}

function renderTimeline() {
  elements.timeline.replaceChildren();
  for (const event of state.events) {
    const item = document.createElement('li');
    item.className = `timeline-item event-${event.type}`;

    const meta = document.createElement('span');
    meta.className = 'event-meta';
    meta.textContent = `${formatTimestamp(event.at)} · ${event.type} · ${event.visibility}`;

    const message = document.createElement('span');
    message.className = 'event-message';
    message.textContent = event.message;

    item.append(meta, message);
    elements.timeline.append(item);
  }
}

function readStoredJson(key, fallback) {
  try {
    const rawValue = localStorage.getItem(key);
    return rawValue === null ? fallback : JSON.parse(rawValue);
  } catch {
    return fallback;
  }
}

function createSessionId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `track-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, code: error.code ?? null };
  }
  if (typeof error === 'object' && error !== null) {
    return {
      name: String(error.name ?? 'Error'),
      message: String(error.message ?? JSON.stringify(error)),
      code: error.code ?? null,
    };
  }
  return { name: 'Error', message: String(error), code: null };
}

function formatCoordinate(value) {
  return Number.isFinite(value) ? value.toFixed(6) : 'unknown';
}

function formatAccuracy(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '?';
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(undefined, { hour12: false });
}

function formatDuration(value) {
  if (value === null || !Number.isFinite(value)) {
    return '—';
  }
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
