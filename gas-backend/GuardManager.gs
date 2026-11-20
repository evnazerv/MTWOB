/**
 * GuardManager.gs — Global Hard-Off Kill Switch, per-tool toggles, trigger
 * teardown/restore, the guarded outbound-HTTP wrapper and state-sync endpoints.
 *
 * Enforcement layers (defence in depth):
 *   1. Kill Switch ON deletes every time-driven trigger → Google runs zero background jobs.
 *   2. assertSystemActive() is the first statement of every cron runner, generator, publisher
 *      and of doPost's work actions → 423 SYSTEM_HALTED.
 *   3. EVERY outbound HTTP request goes through guardedFetch_(), which re-reads the kill
 *      switch from storage and (when a tool key is given) the tool's toggle immediately
 *      before the request. A job already running when the switch is flipped stops at its
 *      next API call.
 */

var TRIGGER_HANDLERS = ['cronGenerateContent', 'cronPublishScheduled', 'cronPollVideoRenders', 'cronHarvestAnalytics'];

function toolRegistry_() {
  var cfg = getConfig();
  var cms = { WIX: [['WIX_API_KEY', 'WIX_SITE_ID', 'WIX_AUTHOR_EMAIL', 'CLAUDE_API_KEY']], WORDPRESS: [['WP_SITE_URL', 'WP_USERNAME', 'WP_APP_PASSWORD', 'CLAUDE_API_KEY']], WEBFLOW: [['WEBFLOW_API_TOKEN', 'WEBFLOW_COLLECTION_ID', 'CLAUDE_API_KEY']], WEBHOOK: [['CMS_WEBHOOK_URL', 'CLAUDE_API_KEY']] }[cfg.cms_provider];
  var video = cfg.video_mode === 'HEYGEN_AVATAR' ? [['HEYGEN_API_KEY', 'HEYGEN_AVATAR_ID']]
    : cfg.video_mode === 'FACELESS_BROLL' ? (cfg.faceless_provider === 'JSON2VIDEO' ? [['JSON2VIDEO_API_KEY']] : [['CREATOMATE_API_KEY']])
    : [];
  var hook = ['SOCIAL_WEBHOOK_URL'];
  return [
    { key: 'TOGGLE_CLAUDE_IDEATION', label: 'Claude Ideation & SEO Research', group: 'AI Engines', requires: [['CLAUDE_API_KEY']] },
    { key: 'TOGGLE_BLOG_CMS', label: 'Blog Generation & CMS Publishing (' + cfg.cms_provider + ')', group: 'CMS', requires: cms },
    { key: 'TOGGLE_ELEVENLABS_VOICE', label: 'ElevenLabs Voiceover (TTS)', group: 'AI Media', requires: [['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']] },
    { key: 'TOGGLE_VIDEO_RENDER', label: 'Video Rendering (' + cfg.video_mode + ')', group: 'AI Media', requires: video },
    { key: 'TOGGLE_FACEBOOK', label: 'Facebook Page', group: 'Social', platform: 'FACEBOOK', requires: [['META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN'], hook] },
    { key: 'TOGGLE_INSTAGRAM', label: 'Instagram Reels', group: 'Social', platform: 'INSTAGRAM', requires: [['IG_USER_ID', 'META_PAGE_ACCESS_TOKEN'], hook] },
    { key: 'TOGGLE_X_TWITTER', label: 'X / Twitter', group: 'Social', platform: 'X_TWITTER', requires: [['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'], hook] },
    { key: 'TOGGLE_LINKEDIN', label: 'LinkedIn Company Page', group: 'Social', platform: 'LINKEDIN', requires: [['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_ORG_ID'], hook] },
    { key: 'TOGGLE_YOUTUBE_SHORTS', label: 'YouTube Shorts', group: 'Social', platform: 'YOUTUBE_SHORTS', requires: [] },
    { key: 'TOGGLE_TIKTOK', label: 'TikTok', group: 'Social', platform: 'TIKTOK', requires: [['TIKTOK_ACCESS_TOKEN'], hook] },
    { key: 'TOGGLE_GOOGLE_BUSINESS', label: 'Google Business Profile', group: 'Social', platform: 'GOOGLE_BUSINESS', requires: [['GBP_ACCOUNT_ID', 'GBP_LOCATION_ID']] },
    { key: 'TOGGLE_ANALYTICS_POLLING', label: 'Analytics & Metrics Harvester', group: 'Analytics', requires: [] }
  ];
}

function platformToggle_(platform) { return 'TOGGLE_' + platform; }

/* ───────────────────────────── Kill switch ───────────────────────────── */

/** Reads the switch straight from storage (never from the per-execution memo). */
function isSystemHalted_() {
  return props_().getProperty('MASTER_KILL_SWITCH') === 'ON';
}

function assertSystemActive() {
  if (isSystemHalted_()) {
    throw appError_(423, 'SYSTEM_HALTED', 'MASTER_KILL_SWITCH is engaged — all generation, rendering, publishing and polling is halted.');
  }
}

function isToolEnabled(toolKey) {
  if (isSystemHalted_()) return false;
  return props_().getProperty(toolKey) === 'ON';
}

function requireTool_(toolKey) {
  assertSystemActive();
  if (props_().getProperty(toolKey) !== 'ON') throw appError_(409, 'TOOL_DISABLED', toolKey + ' is switched OFF');
}

function setKillSwitch(payload) {
  var engage = !!(payload && payload.engaged);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (engage) {
      setProp_('MASTER_KILL_SWITCH', 'ON');   // flip the flag first so in-flight jobs stop at their next guard
      teardownAllTriggers_();
      setProp_('KILL_SWITCH_CHANGED_AT', nowIso_());
      logEvent_('SYSTEM', 'EMERGENCY HARD OFF engaged', 'All triggers deleted. No background jobs will run.');
    } else {
      setProp_('MASTER_KILL_SWITCH', 'OFF');
      rebuildTriggers_();
      setProp_('KILL_SWITCH_CHANGED_AT', nowIso_());
      logEvent_('SYSTEM', 'System resumed', 'Time-driven triggers restored.');
    }
  } finally {
    lock.releaseLock();
  }
  try { syncConfigSheet_(); } catch (e) { /* mirror only */ }
  return getState();
}

function teardownAllTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

/** Idempotent: removes every existing trigger, then creates exactly one per handler. */
function rebuildTriggers_() {
  assertSystemActive();
  teardownAllTriggers_();
  var t = getConfig().triggers;
  ScriptApp.newTrigger('cronGenerateContent').timeBased().everyHours(t.generate_every_hours).create();
  ScriptApp.newTrigger('cronPublishScheduled').timeBased().everyMinutes(t.publish_every_minutes).create();
  ScriptApp.newTrigger('cronPollVideoRenders').timeBased().everyMinutes(t.poll_every_minutes).create();
  ScriptApp.newTrigger('cronHarvestAnalytics').timeBased().everyHours(t.analytics_every_hours).create();
}

function getTriggerStatus_() {
  var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  return {
    count: handlers.length,
    handlers: handlers,
    healthy: TRIGGER_HANDLERS.every(function (h) { return handlers.filter(function (x) { return x === h; }).length === 1; }) && handlers.length === TRIGGER_HANDLERS.length
  };
}

/* ───────────────────────────── State endpoints ───────────────────────────── */

function getState() {
  var halted = isSystemHalted_();
  var trig = getTriggerStatus_();
  return {
    app: APP.NAME, version: APP.VERSION, server_time: nowIso_(),
    kill_switch: halted ? 'ON' : 'OFF',
    system_status: halted ? 'HARD STOPPED' : (trig.count ? 'RUNNING' : 'NO TRIGGERS'),
    kill_switch_changed_at: getProp_('KILL_SWITCH_CHANGED_AT', ''),
    triggers: trig,
    initialized: !!getProp_('SPREADSHEET_ID', null),
    config: getConfig(),
    tools: getToolStates()
  };
}

/** Lightweight poll for the Mac app + tray: properties only, no spreadsheet reads. */
function heartbeat(payload) {
  var since = (payload && payload.since) || '';
  var halted = isSystemHalted_();
  var trig = getTriggerStatus_();
  var events = getJsonProp_('EVENT_LOG', []).filter(function (ev) { return ev.ts > since; });
  return {
    server_time: nowIso_(),
    kill_switch: halted ? 'ON' : 'OFF',
    system_status: halted ? 'HARD STOPPED' : (trig.count ? 'RUNNING' : 'NO TRIGGERS'),
    trigger_count: trig.count,
    triggers_healthy: trig.healthy,
    workflow_mode: getConfig().workflow_mode,
    events: events
  };
}

function getToolStates() {
  var stats = getJsonProp_('TOOL_STATS', {});
  var p = allProps_();
  return toolRegistry_().map(function (t) {
    var credsOk = !t.requires.length || t.requires.some(function (group) {
      return group.every(function (k) { return !!p[k]; });
    });
    var enabled = p[t.key] === 'ON';
    var s = stats[t.key] || {};
    return {
      key: t.key, label: t.label, group: t.group, enabled: enabled, creds_ok: credsOk,
      status: !credsOk ? 'Missing API Key' : (enabled ? 'Active' : 'Paused'),
      last_run: s.last_run || '', runs: s.runs || 0,
      usage_units: s.units || 0, usage_unit_type: s.unit_type || '', claude_tokens: s.tokens || 0, est_cost_usd: Math.round((s.cost || 0) * 10000) / 10000
    };
  });
}

function setToolState(payload) {
  var key = payload && payload.key;
  var known = toolRegistry_().some(function (t) { return t.key === key; });
  if (!known) throw appError_(400, 'BAD_REQUEST', 'Unknown tool key: ' + key);
  setProp_(key, payload.enabled ? 'ON' : 'OFF');
  syncToolStatesSheet_();
  return getToolStates();
}

function syncToolStatesSheet_() {
  try {
    var ts = nowIso_();
    dbReplaceAll_(TABS.TOOL_STATES, getToolStates().map(function (t) {
      return { tool_key: t.key, label: t.label, group: t.group, enabled: t.enabled, status: t.status, last_run: t.last_run, runs: t.runs, usage_units: t.usage_units, usage_unit_type: t.usage_unit_type, est_cost_usd: t.est_cost_usd, updated_at: ts };
    }));
  } catch (e) { /* the sheet is a mirror; ScriptProperties are the source of truth */ }
}

/* ───────────────────────────── Guarded outbound HTTP ───────────────────────────── */

var RUNTIME_ = { reliability: {}, tools: {} };

/**
 * The ONLY place the backend calls UrlFetchApp.fetch.
 * @param {?string} toolKey  toggle that must be ON (null = only the kill switch is checked)
 * @param {string}  service  label for reliability stats, e.g. 'CLAUDE'
 */
function guardedFetch_(toolKey, service, url, options) {
  assertSystemActive();
  if (toolKey) requireTool_(toolKey);
  var opts = options || {};
  opts.muteHttpExceptions = true;
  var res;
  try {
    res = UrlFetchApp.fetch(url, opts);
  } catch (err) {
    tickReliability_(service, false);
    throw appError_(502, 'UPSTREAM_UNREACHABLE', service + ' request failed: ' + err.message);
  }
  tickReliability_(service, res.getResponseCode() < 400);
  return res;
}

/** guardedFetch_ + JSON parsing; throws a descriptive error on HTTP >= 400. */
function fetchJson_(toolKey, service, url, options) {
  var res = guardedFetch_(toolKey, service, url, options);
  var code = res.getResponseCode();
  var text = res.getContentText();
  var json = null;
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = null; }
  if (code >= 400) {
    throw appError_(502, 'UPSTREAM_ERROR', service + ' HTTP ' + code + ': ' + String(text).slice(0, 400));
  }
  return { code: code, json: json, text: text, headers: res.getHeaders() };
}

function header_(headers, name) {
  var lower = name.toLowerCase();
  var keys = Object.keys(headers || {});
  for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === lower) return headers[keys[i]];
  return '';
}

function tickReliability_(service, ok) {
  var r = RUNTIME_.reliability[service] || (RUNTIME_.reliability[service] = [0, 0]);
  r[ok ? 0 : 1]++;
}

function recordToolRun_(toolKey, units, unitType, cost) {
  var t = RUNTIME_.tools[toolKey] || (RUNTIME_.tools[toolKey] = { runs: 0, units: 0, tokens: 0, cost: 0, unit_type: '' });
  t.runs++; t.cost += cost || 0;
  if (unitType === 'tokens') t.tokens += units || 0;           // Claude tokens are tracked separately from posts/characters/videos
  else { t.units += units || 0; t.unit_type = unitType || t.unit_type; }
}

/** Persists per-execution counters (called from dispatch_ and every cron runner's finally block). */
function flushRuntimeStats_() {
  var relKeys = Object.keys(RUNTIME_.reliability), toolKeys = Object.keys(RUNTIME_.tools);
  if (!relKeys.length && !toolKeys.length) return;
  if (relKeys.length) {
    var rel = getJsonProp_('RELIABILITY', {});
    var day = today_();
    rel[day] = rel[day] || {};
    relKeys.forEach(function (s) {
      var cur = rel[day][s] || [0, 0];
      rel[day][s] = [cur[0] + RUNTIME_.reliability[s][0], cur[1] + RUNTIME_.reliability[s][1]];
    });
    Object.keys(rel).sort().slice(0, -30).forEach(function (old) { delete rel[old]; });
    setJsonProp_('RELIABILITY', rel);
  }
  if (toolKeys.length) {
    var stats = getJsonProp_('TOOL_STATS', {});
    toolKeys.forEach(function (k) {
      var s = stats[k] || { runs: 0, units: 0, cost: 0 };
      var t = RUNTIME_.tools[k];
      stats[k] = { last_run: nowIso_(), runs: s.runs + t.runs, units: s.units + t.units, tokens: (s.tokens || 0) + t.tokens, cost: s.cost + t.cost, unit_type: t.unit_type || s.unit_type || '' };
    });
    setJsonProp_('TOOL_STATS', stats);
    syncToolStatesSheet_();
  }
  RUNTIME_ = { reliability: {}, tools: {} };
}

/** Small ring buffer the Mac app polls to raise native notifications. */
function logEvent_(type, title, body, queueId) {
  var log = getJsonProp_('EVENT_LOG', []);
  log.push({ ts: nowIso_(), type: type, title: String(title).slice(0, 90), body: String(body || '').slice(0, 160), queue_id: queueId || '' });
  setJsonProp_('EVENT_LOG', log.slice(-25));
}

/** Shared wrapper for time-driven runners: kill-switch guard, tool guard, lock, stats flush. */
function runCron_(name, toolKey, fn) {
  try {
    assertSystemActive();
    if (toolKey && !isToolEnabled(toolKey)) return { skipped: toolKey + ' is OFF' };
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return { skipped: 'another run is in progress' };
    try { return fn(); } finally { lock.releaseLock(); }
  } catch (err) {
    if (err && err.code === 'SYSTEM_HALTED') return { halted: true };
    logEvent_('ERROR', name + ' failed', err.message);
    throw err;
  } finally {
    try { flushRuntimeStats_(); } catch (e) { /* best effort */ }
  }
}
