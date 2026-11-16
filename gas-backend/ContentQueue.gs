/**
 * ContentQueue.gs — Campaign orchestration and the Content_Queue state machine.
 *
 * Status flow
 *   BLOG    PENDING_APPROVAL → (CMS_DRAFT) → SCHEDULED → PUBLISHED
 *   SOCIAL  PENDING_APPROVAL → SCHEDULED → PUBLISHED
 *   VIDEO   SCRIPT_READY → RENDERING → READY_TO_PUBLISH → PUBLISHED | PARTIAL
 *   any     COMPLIANCE_HOLD (filter flagged it; never auto-published), FAILED, CANCELLED
 *
 * AUTONOMOUS mode: items are created pre-approved and flow straight through.
 * APPROVAL mode:   blogs are pushed to the CMS as drafts, social posts wait for approval,
 *                  video scripts wait for approval BEFORE any voice/render credits are spent,
 *                  and finished videos wait for an explicit "Publish Now".
 */

var TEXT_PLATFORMS = ['FACEBOOK', 'X_TWITTER', 'LINKEDIN', 'GOOGLE_BUSINESS'];
var VIDEO_PLATFORMS = ['INSTAGRAM', 'YOUTUBE_SHORTS', 'TIKTOK'];

/* ───────────────────────────── Time-driven runners ───────────────────────────── */

function cronGenerateContent() {
  assertSystemActive();
  return runCron_('cronGenerateContent', null, runGenerateCycle_);
}

function cronPublishScheduled() {
  assertSystemActive();
  return runCron_('cronPublishScheduled', null, runPublishCycle_);
}

/* ───────────────────────────── Payload storage ───────────────────────────── */

/** Sheets cells hold 50k chars; larger payloads spill into a Drive JSON file. */
function packPayload_(obj) {
  var s = JSON.stringify(obj || {});
  if (s.length <= 45000) return s;
  var file = mediaFolder_('Payloads').createFile(uid_('payload') + '.json', s, 'application/json');
  return 'drive:' + file.getId();
}

function unpackPayload_(cell) {
  if (!cell) return {};
  try {
    if (String(cell).indexOf('drive:') === 0) return JSON.parse(DriveApp.getFileById(String(cell).slice(6)).getBlob().getDataAsString());
    return JSON.parse(cell);
  } catch (e) { return {}; }
}

function loadItem_(id) {
  var item = dbFind_(TABS.QUEUE, id);
  if (!item) throw appError_(404, 'NOT_FOUND', 'Queue item not found: ' + id);
  item.payload = unpackPayload_(item.payload_json);
  return item;
}

function publicItem_(item) {
  var out = {};
  SCHEMA[TABS.QUEUE].forEach(function (h) { if (h !== 'payload_json') out[h] = item[h]; });
  out.approved = truthy_(item.approved);
  if (item.payload) out.payload = item.payload;
  return out;
}

/* ───────────────────────────── Queue endpoints ───────────────────────────── */

function getQueue(payload) {
  var p = payload || {};
  var rows = dbReadAll_(TABS.QUEUE).filter(function (r) {
    if (p.status ? r.status !== p.status : r.status === 'CANCELLED') return false;
    if (p.type && r.type !== p.type) return false;
    return true;
  });
  rows.sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
  var counts = {};
  rows.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
  return {
    counts: counts,
    items: rows.slice(0, Math.min(300, num_(p.limit) || 150)).map(function (r) {
      var out = publicItem_(r);
      if (String(r.payload_json).indexOf('drive:') !== 0) {
        var pl = unpackPayload_(r.payload_json);
        out.preview = String(pl.text || pl.excerpt || pl.narration || '').slice(0, 160);
        out.flagged = !!(pl.compliance_flags && pl.compliance_flags.length);
      }
      return out;
    })
  };
}

function getQueueItem(payload) { return publicItem_(loadItem_(payload.id)); }

/** Human edits from the Studio (SEO meta/slug editor, post text, schedule). Re-runs the compliance scan. */
function updateQueueItem(payload) {
  var item = loadItem_(payload.id);
  if (['PUBLISHED', 'RENDERING', 'CANCELLED'].indexOf(item.status) !== -1) throw appError_(409, 'LOCKED', 'Item cannot be edited in status ' + item.status);
  var patch = {};
  var edits = payload.payload || {};
  var editable = ['title', 'slug', 'meta_description', 'focus_keyword', 'excerpt', 'html_body', 'tags', 'text', 'thread', 'caption', 'narration', 'social_blurb'];
  var touched = false;
  editable.forEach(function (k) { if (k in edits) { item.payload[k] = edits[k]; touched = true; } });
  if (touched) {
    if ('slug' in edits) item.payload.slug = slugify_(edits.slug);
    item.payload.compliance_flags = complianceScan_(collectStrings_(item.payload).join('\n'));
    patch.payload_json = packPayload_(item.payload);
    if (item.payload.title) patch.title = item.payload.title;
  }
  if (typeof payload.title === 'string') patch.title = payload.title;
  if (typeof payload.scheduled_at === 'string') patch.scheduled_at = payload.scheduled_at;
  dbUpdate_(TABS.QUEUE, item.id, patch);
  return publicItem_(loadItem_(item.id));
}

function deleteQueueItem(payload) {
  dbUpdate_(TABS.QUEUE, payload.id, { status: 'CANCELLED', approved: false });
  return { id: payload.id, status: 'CANCELLED' };
}

/** Human approval. For a video script this is the point where voice/render spend is authorised. */
function approveItem(payload) {
  assertSystemActive();
  var item = loadItem_(payload.id);
  var cfg = getConfig();
  if (item.type === 'VIDEO' && item.status === 'SCRIPT_READY') {
    if (cfg.video_mode === 'SCRIPT_ONLY') throw appError_(409, 'SCRIPT_ONLY', 'Video Engine is in Script-Only mode; choose a render mode to produce this video.');
    startVideoProduction_(item.id);
    return publicItem_(loadItem_(item.id));
  }
  if (['PENDING_APPROVAL', 'COMPLIANCE_HOLD', 'CMS_DRAFT', 'FAILED'].indexOf(item.status) === -1) {
    throw appError_(409, 'BAD_STATE', 'Nothing to approve in status ' + item.status);
  }
  dbUpdate_(TABS.QUEUE, item.id, { approved: true, status: 'SCHEDULED', scheduled_at: item.scheduled_at || nowIso_(), error: '' });
  return publicItem_(loadItem_(item.id));
}

/** "Publish Now" — bypasses the schedule and approval flag; blogs go LIVE regardless of workflow mode. */
function publishNow(payload) {
  assertSystemActive();
  var item = loadItem_(payload.id);
  if (['PUBLISHED', 'CANCELLED', 'RENDERING'].indexOf(item.status) !== -1) throw appError_(409, 'BAD_STATE', 'Cannot publish an item in status ' + item.status);
  try {
    publishQueueItem_(item, { forceLive: true });
  } catch (err) {
    if (err.code !== 'SYSTEM_HALTED' && err.code !== 'TOOL_DISABLED' && err.code !== 'NOT_READY') {
      dbUpdate_(TABS.QUEUE, item.id, { status: 'FAILED', error: err.message });
    }
    throw err;
  }
  return publicItem_(loadItem_(item.id));
}

function regenerateItem(payload) {
  assertSystemActive();
  var item = loadItem_(payload.id);
  if (['PUBLISHED', 'RENDERING', 'CANCELLED'].indexOf(item.status) !== -1) throw appError_(409, 'BAD_STATE', 'Cannot regenerate in status ' + item.status);
  var cfg = getConfig();
  var brief = { pillar: item.pillar, metro: item.metro, keyword: item.keyword, topic_idea: item.payload.topic_idea || '' };
  var fresh;
  if (item.type === 'BLOG') {
    fresh = generateBlog_(brief, item.id);
  } else if (item.type === 'VIDEO') {
    fresh = generateVideoScript_(brief, item.payload.targets || item.platform.split(','), item.id);
    fresh.targets = item.payload.targets || item.platform.split(',');
  } else {
    if (item.payload.source === 'BLOG_CROSSPOST') throw appError_(409, 'BAD_STATE', 'Blog cross-posts are derived from the article; edit the text instead.');
    var posts = generateSocialPosts_(brief, [item.platform]);
    if (!posts[item.platform]) throw appError_(409, 'TOOL_DISABLED', platformToggle_(item.platform) + ' is switched OFF');
    fresh = socialPayload_(item.platform, posts[item.platform], item.hook_variant || 'A', posts.compliance_flags, cfg);
  }
  fresh.topic_idea = brief.topic_idea;
  var flagged = !!(fresh.compliance_flags && fresh.compliance_flags.length);
  var auto = cfg.workflow_mode === 'AUTONOMOUS' && !flagged;
  dbUpdate_(TABS.QUEUE, item.id, {
    payload_json: packPayload_(fresh), title: fresh.title || item.title,
    status: flagged ? 'COMPLIANCE_HOLD' : (item.type === 'VIDEO' ? 'SCRIPT_READY' : (auto ? 'SCHEDULED' : 'PENDING_APPROVAL')),
    approved: auto, audio_file_id: '', audio_url: '', video_file_id: '', video_url: '', error: ''
  });
  if (item.type === 'VIDEO' && auto && cfg.video_mode !== 'SCRIPT_ONLY') startVideoProduction_(item.id);
  return publicItem_(loadItem_(item.id));
}

function rerenderVideo(payload) {
  assertSystemActive();
  var item = loadItem_(payload.id);
  if (item.type !== 'VIDEO') throw appError_(400, 'BAD_REQUEST', 'Not a video item');
  if (item.status === 'RENDERING') throw appError_(409, 'BAD_STATE', 'A render is already in progress');
  if (item.status === 'PUBLISHED') throw appError_(409, 'BAD_STATE', 'Already published');
  dbUpdate_(TABS.QUEUE, item.id, { video_file_id: '', video_url: '', error: '' });
  startVideoProduction_(item.id);
  return publicItem_(loadItem_(item.id));
}

/* ───────────────────────────── Planning ───────────────────────────── */

function weightedPick_(weights) {
  var keys = Object.keys(weights).filter(function (k) { return num_(weights[k]) > 0; });
  if (!keys.length) keys = Object.keys(weights);
  var total = keys.reduce(function (s, k) { return s + Math.max(num_(weights[k]), 0.0001); }, 0);
  var r = Math.random() * total;
  for (var i = 0; i < keys.length; i++) { r -= Math.max(num_(weights[keys[i]]), 0.0001); if (r <= 0) return keys[i]; }
  return keys[keys.length - 1];
}

/** Picks pillar + metro by the dashboard weights, then the least-used matching Florida keyword. */
function pickBrief_(cfg, override) {
  var o = override || {};
  var pillar = o.pillar || weightedPick_(cfg.pillar_weights);
  var metro = o.metro || weightedPick_(cfg.metro_weights);
  if (o.keyword) return { pillar: pillar, metro: metro, keyword: o.keyword, topic_idea: o.topic_idea || '' };
  var all = dbReadAll_(TABS.KEYWORDS);
  var pool = all.filter(function (k) { return k.pillar === pillar && k.metro === metro; });
  if (!pool.length) pool = all.filter(function (k) { return k.pillar === pillar; });
  if (!pool.length) pool = all;
  if (!pool.length) return { pillar: pillar, metro: metro, keyword: pillar.toLowerCase() + ' telehealth ' + metro + ' Florida', topic_idea: '' };
  var min = Math.min.apply(null, pool.map(function (k) { return num_(k.used_count); }));
  var least = pool.filter(function (k) { return num_(k.used_count) === min; });
  var kw = least[Math.floor(Math.random() * least.length)];
  dbUpdate_(TABS.KEYWORDS, kw.id, { used_count: num_(kw.used_count) + 1, last_used: nowIso_() });
  return { pillar: pillar, metro: o.metro || kw.metro || metro, keyword: kw.keyword, topic_idea: kw.topic_idea };
}

/**
 * What should be generated right now? A channel is due when (a) its toggle is ON, (b) fewer
 * items than its weekly frequency were created in the trailing 7 days and (c) enough time has
 * passed since its last item to spread posts across the week. Disabled channels are never
 * generated for, so no Claude/voice/video spend is wasted on them.
 */
function computeDue_(cfg) {
  var weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  var counts = {}, last = {};
  dbReadAll_(TABS.QUEUE).forEach(function (r) {
    if (r.status === 'CANCELLED' || r.created_at < weekAgo) return;
    (r.type === 'BLOG' ? ['BLOG'] : String(r.platform).split(',')).forEach(function (p) {
      counts[p] = (counts[p] || 0) + 1;
      if (!last[p] || r.created_at > last[p]) last[p] = r.created_at;
    });
  });
  function due(p) {
    var freq = num_(cfg.frequency[p]);
    if (freq <= 0 || (counts[p] || 0) >= freq) return false;
    if (!last[p]) return true;
    return Date.now() - new Date(last[p]).getTime() >= (7 * 864e5 / freq) * 0.6;
  }
  var videoAllowed = cfg.video_mode === 'SCRIPT_ONLY' || isToolEnabled('TOGGLE_VIDEO_RENDER');
  return {
    blog: isToolEnabled('TOGGLE_BLOG_CMS') && due('BLOG'),
    social: TEXT_PLATFORMS.filter(function (p) { return isToolEnabled(platformToggle_(p)) && due(p); }),
    video: videoAllowed ? VIDEO_PLATFORMS.filter(function (p) { return isToolEnabled(platformToggle_(p)) && due(p); }) : []
  };
}

/** Next configured posting hour (America/New_York), staggered a few minutes per item. */
function nextSlot_(cfg, stagger) {
  var hours = (cfg.posting_hours_et || []).map(Number);
  var base = new Date();
  base.setMinutes(0, 0, 0);
  for (var h = 1; h <= 48; h++) {
    var t = new Date(base.getTime() + h * 3600e3);
    if (!hours.length || hours.indexOf(Number(Utilities.formatDate(t, 'America/New_York', 'H'))) !== -1) {
      return new Date(t.getTime() + (stagger || 0) * 7 * 60e3).toISOString();
    }
  }
  return new Date(Date.now() + 3600e3).toISOString();
}

/* ───────────────────────────── Item creation ───────────────────────────── */

function newQueueRow_(type, platform, brief, campaignId, payload, cfg, stagger) {
  var flagged = !!(payload.compliance_flags && payload.compliance_flags.length);
  var auto = cfg.workflow_mode === 'AUTONOMOUS' && !flagged;
  var status = flagged ? 'COMPLIANCE_HOLD' : (type === 'VIDEO' ? 'SCRIPT_READY' : (auto ? 'SCHEDULED' : 'PENDING_APPROVAL'));
  payload.topic_idea = brief.topic_idea || '';
  var row = {
    id: payload._id || uid_('q'), campaign_id: campaignId, created_at: nowIso_(), updated_at: nowIso_(),
    type: type, platform: platform, status: status, approved: auto, scheduled_at: nextSlot_(cfg, stagger),
    pillar: brief.pillar, metro: brief.metro, keyword: brief.keyword, title: payload.title || brief.keyword,
    hook_variant: payload.hook_variant || '', error: ''
  };
  delete payload._id;
  row.payload_json = packPayload_(payload);
  dbAppend_(TABS.QUEUE, row);
  if (flagged) logEvent_('COMPLIANCE', 'Compliance hold: ' + row.title, payload.compliance_flags.join('; '), row.id);
  return row;
}

function createBlogItem_(brief, campaignId, cfg) {
  var id = uid_('q');
  var blog = generateBlog_(brief, id);
  blog._id = id;
  blog.hook_variant = pickHookVariant_();
  return newQueueRow_('BLOG', 'BLOG', brief, campaignId, blog, cfg, 0);
}

function socialPayload_(platform, post, variant, flags, cfg) {
  var composed = composeSocialText_(platform, post, variant);
  return {
    title: composed.hook, text: composed.text, thread: composed.thread || null, hook: composed.hook,
    hook_a: post.hook_a, hook_b: post.hook_b, hook_variant: variant, link: cfg.cta_url,
    carousel_slides: post.carousel_slides || null, compliance_flags: flags || []
  };
}

function createSocialItems_(brief, platforms, campaignId, cfg) {
  var posts = generateSocialPosts_(brief, platforms);
  var rows = [];
  platforms.forEach(function (p, i) {
    if (!posts[p]) return;
    rows.push(newQueueRow_('SOCIAL', p, brief, campaignId, socialPayload_(p, posts[p], pickHookVariant_(), posts.compliance_flags, cfg), cfg, i));
  });
  return rows;
}

function createVideoItem_(brief, targets, campaignId, cfg) {
  var id = uid_('q');
  var script = generateVideoScript_(brief, targets, id);
  script._id = id;
  script.targets = targets;
  script.hook_variant = pickHookVariant_();
  var row = newQueueRow_('VIDEO', targets.join(','), brief, campaignId, script, cfg, 0);
  if (truthy_(row.approved) && cfg.video_mode !== 'SCRIPT_ONLY') startVideoProduction_(row.id);
  return row;
}

/* ───────────────────────────── Generation cycle ───────────────────────────── */

function runGenerateCycle_() {
  assertSystemActive();
  var cfg = getConfig();
  var out = { created: [], errors: [] };
  function step(label, fn) {
    try { fn(); }
    catch (err) {
      if (err.code === 'SYSTEM_HALTED') throw err;
      out.errors.push(label + ': ' + err.message);
      logEvent_('ERROR', label + ' generation failed', err.message);
    }
  }
  if (isToolEnabled('TOGGLE_CLAUDE_IDEATION')) {
    var unused = dbReadAll_(TABS.KEYWORDS).filter(function (k) { return num_(k.used_count) === 0; }).length;
    if (unused < 6) step('Keyword research', function () { out.keywords_added = researchFloridaKeywords_(12).added; });
  }
  var due = computeDue_(cfg);
  out.due = due;
  if (!due.blog && !due.social.length && !due.video.length) return out;
  var brief = pickBrief_(cfg);
  var campaign = uid_('cmp');
  function note(r) { out.created.push({ id: r.id, type: r.type, platform: r.platform, status: r.status }); }
  if (due.blog) step('Blog', function () { note(createBlogItem_(brief, campaign, cfg)); });
  if (due.social.length) step('Social', function () { createSocialItems_(brief, due.social, campaign, cfg).forEach(note); });
  if (due.video.length) step('Video', function () { note(createVideoItem_(brief, due.video, campaign, cfg)); });
  if (out.created.length) logEvent_('GENERATED', out.created.length + ' new item(s) in the queue', brief.pillar + ' · ' + brief.metro + ' · ' + brief.keyword);
  return out;
}

/** Studio "New content" button: generate one specific piece now, honouring the same toggles. */
function generateOnDemand(payload) {
  assertSystemActive();
  var cfg = getConfig();
  var p = payload || {};
  var brief = pickBrief_(cfg, { pillar: p.pillar, metro: p.metro, keyword: p.keyword });
  var campaign = uid_('cmp');
  if (p.type === 'BLOG') return { created: [publicItem_(createBlogItem_(brief, campaign, cfg))] };
  if (p.type === 'SOCIAL') {
    var plats = (p.platforms && p.platforms.length ? p.platforms : TEXT_PLATFORMS).filter(function (x) { return TEXT_PLATFORMS.indexOf(x) !== -1 && isToolEnabled(platformToggle_(x)); });
    if (!plats.length) throw appError_(409, 'TOOL_DISABLED', 'No text social channel is switched ON');
    return { created: createSocialItems_(brief, plats, campaign, cfg).map(publicItem_) };
  }
  if (p.type === 'VIDEO') {
    var targets = VIDEO_PLATFORMS.filter(function (x) { return isToolEnabled(platformToggle_(x)); });
    if (!targets.length) throw appError_(409, 'TOOL_DISABLED', 'No video channel (Instagram, YouTube Shorts, TikTok) is switched ON');
    return { created: [publicItem_(createVideoItem_(brief, targets, campaign, cfg))] };
  }
  throw appError_(400, 'BAD_REQUEST', 'type must be BLOG, SOCIAL or VIDEO');
}

/* ───────────────────────────── Publishing cycle ───────────────────────────── */

function runPublishCycle_() {
  assertSystemActive();
  var cfg = getConfig();
  var started = Date.now(), now = nowIso_();
  var out = { published: [], drafts: [], failed: [] };
  var rows = dbReadAll_(TABS.QUEUE);
  var blogOn = isToolEnabled('TOGGLE_BLOG_CMS');
  var work = [];
  rows.forEach(function (r) {
    if (r.type === 'BLOG' && r.status === 'PENDING_APPROVAL' && !r.cms_id && blogOn && cfg.workflow_mode === 'APPROVAL') work.push({ row: r, draftOnly: true });
    else if ((r.status === 'SCHEDULED' || r.status === 'READY_TO_PUBLISH') && truthy_(r.approved) && (!r.scheduled_at || r.scheduled_at <= now)) work.push({ row: r, draftOnly: false });
  });
  for (var i = 0; i < work.length && i < 12 && Date.now() - started < 270000; i++) {
    var w = work[i];
    try {
      w.row.payload = unpackPayload_(w.row.payload_json);
      publishQueueItem_(w.row, { draftOnly: w.draftOnly });
      (w.draftOnly ? out.drafts : out.published).push(w.row.id);
    } catch (err) {
      if (err.code === 'SYSTEM_HALTED') throw err;
      if (err.code === 'TOOL_DISABLED' || err.code === 'RETRY_LATER') continue; // stays queued until the tool is re-enabled / media is ready
      dbUpdate_(TABS.QUEUE, w.row.id, { status: 'FAILED', error: err.message });
      logEvent_('ERROR', 'Publish failed: ' + w.row.title, err.message, w.row.id);
      out.failed.push({ id: w.row.id, error: err.message });
    }
  }
  return out;
}

function withUtm_(url, platform, item) {
  if (!url) return url;
  var sep = url.indexOf('?') === -1 ? '?' : '&';
  return url + sep + 'utm_source=' + platform.toLowerCase() + '&utm_medium=organic_social&utm_campaign=' + slugify_(item.pillar || 'nodetelehealth');
}

function logPublished_(item, platform, res, hookText, error) {
  dbAppend_(TABS.PUBLISHED, {
    id: uid_('pub'), ts: nowIso_(), queue_id: item.id, type: item.type, platform: platform,
    external_id: (res && res.external_id) || '', url: (res && res.url) || '', title: item.title,
    metro: item.metro, pillar: item.pillar, keyword: item.keyword, hook_variant: item.hook_variant,
    hook_text: hookText || '', status: error ? 'FAILED' : 'PUBLISHED', error: error || ''
  });
}

/**
 * Publishes one queue item. opts.draftOnly → blog pushed to the CMS as a draft.
 * opts.forceLive → explicit human "Publish Now".
 */
function publishQueueItem_(item, opts) {
  assertSystemActive();
  opts = opts || {};
  var cfg = getConfig();
  var p = item.payload;

  if (item.type === 'BLOG') {
    requireTool_('TOGGLE_BLOG_CMS');
    if (opts.draftOnly) {
      var draft = cmsPublish_(p, false, item);
      p.cms_draft_url = draft.url;
      dbUpdate_(TABS.QUEUE, item.id, { status: 'CMS_DRAFT', cms_id: draft.cms_id, payload_json: packPayload_(p), error: '' });
      logEvent_('DRAFT', 'Blog draft sent to ' + cfg.cms_provider, item.title, item.id);
      return;
    }
    var live = item.cms_id ? cmsPromote_(item.cms_id, p, item) : cmsPublish_(p, true, item);
    dbUpdate_(TABS.QUEUE, item.id, { status: 'PUBLISHED', approved: true, cms_id: live.cms_id, published_url: live.url, error: '' });
    logPublished_(item, 'BLOG', { external_id: live.cms_id, url: live.url }, p.hook_variant === 'B' ? p.hook_b : p.hook_a);
    logEvent_('PUBLISHED', 'Blog live on NodeTelehealth.com', item.title, item.id);
    crossPostBlog_(item, p, live.url, cfg);
    return;
  }

  if (item.type === 'SOCIAL') {
    requireTool_(platformToggle_(item.platform));
    var res = publishSocial_(item.platform, {
      text: p.text, thread: p.thread, title: item.title,
      link: withUtm_(p.link || cfg.cta_url, item.platform, item), image_url: p.image_url || ''
    }, item);
    dbUpdate_(TABS.QUEUE, item.id, { status: 'PUBLISHED', approved: true, published_url: res.url, error: '' });
    logPublished_(item, item.platform, res, p.hook);
    logEvent_('PUBLISHED', 'Posted to ' + item.platform, item.title, item.id);
    return;
  }

  if (item.type === 'VIDEO') {
    if (!item.video_url) throw appError_(409, 'NOT_READY', 'The video has not finished rendering yet.');
    var targets = (p.targets || []).filter(function (t) { return isToolEnabled(platformToggle_(t)); });
    if (!targets.length) throw appError_(409, 'TOOL_DISABLED', 'All target video channels are switched OFF');
    var results = p.publish_results || {};
    var caption = p.caption + '\n\n' + (p.hashtags || []).map(function (h) { return '#' + String(h).replace(/[^A-Za-z0-9_]/g, ''); }).join(' ');
    var retry = false;
    targets.forEach(function (t) {
      if (results[t] && results[t].ok) return; // never double-post on retry
      try {
        var r = publishSocial_(t, { title: p.title, caption: caption, video_url: item.video_url, video_file_id: item.video_file_id, provider_video_url: p.provider_video_url || '' }, item);
        results[t] = { ok: true, url: r.url, external_id: r.external_id };
        logPublished_(item, t, r, item.hook_variant === 'B' ? p.hook_b : p.hook_a);
      } catch (err) {
        if (err.code === 'SYSTEM_HALTED') throw err;
        if (err.code === 'RETRY_LATER') { retry = true; return; }
        results[t] = { ok: false, error: err.message };
        logPublished_(item, t, null, '', err.message);
      }
    });
    p.publish_results = results;
    var oks = targets.filter(function (t) { return results[t] && results[t].ok; });
    var errs = targets.filter(function (t) { return results[t] && !results[t].ok; }).map(function (t) { return t + ': ' + results[t].error; });
    var status = retry ? 'READY_TO_PUBLISH' : (oks.length === targets.length ? 'PUBLISHED' : (oks.length ? 'PARTIAL' : 'FAILED'));
    dbUpdate_(TABS.QUEUE, item.id, {
      status: status, approved: true, payload_json: packPayload_(p),
      published_url: oks.length ? results[oks[0]].url : '', error: errs.join(' | ')
    });
    if (oks.length) logEvent_('PUBLISHED', 'Video published to ' + oks.join(', '), item.title, item.id);
    if (errs.length) logEvent_('ERROR', 'Video publish errors', errs.join(' | '), item.id);
    return;
  }
  throw appError_(400, 'BAD_REQUEST', 'Unknown item type ' + item.type);
}

/** After a blog goes live, queue link posts (URL + summary) for every enabled text network + Google Business Profile. */
function crossPostBlog_(item, blog, url, cfg) {
  var variant = blog.hook_variant || 'A';
  var hook = variant === 'B' ? blog.hook_b : blog.hook_a;
  var image = '';
  try { image = (pickCoverImage_() || {}).url || ''; } catch (e) { image = ''; }
  var n = 0;
  TEXT_PLATFORMS.forEach(function (plat) {
    if (!isToolEnabled(platformToggle_(plat))) return;
    var text = [hook || blog.title, blog.social_blurb || blog.excerpt].filter(String).join('\n\n');
    if (plat === 'X_TWITTER') text = text.slice(0, 250);
    dbAppend_(TABS.QUEUE, {
      id: uid_('q'), campaign_id: item.campaign_id, created_at: nowIso_(), updated_at: nowIso_(),
      type: 'SOCIAL', platform: plat, status: 'SCHEDULED', approved: true,
      scheduled_at: new Date(Date.now() + n * 5 * 60e3).toISOString(),
      pillar: item.pillar, metro: item.metro, keyword: item.keyword, title: 'Blog: ' + blog.title, hook_variant: variant,
      payload_json: packPayload_({ source: 'BLOG_CROSSPOST', text: text, link: url, hook: hook, image_url: image, compliance_flags: [] }), error: ''
    });
    n++;
  });
  return n;
}
