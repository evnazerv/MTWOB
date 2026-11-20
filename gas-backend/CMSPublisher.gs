/**
 * CMSPublisher.gs — Blog publishing adapters.
 *   CMS_PROVIDER = WIX       → Wix Blog REST API v3 (API key + wix-site-id header)
 *                  WORDPRESS → WordPress REST API v2 (Basic Auth with an Application Password)
 *                  WEBFLOW   → Webflow CMS Data API v2 (Bearer token)
 *                  WEBHOOK   → generic JSON webhook (Make.com / Zapier / custom CMS)
 * Every adapter returns { cms_id, url, status } and supports draft and live publishing.
 */

function cmsPublish_(blog, live, item) {
  requireTool_('TOGGLE_BLOG_CMS');
  var provider = getConfig().cms_provider;
  var res = provider === 'WIX' ? wixPublish_(blog, live, item)
    : provider === 'WEBFLOW' ? webflowPublish_(blog, live)
    : provider === 'WEBHOOK' ? webhookCmsPublish_(blog, live, item, null)
    : wordpressPublish_(blog, live, item, null);
  logCost_({ service: provider, tool_key: 'TOGGLE_BLOG_CMS', operation: live ? 'publish' : 'draft', units: 1, unit_type: 'posts', est_cost_usd: 0, ok: true, queue_id: item && item.id });
  recordToolRun_('TOGGLE_BLOG_CMS', 1, 'posts', 0);
  return res;
}

/** Takes an existing CMS draft live (re-sending the latest edited content). */
function cmsPromote_(cmsId, blog, item) {
  requireTool_('TOGGLE_BLOG_CMS');
  var provider = getConfig().cms_provider;
  var res = provider === 'WIX' ? wixPromote_(cmsId, blog, item)
    : provider === 'WEBFLOW' ? webflowPromote_(cmsId, blog)
    : provider === 'WEBHOOK' ? webhookCmsPublish_(blog, true, item, cmsId)
    : wordpressPublish_(blog, true, item, cmsId);
  recordToolRun_('TOGGLE_BLOG_CMS', 1, 'posts', 0);
  return res;
}

/** Random image from NodeTelehealth_Media_Assets/Blog_Covers, or null when the folder is empty. */
function pickCoverImage_() {
  var files = [];
  var it = mediaFolder_('Blog_Covers').getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (/^image\//.test(f.getMimeType())) files.push(f);
  }
  if (!files.length) return null;
  var file = files[Math.floor(Math.random() * files.length)];
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* already shared or restricted domain */ }
  return { file: file, url: driveDirectUrl_(file.getId()) };
}

/* ───────────────────────────── WordPress REST API v2 ───────────────────────────── */

function wpConfig_() {
  var site = trimSlash_(getProp_('WP_SITE_URL', ''));
  var user = getProp_('WP_USERNAME', ''), pass = getProp_('WP_APP_PASSWORD', '');
  if (!site || !user || !pass) throw appError_(412, 'MISSING_API_KEY', 'WordPress site URL, username and application password are required');
  if (!/^https:\/\//i.test(site)) throw appError_(412, 'INSECURE_URL', 'WP_SITE_URL must start with https:// (Basic Auth must never travel over http)');
  return { api: site + '/wp-json/wp/v2', auth: 'Basic ' + Utilities.base64Encode(user + ':' + pass, Utilities.Charset.UTF_8) };
}

function wpRequest_(wp, method, path, body) {
  var opts = { method: method, headers: { Authorization: wp.auth } };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  return fetchJson_('TOGGLE_BLOG_CMS', 'WORDPRESS', wp.api + path, opts).json;
}

/** Finds a tag/category by exact name or creates it; returns the term id. */
function wpEnsureTerm_(wp, taxonomy, name) {
  var found = wpRequest_(wp, 'get', '/' + taxonomy + '?per_page=50&search=' + encodeURIComponent(name));
  for (var i = 0; i < (found || []).length; i++) {
    if (String(found[i].name).toLowerCase() === name.toLowerCase()) return found[i].id;
  }
  var res = guardedFetch_('TOGGLE_BLOG_CMS', 'WORDPRESS', wp.api + '/' + taxonomy, {
    method: 'post', contentType: 'application/json', headers: { Authorization: wp.auth }, payload: JSON.stringify({ name: name })
  });
  var json = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() < 300) return json.id;
  if (json.code === 'term_exists' && json.data && json.data.term_id) return json.data.term_id;
  throw appError_(502, 'UPSTREAM_ERROR', 'WordPress could not create ' + taxonomy + ' "' + name + '": ' + (json.message || res.getResponseCode()));
}

function wpUploadFeaturedImage_(wp, title) {
  var cover = pickCoverImage_();
  if (!cover) return 0;
  var blob = cover.file.getBlob();
  var res = fetchJson_('TOGGLE_BLOG_CMS', 'WORDPRESS', wp.api + '/media', {
    method: 'post', contentType: blob.getContentType(),
    headers: { Authorization: wp.auth, 'Content-Disposition': 'attachment; filename="' + cover.file.getName().replace(/[^\w.\-]/g, '_') + '"' },
    payload: blob.getBytes()
  });
  var mediaId = res.json.id;
  try { wpRequest_(wp, 'post', '/media/' + mediaId, { alt_text: title }); } catch (e) { /* alt text is optional */ }
  return mediaId;
}

/**
 * Creates (or, with existingId, updates) a post. Yoast / Rank Math fields are sent in `meta`;
 * WordPress only stores them when those meta keys are registered for REST (see README snippet).
 */
function wordpressPublish_(blog, live, item, existingId) {
  var wp = wpConfig_();
  var post = {
    title: blog.title,
    slug: blog.slug,
    status: live ? 'publish' : 'draft',
    excerpt: blog.excerpt,
    content: blog.html_body + (blog.faq_jsonld ? '\n<script type="application/ld+json">' + blog.faq_jsonld + '</script>' : ''),
    meta: {
      _yoast_wpseo_title: blog.title, _yoast_wpseo_metadesc: blog.meta_description, _yoast_wpseo_focuskw: blog.focus_keyword,
      rank_math_title: blog.title, rank_math_description: blog.meta_description, rank_math_focus_keyword: blog.focus_keyword
    }
  };
  if (!existingId) {
    post.tags = (blog.tags || []).map(function (t) { return wpEnsureTerm_(wp, 'tags', t); });
    if (item && item.pillar) post.categories = [wpEnsureTerm_(wp, 'categories', item.pillar)];
    var mediaId = 0;
    try { mediaId = wpUploadFeaturedImage_(wp, blog.title); }
    catch (e) { if (e.code === 'SYSTEM_HALTED' || e.code === 'TOOL_DISABLED') throw e; }
    if (mediaId) post.featured_media = mediaId;
  }
  var saved = wpRequest_(wp, 'post', '/posts' + (existingId ? '/' + existingId : ''), post);
  return { cms_id: String(saved.id), url: saved.link, status: saved.status };
}

function testWordPress_() {
  var wp = wpConfig_();
  var me = fetchJson_(null, 'WORDPRESS', wp.api + '/users/me?context=edit', { headers: { Authorization: wp.auth } }).json;
  var canPublish = me.capabilities && me.capabilities.publish_posts;
  return 'Authenticated as ' + me.name + (canPublish ? ' (can publish posts)' : ' — WARNING: this user cannot publish posts');
}

/* ───────────────────────────── Webflow CMS Data API v2 ───────────────────────────── */

function webflowConfig_() {
  var token = getProp_('WEBFLOW_API_TOKEN', ''), collection = getProp_('WEBFLOW_COLLECTION_ID', '');
  if (!token || !collection) throw appError_(412, 'MISSING_API_KEY', 'Webflow API token and collection ID are required');
  return { base: 'https://api.webflow.com/v2/collections/' + collection, headers: { Authorization: 'Bearer ' + token, accept: 'application/json' } };
}

function webflowRequest_(wf, method, path, body) {
  var opts = { method: method, headers: wf.headers };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  return fetchJson_('TOGGLE_BLOG_CMS', 'WEBFLOW', wf.base + path, opts).json;
}

function webflowFieldData_(blog) {
  var map = getConfig().webflow_field_map;
  var data = { name: blog.title, slug: blog.slug };
  data[map.body || 'post-body'] = blog.html_body;          // rich-text field (Webflow strips <script>; add FAQ JSON-LD in the template)
  data[map.summary || 'post-summary'] = blog.excerpt;
  data[map.seo_description || 'seo-description'] = blog.meta_description;
  if (map.focus_keyword) data[map.focus_keyword] = blog.focus_keyword;
  if (map.faq_schema && blog.faq_jsonld) data[map.faq_schema] = blog.faq_jsonld;
  return data;
}

function webflowLiveUrl_(slug) {
  var cfg = getConfig();
  var path = '/' + String(cfg.webflow_blog_path || '/blog/').replace(/^\/+|\/+$/g, '') + '/';
  return trimSlash_(getProp_('WEBFLOW_SITE_URL', APP.SITE)) + path.replace('//', '/') + slug;
}

function webflowPublish_(blog, live) {
  var wf = webflowConfig_();
  var item = webflowRequest_(wf, 'post', '/items', { isArchived: false, isDraft: !live, fieldData: webflowFieldData_(blog) });
  if (live) webflowRequest_(wf, 'post', '/items/publish', { itemIds: [item.id] });
  return { cms_id: item.id, url: webflowLiveUrl_(blog.slug), status: live ? 'publish' : 'draft' };
}

function webflowPromote_(itemId, blog) {
  var wf = webflowConfig_();
  webflowRequest_(wf, 'patch', '/items/' + itemId, { isArchived: false, isDraft: false, fieldData: webflowFieldData_(blog) });
  webflowRequest_(wf, 'post', '/items/publish', { itemIds: [itemId] });
  return { cms_id: itemId, url: webflowLiveUrl_(blog.slug), status: 'publish' };
}

function testWebflow_() {
  var wf = webflowConfig_();
  var col = fetchJson_(null, 'WEBFLOW', wf.base, { headers: wf.headers }).json;
  var slugs = (col.fields || []).map(function (f) { return f.slug; });
  var map = getConfig().webflow_field_map;
  var missing = [map.body, map.summary, map.seo_description].filter(function (s) { return slugs.indexOf(s) === -1; });
  return 'Collection "' + col.displayName + '" reachable.' + (missing.length ? ' WARNING: missing fields: ' + missing.join(', ') : ' All mapped fields exist.');
}

/* ───────────────────────────── Generic webhook ───────────────────────────── */

function webhookCmsPublish_(blog, live, item, existingId) {
  var url = getProp_('CMS_WEBHOOK_URL', '');
  if (!url) throw appError_(412, 'MISSING_API_KEY', 'CMS_WEBHOOK_URL is not configured');
  var res = fetchJson_('TOGGLE_BLOG_CMS', 'CMS_WEBHOOK', url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ event: 'blog.' + (live ? 'publish' : 'draft'), cms_id: existingId || null, status: live ? 'publish' : 'draft', site: APP.SITE, pillar: item && item.pillar, metro: item && item.metro, blog: blog })
  });
  var j = res.json || {};
  return { cms_id: String(j.id || existingId || blog.slug), url: j.url || (APP.SITE + '/blog/' + blog.slug), status: live ? 'publish' : 'draft' };
}

/* ───────────────────────────── Wix Blog (REST v3) ─────────────────────────────
 * Auth: an account API key (Wix dashboard → API Keys Manager) in the Authorization header,
 * plus the target site in the wix-site-id header.
 * Posts need an author: the site member whose login email is WIX_AUTHOR_EMAIL.
 * Article HTML is converted to Wix rich content (Ricos) by Wix's own converter.
 */

var WIX_API = 'https://www.wixapis.com';
var WIX_RICOS_PLUGINS = ['HEADING', 'LINK', 'DIVIDER', 'INDENT', 'LINE_SPACING'];

function wixConfig_() {
  var key = getProp_('WIX_API_KEY', ''), site = getProp_('WIX_SITE_ID', '');
  if (!key || !site) throw appError_(412, 'MISSING_API_KEY', 'Wix API key and site ID are required');
  return { headers: { Authorization: key, 'wix-site-id': site } };
}

/** toolKey undefined → TOGGLE_BLOG_CMS; null → only the kill switch is checked (connection test). */
function wixRequest_(wx, method, path, body, toolKey) {
  var opts = { method: method, headers: wx.headers };
  if (body !== undefined) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  return fetchJson_(toolKey === undefined ? 'TOGGLE_BLOG_CMS' : toolKey, 'WIX', WIX_API + path, opts).json || {};
}

/** Member ID of the blog author (looked up by login email once, then cached). */
function wixAuthor_(wx, toolKey) {
  var email = String(getProp_('WIX_AUTHOR_EMAIL', '')).trim().toLowerCase();
  if (!email) throw appError_(412, 'MISSING_API_KEY', 'Set the blog author\'s login email (WIX_AUTHOR_EMAIL)');
  var cache = getJsonProp_('WIX_AUTHOR_CACHE', {});
  if (cache.email === email && cache.id) return cache;
  var r = wixRequest_(wx, 'post', '/members/v1/members/query', { query: { filter: { loginEmail: email } }, fieldsets: ['FULL'] }, toolKey);
  var member = (r.members || [])[0] || null;
  // Newly created members can be missing from filtered queries for a while: scan the list as a fallback.
  for (var offset = 0; !member && offset < 1000; offset += 100) {
    var page = wixRequest_(wx, 'post', '/members/v1/members/query', { query: { paging: { limit: 100, offset: offset } }, fieldsets: ['FULL'] }, toolKey);
    (page.members || []).some(function (m) { if (String(m.loginEmail || '').toLowerCase() === email) { member = m; return true; } return false; });
    if (!page.members || page.members.length < 100) break;
  }
  if (!member) {
    throw appError_(412, 'WIX_AUTHOR_NOT_FOUND', 'No site member logs in with ' + email + '. Log in to nodetelehealth.com\'s Members Area once with that email (or pick an email that already has), then try again.');
  }
  var out = { email: email, id: member.id, name: (member.profile && member.profile.nickname) || email };
  setJsonProp_('WIX_AUTHOR_CACHE', out);
  return out;
}

/** Splits HTML at section boundaries into pieces under Wix's 10,000-character conversion limit. */
function splitHtml_(html, max) {
  var pieces = [];
  String(html).split(/(?=<h[23][\s>])/i).forEach(function (section) {
    if (section.length <= max) { pieces.push(section); return; }
    section.split(/(?<=<\/(?:p|ul|ol|blockquote|h3)>)/i).forEach(function (p) { pieces.push(p); });
  });
  var out = [], cur = '';
  pieces.forEach(function (p) {
    if (cur && cur.length + p.length > max) { out.push(cur); cur = ''; }
    cur += p;
  });
  if (cur) out.push(cur);
  return out.filter(function (s) { return s.trim(); });
}

function wixRichContent_(wx, html) {
  var nodes = [];
  splitHtml_(html, 9000).forEach(function (part) {
    var r = wixRequest_(wx, 'post', '/ricos/v1/ricos-document/convert/to-ricos', { html: part, options: { plugins: WIX_RICOS_PLUGINS } });
    nodes = nodes.concat((r.document && r.document.nodes) || []);
  });
  if (!nodes.length) throw appError_(502, 'UPSTREAM_ERROR', 'Wix returned empty rich content for this article');
  return { nodes: nodes };
}

function wixTagIds_(wx, labels) {
  var ids = [];
  (labels || []).slice(0, 30).forEach(function (label) {
    label = String(label).trim().slice(0, 50);
    if (!label) return;
    try {
      var r = wixRequest_(wx, 'post', '/blog/v3/tags', { label: label }); // returns the existing tag when the label exists
      if (r.tag && r.tag.id && ids.indexOf(r.tag.id) === -1) ids.push(r.tag.id);
    } catch (e) { if (e.code === 'SYSTEM_HALTED' || e.code === 'TOOL_DISABLED') throw e; }
  });
  return ids;
}

/** Category named after the content pillar; created once when missing (Create Category does not de-duplicate). */
function wixCategoryIds_(wx, label) {
  if (!label) return [];
  try {
    var list = wixRequest_(wx, 'get', '/blog/v3/categories');
    var match = (list.categories || []).filter(function (c) { return String(c.label).toLowerCase() === label.toLowerCase(); })[0];
    if (match) return [match.id];
    var made = wixRequest_(wx, 'post', '/blog/v3/categories', { category: { label: label } });
    return made.category && made.category.id ? [made.category.id] : [];
  } catch (e) {
    if (e.code === 'SYSTEM_HALTED' || e.code === 'TOOL_DISABLED') throw e;
    return [];
  }
}

/** Imports a random image from Drive/Blog_Covers into the Wix Media Manager; null when none or on failure. */
function wixCoverMedia_(wx, title) {
  try {
    var cover = pickCoverImage_();
    if (!cover) return null;
    var r = wixRequest_(wx, 'post', '/site-media/v1/files/import', { url: cover.url, mediaType: 'IMAGE', displayName: cover.file.getName() });
    if (!r.file || !r.file.id) return null;
    return { wixMedia: { image: { id: r.file.id } }, displayed: true, custom: true, altText: String(title).slice(0, 1000) };
  } catch (e) {
    if (e.code === 'SYSTEM_HALTED' || e.code === 'TOOL_DISABLED') throw e;
    return null;
  }
}

function wixSeoData_(blog) {
  var tags = [
    { type: 'title', children: blog.title },
    { type: 'meta', props: { name: 'description', content: blog.meta_description } }
  ];
  if (blog.faq_jsonld) tags.push({ type: 'script', props: { type: 'application/ld+json' }, children: blog.faq_jsonld });
  return { tags: tags, settings: { keywords: [{ term: blog.focus_keyword, isMain: true }] } };
}

function wixDraftFields_(wx, blog, author) {
  return {
    title: String(blog.title).slice(0, 200),
    memberId: author.id,
    excerpt: String(blog.excerpt || '').slice(0, 500),
    seoSlug: String(blog.slug || '').slice(0, 100),
    richContent: wixRichContent_(wx, blog.html_body),
    seoData: wixSeoData_(blog)
  };
}

/** Sends the request; if Wix rejects the SEO block, retries once without it so the post still goes out. */
function wixWithSeoFallback_(send, draft) {
  try { return send(draft); }
  catch (e) {
    if (e.code !== 'UPSTREAM_ERROR' || !/seo/i.test(e.message)) throw e;
    delete draft.seoData;
    return send(draft);
  }
}

function wixLiveUrl_(wx, postId, slug) {
  try {
    var r = wixRequest_(wx, 'get', '/blog/v3/posts/' + encodeURIComponent(postId) + '?fieldsets=URL');
    if (r.post && r.post.url && r.post.url.base) return trimSlash_(r.post.url.base) + (r.post.url.path || '');
  } catch (e) { if (e.code === 'SYSTEM_HALTED' || e.code === 'TOOL_DISABLED') throw e; }
  return APP.SITE + '/post/' + slug;
}

function wixPublish_(blog, live, item) {
  var wx = wixConfig_();
  var author = wixAuthor_(wx);
  var draft = wixDraftFields_(wx, blog, author);
  draft.tagIds = wixTagIds_(wx, blog.tags);
  draft.categoryIds = wixCategoryIds_(wx, item && item.pillar);
  var media = wixCoverMedia_(wx, blog.title);
  if (media) draft.media = media;
  var res = wixWithSeoFallback_(function (d) {
    return wixRequest_(wx, 'post', '/blog/v3/draft-posts', { draftPost: d, publish: !!live, fieldsets: ['URL'] });
  }, draft);
  var id = res.draftPost && res.draftPost.id;
  if (!id) throw appError_(502, 'UPSTREAM_ERROR', 'Wix did not return a post id');
  if (live) return { cms_id: id, url: wixLiveUrl_(wx, id, blog.slug), status: 'publish' };
  var preview = res.draftPost.url && res.draftPost.url.base ? trimSlash_(res.draftPost.url.base) + (res.draftPost.url.path || '') : '';
  return { cms_id: id, url: preview, status: 'draft' };
}

/** Saves the latest (possibly edited) content into the Wix draft, then publishes it. */
function wixPromote_(postId, blog) {
  var wx = wixConfig_();
  var author = wixAuthor_(wx);
  var draft = wixDraftFields_(wx, blog, author);
  draft.id = postId;
  wixWithSeoFallback_(function (d) {
    return wixRequest_(wx, 'patch', '/blog/v3/draft-posts/' + encodeURIComponent(postId), { draftPost: d });
  }, draft);
  wixRequest_(wx, 'post', '/blog/v3/draft-posts/' + encodeURIComponent(postId) + '/publish', {});
  return { cms_id: postId, url: wixLiveUrl_(wx, postId, blog.slug), status: 'publish' };
}

function testWix_() {
  var wx = wixConfig_();
  var author = wixAuthor_(wx, null);
  var cats = wixRequest_(wx, 'get', '/blog/v3/categories', undefined, null);
  return 'Connected to Wix Blog. Posts will be written by "' + author.name + '". ' + (cats.categories || []).length + ' existing blog categor' + ((cats.categories || []).length === 1 ? 'y.' : 'ies.');
}
