/**
 * NodeTelehealth Marketing Automation — Code.gs
 * Router (doGet/doPost), handshake auth, spreadsheet + Drive auto-initializer,
 * script-property helpers and the Google Sheets "database" layer.
 *
 * NOTE ON HTTP SEMANTICS: Apps Script web apps cannot read request headers and
 * cannot set HTTP status codes. The handshake token therefore travels in the
 * JSON body (or ?token= on GET) and every response is HTTP 200 carrying an
 * envelope: { ok, status, code, error, data }. "423 Locked / SYSTEM_HALTED" is
 * reported as { ok:false, status:423, code:"SYSTEM_HALTED" }.
 */

var APP = {
  NAME: 'NodeTelehealth Marketing Automation',
  VERSION: '1.0.0',
  SITE: 'https://nodetelehealth.com',
  SPREADSHEET_NAME: 'NodeTelehealth_Marketing_DB',
  DRIVE_FOLDER: 'NodeTelehealth_Media_Assets',
  SUBFOLDERS: ['Voiceovers', 'Videos', 'Blog_Covers', 'Broll', 'Payloads']
};

var TABS = {
  CONFIG: 'Config',
  TOOL_STATES: 'Tool_States',
  QUEUE: 'Content_Queue',
  VIDEO_JOBS: 'Video_Render_Jobs',
  PUBLISHED: 'Published_Logs',
  METRICS: 'Analytics_Metrics',
  KEYWORDS: 'Florida_Keywords',
  COSTS: 'API_Cost_Log'
};

var SCHEMA = {
  Config: ['key', 'value', 'updated_at'],
  Tool_States: ['tool_key', 'label', 'group', 'enabled', 'status', 'last_run', 'runs', 'usage_units', 'usage_unit_type', 'est_cost_usd', 'updated_at'],
  Content_Queue: ['id', 'campaign_id', 'created_at', 'updated_at', 'type', 'platform', 'status', 'approved', 'scheduled_at', 'pillar', 'metro', 'keyword', 'title', 'hook_variant', 'payload_json', 'audio_file_id', 'audio_url', 'video_file_id', 'video_url', 'cms_id', 'published_url', 'error'],
  Video_Render_Jobs: ['id', 'queue_id', 'provider', 'job_id', 'status', 'submitted_at', 'updated_at', 'attempts', 'video_url', 'duration_sec', 'error'],
  Published_Logs: ['id', 'ts', 'queue_id', 'type', 'platform', 'external_id', 'url', 'title', 'metro', 'pillar', 'keyword', 'hook_variant', 'hook_text', 'status', 'error'],
  Analytics_Metrics: ['ts', 'date', 'source', 'queue_id', 'external_id', 'metro', 'pillar', 'hook_variant', 'impressions', 'views', 'clicks', 'likes', 'comments', 'shares', 'watch_through', 'sessions', 'engaged_sessions', 'conversions'],
  Florida_Keywords: ['id', 'keyword', 'metro', 'pillar', 'intent', 'topic_idea', 'difficulty', 'source', 'used_count', 'last_used', 'created_at'],
  API_Cost_Log: ['ts', 'date', 'service', 'tool_key', 'operation', 'units', 'unit_type', 'est_cost_usd', 'ok', 'queue_id', 'detail']
};

/** Keys the desktop app may write via saveSecrets. secret:true values are never returned. */
var SECRET_FIELDS = {
  CLAUDE_API_KEY: true,
  WP_SITE_URL: false, WP_USERNAME: false, WP_APP_PASSWORD: true,
  WEBFLOW_API_TOKEN: true, WEBFLOW_COLLECTION_ID: false, WEBFLOW_SITE_URL: false,
  CMS_WEBHOOK_URL: true,
  ELEVENLABS_API_KEY: true, ELEVENLABS_VOICE_ID: false,
  HEYGEN_API_KEY: true, HEYGEN_AVATAR_ID: false, HEYGEN_VOICE_ID: false,
  CREATOMATE_API_KEY: true, CREATOMATE_TEMPLATE_ID: false,
  JSON2VIDEO_API_KEY: true, PEXELS_API_KEY: true,
  META_PAGE_ID: false, META_PAGE_ACCESS_TOKEN: true, IG_USER_ID: false,
  X_API_KEY: true, X_API_SECRET: true, X_ACCESS_TOKEN: true, X_ACCESS_SECRET: true,
  LINKEDIN_ACCESS_TOKEN: true, LINKEDIN_ORG_ID: false,
  YT_CLIENT_ID: false, YT_CLIENT_SECRET: true, YT_REFRESH_TOKEN: true,
  TIKTOK_CLIENT_KEY: false, TIKTOK_CLIENT_SECRET: true, TIKTOK_ACCESS_TOKEN: true, TIKTOK_REFRESH_TOKEN: true,
  GBP_ACCOUNT_ID: false, GBP_LOCATION_ID: false,
  SOCIAL_WEBHOOK_URL: true,
  GA4_PROPERTY_ID: false
};

function defaultConfig_() {
  return {
    workflow_mode: 'APPROVAL',            // AUTONOMOUS | APPROVAL
    video_mode: 'SCRIPT_ONLY',            // HEYGEN_AVATAR | FACELESS_BROLL | SCRIPT_ONLY
    faceless_provider: 'CREATOMATE',      // CREATOMATE | JSON2VIDEO
    cms_provider: 'WORDPRESS',            // WORDPRESS | WEBFLOW | WEBHOOK
    claude_model: 'claude-sonnet-4-6',    // claude-sonnet-4-6 | claude-opus-4-6
    elevenlabs_model: 'eleven_flash_v2_5',// eleven_flash_v2_5 | eleven_turbo_v2_5
    cta_url: 'https://nodetelehealth.com/', // where blog/social calls to action point
    webflow_blog_path: '/blog/',
    webflow_field_map: { body: 'post-body', summary: 'post-summary', seo_description: 'seo-description' },
    frequency: { BLOG: 2, FACEBOOK: 4, INSTAGRAM: 3, X_TWITTER: 5, LINKEDIN: 3, YOUTUBE_SHORTS: 2, TIKTOK: 3, GOOGLE_BUSINESS: 2 },
    metro_weights: { 'Miami': 20, 'Orlando': 15, 'Tampa': 15, 'Jacksonville': 10, 'Sarasota / Venice': 10, 'Fort Lauderdale': 8, 'Naples / Fort Myers': 8, 'The Villages': 6, 'Tallahassee': 4, 'Pensacola': 4 },
    pillar_weights: { 'Urgent Care': 30, 'Chronic Care Management': 25, 'Mental Health': 25, 'Prescription Refills': 20 },
    posting_hours_et: [8, 12, 18],
    triggers: { generate_every_hours: 6, publish_every_minutes: 15, poll_every_minutes: 5, analytics_every_hours: 12 },
    cost: { elevenlabs_per_1k_chars: 0.10, heygen_per_minute: 1.00, creatomate_per_video: 0.10, json2video_per_video: 0.10, equiv_cpm_usd: 12, equiv_cpc_usd: 2.5 }
  };
}

/* ───────────────────────── Script property helpers ───────────────────────── */

var PROP_MEMO_ = null;

function props_() { return PropertiesService.getScriptProperties(); }

function allProps_() {
  if (!PROP_MEMO_) PROP_MEMO_ = props_().getProperties();
  return PROP_MEMO_;
}

function getProp_(key, fallback) {
  var v = allProps_()[key];
  return (v === undefined || v === null || v === '') ? fallback : v;
}

function setProp_(key, value) {
  props_().setProperty(key, String(value));
  if (PROP_MEMO_) PROP_MEMO_[key] = String(value);
}

function deleteProp_(key) {
  props_().deleteProperty(key);
  if (PROP_MEMO_) delete PROP_MEMO_[key];
}

function getJsonProp_(key, fallback) {
  var raw = getProp_(key, null);
  if (raw === null) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

function setJsonProp_(key, obj) { setProp_(key, JSON.stringify(obj)); }

function nowIso_() { return new Date().toISOString(); }
function today_() { return Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd'); }
function uid_(prefix) { return (prefix || 'id') + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16); }
function truthy_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || v === 'ON'; }
function num_(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function trimSlash_(s) { return String(s || '').replace(/\/+$/, ''); }

function appError_(status, code, message) {
  var err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

/* ───────────────────────────── Configuration ───────────────────────────── */

function getConfig() {
  return mergeConfig_(defaultConfig_(), getJsonProp_('APP_CONFIG', {}));
}

/** Deep-merge `patch` into `base`, accepting only keys/types that exist in the default config. */
function mergeConfig_(base, patch) {
  var out = JSON.parse(JSON.stringify(base));
  var openMaps = { metro_weights: 1, pillar_weights: 1, webflow_field_map: 1 };
  Object.keys(patch || {}).forEach(function (k) {
    if (!(k in base)) return;
    var b = base[k], p = patch[k];
    if (Array.isArray(b)) { if (Array.isArray(p)) out[k] = p; return; }
    if (b && typeof b === 'object') {
      if (!p || typeof p !== 'object') return;
      if (openMaps[k]) { if (Object.keys(p).length) out[k] = p; return; }
      Object.keys(b).forEach(function (kk) { if (typeof p[kk] === typeof b[kk]) out[k][kk] = p[kk]; });
      return;
    }
    if (typeof p === typeof b) out[k] = p;
  });
  return out;
}

function saveConfig(payload) {
  var before = getConfig();
  var cfg = mergeConfig_(before, payload || {});
  var enums = {
    workflow_mode: ['AUTONOMOUS', 'APPROVAL'],
    video_mode: ['HEYGEN_AVATAR', 'FACELESS_BROLL', 'SCRIPT_ONLY'],
    faceless_provider: ['CREATOMATE', 'JSON2VIDEO'],
    cms_provider: ['WORDPRESS', 'WEBFLOW', 'WEBHOOK'],
    claude_model: ['claude-sonnet-4-6', 'claude-opus-4-6'],
    elevenlabs_model: ['eleven_flash_v2_5', 'eleven_turbo_v2_5']
  };
  Object.keys(enums).forEach(function (k) {
    if (enums[k].indexOf(cfg[k]) === -1) throw appError_(400, 'BAD_CONFIG', 'Invalid value for ' + k);
  });
  var t = cfg.triggers;
  if ([1, 2, 4, 6, 8, 12].indexOf(t.generate_every_hours) === -1 || [1, 2, 4, 6, 8, 12].indexOf(t.analytics_every_hours) === -1 ||
      [1, 5, 10, 15, 30].indexOf(t.publish_every_minutes) === -1 || [1, 5, 10, 15, 30].indexOf(t.poll_every_minutes) === -1) {
    throw appError_(400, 'BAD_CONFIG', 'Trigger intervals must be 1/5/10/15/30 minutes or 1/2/4/6/8/12 hours');
  }
  setJsonProp_('APP_CONFIG', cfg);
  syncConfigSheet_(cfg);
  if (JSON.stringify(before.triggers) !== JSON.stringify(cfg.triggers) && !isSystemHalted_()) rebuildTriggers_();
  return cfg;
}

function saveSecrets(payload) {
  var saved = [];
  Object.keys(payload || {}).forEach(function (k) {
    if (!(k in SECRET_FIELDS)) return;
    var v = payload[k];
    if (v === null) { deleteProp_(k); saved.push(k); return; }
    if (typeof v !== 'string' || v.trim() === '') return; // blank = leave unchanged
    setProp_(k, v.trim());
    saved.push(k);
  });
  syncToolStatesSheet_();
  return { saved: saved, secrets: getSecretStatus() };
}

/** Secrets are write-only: only "is it set" + last 4 chars come back. Non-secret IDs are returned in clear. */
function getSecretStatus() {
  var out = {};
  Object.keys(SECRET_FIELDS).forEach(function (k) {
    var v = getProp_(k, '');
    if (SECRET_FIELDS[k]) out[k] = { set: !!v, hint: v ? '••••' + String(v).slice(-4) : '' };
    else out[k] = { set: !!v, value: v };
  });
  return out;
}

/* ───────────────────────────── Sheets database ───────────────────────────── */

var SS_MEMO_ = null;

function ss_() {
  if (SS_MEMO_) return SS_MEMO_;
  var id = getProp_('SPREADSHEET_ID', null);
  if (!id) throw appError_(503, 'NOT_INITIALIZED', 'Run initializeSystem() in the Apps Script editor first.');
  SS_MEMO_ = SpreadsheetApp.openById(id);
  return SS_MEMO_;
}

function sheet_(tab) {
  var sh = ss_().getSheetByName(tab);
  return sh || ensureTab_(ss_(), tab);
}

function ensureTab_(ss, tab) {
  var headers = SCHEMA[tab];
  var sh = ss.getSheetByName(tab);
  if (!sh) sh = ss.insertSheet(tab);
  // Plain-text format keeps long numeric IDs (tweet ids, etc.) and ISO dates from being mangled.
  sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  sh.setFrozenRows(1);
  return sh;
}

function cell_(v) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function dbReadAll_(tab) {
  var values = sheet_(tab).getDataRange().getValues();
  var headers = SCHEMA[tab];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.join('') === '') continue;
    var obj = { _row: r + 1 };
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = cell_(row[c]);
    out.push(obj);
  }
  return out;
}

function dbAppend_(tab, obj) {
  sheet_(tab).appendRow(SCHEMA[tab].map(function (h) { return cell_(obj[h]); }));
  return obj;
}

function dbAppendMany_(tab, objs) {
  if (!objs.length) return;
  var headers = SCHEMA[tab];
  var sh = sheet_(tab);
  var rows = objs.map(function (o) { return headers.map(function (h) { return cell_(o[h]); }); });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

function dbFind_(tab, id) {
  var rows = dbReadAll_(tab);
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
  return null;
}

function dbUpdate_(tab, id, patch) {
  var row = dbFind_(tab, id);
  if (!row) throw appError_(404, 'NOT_FOUND', tab + ' row not found: ' + id);
  var headers = SCHEMA[tab];
  Object.keys(patch).forEach(function (k) { if (headers.indexOf(k) !== -1) row[k] = cell_(patch[k]); });
  if (headers.indexOf('updated_at') !== -1) row.updated_at = nowIso_();
  sheet_(tab).getRange(row._row, 1, 1, headers.length).setValues([headers.map(function (h) { return row[h]; })]);
  return row;
}

function dbDelete_(tab, id) {
  var row = dbFind_(tab, id);
  if (row) sheet_(tab).deleteRow(row._row);
  return !!row;
}

function dbReplaceAll_(tab, objs) {
  var headers = SCHEMA[tab];
  var sh = sheet_(tab);
  sh.clearContents();
  var rows = [headers].concat(objs.map(function (o) { return headers.map(function (h) { return cell_(o[h]); }); }));
  sh.getRange(1, 1, rows.length, headers.length).setValues(rows);
}

function syncConfigSheet_(cfg) {
  cfg = cfg || getConfig();
  var ts = nowIso_();
  var rows = Object.keys(cfg).map(function (k) { return { key: k, value: cfg[k], updated_at: ts }; });
  rows.push({ key: 'MASTER_KILL_SWITCH', value: getProp_('MASTER_KILL_SWITCH', 'OFF'), updated_at: ts });
  dbReplaceAll_(TABS.CONFIG, rows);
}

/* ───────────────────────────── Drive helpers ───────────────────────────── */

function mediaFolder_(sub) {
  var root = DriveApp.getFolderById(getProp_('DRIVE_FOLDER_ID', ''));
  if (!sub) return root;
  var it = root.getFoldersByName(sub);
  return it.hasNext() ? it.next() : root.createFolder(sub);
}

/** Saves a blob under NodeTelehealth_Media_Assets/<sub>, shares it "anyone with link" and returns ids/urls. */
function saveMediaToDrive_(blob, name, sub) {
  var file = mediaFolder_(sub).createFile(blob.setName(name));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { fileId: file.getId(), url: driveDirectUrl_(file.getId()), size: file.getSize() };
}

function driveDirectUrl_(fileId) { return 'https://drive.google.com/uc?export=download&id=' + fileId; }

/* ───────────────────────────── Initializer ───────────────────────────── */

/**
 * Run ONCE from the Apps Script editor (also grants OAuth scopes). Idempotent:
 * creates/repairs the spreadsheet tabs, the Drive folder tree, the handshake
 * token, default toggles (all OFF) and the time-driven triggers.
 */
function initializeSystem() {
  var p = allProps_();
  var ss = null;
  if (p.SPREADSHEET_ID) { try { ss = SpreadsheetApp.openById(p.SPREADSHEET_ID); } catch (e) { ss = null; } }
  if (!ss) { try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e2) { ss = null; } }
  if (!ss) ss = SpreadsheetApp.create(APP.SPREADSHEET_NAME);
  setProp_('SPREADSHEET_ID', ss.getId());
  SS_MEMO_ = ss;
  Object.keys(SCHEMA).forEach(function (tab) { ensureTab_(ss, tab); });
  var blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0) ss.deleteSheet(blank);

  var folder = null;
  if (p.DRIVE_FOLDER_ID) { try { folder = DriveApp.getFolderById(p.DRIVE_FOLDER_ID); } catch (e3) { folder = null; } }
  if (!folder) {
    var it = DriveApp.getFoldersByName(APP.DRIVE_FOLDER);
    folder = it.hasNext() ? it.next() : DriveApp.createFolder(APP.DRIVE_FOLDER);
  }
  setProp_('DRIVE_FOLDER_ID', folder.getId());
  APP.SUBFOLDERS.forEach(function (s) { mediaFolder_(s); });

  if (!getProp_('HANDSHAKE_TOKEN', null)) {
    setProp_('HANDSHAKE_TOKEN', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  }
  if (!getProp_('MASTER_KILL_SWITCH', null)) setProp_('MASTER_KILL_SWITCH', 'OFF');
  toolRegistry_().forEach(function (t) { if (!getProp_(t.key, null)) setProp_(t.key, 'OFF'); });
  if (!getProp_('APP_CONFIG', null)) setJsonProp_('APP_CONFIG', defaultConfig_());

  seedKeywords_();
  syncConfigSheet_();
  syncToolStatesSheet_();
  if (!isSystemHalted_()) rebuildTriggers_();

  var summary = {
    spreadsheet_url: ss.getUrl(),
    drive_folder_url: folder.getUrl(),
    handshake_token: getProp_('HANDSHAKE_TOKEN', ''),
    triggers: getTriggerStatus_()
  };
  Logger.log('NodeTelehealth backend initialized:\n' + JSON.stringify(summary, null, 2));
  return summary;
}

/** Run from the editor to rotate the desktop-app handshake token. */
function rotateHandshakeToken() {
  setProp_('HANDSHAKE_TOKEN', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  Logger.log('New handshake token: ' + getProp_('HANDSHAKE_TOKEN', ''));
}

function seedKeywords_() {
  if (dbReadAll_(TABS.KEYWORDS).length) return;
  var seeds = [
    ['online urgent care Miami', 'Miami', 'Urgent Care', 'When a same-day video visit makes sense for Miami families'],
    ['telehealth doctor Orlando', 'Orlando', 'Urgent Care', 'What Orlando residents can expect from a first telehealth visit'],
    ['virtual doctor visit Tampa', 'Tampa', 'Urgent Care', 'Skipping the waiting room: virtual visits in Tampa Bay'],
    ['telehealth Jacksonville FL', 'Jacksonville', 'Chronic Care Management', 'Managing blood pressure between appointments in Jacksonville'],
    ['telehealth for seniors Sarasota', 'Sarasota / Venice', 'Chronic Care Management', 'Telehealth tips for retirees in Sarasota and Venice'],
    ['snowbird telehealth Florida', 'Naples / Fort Myers', 'Chronic Care Management', 'Staying on top of care while wintering in Florida'],
    ['hurricane season telehealth Florida', 'Tampa', 'Prescription Refills', 'Hurricane-season care continuity: a Florida checklist'],
    ['online prescription refill Florida', 'Fort Lauderdale', 'Prescription Refills', 'How routine medication refills work over telehealth in Florida'],
    ['online therapy Florida', 'Orlando', 'Mental Health', 'Starting online mental health care in Florida'],
    ['telehealth anxiety support Miami', 'Miami', 'Mental Health', 'Talking to a Florida-licensed provider about anxiety from home'],
    ['telehealth The Villages FL', 'The Villages', 'Chronic Care Management', 'Video visits for active retirement communities'],
    ['virtual urgent care Pensacola', 'Pensacola', 'Urgent Care', 'After-hours options for the Panhandle']
  ];
  dbAppendMany_(TABS.KEYWORDS, seeds.map(function (s) {
    return { id: uid_('kw'), keyword: s[0], metro: s[1], pillar: s[2], intent: 'informational', topic_idea: s[3], difficulty: '', source: 'SEED', used_count: 0, last_used: '', created_at: nowIso_() };
  }));
}

/* ───────────────────────────── Router ───────────────────────────── */

/**
 * control:true  → control-plane action, still served while the Kill Switch is engaged
 *                 (state reads, toggles, settings, dashboards). These never call a paid/external API.
 * control:false → work action; blocked with 423 SYSTEM_HALTED while halted.
 */
function routes_() {
  return {
    ping:             { control: true,  fn: function () { return { pong: true, version: APP.VERSION, time: nowIso_() }; } },
    heartbeat:        { control: true,  fn: heartbeat },
    getState:         { control: true,  fn: getState },
    setKillSwitch:    { control: true,  fn: setKillSwitch },
    getToolStates:    { control: true,  fn: getToolStates },
    setToolState:     { control: true,  fn: setToolState },
    getConfig:        { control: true,  fn: getConfig },
    saveConfig:       { control: true,  fn: saveConfig },
    saveSecrets:      { control: true,  fn: saveSecrets },
    getSecretStatus:  { control: true,  fn: getSecretStatus },
    getDashboard:     { control: true,  fn: getDashboard },
    exportReport:     { control: true,  fn: exportReport },
    getQueue:         { control: true,  fn: getQueue },
    getQueueItem:     { control: true,  fn: getQueueItem },
    updateQueueItem:  { control: true,  fn: updateQueueItem },
    deleteQueueItem:  { control: true,  fn: deleteQueueItem },
    getKeywords:      { control: true,  fn: function () { return dbReadAll_(TABS.KEYWORDS); } },
    // ── work actions (blocked while halted) ──
    approveItem:      { control: false, fn: approveItem },
    publishNow:       { control: false, fn: publishNow },
    regenerateItem:   { control: false, fn: regenerateItem },
    rerenderVideo:    { control: false, fn: rerenderVideo },
    generateOnDemand: { control: false, fn: generateOnDemand },
    runGenerateNow:   { control: false, fn: function () { return runGenerateCycle_(); } },
    runPublishNow:    { control: false, fn: function () { return runPublishCycle_(); } },
    pollVideosNow:    { control: false, fn: function () { return runVideoPoll_(); } },
    harvestNow:       { control: false, fn: function () { return runAnalyticsHarvest_(); } },
    researchKeywords: { control: false, fn: function (p) { return researchFloridaKeywords_(p && p.count); } },
    testConnection:   { control: false, fn: testConnection }
  };
}

function doGet(e) {
  var params = (e && e.parameter) || {};
  return respond_(dispatch_({ token: params.token, action: params.action || 'ping', payload: {} }, true));
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return respond_(fail_(400, 'BAD_REQUEST', 'Body must be JSON: { token, action, payload }')); }
  return respond_(dispatch_(req, false));
}

function dispatch_(req, readOnly) {
  try {
    if (!authOk_(req && req.token)) return fail_(401, 'UNAUTHORIZED', 'Invalid or missing handshake token');
    var route = routes_()[req.action];
    if (!route) return fail_(404, 'UNKNOWN_ACTION', 'Unknown action: ' + req.action);
    if (readOnly && ['ping', 'heartbeat', 'getState'].indexOf(req.action) === -1) return fail_(405, 'USE_POST', 'Use POST for this action');
    if (!route.control) assertSystemActive(); // ← Kill Switch guard for every work action
    return { ok: true, status: 200, data: route.fn(req.payload || {}) };
  } catch (err) {
    if (err && err.code === 'SYSTEM_HALTED') return fail_(423, 'SYSTEM_HALTED', err.message);
    return fail_((err && err.httpStatus) || 500, (err && err.code) || 'INTERNAL', String((err && err.message) || err));
  } finally {
    try { flushRuntimeStats_(); } catch (e2) { /* stats are best-effort */ }
  }
}

function authOk_(token) {
  var expected = getProp_('HANDSHAKE_TOKEN', '');
  if (!expected || typeof token !== 'string' || token.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

function fail_(status, code, message) { return { ok: false, status: status, code: code, error: message }; }

function respond_(envelope) {
  return ContentService.createTextOutput(JSON.stringify(envelope)).setMimeType(ContentService.MimeType.JSON);
}

/** Checks one integration's credentials with a free/read-only API call. */
function testConnection(payload) {
  assertSystemActive();
  var service = String((payload && payload.service) || '').toUpperCase();
  var tests = {
    CLAUDE: testClaude_, WORDPRESS: testWordPress_, WEBFLOW: testWebflow_,
    ELEVENLABS: testElevenLabs_, HEYGEN: testHeyGen_, CREATOMATE: testCreatomate_,
    META: testMeta_, X_TWITTER: testX_, YOUTUBE: testYouTube_, GA4: testGA4_
  };
  if (!tests[service]) throw appError_(400, 'BAD_REQUEST', 'No connection test for ' + service);
  return { service: service, ok: true, detail: tests[service]() };
}
