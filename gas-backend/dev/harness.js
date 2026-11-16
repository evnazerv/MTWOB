/**
 * Local development harness — runs the real *.gs backend files under Node with in-memory
 * stand-ins for the Apps Script services (PropertiesService, SpreadsheetApp, DriveApp,
 * ScriptApp triggers, UrlFetchApp …) and SIMULATED third-party APIs.
 *
 * Nothing here is deployed to Google. It exists so the backend logic (kill switch, toggles,
 * queue state machine, publishers, aggregator) can be tested and the Mac app can be tried
 * before any real account is connected. All API responses below are fake.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const GAS_DIR = path.join(__dirname, '..');
const SOURCE = fs.readdirSync(GAS_DIR).filter((f) => f.endsWith('.gs')).sort((a, b) => (a === 'Code.gs' ? -1 : b === 'Code.gs' ? 1 : a.localeCompare(b)))
  .map((f) => `// ---- ${f} ----\n` + fs.readFileSync(path.join(GAS_DIR, f), 'utf8')).join('\n');
const SCRIPT = new vm.Script(SOURCE, { filename: 'gas-backend.js' });

let seq = 0;
const nextId = (p) => `${p}${(++seq).toString(36)}${crypto.randomBytes(4).toString('hex')}`;

function makeBlob(bytes, type, name) {
  const blob = {
    _bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes)), _type: type || 'application/octet-stream', _name: name || 'blob',
    setName(n) { blob._name = n; return blob; }, getName: () => blob._name,
    setContentType(t) { blob._type = t; return blob; }, getContentType: () => blob._type,
    getBytes: () => blob._bytes, getDataAsString: () => blob._bytes.toString('utf8')
  };
  return blob;
}

function createStore() {
  return { props: {}, spreadsheets: {}, folders: {}, files: {}, triggers: [], cache: {}, fetchLog: [], fetchCount: 0 };
}

/* ───────────── Apps Script service stand-ins ───────────── */

function buildServices(store, fakeFetch) {
  const sheetApi = (ss, name) => {
    const data = ss.sheets[name];
    const range = (r, c, nr, nc) => ({
      setValues(values) {
        values.forEach((row, i) => {
          const target = data[r - 1 + i] || (data[r - 1 + i] = []);
          row.forEach((v, j) => { target[c - 1 + j] = v; });
        });
        return this;
      },
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (data[r - 1 + i] || [])[c - 1 + j] ?? '')),
      setNumberFormat() { return this; }
    });
    return {
      getName: () => name,
      getDataRange: () => ({ getValues: () => (data.length ? data.map((row) => row.slice()) : [[]]) }),
      getRange: range,
      appendRow(row) { data.push(row.slice()); },
      getLastRow: () => data.length,
      getMaxRows: () => 1000,
      setFrozenRows() {},
      deleteRow(r) { data.splice(r - 1, 1); },
      clearContents() { data.length = 0; }
    };
  };
  const ssApi = (ss) => ({
    getId: () => ss.id, getUrl: () => `https://docs.google.com/spreadsheets/d/${ss.id}`,
    getSheetByName: (n) => (ss.sheets[n] ? sheetApi(ss, n) : null),
    insertSheet(n) { ss.sheets[n] = []; return sheetApi(ss, n); },
    deleteSheet(sh) { delete ss.sheets[sh.getName()]; }
  });
  const iterator = (list) => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
  const fileApi = (f) => ({
    getId: () => f.id, getName: () => f.name, getSize: () => f.bytes.length, getMimeType: () => f.type,
    getBlob: () => makeBlob(f.bytes, f.type, f.name), setSharing() { f.shared = true; }, getUrl: () => `https://drive.google.com/file/d/${f.id}`
  });
  const folderApi = (fo) => ({
    getId: () => fo.id, getName: () => fo.name, getUrl: () => `https://drive.google.com/drive/folders/${fo.id}`,
    getFoldersByName: (n) => iterator(Object.values(store.folders).filter((x) => x.parent === fo.id && x.name === n).map(folderApi)),
    createFolder(n) { const id = nextId('fld'); store.folders[id] = { id, name: n, parent: fo.id }; return folderApi(store.folders[id]); },
    createFile(a, content, mime) {
      const id = nextId('file');
      store.files[id] = typeof a === 'string'
        ? { id, name: a, bytes: Buffer.from(String(content)), type: mime || 'text/plain', parent: fo.id }
        : { id, name: a.getName(), bytes: a.getBytes(), type: a.getContentType(), parent: fo.id };
      return fileApi(store.files[id]);
    },
    getFiles: () => iterator(Object.values(store.files).filter((x) => x.parent === fo.id).map(fileApi))
  });
  const fmt = (date, tz, pattern) => {
    const parts = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz === 'UTC' ? 'UTC' : tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
    const monthName = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long' }).format(date);
    return pattern.replace('MMMM', '\u0001').replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day).replace('H', String(Number(parts.hour))).replace('\u0001', monthName);
  };

  return {
    console,
    Logger: { log: (m) => { if (process.env.HARNESS_VERBOSE) console.log('[Logger]', m); } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in store.props ? store.props[k] : null),
      setProperty(k, v) { store.props[k] = String(v); }, deleteProperty(k) { delete store.props[k]; },
      getProperties: () => ({ ...store.props })
    }) },
    SpreadsheetApp: {
      create(name) { const id = nextId('ss'); store.spreadsheets[id] = { id, name, sheets: { Sheet1: [] } }; return ssApi(store.spreadsheets[id]); },
      openById(id) { if (!store.spreadsheets[id]) throw new Error('Spreadsheet not found'); return ssApi(store.spreadsheets[id]); },
      getActiveSpreadsheet: () => null
    },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' },
      getFolderById(id) { if (!store.folders[id]) throw new Error('Folder not found'); return folderApi(store.folders[id]); },
      getFoldersByName: (n) => iterator(Object.values(store.folders).filter((x) => !x.parent && x.name === n).map(folderApi)),
      createFolder(n) { const id = nextId('fld'); store.folders[id] = { id, name: n, parent: null }; return folderApi(store.folders[id]); },
      getFileById(id) { if (!store.files[id]) throw new Error('File not found'); return fileApi(store.files[id]); }
    },
    ScriptApp: {
      getProjectTriggers: () => store.triggers.map((t) => ({ getHandlerFunction: () => t.handler, _id: t.id })),
      deleteTrigger(t) { store.triggers = store.triggers.filter((x) => x.id !== t._id); },
      newTrigger: (handler) => ({ timeBased: () => {
        const t = { id: nextId('trg'), handler, every: '' };
        const b = { everyMinutes(n) { t.every = n + 'm'; return b; }, everyHours(n) { t.every = n + 'h'; return b; }, create() { store.triggers.push(t); return t; } };
        return b;
      } }),
      getOAuthToken: () => 'fake-google-oauth-token'
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => store.cache[k] ?? null, put(k, v) { store.cache[k] = v; }, remove(k) { delete store.cache[k]; } }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (s) => ({ setMimeType() { return this; }, getContent: () => s }) },
    Utilities: {
      Charset: { UTF_8: 'utf8' }, MacAlgorithm: { HMAC_SHA_1: 'sha1' },
      getUuid: () => crypto.randomUUID(), sleep() {}, formatDate: fmt,
      base64Encode: (v) => Buffer.from(v).toString('base64'),
      computeHmacSignature: (alg, value, key) => Array.from(crypto.createHmac(alg, key).update(value).digest()),
      newBlob: (bytes, type, name) => makeBlob(bytes, type, name)
    },
    UrlFetchApp: { fetch(url, opts) {
      store.fetchCount++;
      store.fetchLog.push({ url, method: (opts && opts.method) || 'get' });
      if (store.fetchLog.length > 500) store.fetchLog.shift();
      const r = fakeFetch(url, opts || {}, store) || { code: 404, body: '{"error":"no fake route"}' };
      const body = r.body === undefined ? '' : r.body;
      return {
        getResponseCode: () => r.code || 200,
        getContentText: () => (Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : JSON.stringify(body)),
        getBlob: () => makeBlob(Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), 'application/octet-stream', 'download'),
        getHeaders: () => r.headers || {}
      };
    } }
  };
}

/* ───────────── Simulated third-party APIs ───────────── */

function fakeClaude(body) {
  const props = body.output_config.format.schema.properties;
  const user = body.messages[0].content;
  const metro = (user.match(/Florida metro focus: (.+)/) || [])[1] || 'Tampa';
  const keyword = (user.match(/Focus keyword: (.+)/) || [])[1] || 'telehealth Florida';
  let out;
  if (props.keywords) {
    const metros = props.keywords.items.properties.metro.enum, pillars = props.keywords.items.properties.pillar.enum;
    out = { keywords: Array.from({ length: 8 }, (_, i) => ({ keyword: `sample telehealth topic ${Date.now() % 100000}-${i} ${metros[i % metros.length]}`, metro: metros[i % metros.length], pillar: pillars[i % pillars.length], intent: 'local', topic_idea: `Sample angle ${i + 1} for ${metros[i % metros.length]} residents`, difficulty: 'low' })) };
  } else if (props.html_body) {
    out = {
      title: `Telehealth in ${metro}: What Florida Residents Should Know`, slug: `telehealth-${metro}-florida-guide`,
      meta_description: `A practical guide to ${keyword} for ${metro} residents: how video visits work with Florida-licensed providers. Learn more today.`,
      focus_keyword: keyword, excerpt: `How video visits with Florida-licensed providers work for people in ${metro}.`,
      tags: ['Telehealth', metro, 'Florida', 'Video Visits'],
      html_body: `<p>If you live in ${metro}, getting to a clinic can mean traffic, heat and a long wait. This sample article explains ${keyword}.</p><h2>How ${keyword} works</h2><p>Visits happen over secure audio-video with Florida-licensed providers. <a href="https://nodetelehealth.com/">Learn how NodeTelehealth works</a>.</p><h2>When not to use telehealth</h2><p>For emergencies, call 911.</p><h3>Getting ready</h3><ul><li>Find a quiet, well-lit spot</li><li>Have your medication list nearby</li></ul><p><a href="https://nodetelehealth.com/">Schedule a visit</a>.</p>`,
      faq: [{ question: `Can I use telehealth if I am only in ${metro} for the winter?`, answer: 'Yes, as long as you are physically located in Florida at the time of your visit.' }, { question: 'Who will I see?', answer: 'A Florida-licensed provider, by secure video.' }],
      social_blurb: `New on the blog: a plain-language guide to ${keyword} for ${metro} residents.`,
      hook_a: `Is a video visit right for you, ${metro}?`, hook_b: `Skip the waiting room in ${metro}`
    };
  } else if (props.scenes) {
    out = {
      title: `${metro}: see a Florida-licensed provider from home`, hook_a: 'Stuck in the waiting room?', hook_b: 'Care from your couch',
      scenes: [
        { seconds: 5, narration: `Living in ${metro} and dreading the drive to a clinic?`, visual_prompt: 'Traffic on a palm-lined road', broll_search: 'florida traffic palm trees', on_screen_caption: 'Skip the drive' },
        { seconds: 7, narration: 'A secure video visit lets you talk with a provider from home.', visual_prompt: 'Person on a phone video call at home', broll_search: 'video call doctor phone', on_screen_caption: 'Video visits at home' },
        { seconds: 7, narration: 'Your provider decides whether telehealth is right for your concern.', visual_prompt: 'Friendly clinician on laptop', broll_search: 'doctor laptop consultation', on_screen_caption: 'Provider-guided care' },
        { seconds: 8, narration: 'Visits are with Florida-licensed providers for people in Florida. Learn more at node telehealth dot com.', visual_prompt: 'Sunrise over a Florida beach', broll_search: 'florida beach sunrise', on_screen_caption: 'nodetelehealth.com' }
      ],
      caption: `Video visits for ${metro} residents with Florida-licensed providers.`, hashtags: ['FloridaTelehealth', metro.replace(/[^A-Za-z]/g, ''), 'Telehealth'], cta: 'Learn more at node telehealth dot com.'
    };
  } else {
    out = {};
    Object.keys(props).forEach((p) => {
      const fields = props[p].properties;
      const post = { hook_a: `${metro}, would a video visit save your afternoon?`, hook_b: `See a Florida-licensed provider without leaving ${metro}` };
      if (fields.body) post.body = `Sample ${p} post about ${keyword}. Secure video visits with Florida-licensed providers for people in ${metro}, Florida.`;
      if (fields.thread) post.thread = ['How it works: a secure audio-video visit from home.', 'Your provider decides if telehealth fits your concern. Learn more at NodeTelehealth.'];
      if (fields.hashtags) post.hashtags = ['FloridaTelehealth', metro.replace(/[^A-Za-z]/g, '')];
      if (fields.carousel_slides) post.carousel_slides = ['Why telehealth', 'How a visit works', 'What to prepare', 'When to call 911', 'Get started'];
      out[p] = post;
    });
  }
  return { code: 200, body: { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }], usage: { input_tokens: 1400, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
}

function defaultFakeFetch(url, opts, store) {
  const u = new URL(url);
  const json = () => { try { return JSON.parse(opts.payload); } catch (e) { return {}; } };
  const host = u.hostname, p = u.pathname, method = String(opts.method || 'get').toLowerCase();
  const ext = store.ext || (store.ext = { n: 1000, polls: {} });
  const id = () => String(++ext.n);

  if (host === 'api.anthropic.com') return p.endsWith('/messages') ? fakeClaude(json()) : { code: 200, body: { data: [{ id: 'claude-sonnet-4-6' }] } };
  if (host === 'api.elevenlabs.io') return p.includes('/voices/') ? { code: 200, body: { name: 'Sample Voice' } } : { code: 200, body: Buffer.alloc(16000 * 34, 1) };
  if (host === 'upload.heygen.com') return { code: 200, body: { code: 100, data: { id: 'asset_' + id() } } };
  if (host === 'api.heygen.com') {
    if (p.endsWith('/video/generate')) return { code: 200, body: { error: null, data: { video_id: 'hg_' + id() } } };
    if (p.endsWith('/remaining_quota')) return { code: 200, body: { data: { remaining_quota: 600 } } };
    const vid = u.searchParams.get('video_id');
    ext.polls[vid] = (ext.polls[vid] || 0) + 1;
    return { code: 200, body: { data: ext.polls[vid] < 2 ? { status: 'processing' } : { status: 'completed', video_url: 'https://cdn.fake/video.mp4', video_url_caption: 'https://cdn.fake/video_caption.mp4', duration: 34 } } };
  }
  if (host === 'api.creatomate.com') {
    if (method === 'post') return { code: 202, body: [{ id: 'cr_' + id(), status: 'planned' }] };
    if (p.endsWith('/templates')) return { code: 200, body: [] };
    const rid = p.split('/').pop();
    ext.polls[rid] = (ext.polls[rid] || 0) + 1;
    return { code: 200, body: ext.polls[rid] < 2 ? { status: 'rendering' } : { status: 'succeeded', url: 'https://cdn.fake/render.mp4', duration: 35 } };
  }
  if (host === 'api.pexels.com') return { code: 200, body: { videos: [{ id: Number(id()), video_files: [{ file_type: 'video/mp4', width: 1080, height: 1920, link: 'https://cdn.fake/broll' + ext.n + '.mp4' }] }] } };
  if (host === 'cdn.fake') return { code: 200, body: Buffer.alloc(250000, 2) };
  if (p.includes('/wp-json/wp/v2')) {
    if (p.endsWith('/users/me')) return { code: 200, body: { name: 'Site Admin', capabilities: { publish_posts: true } } };
    if (/\/(tags|categories)$/.test(p)) return method === 'get' ? { code: 200, body: [] } : { code: 201, body: { id: Number(id()) } };
    if (p.includes('/media')) return { code: 201, body: { id: Number(id()) } };
    if (p.includes('/posts')) { const b = json(); const pid = p.split('/posts/')[1] || id(); return { code: 201, body: { id: Number(pid), status: b.status, link: b.status === 'publish' ? `https://nodetelehealth.com/blog/${b.slug}/` : `https://nodetelehealth.com/?p=${pid}` } }; }
  }
  if (host === 'api.webflow.com') return p.endsWith('/publish') ? { code: 202, body: { publishedItemIds: [] } } : { code: 202, body: { id: 'wf_' + id(), displayName: 'Blog Posts', fields: [{ slug: 'post-body' }, { slug: 'post-summary' }, { slug: 'seo-description' }] } };
  if (host === 'graph.facebook.com') {
    if (p.endsWith('/feed')) return { code: 200, body: { id: '1111_' + id() } };
    if (p.endsWith('/media')) return { code: 200, body: { id: 'igc_' + id() } };
    if (p.endsWith('/media_publish')) return { code: 200, body: { id: 'igm_' + id() } };
    if (p.endsWith('/insights')) {
      const seed = parseInt(crypto.createHash('md5').update(p).digest('hex').slice(0, 6), 16);
      if (p.includes('igm_')) return { code: 200, body: { data: [['reach', 900 + seed % 2500], ['views', 1400 + seed % 4000], ['likes', 40 + seed % 160], ['comments', seed % 25], ['shares', seed % 40], ['saved', seed % 30], ['ig_reels_avg_watch_time', 14000 + seed % 16000]].map(([name, value]) => ({ name, values: [{ value }] })) } };
      return { code: 200, body: { data: [{ name: 'post_impressions_unique', values: [{ value: 500 + seed % 1800 }] }, { name: 'post_clicks', values: [{ value: 12 + seed % 70 }] }] } };
    }
    if (u.searchParams.get('fields') && u.searchParams.get('fields').startsWith('status_code')) return { code: 200, body: { status_code: 'FINISHED' } };
    if (u.searchParams.get('fields') === 'permalink') return { code: 200, body: { permalink: 'https://www.instagram.com/reel/SAMPLE/' } };
    if ((u.searchParams.get('fields') || '').startsWith('shares')) { const seed = parseInt(crypto.createHash('md5').update(p).digest('hex').slice(0, 6), 16); return { code: 200, body: { shares: { count: seed % 20 }, likes: { summary: { total_count: 15 + seed % 90 } }, comments: { summary: { total_count: seed % 18 } } } }; }
    return { code: 200, body: { name: 'NodeTelehealth', instagram_business_account: { id: '17840000000' } } };
  }
  if (host === 'api.x.com') {
    if (method === 'post') return { code: 201, body: { data: { id: '18' + Date.now() + id() } } };
    if (p.endsWith('/users/me')) return { code: 200, body: { data: { username: 'nodetelehealth' } } };
    return { code: 200, body: { data: (u.searchParams.get('ids') || '').split(',').map((tid, i) => ({ id: tid, public_metrics: { impression_count: 300 + (i * 137) % 900, like_count: 6 + (i * 7) % 30, reply_count: i % 4, retweet_count: i % 6, quote_count: 0 } })) } };
  }
  if (host === 'api.linkedin.com') {
    if (method === 'post') return { code: 201, body: {}, headers: { 'x-restli-id': 'urn:li:share:' + id() } };
    return { code: 200, body: { elements: [{ totalShareStatistics: { impressionCount: 640, clickCount: 31, likeCount: 22, commentCount: 3, shareCount: 4 } }] } };
  }
  if (host === 'www.googleapis.com' && p.startsWith('/upload/youtube')) return { code: 200, body: '', headers: { Location: 'https://upload.fake/youtube-session' } };
  if (host === 'upload.fake') return { code: 200, body: { id: 'yt_' + id() } };
  if (host === 'www.googleapis.com' && p.endsWith('/videos')) return { code: 200, body: { items: (u.searchParams.get('id') || '').split(',').map((vid, i) => ({ id: vid, statistics: { viewCount: String(800 + i * 310), likeCount: String(30 + i * 9), commentCount: String(2 + i) } })) } };
  if (host === 'www.googleapis.com' && p.endsWith('/channels')) return { code: 200, body: { items: [{ snippet: { title: 'NodeTelehealth' } }] } };
  if (host === 'open.tiktokapis.com') {
    if (p.includes('/video/init')) return { code: 200, body: { data: { publish_id: 'tt_' + id(), upload_url: 'https://upload.fake/tiktok' }, error: { code: 'ok' } } };
    if (p.includes('/status/fetch')) return { code: 200, body: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['7' + json().publish_id.replace(/\D/g, '')] } } };
    if (p.includes('/video/query')) return { code: 200, body: { data: { videos: json().filters.video_ids.map((v, i) => ({ id: v, view_count: 2100 + i * 800, like_count: 120 + i * 30, comment_count: 9 + i, share_count: 14 + i })) } } };
  }
  if (host === 'mybusiness.googleapis.com') return { code: 200, body: { name: 'accounts/1/locations/2/localPosts/' + id(), searchUrl: 'https://local.google.com/place?id=sample' } };
  if (host === 'analyticsdata.googleapis.com') {
    const b = json();
    if (b.dimensions && b.dimensions[0].name === 'pagePath') {
      return { code: 200, body: { rows: Object.values(store.spreadsheets).flatMap((ss) => (ss.sheets.Published_Logs || []).slice(1)).filter((r) => r[4] === 'BLOG').map((r, i) => ({ dimensionValues: [{ value: new URL(r[6]).pathname }], metricValues: [{ value: String(180 + i * 45) }, { value: String(120 + i * 30) }, { value: String(80 + i * 20) }, { value: String(4 + i) }] })) } };
    }
    if (!b.dimensions) return { code: 200, body: { rows: [{ metricValues: [{ value: '412' }] }] } };
    const cities = ['Miami', 'Orlando', 'Tampa', 'Jacksonville', 'Sarasota', 'Fort Lauderdale', 'Naples', 'The Villages'];
    const span = b.dateRanges[0].startDate === '30daysAgo' ? 30 : 3;
    const rows = [];
    for (let d = span; d >= 0; d--) {
      const day = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
      cities.forEach((city, ci) => {
        const s = Math.round((60 - ci * 6) * (1 + (span - d) * 0.02) + ((d * 7 + ci * 13) % 17));
        rows.push({ dimensionValues: [{ value: day }, { value: city }], metricValues: [{ value: String(s) }, { value: String(Math.round(s * (0.52 + ((d + ci) % 7) * 0.03))) }, { value: String(s * 2) }, { value: String(Math.round(s * (0.03 + ((d + ci) % 5) * 0.008))) }] });
      });
    }
    return { code: 200, body: { rows } };
  }
  if (host === 'hooks.fake') return { code: 200, body: { id: 'hook_' + id(), url: 'https://example.invalid/post' } };
  return null;
}

/* ───────────── Backend instance ───────────── */

function createBackend(options = {}) {
  const store = options.store || createStore();
  const fakeFetch = options.fakeFetch || defaultFakeFetch;
  /** Every call runs in a fresh global scope, exactly like a real Apps Script execution. */
  function run(fnName, ...args) {
    const ctx = vm.createContext(buildServices(store, fakeFetch));
    SCRIPT.runInContext(ctx);
    if (typeof ctx[fnName] !== 'function') throw new Error('No such backend function: ' + fnName);
    return ctx[fnName](...args);
  }
  function post(action, payload, token) {
    const out = run('doPost', { postData: { contents: JSON.stringify({ token: token === undefined ? store.props.HANDSHAKE_TOKEN : token, action, payload: payload || {} }) } });
    return JSON.parse(out.getContent());
  }
  function rawPost(body) { return run('doPost', { postData: { contents: body } }).getContent(); }
  /** Fires every installed time-driven trigger once (what Google's scheduler would do). */
  function fireTriggers() {
    return store.triggers.map((t) => { try { return { handler: t.handler, result: run(t.handler) }; } catch (e) { return { handler: t.handler, error: e.message }; } });
  }
  return { store, run, post, rawPost, fireTriggers };
}

module.exports = { createBackend, createStore, defaultFakeFetch };
