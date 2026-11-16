/**
 * Local backend for trying the Mac app without deploying anything:
 *
 *   node gas-backend/dev/serve.js           → empty system, all tools OFF
 *   node gas-backend/dev/serve.js --demo    → fake credentials, tools ON, sample content
 *
 * It serves the real .gs code over http://127.0.0.1:8787/exec with SIMULATED Google services
 * and SIMULATED third-party APIs (see harness.js). Installed "triggers" are fired every 20 s,
 * so engaging the Kill Switch visibly stops all background activity. Data lives in memory.
 */
'use strict';
const http = require('http');
const { createBackend } = require('./harness');

const PORT = Number(process.env.PORT) || 8787;
const be = createBackend();
const init = be.run('initializeSystem');

if (process.argv.includes('--demo')) {
  const post = (a, p) => { const r = be.post(a, p); if (!r.ok) console.warn('demo seed:', a, r.error); return r.data; };
  post('saveSecrets', {
    CLAUDE_API_KEY: 'sk-ant-demo-0000', WP_SITE_URL: 'https://nodetelehealth.com', WP_USERNAME: 'demo', WP_APP_PASSWORD: 'demo demo demo',
    ELEVENLABS_API_KEY: 'demo', ELEVENLABS_VOICE_ID: 'demo-voice', HEYGEN_API_KEY: 'demo', HEYGEN_AVATAR_ID: 'demo-avatar', CREATOMATE_API_KEY: 'demo', PEXELS_API_KEY: 'demo',
    META_PAGE_ID: '1111', META_PAGE_ACCESS_TOKEN: 'demo', IG_USER_ID: '1784', X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'ts',
    LINKEDIN_ACCESS_TOKEN: 'demo', LINKEDIN_ORG_ID: '42', GA4_PROPERTY_ID: '123456'
  });
  post('saveConfig', { video_mode: 'HEYGEN_AVATAR', workflow_mode: 'AUTONOMOUS' });
  ['TOGGLE_CLAUDE_IDEATION', 'TOGGLE_BLOG_CMS', 'TOGGLE_ELEVENLABS_VOICE', 'TOGGLE_VIDEO_RENDER', 'TOGGLE_FACEBOOK', 'TOGGLE_INSTAGRAM', 'TOGGLE_X_TWITTER', 'TOGGLE_LINKEDIN', 'TOGGLE_YOUTUBE_SHORTS', 'TOGGLE_ANALYTICS_POLLING']
    .forEach((key) => post('setToolState', { key, enabled: true }));
  for (let i = 0; i < 3; i++) {
    post('generateOnDemand', { type: 'BLOG' });
    post('generateOnDemand', { type: 'SOCIAL' });
    post('generateOnDemand', { type: 'VIDEO' });
  }
  // Make everything due now, publish, render, publish videos, harvest.
  post('getQueue').items.forEach((i) => { if (i.status === 'SCHEDULED') post('updateQueueItem', { id: i.id, scheduled_at: new Date(Date.now() - 1000).toISOString() }); });
  post('runPublishNow'); post('pollVideosNow'); post('pollVideosNow'); post('runPublishNow'); post('runPublishNow');
  post('saveConfig', { workflow_mode: 'APPROVAL' });
  post('generateOnDemand', { type: 'BLOG' }); post('generateOnDemand', { type: 'SOCIAL' }); post('generateOnDemand', { type: 'VIDEO' });
  post('harvestNow');
  console.log('Demo data seeded (SIMULATED APIs — none of these numbers are real).');
}

setInterval(() => {
  const fired = be.fireTriggers();
  if (fired.length) console.log(new Date().toISOString().slice(11, 19), 'triggers fired:', fired.map((f) => f.handler + (f.error ? ' ✗ ' + f.error : '')).join(', '));
  else console.log(new Date().toISOString().slice(11, 19), 'no triggers installed (kill switch engaged) — zero background jobs');
}, 20000);

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    try {
      if (req.method === 'POST') return res.end(be.rawPost(body));
      const u = new URL(req.url, 'http://localhost');
      res.end(be.run('doGet', { parameter: Object.fromEntries(u.searchParams) }).getContent());
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, status: 500, error: e.message }));
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\nLocal NodeTelehealth backend (simulated)\n  Web App URL:      http://127.0.0.1:${PORT}/exec\n  Handshake token:  ${init.handshake_token}\n`);
});
