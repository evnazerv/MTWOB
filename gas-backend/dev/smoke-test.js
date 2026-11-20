/**
 * Backend smoke test: `node gas-backend/dev/smoke-test.js`
 * Runs the real .gs code in the local harness (simulated Google services + simulated APIs)
 * and asserts the kill switch, toggle enforcement, queue state machine and aggregator.
 */
'use strict';
const assert = require('assert');
const { createBackend } = require('./harness');

const be = createBackend();
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
}
const ok = (res) => { assert.strictEqual(res.ok, true, JSON.stringify(res)); return res.data; };
const handlers = () => be.store.triggers.map((t) => t.handler).sort();
const ALL_TRIGGERS = ['cronGenerateContent', 'cronHarvestAnalytics', 'cronPollVideoRenders', 'cronPublishScheduled'];
const queue = (filter) => ok(be.post('getQueue', filter || {})).items;
const setTool = (key, enabled) => ok(be.post('setToolState', { key, enabled }));

console.log('Initialization & auth');
test('initializeSystem creates tabs, folder, token, triggers; all toggles OFF', () => {
  const s = be.run('initializeSystem');
  assert.ok(s.handshake_token.length >= 32);
  const ss = Object.values(be.store.spreadsheets)[0];
  ['Config', 'Tool_States', 'Content_Queue', 'Video_Render_Jobs', 'Published_Logs', 'Analytics_Metrics', 'Florida_Keywords'].forEach((t) => assert.ok(ss.sheets[t], 'missing tab ' + t));
  assert.ok(Object.values(be.store.folders).some((f) => f.name === 'NodeTelehealth_Media_Assets'));
  assert.deepStrictEqual(handlers(), ALL_TRIGGERS);
  assert.ok(ok(be.post('getToolStates')).every((t) => !t.enabled));
});
test('initializeSystem is idempotent (no duplicate triggers / spreadsheets)', () => {
  be.run('initializeSystem');
  assert.deepStrictEqual(handlers(), ALL_TRIGGERS);
  assert.strictEqual(Object.keys(be.store.spreadsheets).length, 1);
});
test('rejects a wrong or missing handshake token and malformed bodies', () => {
  assert.strictEqual(be.post('getState', {}, 'wrong').status, 401);
  assert.strictEqual(be.post('getState', {}, '').status, 401);
  assert.strictEqual(JSON.parse(be.rawPost('not json')).status, 400);
  assert.strictEqual(be.post('noSuchAction').status, 404);
});
test('secrets are write-only and only whitelisted keys are accepted', () => {
  ok(be.post('saveConfig', { cms_provider: 'WORDPRESS' })); // these tests cover the WordPress adapter
  ok(be.post('saveSecrets', { CLAUDE_API_KEY: 'sk-ant-test-1234', MASTER_KILL_SWITCH: 'ON', HANDSHAKE_TOKEN: 'x', WP_SITE_URL: 'https://nodetelehealth.com', WP_USERNAME: 'admin', WP_APP_PASSWORD: 'abcd efgh ijkl' }));
  assert.strictEqual(be.store.props.MASTER_KILL_SWITCH, 'OFF');
  assert.notStrictEqual(be.store.props.HANDSHAKE_TOKEN, 'x');
  const st = ok(be.post('getSecretStatus'));
  assert.deepStrictEqual(st.CLAUDE_API_KEY, { set: true, hint: '••••1234' });
  assert.strictEqual(st.WP_SITE_URL.value, 'https://nodetelehealth.com');
  assert.ok(!JSON.stringify(ok(be.post('getState'))).includes('sk-ant-test'));
});

console.log('Tool toggles');
test('nothing is generated and no API is called while every tool is OFF', () => {
  const before = be.store.fetchCount;
  const r = ok(be.post('runGenerateNow'));
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(be.store.fetchCount, before);
});
test('tool status reflects missing credentials', () => {
  const tools = setTool('TOGGLE_FACEBOOK', true);
  assert.strictEqual(tools.find((t) => t.key === 'TOGGLE_FACEBOOK').status, 'Missing API Key');
  assert.strictEqual(tools.find((t) => t.key === 'TOGGLE_BLOG_CMS').status, 'Paused');
  setTool('TOGGLE_FACEBOOK', false);
});
test('generation only targets enabled channels (APPROVAL mode → pending, unapproved)', () => {
  ok(be.post('saveSecrets', { META_PAGE_ID: '1111', META_PAGE_ACCESS_TOKEN: 'EAAtest', LINKEDIN_ACCESS_TOKEN: 'li', LINKEDIN_ORG_ID: '42' }));
  setTool('TOGGLE_BLOG_CMS', true); setTool('TOGGLE_FACEBOOK', true);
  const r = ok(be.post('runGenerateNow'));
  assert.deepStrictEqual(r.created.map((c) => c.platform).sort(), ['BLOG', 'FACEBOOK']);
  assert.ok(r.created.every((c) => c.status === 'PENDING_APPROVAL'));
  assert.ok(!queue().some((i) => ['LINKEDIN', 'X_TWITTER', 'INSTAGRAM'].includes(i.platform)));
});
test('blog payload is structured, sanitized, has FAQ schema + disclaimer', () => {
  const blog = ok(be.post('getQueueItem', { id: queue({ type: 'BLOG' })[0].id })).payload;
  ['title', 'slug', 'meta_description', 'focus_keyword', 'html_body', 'excerpt', 'tags'].forEach((k) => assert.ok(blog[k], 'missing ' + k));
  assert.match(blog.slug, /^[a-z0-9-]+$/);
  assert.ok(blog.html_body.includes('<h2>') && blog.html_body.includes('nodetelehealth.com') && blog.html_body.includes('call 911'));
  assert.strictEqual(JSON.parse(blog.faq_jsonld)['@type'], 'FAQPage');
});

console.log('Publishing workflow');
test('APPROVAL mode: publish cycle pushes the blog to the CMS as a DRAFT only', () => {
  const r = ok(be.post('runPublishNow'));
  assert.strictEqual(r.drafts.length, 1);
  assert.strictEqual(r.published.length, 0);
  const blog = queue({ type: 'BLOG' })[0];
  assert.strictEqual(blog.status, 'CMS_DRAFT');
  assert.ok(blog.cms_id);
  assert.ok(be.store.fetchLog.some((f) => f.url.endsWith('/wp-json/wp/v2/posts')));
  assert.strictEqual(queue({ type: 'SOCIAL' })[0].status, 'PENDING_APPROVAL');
});
test('"Publish Now" takes the draft live, logs it and queues cross-posts for enabled networks only', () => {
  const blog = queue({ type: 'BLOG' })[0];
  const live = ok(be.post('publishNow', { id: blog.id }));
  assert.strictEqual(live.status, 'PUBLISHED');
  assert.match(live.published_url, /^https:\/\/nodetelehealth\.com\/blog\//);
  const cross = queue({ type: 'SOCIAL' }).filter((i) => i.title.startsWith('Blog: '));
  assert.deepStrictEqual(cross.map((c) => c.platform), ['FACEBOOK']);
});
test('approve → scheduled → publish cycle posts to Facebook and writes Published_Logs', () => {
  const pending = queue({ status: 'PENDING_APPROVAL' }).find((i) => i.platform === 'FACEBOOK');
  ok(be.post('approveItem', { id: pending.id }));
  ok(be.post('updateQueueItem', { id: pending.id, scheduled_at: new Date(Date.now() - 1000).toISOString() }));
  const r = ok(be.post('runPublishNow'));
  assert.ok(r.published.length >= 2, JSON.stringify(r));
  assert.ok(queue().filter((i) => i.platform === 'FACEBOOK').every((i) => i.status === 'PUBLISHED'));
});
test('a tool switched OFF blocks publishing even via "Publish Now" (409 TOOL_DISABLED)', () => {
  const made = ok(be.post('generateOnDemand', { type: 'SOCIAL', platforms: ['FACEBOOK'] })).created[0];
  setTool('TOGGLE_FACEBOOK', false);
  const before = be.store.fetchCount;
  const res = be.post('publishNow', { id: made.id });
  assert.strictEqual(res.code, 'TOOL_DISABLED');
  assert.strictEqual(be.store.fetchCount, before);
  assert.strictEqual(ok(be.post('getQueueItem', { id: made.id })).status, 'PENDING_APPROVAL');
  setTool('TOGGLE_FACEBOOK', true);
});
test('compliance filter flags edited copy and holds it', () => {
  const item = queue({ status: 'PENDING_APPROVAL' })[0];
  const edited = ok(be.post('updateQueueItem', { id: item.id, payload: { text: 'We guarantee the best doctors nationwide will cure you.' } }));
  assert.ok(edited.payload.compliance_flags.length >= 3, JSON.stringify(edited.payload.compliance_flags));
});

console.log('Video pipeline');
test('APPROVAL mode: script waits; no voice/render spend until approved', () => {
  ok(be.post('saveSecrets', { ELEVENLABS_API_KEY: 'el', ELEVENLABS_VOICE_ID: 'voice1', HEYGEN_API_KEY: 'hg', HEYGEN_AVATAR_ID: 'avatar1', IG_USER_ID: '1784', CREATOMATE_API_KEY: 'cr', PEXELS_API_KEY: 'px' }));
  ok(be.post('saveConfig', { video_mode: 'HEYGEN_AVATAR' }));
  ['TOGGLE_INSTAGRAM', 'TOGGLE_YOUTUBE_SHORTS', 'TOGGLE_ELEVENLABS_VOICE', 'TOGGLE_VIDEO_RENDER'].forEach((k) => setTool(k, true));
  const v = ok(be.post('generateOnDemand', { type: 'VIDEO' })).created[0];
  assert.strictEqual(v.status, 'SCRIPT_READY');
  assert.strictEqual(v.platform, 'INSTAGRAM,YOUTUBE_SHORTS');
  assert.ok(!be.store.fetchLog.some((f) => f.url.includes('elevenlabs') || f.url.includes('heygen')));
});
test('approve → ElevenLabs MP3 in Drive → HeyGen job RENDERING → poller → READY_TO_PUBLISH with MP4 in Drive', () => {
  const v = queue({ type: 'VIDEO' })[0];
  const r = ok(be.post('approveItem', { id: v.id }));
  assert.strictEqual(r.status, 'RENDERING');
  assert.match(r.audio_url, /drive\.google\.com/);
  assert.strictEqual(ok(be.post('pollVideosNow')).ready.length, 0);  // still processing
  assert.strictEqual(ok(be.post('pollVideosNow')).ready.length, 1);
  const done = ok(be.post('getQueueItem', { id: v.id }));
  assert.strictEqual(done.status, 'READY_TO_PUBLISH');
  assert.strictEqual(done.approved, false); // human previews the MP4 first
  assert.ok(Object.values(be.store.files).some((f) => f.name === 'video_' + v.id + '.mp4' && f.shared));
});
test('publishing the video hits only enabled targets and never double-posts', () => {
  const v = queue({ type: 'VIDEO' })[0];
  setTool('TOGGLE_YOUTUBE_SHORTS', false);
  const r = ok(be.post('publishNow', { id: v.id }));
  assert.strictEqual(r.status, 'PUBLISHED');
  assert.deepStrictEqual(Object.keys(r.payload.publish_results), ['INSTAGRAM']);
  assert.strictEqual(be.post('publishNow', { id: v.id }).status, 409);
});
test('faceless mode (Creatomate + Pexels b-roll) renders through the same poller', () => {
  ok(be.post('saveConfig', { video_mode: 'FACELESS_BROLL', workflow_mode: 'AUTONOMOUS' }));
  const v = ok(be.post('generateOnDemand', { type: 'VIDEO' })).created[0];
  assert.strictEqual(ok(be.post('getQueueItem', { id: v.id })).status, 'RENDERING');
  be.post('pollVideosNow'); ok(be.post('pollVideosNow'));
  const done = ok(be.post('getQueueItem', { id: v.id }));
  assert.strictEqual(done.status, 'READY_TO_PUBLISH');
  assert.strictEqual(done.approved, true); // autonomous
});

console.log('Wix Blog');
test('Wix: approval mode sends a draft; Publish Now takes it live with SEO, tags, category and author', () => {
  ok(be.post('saveConfig', { cms_provider: 'WIX', workflow_mode: 'APPROVAL' }));
  const tools = ok(be.post('getToolStates'));
  assert.strictEqual(tools.find((t) => t.key === 'TOGGLE_BLOG_CMS').status, 'Missing API Key');
  ok(be.post('saveSecrets', { WIX_API_KEY: 'IST.fake', WIX_SITE_ID: '236ade3d-5395-424f-a2a6-f507b60c7a6f', WIX_AUTHOR_EMAIL: 'Info@NodeTelehealth.com' }));
  assert.strictEqual(ok(be.post('testConnection', { service: 'WIX' })).ok, true);
  const covers = Object.values(be.store.folders).find((f) => f.name === 'Blog_Covers');
  be.store.files['cover1'] = { id: 'cover1', name: 'cover.jpg', bytes: Buffer.alloc(10), type: 'image/jpeg', parent: covers.id };
  const blog = ok(be.post('generateOnDemand', { type: 'BLOG' })).created[0];
  // make the article longer than Wix's 10,000-character conversion limit to exercise splitting
  const long = ok(be.post('getQueueItem', { id: blog.id })).payload.html_body + Array.from({ length: 40 }, (_, i) => '<h2>Section ' + i + '</h2><p>' + 'Florida telehealth text. '.repeat(20) + '</p>').join('');
  ok(be.post('updateQueueItem', { id: blog.id, payload: { html_body: long } }));
  ok(be.post('runPublishNow'));
  const draft = ok(be.post('getQueueItem', { id: blog.id }));
  assert.strictEqual(draft.status, 'CMS_DRAFT');
  const w = be.store.wix, post = w.posts[draft.cms_id];
  assert.ok(post && !post.live, 'draft created, not live');
  assert.strictEqual(post.draft.memberId, 'mem-1');
  assert.ok(post.draft.richContent.nodes.length > 40, 'all converted chunks joined');
  assert.ok(w.calls.filter((c) => c.path.endsWith('/convert/to-ricos')).length >= 2, 'long article split into several conversions');
  assert.ok(post.draft.seoData.tags.some((t) => t.type === 'meta' && t.props.name === 'description'));
  assert.ok(post.draft.seoData.tags.some((t) => t.type === 'script'), 'FAQ JSON-LD included');
  assert.ok(post.draft.tagIds.length >= 3 && post.draft.categoryIds.length === 1);
  assert.ok(post.draft.media.wixMedia.image.id, 'cover image imported');
  assert.ok(w.calls.every((c) => c.auth === 'IST.fake' && c.site === '236ade3d-5395-424f-a2a6-f507b60c7a6f'));
  const live = ok(be.post('publishNow', { id: blog.id }));
  assert.strictEqual(live.status, 'PUBLISHED');
  assert.ok(post.live);
  assert.strictEqual(live.published_url, 'https://www.nodetelehealth.com/post/' + post.draft.seoSlug);
  ok(be.post('saveConfig', { workflow_mode: 'AUTONOMOUS' }));
});

console.log('Kill switch');
test('engaging deletes ALL triggers and reports HARD STOPPED', () => {
  const s = ok(be.post('setKillSwitch', { engaged: true }));
  assert.strictEqual(s.kill_switch, 'ON');
  assert.strictEqual(s.system_status, 'HARD STOPPED');
  assert.strictEqual(be.store.triggers.length, 0);
});
test('every work action returns 423 SYSTEM_HALTED and makes zero outbound calls', () => {
  const before = be.store.fetchCount;
  ['runGenerateNow', 'runPublishNow', 'pollVideosNow', 'harvestNow', 'researchKeywords', 'generateOnDemand', 'publishNow', 'approveItem', 'regenerateItem', 'rerenderVideo', 'testConnection'].forEach((a) => {
    const r = be.post(a, { id: 'x', type: 'BLOG', service: 'CLAUDE' });
    assert.strictEqual(r.status, 423, a + ' → ' + JSON.stringify(r));
    assert.strictEqual(r.code, 'SYSTEM_HALTED');
  });
  assert.strictEqual(be.store.fetchCount, before);
});
test('cron runners and low-level callers abort when invoked directly while halted', () => {
  const before = be.store.fetchCount;
  ['cronGenerateContent', 'cronPublishScheduled', 'cronPollVideoRenders', 'cronHarvestAnalytics', 'runGenerateCycle_', 'runPublishCycle_', 'runVideoPoll_'].forEach((fn) => {
    assert.throws(() => be.run(fn), /MASTER_KILL_SWITCH/, fn);
  });
  assert.throws(() => be.run('guardedFetch_', null, 'TEST', 'https://api.anthropic.com/v1/messages', {}), /MASTER_KILL_SWITCH/);
  assert.throws(() => be.run('callClaudeJson_', { task: 't', toolKey: 'TOGGLE_BLOG_CMS', user: 'u', schema: {} }), /MASTER_KILL_SWITCH/);
  assert.throws(() => be.run('rebuildTriggers_'), /MASTER_KILL_SWITCH/);
  assert.strictEqual(be.store.fetchCount, before);
  assert.strictEqual(be.store.triggers.length, 0);
});
test('control plane stays reachable while halted (state, toggles, settings, dashboard)', () => {
  ['getState', 'heartbeat', 'getToolStates', 'getConfig', 'getDashboard', 'getQueue', 'getSecretStatus'].forEach((a) => ok(be.post(a)));
  assert.ok(ok(be.post('getToolStates')).length >= 11);
});
test('disengaging restores exactly one trigger per handler (also when repeated)', () => {
  ok(be.post('setKillSwitch', { engaged: false }));
  ok(be.post('setKillSwitch', { engaged: false }));
  assert.deepStrictEqual(handlers(), ALL_TRIGGERS);
  assert.strictEqual(ok(be.post('getState')).system_status, 'RUNNING');
});

console.log('Analytics');
test('harvest respects its toggle, then stores metrics; dashboard aggregates them', () => {
  assert.strictEqual(be.post('harvestNow').code, 'TOOL_DISABLED');
  ok(be.post('saveSecrets', { GA4_PROPERTY_ID: '123456' }));
  setTool('TOGGLE_ANALYTICS_POLLING', true);
  const h = ok(be.post('harvestNow'));
  assert.ok(h.rows > 0 && h.ga4.city_rows > 0, JSON.stringify(h));
  assert.deepStrictEqual(h.errors, []);
  const d = ok(be.post('getDashboard', { days: 30 }));
  assert.strictEqual(d.dates.length, 30);
  assert.ok(d.kpis.florida_sessions > 0 && d.kpis.published >= 3 && d.kpis.spend_usd > 0);
  assert.ok(d.metros.some((m) => m.metro === 'Miami' && m.sessions > 0));
  assert.ok(d.channels.find((c) => c.platform === 'FACEBOOK').impressions > 0);
  assert.ok(d.costs.usage.elevenlabs_characters > 0 && d.costs.usage.video_renders === 2);
  assert.ok(d.reliability.some((r) => r.service === 'CLAUDE' && r.success_rate === 1));
  assert.ok(ok(be.post('getToolStates')).find((t) => t.key === 'TOGGLE_ELEVENLABS_VOICE').usage_units > 0);
});
test('time-driven triggers run end-to-end without errors', () => {
  const results = be.fireTriggers();
  assert.strictEqual(results.length, 4);
  results.forEach((r) => assert.ok(!r.error, r.handler + ': ' + r.error));
});
test('heartbeat returns events for native notifications', () => {
  const hb = ok(be.post('heartbeat', { since: '' }));
  assert.ok(hb.events.some((e) => e.type === 'PUBLISHED') && hb.events.some((e) => e.type === 'RENDERED'));
  assert.strictEqual(ok(be.post('heartbeat', { since: hb.server_time })).events.length, 0);
});

console.log(process.exitCode ? '\nSOME TESTS FAILED' : `\nAll ${passed} backend checks passed.`);
