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
  events: readStoredJson(EVENTS_STORAGE_KEY, []),
  config: { ...defaultConfig, ...readStoredJson(CONFIG_STORAGE_KEY, {}) },
};

document.querySelector('#app').innerHTML = `
  <header class="hero">
    <div>
      <p class="eyebrow">Capgo plugin test harness</p>
      <h1>Background Geolocation</h1>
      <p class="lead">Observe the current plugin before adding a native persistent queue.</p>
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
    <p class="hint">“Harness state” is local UI state, not native <code>isRunning</code>; the plugin does not expose that API yet.</p>
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
      <label class="wide-field">
        <span>Native delivery URL (optional)</span>
        <input id="native-url" type="url" inputmode="url" autocomplete="off" placeholder="https://your-test-endpoint.example/locations" />
        <small>Leave empty for the normal callback test. Setting a URL enables Capgo’s distinct native POST/sticky-service path.</small>
      </label>
    </div>
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
  startForeground: document.getElementById('start-foreground'),
  startBackground: document.getElementById('start-background'),
  stop: document.getElementById('stop'),
  timeline: document.getElementById('timeline'),
};

elements.platformBadge.textContent = `${Capacitor.getPlatform()} / ${Capacitor.isNativePlatform() ? 'native' : 'web'}`;
elements.distanceFilter.value = String(state.config.distanceFilter);
elements.minInterval.value = String(state.config.minIntervalMs);
elements.networkFallback.checked = Boolean(state.config.networkFallback);
elements.nativeUrl.value = state.config.nativeUrl;

document.getElementById('check-permissions').addEventListener('click', checkPermissions);
document.getElementById('request-permissions').addEventListener('click', requestPermissions);
document.getElementById('open-settings').addEventListener('click', runAction('open settings', () => BackgroundGeolocation.openSettings()));
elements.startForeground.addEventListener('click', () => startTracking('foreground'));
elements.startBackground.addEventListener('click', () => startTracking('background'));
elements.stop.addEventListener('click', stopTracking);
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
window.setInterval(renderStatus, 1000);

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
    renderStatus();
  });
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
  };
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(state.config));
  return state.config;
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
}

function renderVisibility() {
  elements.visibilityBadge.textContent = document.visibilityState;
  elements.visibilityBadge.dataset.state = document.visibilityState;
}

function renderStatus() {
  elements.trackingStatus.textContent = state.active ? `Active (${state.mode})` : 'Inactive / unknown natively';
  elements.trackingStatus.dataset.active = String(state.active);
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
  elements.startForeground.disabled = state.active;
  elements.startBackground.disabled = state.active;
  elements.stop.disabled = !state.active;
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
