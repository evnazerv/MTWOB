/**
 * NodeTelehealth Marketing — Electron main process.
 *  • Owns ALL network access: the renderer talks to the Apps Script backend only through IPC.
 *  • Stores the Web App URL + handshake token (token encrypted with the macOS Keychain via safeStorage).
 *  • Menu-bar tray with live status and the Emergency Hard-Off Kill Switch.
 *  • 30-second heartbeat → status push to the window + native notifications for backend events.
 *  • Local report export (CSV / JSON / PDF) and a media cache for the inline audio/video player.
 */
'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, dialog, shell, nativeImage, safeStorage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const HEARTBEAT_MS = 30000;
const LONG_ACTIONS = new Set(['runGenerateNow', 'generateOnDemand', 'regenerateItem', 'approveItem', 'rerenderVideo', 'publishNow', 'runPublishNow', 'pollVideosNow', 'harvestNow', 'researchKeywords']);

let win = null;
let tray = null;
let quitting = false;
let heartbeatTimer = null;
let lastEventTs = null;
let status = { connected: false, configured: false, kill_switch: 'UNKNOWN', system_status: 'NOT CONNECTED', trigger_count: 0, workflow_mode: '', last_ok: null, error: '' };

/* ───────────────────────── Connection settings ───────────────────────── */

const configPath = () => path.join(app.getPath('userData'), 'connection.json');

function readConnection() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    let token = '';
    if (raw.tokenEnc && safeStorage.isEncryptionAvailable()) token = safeStorage.decryptString(Buffer.from(raw.tokenEnc, 'base64'));
    else if (raw.tokenPlain) token = raw.tokenPlain;
    return { url: raw.url || '', token };
  } catch (e) {
    return { url: '', token: '' };
  }
}

function writeConnection(url, token) {
  const data = { url };
  if (safeStorage.isEncryptionAvailable()) data.tokenEnc = safeStorage.encryptString(token).toString('base64');
  else data.tokenPlain = token; // only when no OS keychain is available (never the case on macOS)
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(data), { mode: 0o600 });
}

function validateBackendUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { return 'Enter the full Web App URL.'; }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol === 'https:' && u.hostname === 'script.google.com' && /^\/macros\/s\/[\w-]+\/exec$/.test(u.pathname)) return '';
  if (local && u.protocol === 'http:') return ''; // local development harness
  return 'The URL must look like https://script.google.com/macros/s/…/exec';
}

/* ───────────────────────── Backend client ───────────────────────── */

async function callBackend(action, payload, override) {
  const conn = override || readConnection();
  if (!conn.url || !conn.token) return { ok: false, status: 0, code: 'NOT_CONFIGURED', error: 'Connect the backend in Settings first.' };
  const invalid = validateBackendUrl(conn.url);
  if (invalid) return { ok: false, status: 0, code: 'BAD_URL', error: invalid };
  try {
    // Apps Script answers POSTs with a 302 to script.googleusercontent.com; fetch follows it.
    // Apps Script cannot read request headers, so the token is verified from the JSON body.
    const res = await fetch(conn.url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8', Authorization: 'Bearer ' + conn.token },
      body: JSON.stringify({ token: conn.token, action, payload: payload || {} }),
      signal: AbortSignal.timeout(LONG_ACTIONS.has(action) ? 345000 : 60000)
    });
    const text = await res.text();
    try {
      const envelope = JSON.parse(text);
      if (envelope && typeof envelope.ok === 'boolean') return envelope;
    } catch (e) { /* fall through */ }
    return { ok: false, status: res.status, code: 'BAD_RESPONSE', error: /<html/i.test(text)
      ? 'Google returned a web page instead of JSON. Deploy the Web App with "Execute as: Me" and "Who has access: Anyone", then use the /exec URL.'
      : 'Unexpected response from the backend (HTTP ' + res.status + ').' };
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return { ok: false, status: 0, code: timeout ? 'TIMEOUT' : 'NETWORK', error: timeout ? 'The backend did not answer in time. Long jobs keep running on Google\'s side — refresh in a minute.' : 'Cannot reach the backend: ' + err.message };
  }
}

/* ───────────────────────── Status, heartbeat, notifications ───────────────────────── */

function pushStatus(patch) {
  status = { ...status, ...patch };
  if (win && !win.isDestroyed()) win.webContents.send('status:update', status);
  refreshTray();
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: body || '', silent: false });
  n.on('click', () => { showWindow(); if (onClick) onClick(); });
  n.show();
}

async function heartbeat() {
  const conn = readConnection();
  if (!conn.url || !conn.token) return pushStatus({ configured: false, connected: false, system_status: 'NOT CONNECTED', kill_switch: 'UNKNOWN', error: '' });
  const res = await callBackend('heartbeat', { since: lastEventTs || '9999' });
  if (!res.ok) return pushStatus({ configured: true, connected: false, error: res.error, system_status: 'OFFLINE' });
  const d = res.data;
  const wasHalted = status.kill_switch;
  if (lastEventTs !== null) {
    d.events.forEach((ev) => {
      const prefix = { PUBLISHED: '✅ ', RENDERED: '🎬 ', ERROR: '⚠️ ', COMPLIANCE: '🛡 ', DRAFT: '📝 ' }[ev.type] || '';
      if (['PUBLISHED', 'RENDERED', 'ERROR', 'COMPLIANCE', 'DRAFT'].includes(ev.type)) {
        notify(prefix + ev.title, ev.body, () => { if (ev.queue_id && win) win.webContents.send('navigate', { view: 'studio', id: ev.queue_id }); });
      }
    });
    if (wasHalted !== 'UNKNOWN' && wasHalted !== d.kill_switch) {
      notify(d.kill_switch === 'ON' ? '⛔ System HARD STOPPED' : '▶️ System resumed', d.kill_switch === 'ON' ? 'All triggers deleted. No jobs will run.' : 'Background triggers restored.');
    }
    if (d.events.length && win && !win.isDestroyed()) win.webContents.send('backend:events', d.events);
  }
  lastEventTs = d.events.length ? d.events[d.events.length - 1].ts : (lastEventTs || d.server_time);
  pushStatus({ configured: true, connected: true, error: '', last_ok: Date.now(), kill_switch: d.kill_switch, system_status: d.system_status, trigger_count: d.trigger_count, triggers_healthy: d.triggers_healthy, workflow_mode: d.workflow_mode });
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  lastEventTs = null;
  heartbeat();
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
}

/* ───────────────────────── Kill switch (single code path for window + tray) ───────────────────────── */

async function toggleKillSwitch(engage) {
  const opts = engage
    ? { type: 'warning', buttons: ['Cancel', 'HARD OFF — Halt Everything'], defaultId: 0, cancelId: 0, message: 'Engage EMERGENCY HARD OFF?',
        detail: 'This immediately deletes every scheduled trigger on Google\'s servers and blocks all Claude, ElevenLabs, HeyGen/Creatomate, CMS and social API calls.\n\nNothing will be generated, rendered or published until you resume.' }
    : { type: 'question', buttons: ['Cancel', 'Resume System'], defaultId: 0, cancelId: 0, message: 'Resume the marketing system?',
        detail: 'Scheduled triggers will be restored. Enabled tools will start generating and publishing again on their normal schedule.' };
  const choice = (win && !win.isDestroyed() && win.isVisible()) ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (choice.response !== 1) return { cancelled: true };
  const res = await callBackend('setKillSwitch', { engaged: engage });
  if (res.ok) {
    pushStatus({ connected: true, kill_switch: res.data.kill_switch, system_status: res.data.system_status, trigger_count: res.data.triggers.count, last_ok: Date.now() });
    notify(engage ? '⛔ System HARD STOPPED' : '▶️ System resumed', engage ? 'All triggers deleted. No jobs will run.' : res.data.triggers.count + ' background triggers restored.');
  } else {
    dialog.showErrorBox('Kill Switch', 'The backend could not be reached, so the switch state did NOT change.\n\n' + res.error);
  }
  return res;
}

/* ───────────────────────── Tray ───────────────────────── */

function trayImage(halted) {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', halted ? 'trayHalted.png' : 'trayTemplate.png'));
  if (!halted) img.setTemplateImage(true);
  return img;
}

function refreshTray() {
  if (!tray) return;
  const halted = status.kill_switch === 'ON';
  const live = status.connected && !halted;
  tray.setImage(trayImage(halted));
  if (process.platform === 'darwin') tray.setTitle(halted ? ' HALTED' : '');
  tray.setToolTip('NodeTelehealth Marketing — ' + status.system_status);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: (halted ? '⛔  ' : live ? '🟢  ' : '⚪️  ') + status.system_status + (live ? ' · ' + status.trigger_count + ' triggers' : ''), enabled: false },
    { label: status.workflow_mode ? 'Mode: ' + (status.workflow_mode === 'AUTONOMOUS' ? 'Autonomous' : 'Human-in-the-Loop Approval') : 'Backend not connected', enabled: false },
    { type: 'separator' },
    halted
      ? { label: 'Resume System…', enabled: status.connected, click: () => toggleKillSwitch(false) }
      : { label: 'EMERGENCY HARD OFF…', enabled: status.connected, click: () => toggleKillSwitch(true) },
    { type: 'separator' },
    { label: 'Open Dashboard', click: showWindow },
    { label: 'Refresh Status', click: heartbeat },
    { type: 'separator' },
    { label: 'Quit NodeTelehealth Marketing', click: () => { quitting = true; app.quit(); } }
  ]));
}

/* ───────────────────────── Window ───────────────────────── */

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 1080, minHeight: 700,
    title: 'NodeTelehealth Marketing',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => win.webContents.send('status:update', status));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (!quitting && process.platform === 'darwin') { e.preventDefault(); win.hide(); } // keep running in the menu bar
  });
}

/* ───────────────────────── Report export ───────────────────────── */

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))).join('\n');
}

function reportCsv(d) {
  const k = d.dashboard.kpis;
  const sections = [
    'NodeTelehealth Marketing Report,' + d.dashboard.generated_at + ',last ' + d.dashboard.range_days + ' days',
    '', 'SUMMARY', toCsv(Object.keys(k).map((key) => ({ metric: key, value: k[key] }))),
    '', 'CHANNELS', toCsv(d.dashboard.channels),
    '', 'FLORIDA METROS', toCsv(d.dashboard.metros),
    '', 'A/B HOOK TESTS', toCsv(d.dashboard.ab_tests),
    '', 'API RELIABILITY', toCsv(d.dashboard.reliability),
    '', 'ESTIMATED API COST BY SERVICE (USD)', toCsv(Object.keys(d.dashboard.costs.by_service).map((s) => ({ service: s, est_cost_usd: d.dashboard.costs.by_service[s] }))),
    '', 'PUBLISHED LOG', toCsv(d.published),
    '', 'API COST LOG', toCsv(d.costs)
  ];
  return sections.join('\n');
}

async function exportReport({ format, days }) {
  const stamp = new Date().toISOString().slice(0, 10);
  const pick = await dialog.showSaveDialog(win, {
    title: 'Export report', defaultPath: path.join(app.getPath('documents'), `NodeTelehealth-report-${stamp}.${format}`),
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  });
  if (pick.canceled || !pick.filePath) return { ok: false, cancelled: true };
  if (format === 'pdf') {
    const pdf = await win.webContents.printToPDF({ landscape: true, printBackground: true, pageSize: 'Letter' });
    fs.writeFileSync(pick.filePath, pdf);
  } else {
    const res = await callBackend('exportReport', { days });
    if (!res.ok) return res;
    fs.writeFileSync(pick.filePath, format === 'csv' ? reportCsv(res.data) : JSON.stringify(res.data, null, 2));
  }
  notify('Report exported', path.basename(pick.filePath));
  shell.showItemInFolder(pick.filePath);
  return { ok: true, path: pick.filePath };
}

/* ───────────────────────── Media cache (inline audio/video preview) ───────────────────────── */

/** Downloads a rendered MP3/MP4 from Google Drive once and hands the renderer a local file URL. */
async function cacheMedia(url) {
  let u;
  try { u = new URL(url); } catch (e) { return { ok: false, error: 'Invalid media URL' }; }
  if (u.protocol !== 'https:' || !/(^|\.)google\.com$|(^|\.)googleusercontent\.com$/.test(u.hostname)) return { ok: false, error: 'Only Google Drive media can be previewed' };
  const dir = path.join(app.getPath('userData'), 'media-cache');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, crypto.createHash('sha256').update(url).digest('hex').slice(0, 32));
  const existing = ['.mp4', '.mp3'].map((ext) => base + ext).find((f) => fs.existsSync(f));
  if (existing) return { ok: true, fileUrl: pathToFileURL(existing).href };
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || /text\/html/i.test(type)) return { ok: false, error: 'Drive did not return a media file. Check that the file is shared as "Anyone with the link".' };
    const file = base + (/audio/i.test(type) ? '.mp3' : '.mp4');
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return { ok: true, fileUrl: pathToFileURL(file).href };
  } catch (err) {
    return { ok: false, error: 'Download failed: ' + err.message };
  }
}

/* ───────────────────────── IPC ───────────────────────── */

function registerIpc() {
  ipcMain.handle('conn:get', () => { const c = readConnection(); return { url: c.url, hasToken: !!c.token }; });
  ipcMain.handle('conn:save', async (_e, { url, token }) => {
    url = String(url || '').trim();
    const current = readConnection();
    token = String(token || '').trim() || current.token; // blank token = keep the stored one
    const invalid = validateBackendUrl(url);
    if (invalid) return { ok: false, error: invalid };
    if (!token) return { ok: false, error: 'Enter the handshake token printed by initializeSystem().' };
    const res = await callBackend('getState', {}, { url, token });
    if (!res.ok) return { ok: false, error: res.status === 401 ? 'The backend rejected this handshake token.' : res.error };
    writeConnection(url, token);
    startHeartbeat();
    return { ok: true, state: res.data };
  });
  ipcMain.handle('api:call', (_e, action, payload) => callBackend(String(action), payload));
  ipcMain.handle('kill:toggle', (_e, engage) => toggleKillSwitch(!!engage));
  ipcMain.handle('status:get', () => status);
  ipcMain.handle('status:refresh', async () => { await heartbeat(); return status; });
  ipcMain.handle('report:export', (_e, opts) => exportReport({ format: ['csv', 'json', 'pdf'].includes(opts && opts.format) ? opts.format : 'csv', days: Number(opts && opts.days) || 30 }));
  ipcMain.handle('media:cache', (_e, url) => cacheMedia(String(url)));
  ipcMain.handle('open:external', (_e, url) => { if (/^https:\/\//i.test(String(url))) shell.openExternal(String(url)); });
  ipcMain.handle('confirm', async (_e, message, okLabel) => {
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Cancel', String(okLabel || 'Continue')], defaultId: 1, cancelId: 0, message: String(message) });
    return r.response === 1;
  });
  ipcMain.handle('notify', (_e, title, body) => notify(String(title), String(body || '')));
}

/* ───────────────────────── Install helpers (packaged macOS app only) ───────────────────────── */

/** …/NodeTelehealth Marketing.app/Contents/MacOS/<exe> → …/NodeTelehealth Marketing.app */
const appBundlePath = () => path.resolve(app.getPath('exe'), '..', '..', '..');

/**
 * Puts a "NodeTelehealth Marketing" icon on the Desktop (a symlink to the installed app, which
 * Finder shows with the app's own icon). Never overwrites a real file of the same name.
 */
function createDesktopShortcut(announce) {
  const link = path.join(app.getPath('desktop'), app.getName() + '.app');
  try {
    let st = null;
    try { st = fs.lstatSync(link); } catch (e) { st = null; }
    if (st && !st.isSymbolicLink()) {
      if (announce) dialog.showMessageBox({ type: 'info', message: 'Something named "' + path.basename(link) + '" is already on your Desktop, so no shortcut was added.' });
      return false;
    }
    if (st) fs.unlinkSync(link);
    fs.symlinkSync(appBundlePath(), link);
    if (announce) notify('Desktop shortcut created', 'Double-click "' + app.getName() + '" on your Desktop to open the app.');
    return true;
  } catch (err) {
    if (announce) dialog.showErrorBox('Desktop shortcut', 'Could not create the Desktop shortcut: ' + err.message + '\n\nIf macOS asked for access to your Desktop folder, allow it and try again from System → Create Desktop Shortcut.');
    return false;
  }
}

/**
 * First launch of the packaged app: offer to move itself into Applications (when opened from the
 * .dmg or Downloads), then add the Desktop shortcut once. Returns true if the app is relaunching.
 */
function firstRunInstall() {
  if (!app.isPackaged || process.platform !== 'darwin') return false;
  if (!app.isInApplicationsFolder()) {
    const choice = dialog.showMessageBoxSync({
      type: 'question', buttons: ['Move to Applications', 'Not Now'], defaultId: 0, cancelId: 1,
      message: 'Move NodeTelehealth Marketing to your Applications folder?',
      detail: 'This installs the app properly and adds a shortcut to your Desktop.'
    });
    if (choice === 0) {
      try { if (app.moveToApplicationsFolder()) return true; } // relaunches from /Applications
      catch (err) { dialog.showErrorBox('Move to Applications', err.message); }
    }
    return false;
  }
  const flag = path.join(app.getPath('userData'), 'desktop-shortcut.done');
  if (!fs.existsSync(flag)) {
    createDesktopShortcut(false);
    try { fs.mkdirSync(path.dirname(flag), { recursive: true }); fs.writeFileSync(flag, new Date().toISOString()); } catch (e) { /* retried next launch */ }
  }
  return false;
}

/* ───────────────────────── App lifecycle ───────────────────────── */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    if (firstRunInstall()) return;
    registerIpc();
    createWindow();
    tray = new Tray(trayImage(false));
    tray.on('click', () => { if (process.platform !== 'darwin') showWindow(); });
    refreshTray();
    startHeartbeat();
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' }, { role: 'editMenu' },
        { label: 'System', submenu: [
          { label: 'EMERGENCY HARD OFF…', accelerator: 'Cmd+Shift+K', click: () => toggleKillSwitch(true) },
          { label: 'Resume System…', click: () => toggleKillSwitch(false) },
          { type: 'separator' },
          { label: 'Refresh Status', accelerator: 'Cmd+R', click: heartbeat },
          { type: 'separator' },
          { label: 'Create Desktop Shortcut', enabled: app.isPackaged, click: () => createDesktopShortcut(true) }
        ] },
        { role: 'windowMenu' }
      ]));
    }
    app.on('activate', showWindow);
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
