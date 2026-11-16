/**
 * NodeTelehealth Marketing — renderer (sandboxed, no Node, no network).
 * All backend access goes through window.nt (preload.js → main process → Apps Script).
 * Backend/AI-generated text is always inserted with textContent; blog HTML is shown only
 * inside a script-less sandboxed iframe.
 */
'use strict';
(() => {
  const nt = window.nt;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* ───────────────────────── DOM helpers ───────────────────────── */

  function append(el, kids) {
    kids.forEach((k) => {
      if (k === null || k === undefined || k === false) return;
      if (Array.isArray(k)) append(el, k);
      else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    });
    return el;
  }

  /** replaceChildren that flattens arrays and skips null/false. */
  function setKids(el, ...kids) { el.replaceChildren(); return append(el, kids); }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (['checked', 'disabled', 'hidden'].includes(k)) el[k] = true;
      else el.setAttribute(k, v === true ? '' : v);
    });
    return append(el, kids);
  }

  function select(options, value, onChange, attrs) {
    const el = h('select', attrs || {}, options.map(([v, label]) => h('option', { value: String(v), text: label })));
    el.value = String(value);
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }

  function segmented(options, value, onChange) {
    const wrap = h('div', { class: 'segmented', role: 'radiogroup' });
    options.forEach(([v, label]) => wrap.appendChild(h('button', {
      class: v === value ? 'on' : '', role: 'radio', 'aria-checked': String(v === value), text: label,
      onclick: () => onChange(v)
    })));
    return wrap;
  }

  function toggle(checked, onChange, label, disabled) {
    const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label, checked, disabled });
    input.addEventListener('change', () => onChange(input.checked, input));
    return h('label', { class: 'switch' }, input, h('span'));
  }

  function toast(message, isError) {
    const t = h('div', { class: 'toast' + (isError ? ' err' : ''), text: message });
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), isError ? 8000 : 3500);
  }

  async function busy(btn, fn) {
    if (btn) { btn.classList.add('busy'); btn.disabled = true; }
    try { return await fn(); }
    finally { if (btn && btn.isConnected) { btn.classList.remove('busy'); btn.disabled = false; } }
  }

  const empty = (title, detail, action) => h('div', { class: 'empty' }, h('strong', { text: title }), detail ? h('span', { text: detail }) : null, action || null);

  /* ───────────────────────── Formatting ───────────────────────── */

  const PLATFORM = { BLOG: 'Blog', FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', X_TWITTER: 'X', LINKEDIN: 'LinkedIn', YOUTUBE_SHORTS: 'YouTube Shorts', TIKTOK: 'TikTok', GOOGLE_BUSINESS: 'Google Business' };
  const STATUS = {
    PENDING_APPROVAL: ['Needs approval', 'warn'], CMS_DRAFT: ['Draft in CMS', 'warn'], SCRIPT_READY: ['Script ready', 'warn'], COMPLIANCE_HOLD: ['Compliance hold', 'danger'],
    SCHEDULED: ['Scheduled', 'info'], RENDERING: ['Rendering…', 'info'], READY_TO_PUBLISH: ['Ready to publish', 'accent'],
    PUBLISHED: ['Published', 'ok'], PARTIAL: ['Partly published', 'warn'], FAILED: ['Failed', 'danger'], CANCELLED: ['Removed', '']
  };
  const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
  const fmtCompact = (n) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n) || 0);
  const fmtPct = (r, d) => (r === null || r === undefined ? '—' : (Number(r) * 100).toFixed(d === undefined ? 1 : d) + '%');
  const fmtUsd = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  function relTime(iso) {
    if (!iso) return 'never';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  const statusTag = (status) => h('span', { class: 'tag ' + ((STATUS[status] || [])[1] || ''), text: (STATUS[status] || [status])[0] });
  const platformNames = (csv) => String(csv || '').split(',').map((p) => PLATFORM[p] || p).join(', ');

  /* ───────────────────────── State ───────────────────────── */

  const S = {
    status: { connected: false, configured: false, kill_switch: 'UNKNOWN', system_status: 'NOT CONNECTED' },
    view: 'dashboard', state: null, secrets: null,
    dash: null, days: 30, trendMetric: 'engagement_rate', charts: {},
    queue: null, qType: '', qStatus: 'active', selId: null, selItem: null, edits: {}, blogTab: 'preview', newType: 'BLOG',
    draft: null, dirty: false, step: 0
  };
  const halted = () => S.status.kill_switch === 'ON';

  /** Backend call with uniform error surfacing. Returns data, or null on failure. */
  async function api(action, payload, opts) {
    const res = await nt.call(action, payload || {});
    if (res.ok) return res.data;
    if (!(opts && opts.quiet)) {
      const msg = res.code === 'SYSTEM_HALTED' ? 'System is HALTED — resume it to run this action.'
        : res.code === 'TOOL_DISABLED' ? 'Blocked: ' + res.error + '. Enable it in Tool Controls.'
        : res.error || 'Request failed';
      toast(msg, true);
    }
    return null;
  }

  async function loadState(force) {
    if (!S.status.connected) return null;
    if (S.state && !force) return S.state;
    const st = await api('getState', {}, { quiet: true });
    if (st) S.state = st;
    return S.state;
  }

  /* ───────────────────────── Top bar ───────────────────────── */

  function renderTopbar() {
    const st = S.status;
    const dot = $('#hb-dot'), killBtn = $('#kill-switch');
    dot.className = 'dot' + (st.connected ? ' ok' : st.configured ? ' bad' : '');
    $('#hb-text').textContent = st.connected ? 'Connected · ' + new Date(st.last_ok || Date.now()).toLocaleTimeString('en-US') : st.configured ? 'Backend unreachable' : 'Not connected';
    $('#hb-pill').title = st.error || 'Backend heartbeat (every 30 s)';
    const trig = $('#trigger-pill');
    trig.className = 'pill ' + (!st.connected ? 'subtle' : halted() ? 'stopped' : st.system_status === 'RUNNING' ? 'running' : 'warn');
    $('#trigger-text').textContent = !st.connected ? 'Triggers: —' : halted() ? 'HARD STOPPED · 0 triggers' : st.system_status + ' · ' + st.trigger_count + ' triggers';
    const mode = $('#mode-pill');
    mode.hidden = !st.connected || !st.workflow_mode;
    mode.textContent = st.workflow_mode === 'AUTONOMOUS' ? 'Autonomous mode' : 'Approval mode';
    killBtn.disabled = !st.connected;
    killBtn.setAttribute('aria-checked', String(halted()));
    $('#kill-state').textContent = !st.connected ? 'Not connected' : halted() ? 'HALTED — click to resume' : 'System live — click to halt';
    $('#halt-banner').hidden = !halted();
    $('#sidebar-foot').textContent = st.connected ? 'Backend v' + ((S.state && S.state.version) || '1.0.0') + '\nnodetelehealth.com' : '';
  }

  $('#kill-switch').addEventListener('click', async () => {
    const res = await nt.toggleKillSwitch(!halted());
    if (res && res.ok) { S.state = res.data; refreshView(); }
  });

  /* ───────────────────────── Navigation ───────────────────────── */

  const VIEWS = { dashboard: renderDashboard, tools: renderTools, agent: renderAgent, studio: renderStudio, settings: renderSettings };

  function showView(name) {
    S.view = name;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    Object.keys(VIEWS).forEach((v) => { $('#view-' + v).hidden = v !== name; });
    refreshView();
  }
  function refreshView() { return VIEWS[S.view](); }
  document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  function viewHead(title, sub, ...right) {
    return h('div', { class: 'view-head' }, h('div', {}, h('h1', { text: title }), sub ? h('p', { text: sub }) : null), h('div', { class: 'spacer' }), h('div', { class: 'row' }, right));
  }

  function needsConnection(root, title) {
    setKids(root, viewHead(title), h('div', { class: 'card' }, empty(
      S.status.configured ? 'Backend unreachable' : 'Connect your backend to get started',
      S.status.configured ? (S.status.error || 'Retrying every 30 seconds.') : 'Deploy the Google Apps Script Web App, then enter its URL and handshake token.',
      h('button', { class: 'btn primary', text: 'Open Settings & Setup', onclick: () => showView('settings') }))));
  }

  /* ───────────────────────── Dashboard ───────────────────────── */

  function chart(id, config) {
    if (S.charts[id]) S.charts[id].destroy();
    const canvas = $('#' + id);
    if (!canvas) return;
    const text = cssVar('--muted'), grid = cssVar('--grid');
    config.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: { duration: 250 } }, config.options);
    config.options.plugins = Object.assign({ legend: { position: 'bottom', labels: { color: text, boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 11 } } } }, config.options.plugins);
    Object.values(config.options.scales || {}).forEach((axis) => {
      axis.ticks = Object.assign({ color: text, font: { size: 11 } }, axis.ticks);
      axis.grid = Object.assign({ color: grid }, axis.grid);
      axis.border = { display: false };
    });
    S.charts[id] = new Chart(canvas, config);
  }
  const palette = () => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar('--chart-' + i));
  const canvasBox = (id, tall) => h('div', { class: 'chart-box' + (tall ? ' tall' : '') }, h('canvas', { id, role: 'img' }));
  const card = (title, note, body, extra, cls) => h('div', { class: 'card ' + (cls || '') }, h('div', { class: 'card-head' }, h('h2', { text: title }), h('div', { class: 'spacer' }), extra || null), body, note ? h('div', { class: 'card-note', text: note }) : null);

  async function renderDashboard() {
    const root = $('#view-dashboard');
    if (!S.status.connected) return needsConnection(root, 'Performance');
    const d = await api('getDashboard', { days: S.days }, { quiet: !!S.dash });
    if (d) S.dash = d;
    if (!S.dash || S.view !== 'dashboard') return;
    const D = S.dash, k = D.kpis, colors = palette();

    const exportSel = select([['', 'Export report…'], ['csv', 'CSV spreadsheet'], ['json', 'JSON data'], ['pdf', 'PDF of this view']], '', async (fmt) => {
      exportSel.value = '';
      if (!fmt) return;
      const r = await nt.exportReport(fmt, S.days);
      if (r && r.ok) toast('Report saved to ' + r.path); else if (r && !r.cancelled) toast(r.error || 'Export failed', true);
    }, { 'aria-label': 'Export report' });

    const kpi = (label, value, sub) => h('div', { class: 'kpi' }, h('div', { class: 'kpi-label', text: label }), h('div', { class: 'kpi-value', text: value }), h('div', { class: 'kpi-sub', text: sub }));
    const hasTrend = D.trend.some((t) => t.sessions > 0);
    const hasSocial = D.channels.some((c) => c.impressions + c.views > 0);
    const hasCost = Object.keys(D.costs.by_service).length > 0;
    const metroKey = D.metros.some((m) => m.sessions > 0) ? 'sessions' : 'social_reach';
    const metros = D.metros.filter((m) => m[metroKey] > 0).sort((a, b) => b[metroKey] - a[metroKey]).slice(0, 10);

    setKids(root, 
      viewHead('Performance', 'Florida organic growth · updated ' + relTime(D.generated_at),
        select([[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']], S.days, (v) => { S.days = Number(v); renderDashboard(); }, { 'aria-label': 'Date range' }),
        exportSel,
        h('button', { class: 'btn', text: 'Refresh', onclick: (e) => busy(e.currentTarget, renderDashboard) })),
      h('div', { class: 'kpis' },
        kpi('Published', fmtInt(k.published), k.blogs + ' blog posts · ' + k.videos + ' video posts'),
        kpi('Social reach', fmtCompact(k.social_reach), fmtPct(k.social_engagement_rate) + ' engagement rate'),
        kpi('Florida site sessions', fmtCompact(k.florida_sessions), D.has_ga4 ? fmtPct(k.florida_engagement_rate, 0) + ' engaged' : 'GA4 not connected'),
        kpi('Florida conversion rate', D.has_ga4 ? fmtPct(k.florida_conversion_rate) : '—', D.has_ga4 ? fmtInt(k.florida_conversions) + ' key events' : 'Add GA4 in Settings'),
        kpi('API spend (est.)', fmtUsd(k.spend_usd), 'Claude + voice + video'),
        kpi('Organic reach value (est.)', fmtUsd(k.reach_value_usd), '$0 ad spend equivalent'),
        kpi('Return multiple', k.roi_multiple === null ? '—' : k.roi_multiple + '×', 'Reach value ÷ API spend'),
        kpi('Video renders', fmtInt(D.costs.usage.video_renders), fmtInt(D.costs.usage.elevenlabs_characters) + ' voice characters')),
      h('div', { class: 'cards cols-3' },
        card('Florida city trends', 'Source: Google Analytics 4, visitors located in Florida.',
          hasTrend ? canvasBox('ch-trend', true) : h('div', { class: 'chart-box tall' }, empty('No Florida traffic data yet', D.has_ga4 ? 'Appears after the next analytics harvest.' : 'Add your GA4 property ID in Settings → Analytics to chart city-level trends.')),
          segmented([['engagement_rate', 'Engagement rate'], ['conversion_rate', 'Conversion rate'], ['sessions', 'Sessions']], S.trendMetric, (v) => { S.trendMetric = v; renderDashboard(); }), 'span-2'),
        card('Florida metros', metroKey === 'sessions' ? 'Site sessions by city (GA4).' : 'Social reach by targeted metro.',
          metros.length ? canvasBox('ch-metros', true) : h('div', { class: 'chart-box tall' }, empty('No metro data yet'))),
        card('Channel breakdown', 'Reach = impressions or views reported by each platform. Blog = page views from Florida.',
          h('div', {}, hasSocial ? canvasBox('ch-channels') : h('div', { class: 'chart-box' }, empty('No channel metrics yet', 'Metrics are harvested for published posts when Analytics polling is ON.')), channelTable(D.channels)), null, 'span-2'),
        card('AI content & media cost', 'Estimates from logged usage × unit prices in Agent Control.',
          h('div', {}, hasCost ? canvasBox('ch-costs') : h('div', { class: 'chart-box' }, empty('No API spend logged yet')), costTable(D))),
        card('A/B hook win rates', 'Engagement rate per hook variant. A winner needs at least 3 posts per variant.',
          D.ab_tests.length ? h('div', {}, canvasBox('ch-ab'), abTable(D.ab_tests)) : h('div', { class: 'chart-box' }, empty('No A/B results yet', 'Every post ships with hook A or B; results appear after metrics are harvested.')), null, 'span-2'),
        card('API reliability', 'Share of successful API calls per service.',
          D.reliability.length ? canvasBox('ch-rel') : h('div', { class: 'chart-box' }, empty('No API calls recorded yet')))));

    const pctAxis = { ticks: { callback: (v) => (v * 100).toFixed(0) + '%' }, beginAtZero: true };
    const labels = D.dates.map((x) => x.slice(5));
    if (hasTrend) {
      const m = S.trendMetric;
      const line = (label, rows, color, width) => ({ label, data: rows.map((r) => r[m]), borderColor: color, backgroundColor: color, borderWidth: width, pointRadius: 0, pointHoverRadius: 4, tension: 0.3, spanGaps: true });
      chart('ch-trend', {
        type: 'line',
        data: { labels, datasets: [line('All Florida', D.trend, cssVar('--text'), 2.6)].concat(Object.keys(D.trend_by_city).slice(0, 5).map((c, i) => line(c, D.trend_by_city[c], colors[i], 1.6))) },
        options: { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } }, y: m === 'sessions' ? { beginAtZero: true } : pctAxis },
          plugins: { tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + (m === 'sessions' ? fmtInt(c.parsed.y) : fmtPct(c.parsed.y)) } } } }
      });
    }
    if (metros.length) {
      chart('ch-metros', {
        type: 'bar',
        data: { labels: metros.map((x) => x.metro), datasets: [{ label: metroKey === 'sessions' ? 'Sessions' : 'Social reach', data: metros.map((x) => x[metroKey]), backgroundColor: colors[0], borderRadius: 4 }] },
        options: { indexAxis: 'y', scales: { x: { beginAtZero: true }, y: { grid: { display: false } } },
          plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: (c) => { const x = metros[c.dataIndex]; return metroKey === 'sessions' ? ['Engagement ' + fmtPct(x.engagement_rate), 'Conversion ' + fmtPct(x.conversion_rate)] : 'Engagement ' + fmtPct(x.social_engagement_rate); } } } } }
      });
    }
    if (hasSocial) {
      const ch = D.channels.filter((c) => c.published > 0 || c.impressions + c.views > 0);
      chart('ch-channels', {
        type: 'bar',
        data: { labels: ch.map((c) => PLATFORM[c.platform]), datasets: [
          { label: 'Reach', data: ch.map((c) => Math.max(c.impressions, c.views)), backgroundColor: colors[0], borderRadius: 4 },
          { label: 'Engagements', data: ch.map((c) => c.likes + c.comments + c.shares + c.clicks), backgroundColor: colors[2], borderRadius: 4 },
          { label: 'Clicks', data: ch.map((c) => c.clicks), backgroundColor: colors[1], borderRadius: 4 }] },
        options: { scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: (v) => fmtCompact(v) } } } }
      });
    }
    if (hasCost) {
      const services = Object.keys(D.costs.by_service);
      chart('ch-costs', {
        type: 'bar',
        data: { labels, datasets: services.map((s, i) => ({ label: s, data: D.costs.by_day.map((r) => r[s] || 0), backgroundColor: colors[i % colors.length], borderRadius: 2 })) },
        options: { scales: { x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => '$' + v } } },
          plugins: { tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + fmtUsd(c.parsed.y) } } } }
      });
    }
    if (D.ab_tests.length) {
      chart('ch-ab', {
        type: 'bar',
        data: { labels: D.ab_tests.map((a) => PLATFORM[a.platform] || a.platform), datasets: [
          { label: 'Hook A', data: D.ab_tests.map((a) => a.a_rate), backgroundColor: colors[0], borderRadius: 4 },
          { label: 'Hook B', data: D.ab_tests.map((a) => a.b_rate), backgroundColor: colors[3], borderRadius: 4 }] },
        options: { scales: { x: { grid: { display: false } }, y: pctAxis }, plugins: { tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + fmtPct(c.parsed.y) } } } }
      });
    }
    if (D.reliability.length) {
      chart('ch-rel', {
        type: 'bar',
        data: { labels: D.reliability.map((r) => r.service), datasets: [{ label: 'Success rate', data: D.reliability.map((r) => r.success_rate),
          backgroundColor: D.reliability.map((r) => cssVar(r.success_rate >= 0.99 ? '--ok' : r.success_rate >= 0.95 ? '--warn' : '--danger')), borderRadius: 4 }] },
        options: { indexAxis: 'y', scales: { x: { min: 0, max: 1, ticks: { callback: (v) => (v * 100).toFixed(0) + '%' } }, y: { grid: { display: false } } },
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => { const r = D.reliability[c.dataIndex]; return fmtPct(r.success_rate) + ' · ' + r.ok + ' ok, ' + r.failed + ' failed'; } } } } }
      });
    }
  }

  function table(headers, rows) {
    return h('table', { class: 'data' }, h('thead', {}, h('tr', {}, headers.map((x) => h('th', { text: x })))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c))))));
  }
  function channelTable(channels) {
    const rows = channels.filter((c) => c.published > 0 || c.impressions + c.views > 0);
    if (!rows.length) return null;
    return h('div', { style: 'margin-top:12px' }, table(['Channel', 'Published', 'Reach', 'Clicks', 'CTR', 'Shares', 'Engagement', 'Watch-through'],
      rows.map((c) => [PLATFORM[c.platform], fmtInt(c.published), fmtInt(Math.max(c.impressions, c.views)), fmtInt(c.clicks), fmtPct(c.ctr), fmtInt(c.shares), fmtPct(c.engagement_rate), c.watch_through === null ? '—' : fmtPct(c.watch_through, 0)])));
  }
  function costTable(D) {
    const u = D.costs.usage, rows = Object.keys(D.costs.by_service).map((s) => [s, fmtUsd(D.costs.by_service[s])]);
    rows.push(['ElevenLabs characters', fmtInt(u.elevenlabs_characters)], ['Video renders', fmtInt(u.video_renders) + ' · ' + fmtUsd(u.video_render_cost)], ['Claude tokens', fmtCompact(u.claude_tokens)]);
    return h('div', { style: 'margin-top:12px' }, table(['Item', 'Last ' + D.range_days + ' days'], rows));
  }
  function abTable(tests) {
    return h('div', { style: 'margin-top:12px' }, table(['Channel', 'A posts', 'A rate', 'B posts', 'B rate', 'Winner'],
      tests.map((a) => [PLATFORM[a.platform] || a.platform, a.a_posts, fmtPct(a.a_rate), a.b_posts, fmtPct(a.b_rate), h('span', { class: 'tag ' + (a.winner.length === 1 ? 'ok' : ''), text: a.winner.length === 1 ? 'Hook ' + a.winner : a.winner })])));
  }

  /* ───────────────────────── Tool control matrix ───────────────────────── */

  async function renderTools() {
    const root = $('#view-tools');
    if (!S.status.connected) return needsConnection(root, 'Tool Controls');
    const tools = await api('getToolStates', {}, { quiet: true });
    if (tools && S.state) S.state.tools = tools;
    const list = tools || (S.state && S.state.tools) || [];
    if (S.view !== 'tools') return;
    const groups = {};
    list.forEach((t) => (groups[t.group] = groups[t.group] || []).push(t));
    setKids(root, 
      viewHead('Tool Controls', 'Each switch is checked before content is generated and again before anything is published.',
        h('button', { class: 'btn', text: 'Refresh', onclick: (e) => busy(e.currentTarget, renderTools) })),
      halted() ? h('div', { class: 'notice danger', text: 'The Kill Switch is engaged. Switches below are saved, but no tool runs until the system is resumed.' }) : null,
      Object.keys(groups).map((g) => h('div', { class: 'tool-group' }, h('h3', { text: g }), h('div', { class: 'tool-grid' }, groups[g].map(toolCard)))));
  }

  function toolCard(t) {
    const label = halted() ? 'Halted' : t.status;
    const cls = halted() ? 'danger' : t.status === 'Active' ? 'ok' : t.status === 'Missing API Key' ? 'warn' : '';
    return h('div', { class: 'tool' + (t.enabled && !halted() ? '' : ' off') },
      h('div', { class: 'tool-top' },
        h('div', { class: 'tool-name' }, t.label, h('div', { class: 'tool-key', text: t.key })),
        toggle(t.enabled, async (on, input) => {
          input.disabled = true;
          const tools = await api('setToolState', { key: t.key, enabled: on });
          if (tools) { if (S.state) S.state.tools = tools; toast(t.label + (on ? ' switched ON' : ' switched OFF')); }
          renderTools();
        }, t.label)),
      h('div', { class: 'row' }, h('span', { class: 'tag ' + cls, text: label }),
        t.status === 'Missing API Key' ? h('a', { class: 'small', text: 'Add credentials', onclick: () => showView('settings') }) : null),
      h('div', { class: 'tool-meta' },
        'Last run', h('b', { text: relTime(t.last_run) }),
        'Runs', h('b', { text: fmtInt(t.runs) }),
        'Usage', h('b', { text: [t.usage_units ? fmtInt(t.usage_units) + ' ' + t.usage_unit_type : '', t.claude_tokens ? fmtCompact(t.claude_tokens) + ' Claude tokens' : ''].filter(Boolean).join(' · ') || '—' }),
        'Est. cost', h('b', { text: t.est_cost_usd ? fmtUsd(t.est_cost_usd) : '$0.00' })));
  }

  /* ───────────────────────── Agent control center ───────────────────────── */

  const MODE_HELP = {
    AUTONOMOUS: 'Content is generated, rendered and published live with no review. Anything the compliance filter flags is still held for you.',
    APPROVAL: 'Blogs are sent to the CMS as drafts, social posts wait for approval, and video scripts wait for approval before any voice or render credits are spent.'
  };
  const VIDEO_HELP = {
    HEYGEN_AVATAR: 'HeyGen talking-head avatar in 9:16 with burned-in captions. Uses the ElevenLabs voiceover when that tool is ON, otherwise a HeyGen voice.',
    FACELESS_BROLL: 'Lowest cost: ElevenLabs voiceover + stock b-roll + word-by-word captions, rendered by Creatomate or JSON2Video.',
    SCRIPT_ONLY: 'Claude writes scripts only. No voice or video credits are spent; produce the videos yourself.'
  };

  async function renderAgent(keepDraft) {
    const root = $('#view-agent');
    if (!S.status.connected) return needsConnection(root, 'Agent Control');
    if (!(keepDraft === true && S.draft)) {
      const st = await loadState(true);
      if (!st) return needsConnection(root, 'Agent Control');
      S.draft = JSON.parse(JSON.stringify(st.config));
      S.dirty = false;
    }
    if (S.view !== 'agent') return;
    const c = S.draft;
    const enabled = {};
    ((S.state && S.state.tools) || []).forEach((t) => { enabled[t.key] = t.enabled; });
    const touch = (rerender) => { S.dirty = true; if (rerender) renderAgent(true); else $('#save-state').textContent = 'Unsaved changes'; };

    function slider(name, value, max, onInput, suffix, dim, onRemove) {
      const val = h('span', { class: 'val', text: suffix(value) });
      const input = h('input', { type: 'range', min: '0', max: String(max), step: '1', value: String(value), 'aria-label': name });
      input.addEventListener('input', () => { onInput(Number(input.value)); val.textContent = suffix(Number(input.value)); touch(false); });
      return h('div', { class: 'slider-row' + (dim ? ' dim' : '') },
        h('span', { class: 'name', title: name }, name, onRemove ? h('a', { class: 'tiny', text: '  remove', onclick: onRemove }) : null), input, val);
    }
    function weightCard(title, note, map, max, placeholder) {
      const total = () => Object.values(map).reduce((s, v) => s + Number(v), 0) || 1;
      const add = h('input', { type: 'text', placeholder, 'aria-label': placeholder });
      return card(title, note, h('div', {},
        Object.keys(map).map((name) => slider(name, map[name], max, (v) => { map[name] = v; }, (v) => Math.round(v / total() * 100) + '%', false,
          Object.keys(map).length > 1 ? () => { delete map[name]; touch(true); } : null)),
        h('div', { class: 'row', style: 'margin-top:10px' }, h('div', { style: 'flex:1' }, add),
          h('button', { class: 'btn', text: 'Add', onclick: () => { const v = add.value.trim(); if (v && !(v in map)) { map[v] = Math.round(max / 3); touch(true); } } }))));
    }
    const field = (label, control, help) => h('label', { class: 'field' }, h('span', { text: label }), control, help ? h('small', { text: help }) : null);
    const numInput = (obj, key, step) => { const i = h('input', { type: 'number', min: '0', step: String(step), value: String(obj[key]) }); i.addEventListener('input', () => { obj[key] = Number(i.value) || 0; touch(false); }); return i; };
    const hoursOpt = [1, 2, 4, 6, 8, 12].map((v) => [v, 'Every ' + v + ' h']), minsOpt = [1, 5, 10, 15, 30].map((v) => [v, 'Every ' + v + ' min']);
    const runBtn = (label, action, done) => h('button', { class: 'btn', text: label, disabled: halted(), onclick: (e) => busy(e.currentTarget, async () => { const r = await api(action); if (r) toast(done(r)); }) });
    const hours = h('input', { type: 'text', value: c.posting_hours_et.join(', ') });
    hours.addEventListener('input', () => { c.posting_hours_et = hours.value.split(',').map((x) => parseInt(x, 10)).filter((x) => x >= 0 && x <= 23); touch(false); });
    const cta = h('input', { type: 'url', value: c.cta_url });
    cta.addEventListener('input', () => { c.cta_url = cta.value.trim(); touch(false); });

    setKids(root, 
      viewHead('Agent Control', 'How the autonomous agent plans, produces and publishes Florida content.'),
      h('div', { class: 'cards cols-2' },
        card('Workflow mode', null, h('div', {},
          segmented([['AUTONOMOUS', 'Autonomous Mode'], ['APPROVAL', 'Human-in-the-Loop Approval']], c.workflow_mode, (v) => { c.workflow_mode = v; touch(true); }),
          h('div', { class: 'option-help', text: MODE_HELP[c.workflow_mode] }))),
        card('Video engine', null, h('div', {},
          segmented([['HEYGEN_AVATAR', 'HeyGen AI Avatar'], ['FACELESS_BROLL', 'Faceless B-Roll + ElevenLabs'], ['SCRIPT_ONLY', 'Script-Only']], c.video_mode, (v) => { c.video_mode = v; touch(true); }),
          h('div', { class: 'option-help', text: VIDEO_HELP[c.video_mode] }),
          c.video_mode === 'FACELESS_BROLL' ? field('Faceless render provider', select([['CREATOMATE', 'Creatomate'], ['JSON2VIDEO', 'JSON2Video']], c.faceless_provider, (v) => { c.faceless_provider = v; touch(false); })) : null)),
        card('Posting frequency', 'Posts per week. Channels that are switched OFF are never generated for.', h('div', {},
          Object.keys(c.frequency).map((p) => slider(PLATFORM[p] + (p !== 'BLOG' && !enabled['TOGGLE_' + p] || (p === 'BLOG' && !enabled.TOGGLE_BLOG_CMS) ? ' (off)' : ''), c.frequency[p], 14,
            (v) => { c.frequency[p] = v; }, (v) => v + ' / wk', p === 'BLOG' ? !enabled.TOGGLE_BLOG_CMS : !enabled['TOGGLE_' + p])))),
        weightCard('Florida target metros', 'Share of content aimed at each metro. All content stays Florida-only.', c.metro_weights, 30, 'Add a Florida metro'),
        weightCard('Content pillars', 'Share of topics per pillar.', c.pillar_weights, 50, 'Add a content pillar'),
        card('Schedule & models', 'Trigger changes are applied to Google\'s scheduler when you save.', h('div', { class: 'grid-2' },
          field('Generate content', select(hoursOpt, c.triggers.generate_every_hours, (v) => { c.triggers.generate_every_hours = Number(v); touch(false); })),
          field('Publish due items', select(minsOpt, c.triggers.publish_every_minutes, (v) => { c.triggers.publish_every_minutes = Number(v); touch(false); })),
          field('Poll video renders', select(minsOpt, c.triggers.poll_every_minutes, (v) => { c.triggers.poll_every_minutes = Number(v); touch(false); })),
          field('Harvest analytics', select(hoursOpt, c.triggers.analytics_every_hours, (v) => { c.triggers.analytics_every_hours = Number(v); touch(false); })),
          field('Claude model', select([['claude-sonnet-4-6', 'Claude Sonnet 4.6 (lower cost)'], ['claude-opus-4-6', 'Claude Opus 4.6 (highest quality)']], c.claude_model, (v) => { c.claude_model = v; touch(false); })),
          field('ElevenLabs model', select([['eleven_flash_v2_5', 'Flash v2.5'], ['eleven_turbo_v2_5', 'Turbo v2.5']], c.elevenlabs_model, (v) => { c.elevenlabs_model = v; touch(false); })),
          field('Posting hours (Eastern, 0–23)', hours, 'Comma-separated, e.g. 8, 12, 18'),
          field('Call-to-action URL', cta))),
        card('Cost & value assumptions', 'Used only for the estimates on the Performance page. Match them to your plans.', h('div', { class: 'grid-2' },
          field('ElevenLabs $ per 1,000 characters', numInput(c.cost, 'elevenlabs_per_1k_chars', 0.01)),
          field('HeyGen $ per video minute', numInput(c.cost, 'heygen_per_minute', 0.05)),
          field('Creatomate $ per video', numInput(c.cost, 'creatomate_per_video', 0.01)),
          field('JSON2Video $ per video', numInput(c.cost, 'json2video_per_video', 0.01)),
          field('Equivalent ad CPM ($)', numInput(c.cost, 'equiv_cpm_usd', 0.5)),
          field('Equivalent ad CPC ($)', numInput(c.cost, 'equiv_cpc_usd', 0.1)))),
        card('Run now', halted() ? 'Unavailable while the system is halted.' : 'Runs the same jobs the scheduled triggers run. Tool switches still apply.', h('div', { class: 'row' },
          runBtn('Generate content', 'runGenerateNow', (r) => r.created.length ? r.created.length + ' item(s) added to the queue' : (r.errors.length ? r.errors[0] : 'Nothing is due right now')),
          runBtn('Publish due items', 'runPublishNow', (r) => r.published.length + ' published · ' + r.drafts.length + ' drafts · ' + r.failed.length + ' failed'),
          runBtn('Poll video renders', 'pollVideosNow', (r) => r.checked + ' checked · ' + r.ready.length + ' ready'),
          runBtn('Harvest analytics', 'harvestNow', (r) => r.rows + ' metric rows' + (r.errors.length ? ' · ' + r.errors.length + ' error(s)' : '')),
          runBtn('Research Florida keywords', 'researchKeywords', (r) => r.added + ' keywords added')))),
      h('div', { class: 'savebar' },
        h('button', { class: 'btn primary', text: 'Save changes', onclick: (e) => busy(e.currentTarget, async () => {
          const saved = await api('saveConfig', S.draft);
          if (saved) { toast('Agent settings saved'); await nt.refreshStatus(); renderAgent(); }
        }) }),
        h('button', { class: 'btn', text: 'Discard', onclick: () => renderAgent() }),
        h('span', { class: 'muted small', id: 'save-state', text: S.dirty ? 'Unsaved changes' : 'All changes saved' })));
  }

  /* ───────────────────────── Content & video studio ───────────────────────── */

  const NEEDS_REVIEW = (i) => ['PENDING_APPROVAL', 'CMS_DRAFT', 'SCRIPT_READY', 'COMPLIANCE_HOLD'].includes(i.status) || (i.status === 'READY_TO_PUBLISH' && !i.approved);
  const STATUS_FILTERS = {
    active: ['All active', (i) => i.status !== 'PUBLISHED'], review: ['Needs my review', NEEDS_REVIEW],
    SCHEDULED: ['Scheduled', (i) => i.status === 'SCHEDULED'], RENDERING: ['Rendering', (i) => i.status === 'RENDERING'],
    PUBLISHED: ['Published', (i) => i.status === 'PUBLISHED' || i.status === 'PARTIAL'], FAILED: ['Failed', (i) => i.status === 'FAILED'], all: ['Everything', () => true]
  };

  function updateBadge() {
    const n = S.queue ? S.queue.items.filter(NEEDS_REVIEW).length : 0;
    const b = $('#studio-badge');
    b.hidden = !n; b.textContent = String(n);
  }

  async function loadQueue() {
    const q = await api('getQueue', { limit: 200 }, { quiet: true });
    const pub = await api('getQueue', { status: 'PUBLISHED', limit: 60 }, { quiet: true });
    if (q) { S.queue = q; if (pub) S.queue.items = q.items.filter((i) => i.status !== 'PUBLISHED').concat(pub.items); }
    updateBadge();
    return S.queue;
  }

  async function selectItem(id) {
    S.selId = id; S.edits = {}; S.blogTab = 'preview';
    S.selItem = id ? await api('getQueueItem', { id }) : null;
    if (S.view === 'studio') drawStudio();
  }

  async function renderStudio(keepSelection) {
    const root = $('#view-studio');
    if (!S.status.connected) return needsConnection(root, 'Content Studio');
    if (Object.keys(S.edits).length && keepSelection) return; // never clobber unsaved edits on auto-refresh
    await Promise.all([loadQueue(), loadState()]);
    if (S.selId) S.selItem = await api('getQueueItem', { id: S.selId }, { quiet: true });
    if (S.view === 'studio') drawStudio();
  }

  function drawStudio() {
    const root = $('#view-studio');
    const items = ((S.queue && S.queue.items) || []).filter((i) => (!S.qType || i.type === S.qType) && STATUS_FILTERS[S.qStatus][1](i));
    const typeChip = (v, label) => h('button', { class: 'chip' + (S.qType === v ? ' on' : ''), text: label, onclick: () => { S.qType = v; drawStudio(); } });
    const listScroll = $('.q-list', root) ? $('.q-list', root).scrollTop : 0;
    setKids(root, 
      viewHead('Content Studio', 'Preview, edit, approve and publish blogs, social posts and videos.',
        select([['BLOG', 'Blog post'], ['SOCIAL', 'Social posts'], ['VIDEO', 'Video script']], S.newType, (v) => { S.newType = v; }, { 'aria-label': 'New content type' }),
        h('button', { class: 'btn primary', text: 'Generate new', disabled: halted(), onclick: (e) => busy(e.currentTarget, async () => {
          const r = await api('generateOnDemand', { type: S.newType });
          if (r && r.created.length) { toast(r.created.length + ' item(s) generated'); S.selId = r.created[0].id; S.edits = {}; await renderStudio(); }
        }) }),
        h('button', { class: 'btn', text: 'Refresh', onclick: (e) => busy(e.currentTarget, () => renderStudio()) })),
      h('div', { class: 'row', style: 'margin-bottom:14px' },
        h('div', { class: 'chips' }, typeChip('', 'All'), typeChip('BLOG', 'Blogs'), typeChip('SOCIAL', 'Social'), typeChip('VIDEO', 'Video')),
        select(Object.keys(STATUS_FILTERS).map((k) => [k, STATUS_FILTERS[k][0]]), S.qStatus, (v) => { S.qStatus = v; drawStudio(); }, { 'aria-label': 'Status filter' }),
        h('span', { class: 'muted small', text: items.length + ' item' + (items.length === 1 ? '' : 's') })),
      h('div', { class: 'studio' },
        h('div', { class: 'q-list' }, items.length ? items.map(queueCard) : h('div', { class: 'card' }, empty('Nothing here', 'Generate content or change the filters.'))),
        h('div', { class: 'card detail' }, S.selItem ? itemDetail(S.selItem) : empty('Select an item', 'Choose something from the queue to preview it.'))));
    if ($('.q-list', root)) $('.q-list', root).scrollTop = listScroll;
    if (S.selItem && S.selItem.type === 'VIDEO') loadMedia(S.selItem);
  }

  function queueCard(i) {
    return h('button', { class: 'q-item' + (i.id === S.selId ? ' sel' : ''), onclick: () => selectItem(i.id) },
      h('div', { class: 'q-meta' }, h('span', { class: 'tag', text: i.type === 'BLOG' ? 'Blog' : i.type === 'VIDEO' ? 'Video' : PLATFORM[i.platform] || i.platform }), statusTag(i.status),
        i.flagged ? h('span', { class: 'tag danger', text: 'Flagged' }) : null),
      h('div', { class: 'q-title', text: i.title || '(untitled)' }),
      h('div', { class: 'q-sub', text: [i.metro, i.pillar, i.status === 'SCHEDULED' ? 'due ' + fmtDate(i.scheduled_at) : 'created ' + relTime(i.created_at)].filter(Boolean).join(' · ') }));
  }

  function editField(item, key, label, opts) {
    const o = opts || {};
    const current = key in S.edits ? S.edits[key] : (item.payload[key] || '');
    const counter = o.max ? h('span', { class: 'counter' }) : null;
    const input = o.rows ? h('textarea', { rows: String(o.rows), class: 'selectable' }) : h('input', { type: 'text' });
    input.value = current;
    input.disabled = !!o.readOnly;
    const count = () => { if (counter) { counter.textContent = input.value.length + ' / ' + o.max; counter.classList.toggle('over', input.value.length > o.max); } };
    input.addEventListener('input', () => { S.edits[key] = input.value; count(); const b = $('#save-edits'); if (b) b.disabled = false; if (o.onInput) o.onInput(input.value); });
    count();
    return h('label', { class: 'field' }, h('span', {}, label, counter), input, o.help ? h('small', { text: o.help }) : null);
  }

  function itemDetail(item) {
    const p = item.payload || {};
    const locked = ['PUBLISHED', 'RENDERING', 'CANCELLED'].includes(item.status);
    const cfg = (S.state && S.state.config) || {};
    const body = item.type === 'BLOG' ? blogDetail(item, p, locked) : item.type === 'VIDEO' ? videoDetail(item, p, locked) : socialDetail(item, p, locked);

    const act = (label, action, cls, confirmText, okText) => h('button', { class: 'btn ' + (cls || ''), text: label, disabled: halted() && action !== 'deleteQueueItem', onclick: (e) => busy(e.currentTarget, async () => {
      if (confirmText && !(await nt.confirm(confirmText, label))) return;
      if (Object.keys(S.edits).length && action !== 'deleteQueueItem') { if (!(await saveEdits(item))) return; }
      const r = await api(action, { id: item.id });
      if (r) { toast(okText); S.edits = {}; if (action === 'deleteQueueItem') { S.selId = null; S.selItem = null; } await renderStudio(); }
    }) });
    const actions = [];
    if (!locked) actions.push(h('button', { class: 'btn', id: 'save-edits', text: 'Save edits', disabled: !Object.keys(S.edits).length, onclick: (e) => busy(e.currentTarget, async () => { if (await saveEdits(item)) { toast('Edits saved'); await renderStudio(); } }) }));
    if (item.type === 'VIDEO' && item.status === 'SCRIPT_READY' && cfg.video_mode !== 'SCRIPT_ONLY') actions.push(act('Approve Script & Render Video', 'approveItem', 'primary', null, 'Render submitted'));
    else if (['PENDING_APPROVAL', 'COMPLIANCE_HOLD', 'CMS_DRAFT', 'FAILED'].includes(item.status) && item.type !== 'VIDEO') actions.push(act('Approve & Schedule', 'approveItem', 'primary', null, 'Approved and scheduled'));
    if (!locked && (item.type !== 'VIDEO' || item.video_url)) {
      actions.push(act(item.type === 'BLOG' ? 'Publish Now to NodeTelehealth.com' : 'Publish Now', 'publishNow', item.status === 'READY_TO_PUBLISH' ? 'primary' : '',
        item.type === 'BLOG' ? 'Publish this article LIVE on nodetelehealth.com now?' : 'Publish this now to ' + platformNames(item.platform) + '?', 'Published'));
    }
    if (!locked && p.source !== 'BLOG_CROSSPOST') actions.push(act(item.type === 'VIDEO' ? 'Regenerate Script' : 'Regenerate', 'regenerateItem', '', 'Replace this draft with a newly generated one?', 'Regenerated'));
    if (item.type === 'VIDEO' && !locked && cfg.video_mode !== 'SCRIPT_ONLY' && (item.video_url || item.status === 'FAILED')) actions.push(act('Re-render Video', 'rerenderVideo', '', 'Render this video again? This spends render credits.', 'Render submitted'));
    if (item.status !== 'PUBLISHED') actions.push(act('Remove', 'deleteQueueItem', 'danger', 'Remove this item from the queue?', 'Removed'));

    return h('div', {},
      h('div', { class: 'row' }, statusTag(item.status), h('span', { class: 'tag', text: item.type === 'BLOG' ? 'Blog · ' + (cfg.cms_provider || 'CMS') : platformNames(item.platform) }),
        item.hook_variant ? h('span', { class: 'tag', text: 'Hook ' + item.hook_variant }) : null,
        h('span', { class: 'muted small', text: [item.pillar, item.metro, '“' + item.keyword + '”'].filter(Boolean).join(' · ') })),
      h('h1', { style: 'margin:10px 0 4px;font-size:18px', class: 'selectable', text: item.title }),
      h('div', { class: 'muted small', text: item.status === 'PUBLISHED' ? 'Published ' + fmtDate(item.updated_at) : 'Scheduled for ' + fmtDate(item.scheduled_at) }),
      item.published_url ? h('div', { style: 'margin-top:6px' }, h('a', { class: 'selectable', text: item.published_url, onclick: () => nt.openExternal(item.published_url) })) : null,
      item.error ? h('div', { class: 'notice danger selectable', style: 'margin:12px 0 0', text: item.error }) : null,
      (p.compliance_flags || []).length ? h('div', { class: 'notice danger', style: 'margin:12px 0 0' }, h('strong', { text: 'Compliance filter flagged this content: ' }), p.compliance_flags.join('; ') + '. Edit or regenerate before approving.') : null,
      h('div', { style: 'margin-top:14px' }, body),
      h('div', { class: 'detail-actions' }, actions));
  }

  async function saveEdits(item) {
    const edits = Object.assign({}, S.edits);
    if (typeof edits.tags === 'string') edits.tags = edits.tags.split(',').map((t) => t.trim()).filter(Boolean);
    const r = await api('updateQueueItem', { id: item.id, payload: edits });
    if (r) { S.edits = {}; S.selItem = r; }
    return !!r;
  }

  function blogDoc(title, html) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return '<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font:17px/1.7 Georgia,serif;color:#1d1d1f;max-width:700px;margin:28px auto;padding:0 24px}' +
      'h1,h2,h3{font-family:-apple-system,Helvetica,Arial,sans-serif;line-height:1.25}h1{font-size:30px}h2{font-size:22px;margin-top:1.6em}h3{font-size:17px}a{color:#0f766e}em{color:#555}</style>' +
      '<h1>' + esc(title) + '</h1>' + html;
  }

  function blogDetail(item, p, locked) {
    const v = (k) => (k in S.edits ? S.edits[k] : p[k] || '');
    const tab = (id, label) => h('button', { class: S.blogTab === id ? 'on' : '', text: label, onclick: () => { S.blogTab = id; drawStudio(); } });
    const site = 'nodetelehealth.com › blog › ';
    const serp = h('div', { class: 'serp' }, h('div', { class: 'serp-url', id: 'serp-url', text: site + v('slug') }), h('div', { class: 'serp-title', id: 'serp-title', text: v('title') }), h('div', { class: 'serp-desc', id: 'serp-desc', text: v('meta_description') }));
    let pane;
    if (S.blogTab === 'preview') {
      pane = h('iframe', { class: 'blog-preview', sandbox: '', title: 'Rendered blog preview', srcdoc: blogDoc(v('title'), v('html_body')) });
    } else if (S.blogTab === 'seo') {
      pane = h('div', {}, serp,
        editField(item, 'title', 'SEO title', { max: 60, readOnly: locked, onInput: (x) => { $('#serp-title').textContent = x; } }),
        editField(item, 'slug', 'URL slug', { readOnly: locked, help: 'Lowercase words separated by hyphens.', onInput: (x) => { $('#serp-url').textContent = site + x; } }),
        editField(item, 'meta_description', 'Meta description', { max: 160, rows: 3, readOnly: locked, onInput: (x) => { $('#serp-desc').textContent = x; } }),
        editField(item, 'focus_keyword', 'Focus keyword', { readOnly: locked }),
        editField(item, 'excerpt', 'Excerpt', { rows: 2, readOnly: locked }),
        (() => { const f = editField(item, 'tags', 'Tags (comma-separated)', { readOnly: locked }); if (!('tags' in S.edits)) $('input', f).value = (p.tags || []).join(', '); return f; })());
    } else {
      pane = editField(item, 'html_body', 'Article HTML', { rows: 22, readOnly: locked, help: 'Edit the source, then open Preview to check it.' });
    }
    return h('div', {}, h('div', { class: 'tabs' }, tab('preview', 'Preview'), tab('seo', 'SEO meta & slug'), tab('html', 'HTML source')), pane);
  }

  function socialDetail(item, p, locked) {
    const isX = item.platform === 'X_TWITTER';
    return h('div', {},
      editField(item, 'text', isX && p.thread ? 'First post' : 'Post text', { rows: isX ? 4 : 9, max: isX ? 280 : (item.platform === 'GOOGLE_BUSINESS' ? 1450 : 3000), readOnly: locked }),
      isX && p.thread && p.thread.length > 1 ? h('div', { class: 'field' }, h('h3', { text: 'Thread' }), p.thread.slice(1).map((t, i) => h('div', { class: 'scene' }, h('div', { class: 'scene-t', text: String(i + 2) }), h('div', { class: 'selectable', text: t })))) : null,
      p.link ? h('div', { class: 'small muted selectable', text: 'Link: ' + p.link }) : null,
      p.hook_a ? h('div', { class: 'small', style: 'margin-top:12px' }, h('h3', { text: 'A/B hooks' }),
        h('div', { class: 'scene' }, h('div', { class: 'scene-t', text: 'A' }), h('div', { class: 'selectable', text: p.hook_a })),
        h('div', { class: 'scene' }, h('div', { class: 'scene-t', text: 'B' }), h('div', { class: 'selectable', text: p.hook_b }))) : null,
      p.carousel_slides ? h('div', { style: 'margin-top:12px' }, h('h3', { text: 'Carousel outline (design manually)' }), p.carousel_slides.map((s, i) => h('div', { class: 'scene' }, h('div', { class: 'scene-t', text: String(i + 1) }), h('div', { class: 'selectable', text: s })))) : null);
  }

  function videoDetail(item, p, locked) {
    let t = 0;
    return h('div', { class: 'media-row' },
      h('div', {},
        h('div', { class: 'phone', id: 'video-slot' }, h('div', { class: 'ph', text: item.status === 'RENDERING' ? 'Rendering… the poller checks every few minutes.' : item.video_url ? 'Loading video…' : 'No video rendered yet.' })),
        item.video_file_id ? h('div', { style: 'margin-top:8px;text-align:center' }, h('a', { class: 'small', text: 'Open MP4 in Google Drive', onclick: () => nt.openExternal('https://drive.google.com/file/d/' + item.video_file_id + '/view') })) : null),
      h('div', { style: 'flex:1;min-width:300px' },
        h('h3', { text: 'Voiceover' }),
        h('div', { id: 'audio-slot', class: 'small muted', style: 'margin:6px 0 14px', text: item.audio_url ? 'Loading audio…' : 'No voiceover synthesized yet.' }),
        h('h3', { text: 'On-screen hooks' }),
        h('div', { class: 'scene' }, h('div', { class: 'scene-t', text: 'A' }), h('div', { class: 'selectable', text: p.hook_a })),
        h('div', { class: 'scene', style: 'margin-bottom:12px' }, h('div', { class: 'scene-t', text: 'B' }), h('div', { class: 'selectable', text: p.hook_b })),
        h('h3', { text: 'Scenes · about ' + (p.audio_duration || p.est_duration_sec || '?') + ' s' }),
        (p.scenes || []).map((s) => { const start = t; t += Number(s.seconds) || 0; return h('div', { class: 'scene' }, h('div', { class: 'scene-t', text: start + 's' }), h('div', {}, h('div', { class: 'selectable', text: s.narration }), h('div', { class: 'scene-v', text: '🎬 ' + s.visual_prompt + '  ·  “' + s.on_screen_caption + '”' }))); }),
        h('div', { style: 'margin-top:14px' },
          editField(item, 'narration', 'Narration (spoken by the voiceover)', { rows: 5, readOnly: locked, help: 'Edits are re-voiced the next time the video is rendered.' }),
          editField(item, 'caption', 'Post caption', { rows: 3, readOnly: locked }))));
  }

  async function loadMedia(item) {
    const id = item.id;
    const stillHere = () => S.selItem && S.selItem.id === id && S.view === 'studio';
    const fail = (slot, msg, url) => setKids(slot, h('div', { class: slot.id === 'video-slot' ? 'ph' : '' }, msg + ' ', h('a', { text: 'Open in Drive', onclick: () => nt.openExternal(url) })));
    if (item.audio_url) nt.cacheMedia(item.audio_url).then((r) => {
      const slot = $('#audio-slot');
      if (!slot || !stillHere()) return;
      if (r.ok) setKids(slot, h('audio', { controls: true, preload: 'metadata', src: r.fileUrl })); else fail(slot, r.error, item.audio_url);
    });
    if (item.video_url) nt.cacheMedia(item.video_url).then((r) => {
      const slot = $('#video-slot');
      if (!slot || !stillHere()) return;
      if (r.ok) setKids(slot, h('video', { controls: true, playsinline: true, preload: 'metadata', src: r.fileUrl })); else fail(slot, r.error, item.video_url);
    });
  }

  /* ───────────────────────── Settings & connection wizard ───────────────────────── */

  const FIELD = {
    CLAUDE_API_KEY: ['Claude API key', 'sk-ant-…'],
    WP_SITE_URL: ['WordPress site URL', 'https://nodetelehealth.com'], WP_USERNAME: ['WordPress username', ''], WP_APP_PASSWORD: ['Application password', 'xxxx xxxx xxxx xxxx xxxx xxxx'],
    WEBFLOW_API_TOKEN: ['Webflow API token', ''], WEBFLOW_COLLECTION_ID: ['Blog collection ID', ''], WEBFLOW_SITE_URL: ['Published site URL', 'https://nodetelehealth.com'],
    CMS_WEBHOOK_URL: ['Webhook URL', 'https://hook.make.com/…'],
    ELEVENLABS_API_KEY: ['ElevenLabs API key', ''], ELEVENLABS_VOICE_ID: ['Voice ID', ''],
    HEYGEN_API_KEY: ['HeyGen API key', ''], HEYGEN_AVATAR_ID: ['Avatar ID', ''], HEYGEN_VOICE_ID: ['HeyGen voice ID (only if ElevenLabs is off)', ''],
    CREATOMATE_API_KEY: ['Creatomate API key', ''], CREATOMATE_TEMPLATE_ID: ['Template ID (optional)', 'Leave blank to use the built-in layout'],
    JSON2VIDEO_API_KEY: ['JSON2Video API key', ''], PEXELS_API_KEY: ['Pexels API key (free stock b-roll)', ''],
    META_PAGE_ID: ['Facebook Page ID', ''], META_PAGE_ACCESS_TOKEN: ['Page access token (long-lived)', ''], IG_USER_ID: ['Instagram business account ID', ''],
    X_API_KEY: ['API key', ''], X_API_SECRET: ['API key secret', ''], X_ACCESS_TOKEN: ['Access token', ''], X_ACCESS_SECRET: ['Access token secret', ''],
    LINKEDIN_ACCESS_TOKEN: ['Access token (w_organization_social)', ''], LINKEDIN_ORG_ID: ['Organization ID', ''],
    YT_CLIENT_ID: ['OAuth client ID (optional)', ''], YT_CLIENT_SECRET: ['OAuth client secret (optional)', ''], YT_REFRESH_TOKEN: ['Refresh token (optional)', 'Blank = upload to the script owner\'s channel'],
    TIKTOK_CLIENT_KEY: ['Client key', ''], TIKTOK_CLIENT_SECRET: ['Client secret', ''], TIKTOK_ACCESS_TOKEN: ['Access token (video.publish)', ''], TIKTOK_REFRESH_TOKEN: ['Refresh token', ''],
    GBP_ACCOUNT_ID: ['Account ID', ''], GBP_LOCATION_ID: ['Location ID', ''],
    SOCIAL_WEBHOOK_URL: ['Buffer / Make.com webhook URL', 'Used for any network without native credentials'],
    GA4_PROPERTY_ID: ['GA4 property ID', '123456789']
  };

  const STEPS = [
    { title: 'Backend connection', sub: 'Apps Script Web App' },
    { title: 'Claude AI', sub: 'Content engine', help: ['Create a key at console.anthropic.com → API Keys.', 'The key is stored only in Google ScriptProperties, never on this Mac.'],
      groups: [{ legend: 'Anthropic', keys: ['CLAUDE_API_KEY'], test: 'CLAUDE' }], config: [['claude_model', 'Model', [['claude-sonnet-4-6', 'Claude Sonnet 4.6'], ['claude-opus-4-6', 'Claude Opus 4.6']]]] },
    { title: 'Blog CMS', sub: 'WordPress or Webflow', config: [['cms_provider', 'CMS provider', [['WORDPRESS', 'WordPress'], ['WEBFLOW', 'Webflow'], ['WEBHOOK', 'Webhook']]]],
      groups: [
        { legend: 'WordPress REST API', when: (c) => c.cms_provider === 'WORDPRESS', keys: ['WP_SITE_URL', 'WP_USERNAME', 'WP_APP_PASSWORD'], test: 'WORDPRESS',
          help: ['WordPress admin → Users → Profile → Application Passwords.', 'Name it "NodeTelehealth Marketing", click Add New, and paste the generated password here.', 'The user needs the Editor or Administrator role.'] },
        { legend: 'Webflow CMS Data API v2', when: (c) => c.cms_provider === 'WEBFLOW', keys: ['WEBFLOW_API_TOKEN', 'WEBFLOW_COLLECTION_ID', 'WEBFLOW_SITE_URL'], test: 'WEBFLOW',
          help: ['Webflow → Site settings → Apps & integrations → API access → Generate API token with CMS read/write.', 'Collection ID: CMS → your Blog Posts collection → settings.', 'Fields expected: post-body, post-summary, seo-description.'] },
        { legend: 'Generic webhook', when: (c) => c.cms_provider === 'WEBHOOK', keys: ['CMS_WEBHOOK_URL'] }] },
    { title: 'Voiceover', sub: 'ElevenLabs', config: [['elevenlabs_model', 'Model', [['eleven_flash_v2_5', 'Flash v2.5 (lowest cost)'], ['eleven_turbo_v2_5', 'Turbo v2.5']]]],
      groups: [{ legend: 'ElevenLabs', keys: ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'], test: 'ELEVENLABS', help: ['Key: elevenlabs.io → Profile → API keys.', 'Voice ID: Voices → your voice → Copy voice ID.'] }] },
    { title: 'Video rendering', sub: 'HeyGen · Creatomate', config: [['video_mode', 'Video engine', [['HEYGEN_AVATAR', 'HeyGen AI Avatar'], ['FACELESS_BROLL', 'Faceless B-Roll + ElevenLabs'], ['SCRIPT_ONLY', 'Script-Only']]], ['faceless_provider', 'Faceless provider', [['CREATOMATE', 'Creatomate'], ['JSON2VIDEO', 'JSON2Video']]]],
      groups: [
        { legend: 'HeyGen (AI avatar)', keys: ['HEYGEN_API_KEY', 'HEYGEN_AVATAR_ID', 'HEYGEN_VOICE_ID'], test: 'HEYGEN' },
        { legend: 'Creatomate (faceless b-roll)', keys: ['CREATOMATE_API_KEY', 'CREATOMATE_TEMPLATE_ID'], test: 'CREATOMATE' },
        { legend: 'JSON2Video and stock footage', keys: ['JSON2VIDEO_API_KEY', 'PEXELS_API_KEY'] }] },
    { title: 'Social networks', sub: 'OAuth tokens', groups: [
      { legend: 'Facebook Page & Instagram', keys: ['META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN', 'IG_USER_ID'], test: 'META' },
      { legend: 'X / Twitter (OAuth 1.0a, Read and Write)', keys: ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'], test: 'X_TWITTER' },
      { legend: 'LinkedIn Company Page', keys: ['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_ORG_ID'] },
      { legend: 'YouTube Shorts', keys: ['YT_CLIENT_ID', 'YT_CLIENT_SECRET', 'YT_REFRESH_TOKEN'], test: 'YOUTUBE' },
      { legend: 'TikTok Content Posting API', keys: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_ACCESS_TOKEN', 'TIKTOK_REFRESH_TOKEN'] },
      { legend: 'Google Business Profile', keys: ['GBP_ACCOUNT_ID', 'GBP_LOCATION_ID'] },
      { legend: 'Fallback', keys: ['SOCIAL_WEBHOOK_URL'] }] },
    { title: 'Analytics', sub: 'Google Analytics 4', help: ['GA4 → Admin → Property settings → Property ID.', 'The Google account that owns the Apps Script must have Viewer access to the property.'],
      groups: [{ legend: 'Google Analytics 4', keys: ['GA4_PROPERTY_ID'], test: 'GA4' }] }
  ];

  async function renderSettings() {
    const root = $('#view-settings');
    if (S.status.connected) { await loadState(); S.secrets = (await api('getSecretStatus', {}, { quiet: true })) || S.secrets; }
    if (S.view !== 'settings') return;
    if (!S.status.connected) S.step = 0;
    const step = STEPS[S.step];
    const stepDone = (s, i) => i === 0 ? S.status.connected : !!S.secrets && (s.groups || []).some((g) => g.keys.some((k) => S.secrets[k] && S.secrets[k].set));
    setKids(root, 
      viewHead('Settings & Setup', 'API keys are sent once to your Apps Script backend and stored in ScriptProperties. They are never saved on this Mac.'),
      h('div', { class: 'wizard' },
        h('div', { class: 'steps' }, STEPS.map((s, i) => h('button', { class: 'step' + (i === S.step ? ' on' : '') + (stepDone(s, i) ? ' done' : ''), disabled: i > 0 && !S.status.connected, onclick: () => { S.step = i; renderSettings(); } },
          h('span', { class: 'step-n', text: stepDone(s, i) && i !== S.step ? '✓' : String(i + 1) }), h('span', {}, h('div', { class: 'step-t', text: s.title }), h('div', { class: 'step-s', text: s.sub }))))),
        h('div', { class: 'card' }, S.step === 0 ? await backendStep() : serviceStep(step))));
  }

  async function backendStep() {
    const conn = await nt.getConnection();
    const url = h('input', { type: 'url', value: conn.url, placeholder: 'https://script.google.com/macros/s/…/exec' });
    const token = h('input', { type: 'password', placeholder: conn.hasToken ? '•••• saved — leave blank to keep' : 'Paste the handshake token', autocomplete: 'off' });
    const result = h('div', { class: 'test-result' + (S.status.connected ? ' ok' : ''), text: S.status.connected ? 'Connected. System status: ' + S.status.system_status : '' });
    return h('div', {},
      h('h2', { text: 'Step 1 · Connect the Google Apps Script backend' }),
      h('ol', { class: 'steps-list', style: 'margin-bottom:16px' },
        h('li', { text: 'Paste the gas-backend files into a new Apps Script project and run initializeSystem() once.' }),
        h('li', { text: 'Copy the handshake token printed in the execution log.' }),
        h('li', { text: 'Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone. Copy the /exec URL.' })),
      h('label', { class: 'field' }, h('span', { text: 'Web App URL' }), url),
      h('label', { class: 'field' }, h('span', { text: 'Secret handshake token' }), token, h('small', { text: 'Stored encrypted in the macOS Keychain.' })),
      result,
      h('div', { class: 'wizard-foot' },
        h('button', { class: 'btn primary', text: 'Save & Test Connection', onclick: (e) => busy(e.currentTarget, async () => {
          const r = await nt.saveConnection(url.value, token.value);
          if (!r.ok) { result.className = 'test-result bad'; result.textContent = r.error; return; }
          S.state = r.state; S.status = await nt.refreshStatus(); renderTopbar();
          toast('Backend connected'); S.step = 1; renderSettings();
        }) })));
  }

  function serviceStep(step) {
    const cfg = Object.assign({}, S.state ? S.state.config : {});
    const inputs = {}, cfgPatch = {};
    const body = h('div', {});
    const draw = () => {
      const view = Object.assign({}, cfg, cfgPatch);
      setKids(body, 
        (step.config || []).map(([key, label, options]) => h('label', { class: 'field', style: 'max-width:340px' }, h('span', { text: label }), select(options, view[key], (v) => { cfgPatch[key] = v; draw(); }))),
        (step.groups || []).filter((g) => !g.when || g.when(view)).map((g) => {
          const result = h('div', { class: 'test-result' });
          return h('fieldset', {}, h('legend', { text: g.legend }),
            g.help ? h('ol', { class: 'steps-list', style: 'margin-bottom:12px' }, g.help.map((x) => h('li', { text: x }))) : null,
            h('div', { class: g.keys.length > 1 ? 'grid-2' : '' }, g.keys.map((k) => {
              const st = (S.secrets && S.secrets[k]) || {};
              const isSecret = !('value' in st);
              const input = inputs[k] || (inputs[k] = h('input', { type: isSecret ? 'password' : 'text', autocomplete: 'off', value: isSecret ? '' : (st.value || ''), placeholder: isSecret && st.set ? 'Saved ' + st.hint + ' — leave blank to keep' : FIELD[k][1] }));
              return h('label', { class: 'field' }, h('span', {}, FIELD[k][0], st.set ? h('span', { class: 'counter', text: '✓ saved' }) : null), input);
            })),
            g.test ? h('div', { class: 'row', style: 'margin-bottom:10px' }, h('button', { class: 'btn', text: 'Save & Test', disabled: halted(), onclick: (e) => busy(e.currentTarget, async () => {
              if (!(await save())) return;
              const res = await nt.call('testConnection', { service: g.test });
              result.className = 'test-result ' + (res.ok ? 'ok' : 'bad');
              result.textContent = res.ok ? '✓ ' + res.data.detail : '✗ ' + res.error;
            }) }), result) : null);
        }));
    };
    async function save() {
      const secrets = {};
      Object.keys(inputs).forEach((k) => { const v = inputs[k].value.trim(); const st = (S.secrets && S.secrets[k]) || {}; if (v && v !== st.value) secrets[k] = v; });
      if (Object.keys(cfgPatch).length) { const c = await api('saveConfig', cfgPatch); if (!c) return false; if (S.state) S.state.config = c; }
      if (Object.keys(secrets).length) { const r = await api('saveSecrets', secrets); if (!r) return false; S.secrets = r.secrets; }
      return true;
    }
    draw();
    const last = S.step === STEPS.length - 1;
    return h('div', {},
      h('h2', { text: 'Step ' + (S.step + 1) + ' · ' + step.title }),
      step.help ? h('ol', { class: 'steps-list', style: 'margin-bottom:14px' }, step.help.map((x) => h('li', { text: x }))) : h('div', { style: 'height:12px' }),
      body,
      h('div', { class: 'wizard-foot' },
        h('button', { class: 'btn', text: 'Back', onclick: () => { S.step--; renderSettings(); } }),
        h('button', { class: 'btn primary', text: last ? 'Save & Finish' : 'Save & Continue', onclick: (e) => busy(e.currentTarget, async () => {
          if (!(await save())) return;
          toast('Saved');
          await loadState(true);
          if (last) showView('tools'); else { S.step++; renderSettings(); }
        }) }),
        h('span', { class: 'muted small', text: last ? 'Next: switch tools ON in Tool Controls.' : 'Every field is optional — skip what you do not use.' })));
  }

  /* ───────────────────────── Boot & live updates ───────────────────────── */

  nt.onStatus((st) => {
    const changed = st.connected !== S.status.connected || st.kill_switch !== S.status.kill_switch || st.workflow_mode !== S.status.workflow_mode;
    S.status = st;
    renderTopbar();
    if (changed) { S.state = null; loadState().then(() => { renderTopbar(); if (!(S.view === 'agent' && S.dirty) && S.view !== 'settings') refreshView(); if (st.connected) loadQueue(); }); }
  });
  nt.onEvents(() => { if (S.view === 'studio') renderStudio(true); else loadQueue(); });
  nt.onNavigate(({ view, id }) => { if (id) { S.selId = id; S.edits = {}; } showView(view); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.view === 'dashboard') renderDashboard(); });

  setInterval(() => {
    if (!S.status.connected || document.hidden) return;
    if (S.view === 'dashboard') renderDashboard();
    else if (S.view === 'tools') renderTools();
    else if (S.view === 'studio') renderStudio(true);
  }, 60000);

  if (nt.platform !== 'darwin') document.body.classList.add('not-mac');
  nt.getStatus().then((st) => { S.status = st; renderTopbar(); showView(st.configured ? 'dashboard' : 'settings'); });
})();
