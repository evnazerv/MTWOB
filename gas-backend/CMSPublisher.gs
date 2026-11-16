/**
 * CMSPublisher.gs — Blog publishing adapters.
 *   CMS_PROVIDER = WORDPRESS → WordPress REST API v2 (Basic Auth with an Application Password)
 *                  WEBFLOW   → Webflow CMS Data API v2 (Bearer token)
 *                  WEBHOOK   → generic JSON webhook (Make.com / Zapier / custom CMS)
 * Every adapter returns { cms_id, url, status } and supports draft and live publishing.
 */

function cmsPublish_(blog, live, item) {
  requireTool_('TOGGLE_BLOG_CMS');
  var provider = getConfig().cms_provider;
  var res = provider === 'WEBFLOW' ? webflowPublish_(blog, live)
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
  var res = provider === 'WEBFLOW' ? webflowPromote_(cmsId, blog)
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
