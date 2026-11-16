/**
 * AnalyticsSync.gs — Scheduled metrics + API-cost harvester and the JSON aggregator
 * that feeds the Mac dashboard charts.
 *
 * Sources: Facebook / Instagram insights, X public metrics, LinkedIn share statistics,
 * YouTube statistics, TikTok video query, and Google Analytics 4 (Florida-only sessions,
 * engagement and key events by city, plus page views for published blog URLs).
 * Every number shown in the app is harvested or logged; nothing is simulated. Dollar
 * figures are estimates derived from the unit prices in Config → cost.
 */

function cronHarvestAnalytics() {
  assertSystemActive();
  return runCron_('cronHarvestAnalytics', 'TOGGLE_ANALYTICS_POLLING', runAnalyticsHarvest_);
}

/* ───────────────────────────── Cost log ───────────────────────────── */

function logCost_(o) {
  try {
    dbAppend_(TABS.COSTS, {
      ts: nowIso_(), date: today_(), service: o.service, tool_key: o.tool_key || '', operation: o.operation || '',
      units: o.units || 0, unit_type: o.unit_type || '', est_cost_usd: Math.round(num_(o.est_cost_usd) * 1e6) / 1e6,
      ok: o.ok !== false, queue_id: o.queue_id || '', detail: String(o.detail || '').slice(0, 300)
    });
  } catch (e) { /* never let bookkeeping break a publish */ }
}

/* ───────────────────────────── Harvest ───────────────────────────── */

function runAnalyticsHarvest_() {
  assertSystemActive();
  requireTool_('TOGGLE_ANALYTICS_POLLING');
  var TOOL = 'TOGGLE_ANALYTICS_POLLING';
  var since = new Date(Date.now() - 30 * 864e5).toISOString();
  var logs = dbReadAll_(TABS.PUBLISHED).filter(function (l) { return l.status === 'PUBLISHED' && l.external_id && l.ts >= since; });
  var byPlatform = {};
  logs.forEach(function (l) { (byPlatform[l.platform] = byPlatform[l.platform] || []).push(l); });
  var durations = {};
  dbReadAll_(TABS.VIDEO_JOBS).forEach(function (j) { if (num_(j.duration_sec)) durations[j.queue_id] = num_(j.duration_sec); });

  var rows = [], errors = [];
  var ts = nowIso_(), date = today_();
  function push(log, m) {
    if (!m) return;
    rows.push({
      ts: ts, date: date, source: log.platform, queue_id: log.queue_id, external_id: log.external_id, metro: log.metro, pillar: log.pillar, hook_variant: log.hook_variant,
      impressions: m.impressions || 0, views: m.views || 0, clicks: m.clicks || 0, likes: m.likes || 0, comments: m.comments || 0, shares: m.shares || 0,
      watch_through: m.watch_through || '', sessions: m.sessions || 0, engaged_sessions: m.engaged_sessions || 0, conversions: m.conversions || 0
    });
  }
  function each(platform, credKeys, fn) {
    var list = (byPlatform[platform] || []).slice(-40);
    if (!list.length || !credKeys.every(function (k) { return !!getProp_(k, ''); })) return;
    try { fn(list); }
    catch (err) {
      if (err.code === 'SYSTEM_HALTED' || err.code === 'TOOL_DISABLED') throw err;
      errors.push(platform + ': ' + err.message);
    }
  }

  each('FACEBOOK', ['META_PAGE_ACCESS_TOKEN'], function (list) {
    var token = encodeURIComponent(getProp_('META_PAGE_ACCESS_TOKEN', ''));
    list.forEach(function (l) {
      var p = fetchJson_(TOOL, 'FACEBOOK', META_GRAPH + '/' + l.external_id + '?fields=shares,likes.summary(true).limit(0),comments.summary(true).limit(0)&access_token=' + token, {}).json;
      var m = { likes: num_(p.likes && p.likes.summary && p.likes.summary.total_count), comments: num_(p.comments && p.comments.summary && p.comments.summary.total_count), shares: num_(p.shares && p.shares.count) };
      try {
        var ins = fetchJson_(TOOL, 'FACEBOOK', META_GRAPH + '/' + l.external_id + '/insights?metric=post_impressions_unique,post_clicks&access_token=' + token, {}).json;
        (ins.data || []).forEach(function (d) {
          var v = num_(d.values && d.values[0] && d.values[0].value);
          if (d.name === 'post_impressions_unique') m.impressions = v;
          if (d.name === 'post_clicks') m.clicks = v;
        });
      } catch (e) { if (e.code === 'SYSTEM_HALTED' || e.code === 'TOOL_DISABLED') throw e; }
      push(l, m);
    });
  });

  each('INSTAGRAM', ['META_PAGE_ACCESS_TOKEN'], function (list) {
    var token = encodeURIComponent(getProp_('META_PAGE_ACCESS_TOKEN', ''));
    list.forEach(function (l) {
      var data;
      try {
        data = fetchJson_(TOOL, 'INSTAGRAM', META_GRAPH + '/' + l.external_id + '/insights?metric=reach,views,likes,comments,shares,saved,ig_reels_avg_watch_time&access_token=' + token, {}).json.data;
      } catch (e) {
        if (e.code === 'SYSTEM_HALTED' || e.code === 'TOOL_DISABLED') throw e;
        data = fetchJson_(TOOL, 'INSTAGRAM', META_GRAPH + '/' + l.external_id + '/insights?metric=reach,likes,comments,shares&access_token=' + token, {}).json.data;
      }
      var v = {};
      (data || []).forEach(function (d) { v[d.name] = num_(d.values && d.values[0] && d.values[0].value); });
      var dur = durations[l.queue_id];
      push(l, {
        impressions: v.reach, views: v.views, likes: v.likes, comments: v.comments, shares: num_(v.shares) + num_(v.saved),
        watch_through: (dur && v.ig_reels_avg_watch_time) ? Math.min(1, v.ig_reels_avg_watch_time / 1000 / dur).toFixed(3) : ''
      });
    });
  });

  each('X_TWITTER', ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'], function (list) {
    var url = 'https://api.x.com/2/tweets';
    var query = { ids: list.map(function (l) { return l.external_id; }).join(','), 'tweet.fields': 'public_metrics' };
    var qs = Object.keys(query).map(function (k) { return pctEncode_(k) + '=' + pctEncode_(query[k]); }).join('&');
    var r = fetchJson_(TOOL, 'X_TWITTER', url + '?' + qs, { headers: { Authorization: xOAuthHeader_('GET', url, query) } }).json;
    var byId = {};
    (r.data || []).forEach(function (t) { byId[t.id] = t.public_metrics || {}; });
    list.forEach(function (l) {
      var pm = byId[l.external_id];
      if (pm) push(l, { impressions: pm.impression_count, likes: pm.like_count, comments: pm.reply_count, shares: num_(pm.retweet_count) + num_(pm.quote_count) });
    });
  });

  each('LINKEDIN', ['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_ORG_ID'], function (list) {
    var org = encodeURIComponent('urn:li:organization:' + getProp_('LINKEDIN_ORG_ID', ''));
    list.slice(-20).forEach(function (l) {
      var param = l.external_id.indexOf('ugcPost') !== -1 ? 'ugcPosts' : 'shares';
      var r = fetchJson_(TOOL, 'LINKEDIN', 'https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=' + org + '&' + param + '=List(' + encodeURIComponent(l.external_id) + ')', { headers: linkedInHeaders_() }).json;
      var s = r.elements && r.elements[0] && r.elements[0].totalShareStatistics;
      if (s) push(l, { impressions: s.impressionCount, clicks: s.clickCount, likes: s.likeCount, comments: s.commentCount, shares: s.shareCount });
    });
  });

  each('YOUTUBE_SHORTS', [], function (list) {
    var token = youtubeAccessToken_(TOOL);
    var r = fetchJson_(TOOL, 'YOUTUBE', 'https://www.googleapis.com/youtube/v3/videos?part=statistics&id=' + encodeURIComponent(list.map(function (l) { return l.external_id; }).join(',')), { headers: { Authorization: 'Bearer ' + token } }).json;
    var byId = {};
    (r.items || []).forEach(function (v) { byId[v.id] = v.statistics || {}; });
    list.forEach(function (l) {
      var s = byId[l.external_id];
      if (s) push(l, { views: s.viewCount, likes: s.likeCount, comments: s.commentCount });
    });
  });

  each('TIKTOK', ['TIKTOK_ACCESS_TOKEN'], function (list) {
    var auth = { Authorization: 'Bearer ' + tiktokAccessToken_(TOOL) };
    var videoIds = {}, ids = [];
    list.forEach(function (l) {
      var st = fetchJson_(TOOL, 'TIKTOK', 'https://open.tiktokapis.com/v2/post/publish/status/fetch/', { method: 'post', contentType: 'application/json', headers: auth, payload: JSON.stringify({ publish_id: l.external_id }) }).json;
      var posted = st.data && (st.data.publicaly_available_post_id || st.data.publicly_available_post_id);
      if (posted && posted.length) { videoIds[String(posted[0])] = l; ids.push(String(posted[0])); }
    });
    if (!ids.length) return;
    var q = fetchJson_(TOOL, 'TIKTOK', 'https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count', { method: 'post', contentType: 'application/json', headers: auth, payload: JSON.stringify({ filters: { video_ids: ids.slice(0, 20) } }) }).json;
    ((q.data && q.data.videos) || []).forEach(function (v) {
      if (videoIds[v.id]) push(videoIds[v.id], { views: v.view_count, likes: v.like_count, comments: v.comment_count, shares: v.share_count });
    });
  });

  var ga4 = { city_rows: 0, blog_rows: 0 };
  if (getProp_('GA4_PROPERTY_ID', '')) {
    try { ga4 = harvestGA4_(TOOL, byPlatform.BLOG || [], rows, ts, date); }
    catch (err) {
      if (err.code === 'SYSTEM_HALTED' || err.code === 'TOOL_DISABLED') throw err;
      errors.push('GA4: ' + err.message);
    }
  }

  dbAppendMany_(TABS.METRICS, rows);
  recordToolRun_(TOOL, rows.length, 'metric rows', 0);
  compactMetrics_();
  if (errors.length) logEvent_('ERROR', 'Analytics harvest had errors', errors.join(' | '));
  return { rows: rows.length, ga4: ga4, errors: errors };
}

/* ───────────────────────────── Google Analytics 4 (Florida only) ───────────────────────────── */

function ga4Report_(toolKey, body) {
  return fetchJson_(toolKey, 'GA4', 'https://analyticsdata.googleapis.com/v1beta/properties/' + encodeURIComponent(getProp_('GA4_PROPERTY_ID', '')) + ':runReport', {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, payload: JSON.stringify(body)
  }).json;
}

function harvestGA4_(toolKey, blogLogs, rows, ts, date) {
  var florida = { filter: { fieldName: 'region', stringFilter: { value: 'Florida' } } };
  var hasHistory = dbReadAll_(TABS.METRICS).some(function (m) { return m.source === 'GA4'; });
  var cities = ga4Report_(toolKey, {
    dateRanges: [{ startDate: hasHistory ? '3daysAgo' : '30daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'date' }, { name: 'city' }],
    metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'screenPageViews' }, { name: 'keyEvents' }],
    dimensionFilter: florida, orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: hasHistory ? 150 : 900
  });
  var out = { city_rows: 0, blog_rows: 0 };
  (cities.rows || []).forEach(function (r) {
    var d = r.dimensionValues[0].value, city = r.dimensionValues[1].value;
    if (!city || city === '(not set)') return;
    rows.push({
      ts: ts, date: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8), source: 'GA4', metro: city,
      sessions: num_(r.metricValues[0].value), engaged_sessions: num_(r.metricValues[1].value), views: num_(r.metricValues[2].value), conversions: num_(r.metricValues[3].value)
    });
    out.city_rows++;
  });
  if (blogLogs.length) {
    var pages = ga4Report_(toolKey, {
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }],
      dimensionFilter: florida, orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 500
    });
    var byPath = {};
    (pages.rows || []).forEach(function (r) { byPath[trimSlash_(r.dimensionValues[0].value)] = r.metricValues; });
    blogLogs.forEach(function (l) {
      var path = trimSlash_(String(l.url).replace(/^https?:\/\/[^/]+/i, '').split('?')[0]);
      var mv = byPath[path];
      if (!mv) return;
      rows.push({
        ts: ts, date: date, source: 'BLOG', queue_id: l.queue_id, external_id: l.external_id, metro: l.metro, pillar: l.pillar, hook_variant: l.hook_variant,
        views: num_(mv[0].value), sessions: num_(mv[1].value), engaged_sessions: num_(mv[2].value), conversions: num_(mv[3].value)
      });
      out.blog_rows++;
    });
  }
  return out;
}

function testGA4_() {
  if (!getProp_('GA4_PROPERTY_ID', '')) throw appError_(412, 'MISSING_API_KEY', 'GA4_PROPERTY_ID is not configured');
  var r = ga4Report_(null, { dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }], dimensionFilter: { filter: { fieldName: 'region', stringFilter: { value: 'Florida' } } } });
  return 'GA4 reachable. Florida sessions, last 7 days: ' + ((r.rows && r.rows[0] && r.rows[0].metricValues[0].value) || 0);
}

/* ───────────────────────────── Snapshot handling ───────────────────────────── */

/** Latest snapshot per key (social metrics are cumulative; GA4 rows are re-fetched for recent days). */
function latestBy_(rows, keyFn) {
  var map = {};
  rows.forEach(function (r) { var k = keyFn(r); if (!map[k] || r.ts >= map[k].ts) map[k] = r; });
  return Object.keys(map).map(function (k) { return map[k]; });
}

function metricKey_(m) {
  return m.source === 'GA4' ? 'GA4|' + m.date + '|' + m.metro : m.source + '|' + m.external_id + '|' + m.date;
}

/** Keeps the sheet small: one row per item per day, 120 days of history. */
function compactMetrics_() {
  var all = dbReadAll_(TABS.METRICS);
  if (all.length < 4000) return;
  var cutoff = Utilities.formatDate(new Date(Date.now() - 120 * 864e5), 'America/New_York', 'yyyy-MM-dd');
  var kept = latestBy_(all.filter(function (m) { return m.date >= cutoff; }), metricKey_);
  kept.sort(function (a, b) { return a.ts < b.ts ? -1 : 1; });
  dbReplaceAll_(TABS.METRICS, kept);
}

function engagements_(m) { return num_(m.likes) + num_(m.comments) + num_(m.shares) + num_(m.clicks); }
function reach_(m) { return Math.max(num_(m.impressions), num_(m.views)); }

/** Best past hooks by engagement rate — fed back into Claude prompts (A/B optimisation loop). */
function topHooks_(n) {
  var latest = {};
  latestBy_(dbReadAll_(TABS.METRICS).filter(function (m) { return m.source !== 'GA4' && m.source !== 'BLOG' && m.external_id; }), function (m) { return m.source + '|' + m.external_id; })
    .forEach(function (m) { latest[m.source + '|' + m.external_id] = m; });
  return dbReadAll_(TABS.PUBLISHED).map(function (l) {
    var m = latest[l.platform + '|' + l.external_id];
    if (!m || !l.hook_text || reach_(m) < 50) return null;
    return { platform: l.platform, hook_text: l.hook_text, rate: engagements_(m) / reach_(m) };
  }).filter(Boolean).sort(function (a, b) { return b.rate - a.rate; }).slice(0, n || 5);
}

/* ───────────────────────────── Dashboard aggregator ───────────────────────────── */

function round_(n, d) { var f = Math.pow(10, d || 0); return Math.round(num_(n) * f) / f; }
function rate_(a, b) { return b > 0 ? round_(a / b, 4) : 0; }

function getDashboard(payload) {
  var days = Math.max(7, Math.min(90, num_(payload && payload.days) || 30));
  var cfg = getConfig();
  var tz = 'America/New_York';
  var dates = [];
  for (var i = days - 1; i >= 0; i--) dates.push(Utilities.formatDate(new Date(Date.now() - i * 864e5), tz, 'yyyy-MM-dd'));
  var sinceDate = dates[0], sinceIso = new Date(Date.now() - days * 864e5).toISOString();

  var metrics = dbReadAll_(TABS.METRICS);
  var ga = latestBy_(metrics.filter(function (m) { return m.source === 'GA4' && m.date >= sinceDate; }), metricKey_);
  var social = latestBy_(metrics.filter(function (m) { return m.source !== 'GA4' && m.external_id; }), function (m) { return m.source + '|' + m.external_id; });
  var published = dbReadAll_(TABS.PUBLISHED).filter(function (l) { return l.ts >= sinceIso; });
  var livePosts = published.filter(function (l) { return l.status === 'PUBLISHED'; });
  var liveIds = {};
  livePosts.forEach(function (l) { liveIds[l.platform + '|' + l.external_id] = 1; });
  social = social.filter(function (m) { return liveIds[m.source + '|' + m.external_id]; });

  // ── Florida city trend (GA4) ──
  var byDate = {}, byCity = {};
  ga.forEach(function (m) {
    var d = byDate[m.date] || (byDate[m.date] = { sessions: 0, engaged: 0, conversions: 0 });
    d.sessions += num_(m.sessions); d.engaged += num_(m.engaged_sessions); d.conversions += num_(m.conversions);
    var c = byCity[m.metro] || (byCity[m.metro] = { sessions: 0, engaged: 0, conversions: 0, days: {} });
    c.sessions += num_(m.sessions); c.engaged += num_(m.engaged_sessions); c.conversions += num_(m.conversions);
    c.days[m.date] = { sessions: num_(m.sessions), engaged: num_(m.engaged_sessions), conversions: num_(m.conversions) };
  });
  function series(lookup) {
    return dates.map(function (d) {
      var v = lookup[d];
      return v ? { date: d, sessions: v.sessions, engagement_rate: rate_(v.engaged, v.sessions), conversion_rate: rate_(v.conversions, v.sessions) }
               : { date: d, sessions: 0, engagement_rate: null, conversion_rate: null };
    });
  }
  var topCities = Object.keys(byCity).sort(function (a, b) { return byCity[b].sessions - byCity[a].sessions; }).slice(0, 8);
  var trendByCity = {};
  topCities.forEach(function (c) { trendByCity[c] = series(byCity[c].days); });

  // ── Social performance by targeted metro ──
  var socialByMetro = {};
  social.forEach(function (m) {
    var s = socialByMetro[m.metro] || (socialByMetro[m.metro] = { reach: 0, eng: 0 });
    s.reach += reach_(m); s.eng += engagements_(m);
  });
  var metroNames = {};
  topCities.forEach(function (c) { metroNames[c] = 1; });
  Object.keys(socialByMetro).forEach(function (c) { if (c) metroNames[c] = 1; });
  var metros = Object.keys(metroNames).map(function (name) {
    var g = byCity[name] || { sessions: 0, engaged: 0, conversions: 0 }, s = socialByMetro[name] || { reach: 0, eng: 0 };
    return { metro: name, sessions: g.sessions, engagement_rate: rate_(g.engaged, g.sessions), conversion_rate: rate_(g.conversions, g.sessions), conversions: g.conversions, social_reach: s.reach, social_engagement_rate: rate_(s.eng, s.reach) };
  });

  // ── Channels ──
  var order = ['BLOG', 'FACEBOOK', 'INSTAGRAM', 'X_TWITTER', 'LINKEDIN', 'YOUTUBE_SHORTS', 'TIKTOK', 'GOOGLE_BUSINESS'];
  var ch = {};
  order.forEach(function (p) { ch[p] = { platform: p, published: 0, impressions: 0, views: 0, clicks: 0, likes: 0, comments: 0, shares: 0, wt_sum: 0, wt_n: 0 }; });
  livePosts.forEach(function (l) { if (ch[l.platform]) ch[l.platform].published++; });
  social.forEach(function (m) {
    var c = ch[m.source];
    if (!c) return;
    ['impressions', 'views', 'clicks', 'likes', 'comments', 'shares'].forEach(function (k) { c[k] += num_(m[k]); });
    if (m.watch_through !== '') { c.wt_sum += num_(m.watch_through); c.wt_n++; }
  });
  var channels = order.map(function (p) {
    var c = ch[p], r = Math.max(c.impressions, c.views);
    return { platform: p, published: c.published, impressions: c.impressions, views: c.views, clicks: c.clicks, likes: c.likes, comments: c.comments, shares: c.shares,
      ctr: rate_(c.clicks, r), engagement_rate: rate_(c.likes + c.comments + c.shares + c.clicks, r), watch_through: c.wt_n ? round_(c.wt_sum / c.wt_n, 3) : null };
  });

  // ── A/B hook win rates ──
  var ab = {};
  social.forEach(function (m) {
    if (m.source === 'BLOG' || (m.hook_variant !== 'A' && m.hook_variant !== 'B')) return; // blog hooks are measured through their social cross-posts
    var a = ab[m.source] || (ab[m.source] = { A: { n: 0, reach: 0, eng: 0 }, B: { n: 0, reach: 0, eng: 0 } });
    a[m.hook_variant].n++; a[m.hook_variant].reach += reach_(m); a[m.hook_variant].eng += engagements_(m);
  });
  var abRows = Object.keys(ab).map(function (p) {
    var A = ab[p].A, B = ab[p].B, ra = rate_(A.eng, A.reach), rb = rate_(B.eng, B.reach);
    var enough = A.n >= 3 && B.n >= 3;
    return { platform: p, a_posts: A.n, b_posts: B.n, a_rate: ra, b_rate: rb, winner: !enough ? 'collecting data' : (ra === rb ? 'tie' : (ra > rb ? 'A' : 'B')) };
  });

  // ── Costs, usage, ROI ──
  var costs = dbReadAll_(TABS.COSTS).filter(function (c) { return c.date >= sinceDate; });
  var costDay = {}, costService = {}, usage = { claude_tokens: 0, elevenlabs_characters: 0, video_renders: 0, video_render_cost: 0 };
  costs.forEach(function (c) {
    var usd = num_(c.est_cost_usd);
    if (usd > 0) {
      (costDay[c.date] = costDay[c.date] || {})[c.service] = round_(num_((costDay[c.date] || {})[c.service]) + usd, 4);
      costService[c.service] = round_(num_(costService[c.service]) + usd, 4);
    }
    if (!truthy_(c.ok)) return;
    if (c.service === 'CLAUDE') usage.claude_tokens += num_(c.units);
    if (c.service === 'ELEVENLABS') usage.elevenlabs_characters += num_(c.units);
    if (c.operation === 'render') { usage.video_renders += 1; usage.video_render_cost = round_(usage.video_render_cost + usd, 4); }
  });
  var spend = Object.keys(costService).reduce(function (s, k) { return s + costService[k]; }, 0);
  var totals = channels.reduce(function (t, c) {
    t.reach += Math.max(c.impressions, c.views); t.clicks += c.clicks; t.eng += c.likes + c.comments + c.shares + c.clicks; return t;
  }, { reach: 0, clicks: 0, eng: 0 });
  var reachValue = totals.reach / 1000 * num_(cfg.cost.equiv_cpm_usd) + totals.clicks * num_(cfg.cost.equiv_cpc_usd);

  // ── API reliability (last 30 days of guardedFetch_ outcomes) ──
  var rel = getJsonProp_('RELIABILITY', {}), relSum = {};
  Object.keys(rel).forEach(function (d) {
    if (d < sinceDate) return;
    Object.keys(rel[d]).forEach(function (s) {
      var r = relSum[s] || (relSum[s] = [0, 0]);
      r[0] += rel[d][s][0]; r[1] += rel[d][s][1];
    });
  });
  var reliability = Object.keys(relSum).sort().map(function (s) {
    return { service: s, ok: relSum[s][0], failed: relSum[s][1], success_rate: rate_(relSum[s][0], relSum[s][0] + relSum[s][1]) };
  });

  var flSessions = ga.reduce(function (s, m) { return s + num_(m.sessions); }, 0);
  var flConv = ga.reduce(function (s, m) { return s + num_(m.conversions); }, 0);
  var flEngaged = ga.reduce(function (s, m) { return s + num_(m.engaged_sessions); }, 0);
  var queueCounts = {};
  dbReadAll_(TABS.QUEUE).forEach(function (q) { queueCounts[q.status] = (queueCounts[q.status] || 0) + 1; });

  return {
    generated_at: nowIso_(), range_days: days, dates: dates,
    has_ga4: !!getProp_('GA4_PROPERTY_ID', ''),
    kpis: {
      published: livePosts.length,
      blogs: ch.BLOG.published,
      videos: livePosts.filter(function (l) { return l.type === 'VIDEO'; }).length,
      social_reach: totals.reach, social_engagements: totals.eng, social_engagement_rate: rate_(totals.eng, totals.reach), clicks: totals.clicks,
      florida_sessions: flSessions, florida_engagement_rate: rate_(flEngaged, flSessions), florida_conversions: flConv, florida_conversion_rate: rate_(flConv, flSessions),
      spend_usd: round_(spend, 2), reach_value_usd: round_(reachValue, 2), roi_multiple: spend > 0 ? round_(reachValue / spend, 1) : null
    },
    trend: series(byDate),
    trend_by_city: trendByCity,
    metros: metros,
    channels: channels,
    ab_tests: abRows,
    costs: { by_day: dates.map(function (d) { var o = { date: d }; Object.keys(costDay[d] || {}).forEach(function (s) { o[s] = costDay[d][s]; }); return o; }), by_service: costService, usage: usage, assumptions: cfg.cost },
    reliability: reliability,
    queue_counts: queueCounts
  };
}

/** Raw rows for the Mac app's local CSV / JSON report export. */
function exportReport(payload) {
  var days = Math.max(7, Math.min(90, num_(payload && payload.days) || 30));
  var sinceIso = new Date(Date.now() - days * 864e5).toISOString();
  function strip(r) { var o = {}; Object.keys(r).forEach(function (k) { if (k !== '_row') o[k] = r[k]; }); return o; }
  return {
    dashboard: getDashboard({ days: days }),
    published: dbReadAll_(TABS.PUBLISHED).filter(function (l) { return l.ts >= sinceIso; }).map(strip),
    costs: dbReadAll_(TABS.COSTS).filter(function (c) { return c.ts >= sinceIso; }).map(strip)
  };
}
