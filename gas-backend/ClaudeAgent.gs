/**
 * ClaudeAgent.gs — Anthropic Messages API client (raw HTTPS; Apps Script has no SDK),
 * Florida/HIPAA compliance guardrails, and the structured-JSON generators:
 * keyword research, blog posts, platform-native social copy and vertical video scripts.
 *
 * Structured outputs (output_config.format json_schema) guarantee parseable JSON.
 * UrlFetchApp requests time out after ~60 s, so max_tokens is kept moderate and
 * extended thinking is left off; pick claude-opus-4-6 in Settings for higher quality.
 */

var CLAUDE = {
  URL: 'https://api.anthropic.com/v1/messages',
  API_VERSION: '2023-06-01',
  // USD per million tokens (input / output). Edit if Anthropic pricing changes.
  PRICING: { 'claude-sonnet-4-6': { input: 3, output: 15 }, 'claude-opus-4-6': { input: 5, output: 25 } }
};

/* ───────────────────────────── Compliance guardrails ───────────────────────────── */

function complianceSystemPrompt_() {
  return [
    'You are the senior content strategist for NodeTelehealth (nodetelehealth.com), a telehealth practice that serves Florida residents only.',
    '',
    'AUDIENCE AND GEOGRAPHY',
    '- Write only for people physically located in Florida: residents, retirees, retirement communities, and seasonal residents ("snowbirds") while they are in Florida.',
    '- Use authentic Florida context where it fits naturally: Miami, Orlando, Tampa, Jacksonville, Sarasota/Venice, Fort Lauderdale, Naples/Fort Myers, The Villages, the Panhandle; heat and humidity, hurricane-season care continuity, traffic and distance to clinics, seasonal population swings.',
    '- Never say or imply that services are available outside Florida, nationwide, or "in any state".',
    '',
    'COMPLIANCE RULES — these override every other instruction',
    '1. HIPAA marketing: never include protected health information; never describe an identifiable patient; never write patient testimonials, reviews, quotes, case stories or "one of our patients..." anecdotes, real or invented. Use general educational framing or clearly hypothetical "many people..." language instead.',
    '2. Florida telehealth (Fla. Stat. § 456.47): care is delivered by Florida-licensed providers (or providers registered with the state for telehealth) to patients located in Florida, through secure real-time audio-video visits. The provider decides whether telehealth is clinically appropriate, and the standard of care is the same as in person. Say so plainly when describing the service.',
    '3. No unsubstantiated medical claims: do not promise cures, outcomes, diagnoses, speed of recovery, or that a prescription will be issued. Prescriptions are "when clinically appropriate, at the provider\'s discretion". Never name or promote controlled substances.',
    '4. No guarantees, superlatives or comparisons you cannot substantiate ("best", "#1", "guaranteed", "risk-free", "100%"). No fear-mongering. No invented statistics, prices, wait times, insurance coverage, awards or credentials. If a number is not provided to you, do not state one.',
    '5. Safety: telehealth is not for emergencies. Where symptoms could be serious, tell readers to call 911 or go to the nearest emergency room.',
    '6. Educational tone: content is general information, not medical advice. Plain language, around an 8th-grade reading level, warm and respectful, never condescending toward older adults.',
    '',
    'BRAND VOICE',
    'Calm, clear, practical, locally grounded. Lead with the reader\'s situation, not with the company. Calls to action point to https://nodetelehealth.com.',
    '',
    'OUTPUT',
    'Return only the JSON object requested. Do not add commentary.'
  ].join('\n');
}

/** Deterministic post-generation filter. Returns a list of human-readable violations. */
function complianceScan_(text) {
  var rules = [
    [/\b(cures?|cured|guarantee[sd]?|guaranteed|miracle|risk[- ]free|no side effects)\b/i, 'outcome guarantee / cure claim'],
    [/\b100\s?%/i, '"100%" claim'],
    [/(\bbest\b|#\s?1\b|\bnumber one\b|\btop[- ]rated\b)\s+(online\s+|virtual\s+|telehealth\s+|florida\s+)*(doctor|doctors|provider|providers|telehealth|clinic|care|service)/i, 'unsubstantiated superlative'],
    [/\b(testimonial|five[- ]star review|one of our patients|a patient of ours|our patient [A-Z][a-z]+|patient story)\b/i, 'patient testimonial / identifiable patient'],
    [/\b(date of birth|social security number|medical record number|\bMRN\b|\bSSN\b)\b/i, 'possible PHI reference'],
    [/\b(adderall|xanax|oxycodone|oxycontin|percocet|vicodin|vyvanse|ritalin|ambien|klonopin|valium|tramadol|opioids? prescription|testosterone prescription)\b/i, 'controlled substance mention'],
    [/\b(nationwide|all 50 states|any state|in every state|across the (country|u\.?s\.?))\b/i, 'claims availability outside Florida'],
    [/\b(instant(ly)? (diagnos|prescri)|prescription guaranteed|get (your )?antibiotics (now|today|fast))\b/i, 'prescription / diagnosis promise']
  ];
  var found = [];
  rules.forEach(function (r) {
    var m = String(text || '').match(r[0]);
    if (m) found.push(r[1] + ' ("' + m[0] + '")');
  });
  return found;
}

function collectStrings_(value, out) {
  out = out || [];
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(function (v) { collectStrings_(v, out); });
  else if (value && typeof value === 'object') Object.keys(value).forEach(function (k) { collectStrings_(value[k], out); });
  return out;
}

/* ───────────────────────────── API client ───────────────────────────── */

/**
 * @param {{task:string, toolKey:string, user:string, schema:Object, maxTokens:number, queueId:?string}} o
 * @return {Object} parsed JSON matching o.schema
 */
function callClaudeJson_(o) {
  assertSystemActive();
  var key = getProp_('CLAUDE_API_KEY', '');
  if (!key) throw appError_(412, 'MISSING_API_KEY', 'CLAUDE_API_KEY is not configured');
  var model = getConfig().claude_model;
  var body = {
    model: model,
    max_tokens: o.maxTokens || 4000,
    system: [{ type: 'text', text: complianceSystemPrompt_(), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: o.user }],
    output_config: { format: { type: 'json_schema', schema: o.schema } }
  };
  var res, code;
  for (var attempt = 0; attempt < 3; attempt++) {
    res = guardedFetch_(o.toolKey, 'CLAUDE', CLAUDE.URL, {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': key, 'anthropic-version': CLAUDE.API_VERSION },
      payload: JSON.stringify(body)
    });
    code = res.getResponseCode();
    if (code !== 429 && code < 500) break;
    Utilities.sleep(2000 * (attempt + 1) * (attempt + 1));
  }
  var text = res.getContentText();
  if (code >= 400) {
    logCost_({ service: 'CLAUDE', tool_key: o.toolKey, operation: o.task, ok: false, queue_id: o.queueId, detail: 'HTTP ' + code + ' ' + text.slice(0, 200) });
    throw appError_(502, 'CLAUDE_ERROR', 'Claude API HTTP ' + code + ': ' + text.slice(0, 300));
  }
  var msg = JSON.parse(text);
  var u = msg.usage || {};
  var price = CLAUDE.PRICING[model] || CLAUDE.PRICING['claude-sonnet-4-6'];
  var inputEquivalent = num_(u.input_tokens) + num_(u.cache_creation_input_tokens) * 1.25 + num_(u.cache_read_input_tokens) * 0.1;
  var cost = (inputEquivalent * price.input + num_(u.output_tokens) * price.output) / 1e6;
  var tokens = num_(u.input_tokens) + num_(u.cache_creation_input_tokens) + num_(u.cache_read_input_tokens) + num_(u.output_tokens);
  var okStop = msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence';
  logCost_({ service: 'CLAUDE', tool_key: o.toolKey, operation: o.task, units: tokens, unit_type: 'tokens', est_cost_usd: cost, ok: okStop, queue_id: o.queueId, detail: model + ' in=' + num_(u.input_tokens) + ' out=' + num_(u.output_tokens) + ' stop=' + msg.stop_reason });
  recordToolRun_(o.toolKey, tokens, 'tokens', cost);
  if (msg.stop_reason === 'refusal') throw appError_(502, 'CLAUDE_REFUSAL', 'Claude declined this request.');
  if (msg.stop_reason === 'max_tokens') throw appError_(502, 'CLAUDE_TRUNCATED', 'Claude output hit max_tokens; nothing was saved.');
  var out = (msg.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  try { return JSON.parse(out); }
  catch (e) { throw appError_(502, 'CLAUDE_BAD_JSON', 'Claude returned unparseable JSON.'); }
}

/** Generates, scans, and (once) asks Claude to repair any compliance violation. */
function generateCompliant_(o) {
  var result = callClaudeJson_(o);
  var violations = complianceScan_(collectStrings_(result).join('\n'));
  if (violations.length) {
    var retry = {};
    Object.keys(o).forEach(function (k) { retry[k] = o[k]; });
    retry.task = o.task + ':compliance_retry';
    retry.user = o.user + '\n\nYour previous draft was rejected by the compliance filter for: ' + violations.join('; ') +
      '. Write a fresh version that avoids every flagged phrase and still satisfies all requirements.';
    result = callClaudeJson_(retry);
    violations = complianceScan_(collectStrings_(result).join('\n'));
  }
  result.compliance_flags = violations;
  return result;
}

function testClaude_() {
  var key = getProp_('CLAUDE_API_KEY', '');
  if (!key) throw appError_(412, 'MISSING_API_KEY', 'CLAUDE_API_KEY is not configured');
  var r = fetchJson_(null, 'CLAUDE', 'https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': CLAUDE.API_VERSION } });
  return 'Key accepted. Configured model: ' + getConfig().claude_model + (r.json && r.json.data && r.json.data[0] ? ' (API reachable)' : '');
}

/* ───────────────────────────── Prompt building blocks ───────────────────────────── */

function briefBlock_(brief) {
  return [
    'CONTENT BRIEF',
    '- Content pillar: ' + brief.pillar,
    '- Florida metro focus: ' + brief.metro,
    '- Focus keyword: ' + brief.keyword,
    brief.topic_idea ? '- Topic angle: ' + brief.topic_idea : '',
    '- Season/date context: ' + Utilities.formatDate(new Date(), 'America/New_York', 'MMMM yyyy') + ' in Florida'
  ].filter(String).join('\n');
}

/** A/B optimisation: feed the best-performing past hooks back into the prompt as style evidence. */
function hookInsightsBlock_() {
  var top = [];
  try { top = topHooks_(5); } catch (e) { top = []; }
  if (!top.length) return 'A/B HOOKS\nWrite two genuinely different opening hooks (hook_a: curiosity or question-led; hook_b: direct benefit-led). No performance data exists yet.';
  return 'A/B HOOKS\nWrite two genuinely different opening hooks (hook_a and hook_b). These past hooks earned the highest engagement — learn from their style without copying them:\n' +
    top.map(function (h) { return '- [' + h.platform + ', ' + (h.rate * 100).toFixed(1) + '% engagement] ' + h.hook_text; }).join('\n');
}

function obj_(properties) {
  return { type: 'object', properties: properties, required: Object.keys(properties), additionalProperties: false };
}
function str_(description) { return { type: 'string', description: description }; }
function arr_(items, description) { return { type: 'array', items: items, description: description }; }

/* ───────────────────────────── Ideation / Florida SEO research ───────────────────────────── */

function researchFloridaKeywords_(count) {
  requireTool_('TOGGLE_CLAUDE_IDEATION');
  var cfg = getConfig();
  var n = Math.max(4, Math.min(20, num_(count) || 12));
  var existing = dbReadAll_(TABS.KEYWORDS).map(function (k) { return k.keyword; });
  var schema = obj_({
    keywords: arr_(obj_({
      keyword: str_('Search phrase a Florida resident would type, 2-6 words, includes a Florida place or "Florida" where natural'),
      metro: { type: 'string', enum: Object.keys(cfg.metro_weights) },
      pillar: { type: 'string', enum: Object.keys(cfg.pillar_weights) },
      intent: { type: 'string', enum: ['informational', 'commercial', 'local', 'seasonal'] },
      topic_idea: str_('One-sentence content angle for a blog post, short video and social posts'),
      difficulty: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Your qualitative estimate of ranking difficulty for a small local site' }
    }), 'Exactly ' + n + ' keyword ideas')
  });
  var user = [
    'Propose ' + n + ' new long-tail, low-competition organic search topics for NodeTelehealth.',
    'Spread them across these Florida metros (weight = priority): ' + JSON.stringify(cfg.metro_weights),
    'and these content pillars (weight = priority): ' + JSON.stringify(cfg.pillar_weights) + '.',
    'Favor specific local or seasonal intent (hurricane season, snowbird season, retirement communities, heat, travel distance) over generic head terms.',
    'Do not repeat any of these existing keywords: ' + existing.slice(-80).join('; ') + '.',
    'Difficulty is your qualitative judgement only; do not invent search-volume numbers.'
  ].join('\n');
  var out = callClaudeJson_({ task: 'keyword_research', toolKey: 'TOGGLE_CLAUDE_IDEATION', user: user, schema: schema, maxTokens: 3000 });
  var seen = {};
  existing.forEach(function (k) { seen[k.toLowerCase()] = 1; });
  var rows = (out.keywords || []).filter(function (k) {
    var key = String(k.keyword).toLowerCase();
    if (seen[key] || complianceScan_(k.keyword + ' ' + k.topic_idea).length) return false;
    seen[key] = 1;
    return true;
  }).map(function (k) {
    return { id: uid_('kw'), keyword: k.keyword, metro: k.metro, pillar: k.pillar, intent: k.intent, topic_idea: k.topic_idea, difficulty: k.difficulty, source: 'CLAUDE', used_count: 0, last_used: '', created_at: nowIso_() };
  });
  dbAppendMany_(TABS.KEYWORDS, rows);
  return { added: rows.length, keywords: rows };
}

/* ───────────────────────────── Blog generation ───────────────────────────── */

function generateBlog_(brief, queueId) {
  requireTool_('TOGGLE_BLOG_CMS');
  var schema = obj_({
    title: str_('SEO title, 50-60 characters, includes the focus keyword and a Florida reference'),
    slug: str_('lowercase-hyphenated URL slug, 3-7 words, no dates'),
    meta_description: str_('140-155 characters, includes the focus keyword, ends with a soft call to action'),
    focus_keyword: str_('The focus keyword exactly as given in the brief'),
    excerpt: str_('1-2 sentence summary, under 300 characters'),
    tags: arr_({ type: 'string' }, '4-6 short topical tags, at least two naming Florida places'),
    html_body: str_('Article body as clean semantic HTML. Allowed tags only: h2 h3 p ul ol li strong em a blockquote. No h1, no inline styles, no scripts, no FAQ section (it is added separately).'),
    faq: arr_(obj_({ question: str_('A question a Florida resident would actually ask'), answer: str_('2-3 sentence plain-text answer') }), '4 Florida-specific FAQs'),
    social_blurb: str_('2-sentence teaser for sharing the article link on social media, under 220 characters, no hashtags'),
    hook_a: str_('Alternative social headline, curiosity-led, under 90 characters'),
    hook_b: str_('Alternative social headline, benefit-led, under 90 characters')
  });
  var user = [
    'Write an original, genuinely useful blog article for nodetelehealth.com.',
    briefBlock_(brief),
    '',
    'REQUIREMENTS',
    '- 800-1,000 words in html_body. Open with a short paragraph grounded in the reader\'s situation in ' + brief.metro + '.',
    '- 4-6 <h2> sections with <h3> sub-points where helpful. Use the focus keyword in the first paragraph and in one <h2>, and write naturally everywhere else.',
    '- Include one section explaining how a telehealth visit works in Florida (Florida-licensed providers, secure audio-video visit, provider decides if telehealth is appropriate).',
    '- Include one section on when NOT to use telehealth (emergencies: call 911).',
    '- Include exactly two internal calls to action as links to <a href="' + getConfig().cta_url + '">...</a>, with natural, varied anchor text.',
    '- No external links, no statistics you were not given, no prices, no insurance claims.',
    '- The faq array must not repeat sentences from the body.'
  ].join('\n');
  var blog = generateCompliant_({ task: 'blog', toolKey: 'TOGGLE_BLOG_CMS', user: user, schema: schema, maxTokens: 6000, queueId: queueId });
  return finalizeBlog_(blog, brief);
}

function slugify_(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 75);
}

function escapeHtml_(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Sanitizes Claude's HTML and appends the FAQ section, CTA fallback, disclaimer and FAQPage JSON-LD. */
function finalizeBlog_(blog, brief) {
  var html = String(blog.html_body || '')
    .replace(/<\s*(script|style|iframe|object|embed|form)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/<(\/?)h1(\s[^>]*)?>/gi, '<$1h2>');
  if (html.indexOf('nodetelehealth.com') === -1) {
    html += '\n<p><a href="' + getConfig().cta_url + '">Schedule a video visit with a Florida-licensed provider at NodeTelehealth</a>.</p>';
  }
  var faq = (blog.faq || []).slice(0, 6);
  if (faq.length) {
    html += '\n<h2>Frequently Asked Questions: Telehealth in ' + escapeHtml_(brief.metro) + ', Florida</h2>\n' + faq.map(function (f) {
      return '<h3>' + escapeHtml_(f.question) + '</h3>\n<p>' + escapeHtml_(f.answer) + '</p>';
    }).join('\n');
  }
  html += '\n<p><em>NodeTelehealth visits are provided by Florida-licensed providers to patients located in Florida through secure audio-video visits. ' +
    'This article is general information, not medical advice. Your provider will determine whether telehealth is appropriate for you. ' +
    'If you think you are having a medical emergency, call 911.</em></p>';
  blog.slug = slugify_(blog.slug || blog.title);
  blog.title = String(blog.title || '').trim();
  blog.meta_description = String(blog.meta_description || '').trim().slice(0, 160);
  blog.focus_keyword = brief.keyword;
  blog.tags = (blog.tags || []).map(function (t) { return String(t).trim(); }).filter(String).slice(0, 8);
  blog.html_body = html;
  blog.faq_jsonld = faq.length ? JSON.stringify({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    about: { '@type': 'MedicalOrganization', name: 'NodeTelehealth', url: APP.SITE, areaServed: { '@type': 'State', name: 'Florida' } },
    mainEntity: faq.map(function (f) { return { '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: f.answer } }; })
  }) : '';
  return blog;
}

/* ───────────────────────────── Social copy ───────────────────────────── */

function socialSchemaFor_(platform) {
  var hooks = { hook_a: str_('Opening line variant A'), hook_b: str_('Opening line variant B') };
  var tags = arr_({ type: 'string' }, 'Hashtags without the # sign; mix Florida-local and health topics');
  if (platform === 'FACEBOOK') return obj_({ hook_a: hooks.hook_a, hook_b: hooks.hook_b, body: str_('60-120 words after the hook, conversational, ends with a question or soft CTA'), hashtags: tags });
  if (platform === 'X_TWITTER') return obj_({ hook_a: hooks.hook_a, hook_b: hooks.hook_b, thread: arr_({ type: 'string' }, '2-4 follow-up posts, each under 260 characters; the last one carries the CTA'), hashtags: tags });
  if (platform === 'LINKEDIN') return obj_({ hook_a: hooks.hook_a, hook_b: hooks.hook_b, body: str_('120-180 words, professional and community-minded, short paragraphs'), carousel_slides: arr_({ type: 'string' }, '5-6 short slide captions (max 12 words each) outlining a document carousel on this topic'), hashtags: tags });
  if (platform === 'GOOGLE_BUSINESS') return obj_({ hook_a: hooks.hook_a, hook_b: hooks.hook_b, body: str_('50-90 words, local-update style naming the metro; no hashtags, no phone numbers') });
  throw appError_(400, 'BAD_REQUEST', 'No text format for platform ' + platform);
}

/**
 * One Claude call produces native copy for every requested (currently enabled) text network.
 * @param {string[]} platforms subset of FACEBOOK, X_TWITTER, LINKEDIN, GOOGLE_BUSINESS
 */
function generateSocialPosts_(brief, platforms) {
  assertSystemActive();
  platforms = platforms.filter(function (p) { return isToolEnabled(platformToggle_(p)); });
  if (!platforms.length) return {};
  var props = {};
  platforms.forEach(function (p) { props[p] = socialSchemaFor_(p); });
  var user = [
    'Write platform-native organic social posts for: ' + platforms.join(', ') + '.',
    briefBlock_(brief),
    '',
    hookInsightsBlock_(),
    '',
    'REQUIREMENTS',
    '- Each platform gets its own angle and rhythm; do not paste the same text across networks.',
    '- X_TWITTER hooks must be under 240 characters. Hooks elsewhere: under 140 characters.',
    '- Name ' + brief.metro + ' or Florida in every post. 3-5 hashtags where hashtags are requested, at least two Florida-local.',
    '- CTA is a visit to nodetelehealth.com (the link is appended automatically — do not write URLs).',
    '- No emojis in LinkedIn or Google Business posts; at most two elsewhere.'
  ].join('\n');
  return generateCompliant_({ task: 'social', toolKey: platformToggle_(platforms[0]), user: user, schema: obj_(props), maxTokens: 3500 });
}

/** Assembles the final publishable text for one platform using the chosen hook variant. */
function composeSocialText_(platform, post, variant) {
  var hook = variant === 'B' ? post.hook_b : post.hook_a;
  var tags = (post.hashtags || []).map(function (t) { return '#' + String(t).replace(/[^A-Za-z0-9_]/g, ''); }).filter(function (t) { return t.length > 1; }).join(' ');
  if (platform === 'X_TWITTER') {
    var thread = [hook].concat(post.thread || []);
    if (tags) thread[thread.length - 1] = (thread[thread.length - 1] + ' ' + tags).slice(0, 280);
    return { text: thread[0].slice(0, 280), thread: thread.map(function (t) { return String(t).slice(0, 280); }), hook: hook };
  }
  return { text: [hook, post.body, tags].filter(String).join('\n\n'), hook: hook };
}

/* ───────────────────────────── Video scripts ───────────────────────────── */

function generateVideoScript_(brief, targets, queueId) {
  assertSystemActive();
  var toolKey = platformToggle_(targets[0]);
  var schema = obj_({
    title: str_('Video title under 70 characters, includes a Florida reference'),
    hook_a: str_('On-screen hook caption for the first 2 seconds, max 8 words, curiosity-led'),
    hook_b: str_('On-screen hook caption for the first 2 seconds, max 8 words, benefit-led'),
    scenes: arr_(obj_({
      seconds: { type: 'integer', description: 'Scene length in seconds (4-9)' },
      narration: str_('Exactly what the voiceover says in this scene, natural spoken English'),
      visual_prompt: str_('What appears on screen (b-roll or avatar framing), concrete and filmable'),
      broll_search: str_('2-4 word stock-footage search phrase for this scene, e.g. "florida beach sunrise"'),
      on_screen_caption: str_('Short caption overlay, max 7 words')
    }), '5-7 scenes totalling 30-45 seconds'),
    caption: str_('Post caption for Reels/TikTok/Shorts, under 300 characters, no URLs'),
    hashtags: arr_({ type: 'string' }, '4-6 hashtags without the # sign, at least two Florida-local'),
    cta: str_('Closing spoken call to action mentioning nodetelehealth.com')
  });
  var user = [
    'Write a 30-45 second vertical (9:16) short-form video script for ' + targets.join(', ') + '.',
    briefBlock_(brief),
    '',
    hookInsightsBlock_(),
    '',
    'REQUIREMENTS',
    '- Total narration across scenes: 75-105 spoken words (about 30-45 seconds). The first scene\'s narration must land the hook in under 3 seconds.',
    '- Speak directly to one viewer in ' + brief.metro + ', Florida. One clear idea, one practical takeaway.',
    '- The final scene\'s narration is the CTA and must say that visits are with Florida-licensed providers for people in Florida.',
    '- Narration must read naturally aloud: no symbols, no hashtags, no URLs other than saying "node telehealth dot com", numbers written as words.',
    '- Visuals: Florida lifestyle and everyday health scenes (home, phone video call, pharmacy pickup, palm-lined streets). No depictions of identifiable patients\' medical records or screens showing personal data.'
  ].join('\n');
  var script = generateCompliant_({ task: 'video_script', toolKey: toolKey, user: user, schema: schema, maxTokens: 2500, queueId: queueId });
  script.scenes = (script.scenes || []).slice(0, 8);
  script.narration = script.scenes.map(function (s) { return String(s.narration).trim(); }).join(' ');
  script.est_duration_sec = Math.round(script.narration.split(/\s+/).length / 2.5);
  return script;
}

/** 50/50 split so both variants gather evidence; win rates are computed in AnalyticsSync. */
function pickHookVariant_() { return Math.random() < 0.5 ? 'A' : 'B'; }
