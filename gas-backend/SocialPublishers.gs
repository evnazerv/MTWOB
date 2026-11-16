/**
 * SocialPublishers.gs — Native API connectors with a Buffer / Make.com webhook fallback.
 *   Facebook Page (Graph API) · Instagram Reels (Graph API) · X API v2 (OAuth 1.0a user context)
 *   LinkedIn Posts API · YouTube Data API v3 (Shorts) · TikTok Content Posting API
 *   Google Business Profile local posts.
 * Each connector checks the kill switch and its own toggle on its first line and again inside
 * guardedFetch_ before every request. All return { external_id, url }.
 */

var META_GRAPH = 'https://graph.facebook.com/v24.0';

/**
 * @param {string} platform FACEBOOK | INSTAGRAM | X_TWITTER | LINKEDIN | YOUTUBE_SHORTS | TIKTOK | GOOGLE_BUSINESS
 * @param {Object} post { text, thread, link, title, caption, image_url, video_url, video_file_id, provider_video_url }
 */
function publishSocial_(platform, post, item) {
  var toolKey = platformToggle_(platform);
  requireTool_(toolKey);
  var native = {
    FACEBOOK: [publishFacebook_, ['META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN']],
    INSTAGRAM: [publishInstagram_, ['IG_USER_ID', 'META_PAGE_ACCESS_TOKEN']],
    X_TWITTER: [publishX_, ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET']],
    LINKEDIN: [publishLinkedIn_, ['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_ORG_ID']],
    YOUTUBE_SHORTS: [publishYouTubeShort_, []],
    TIKTOK: [publishTikTok_, ['TIKTOK_ACCESS_TOKEN']],
    GOOGLE_BUSINESS: [publishGoogleBusiness_, ['GBP_ACCOUNT_ID', 'GBP_LOCATION_ID']]
  }[platform];
  if (!native) throw appError_(400, 'BAD_REQUEST', 'Unknown platform ' + platform);
  var hasCreds = native[1].every(function (k) { return !!getProp_(k, ''); });
  var res, service = platform;
  try {
    if (hasCreds) {
      res = native[0](post, toolKey, item);
    } else if (getProp_('SOCIAL_WEBHOOK_URL', '')) {
      service = 'SOCIAL_WEBHOOK';
      res = publishViaWebhook_(platform, post, toolKey, item);
    } else {
      throw appError_(412, 'MISSING_API_KEY', platform + ' credentials are missing and no SOCIAL_WEBHOOK_URL fallback is set');
    }
  } catch (err) {
    if (['SYSTEM_HALTED', 'TOOL_DISABLED', 'RETRY_LATER'].indexOf(err.code) === -1) {
      logCost_({ service: service, tool_key: toolKey, operation: 'publish', ok: false, queue_id: item && item.id, detail: err.message });
    }
    throw err;
  }
  logCost_({ service: service, tool_key: toolKey, operation: 'publish', units: 1, unit_type: 'posts', est_cost_usd: 0, ok: true, queue_id: item && item.id });
  recordToolRun_(toolKey, 1, 'posts', 0);
  return res;
}

function formPost_(toolKey, service, url, params) {
  return fetchJson_(toolKey, service, url, { method: 'post', payload: params }).json; // object payload → form-encoded
}

/* ───────────────────────────── Buffer / Make.com fallback ───────────────────────────── */

function publishViaWebhook_(platform, post, toolKey, item) {
  var res = fetchJson_(toolKey, 'SOCIAL_WEBHOOK', getProp_('SOCIAL_WEBHOOK_URL', ''), {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({
      event: 'social.publish', platform: platform, queue_id: item && item.id,
      text: post.text || post.caption || '', thread: post.thread || null, title: post.title || '',
      link: post.link || '', image_url: post.image_url || '', video_url: post.video_url || ''
    })
  });
  var j = res.json || {};
  return { external_id: String(j.id || ''), url: j.url || '' };
}

/* ───────────────────────────── Facebook Page ───────────────────────────── */

function publishFacebook_(post, toolKey) {
  assertSystemActive();
  var page = getProp_('META_PAGE_ID', ''), token = getProp_('META_PAGE_ACCESS_TOKEN', '');
  var params = { message: post.text, access_token: token };
  if (post.link) params.link = post.link;
  var r = formPost_(toolKey, 'FACEBOOK', META_GRAPH + '/' + page + '/feed', params);
  return { external_id: r.id, url: 'https://www.facebook.com/' + r.id };
}

/* ───────────────────────────── Instagram Reels ───────────────────────────── */

/**
 * Container → poll → publish. Instagram fetches the MP4 from a public URL: the render
 * provider's CDN URL while fresh, otherwise the public Drive link. If Meta is still
 * processing after ~75 s the container id is cached and the publish cron retries.
 */
function publishInstagram_(post, toolKey, item) {
  assertSystemActive();
  var ig = getProp_('IG_USER_ID', ''), token = getProp_('META_PAGE_ACCESS_TOKEN', '');
  var cache = CacheService.getScriptCache();
  var cacheKey = 'ig_container_' + (item ? item.id : '');
  var container = cache.get(cacheKey);
  if (!container) {
    var params = { access_token: token, caption: post.caption || post.text || '' };
    if (post.video_url) {
      var freshProvider = post.provider_video_url && item && item.payload && item.payload.provider_video_at &&
        Date.now() - new Date(item.payload.provider_video_at).getTime() < 3 * 864e5;
      params.media_type = 'REELS';
      params.video_url = freshProvider ? post.provider_video_url : post.video_url;
      params.share_to_feed = 'true';
    } else if (post.image_url) {
      params.image_url = post.image_url;
    } else {
      throw appError_(412, 'NO_MEDIA', 'Instagram requires a video or image; text-only posts are not supported');
    }
    container = formPost_(toolKey, 'INSTAGRAM', META_GRAPH + '/' + ig + '/media', params).id;
    cache.put(cacheKey, container, 3600);
  }
  var status = '';
  for (var i = 0; i < 15; i++) {
    status = fetchJson_(toolKey, 'INSTAGRAM', META_GRAPH + '/' + container + '?fields=status_code,status&access_token=' + encodeURIComponent(token), {}).json.status_code;
    if (status === 'FINISHED' || status === 'ERROR' || status === 'EXPIRED') break;
    Utilities.sleep(5000);
  }
  if (status === 'ERROR' || status === 'EXPIRED') {
    cache.remove(cacheKey);
    throw appError_(502, 'UPSTREAM_ERROR', 'Instagram could not process the media (' + status + '). Check that the MP4 is 9:16, H.264/AAC and publicly reachable.');
  }
  if (status !== 'FINISHED') throw appError_(409, 'RETRY_LATER', 'Instagram is still processing the video');
  var pub = formPost_(toolKey, 'INSTAGRAM', META_GRAPH + '/' + ig + '/media_publish', { creation_id: container, access_token: token });
  cache.remove(cacheKey);
  var link = '';
  try { link = fetchJson_(toolKey, 'INSTAGRAM', META_GRAPH + '/' + pub.id + '?fields=permalink&access_token=' + encodeURIComponent(token), {}).json.permalink; } catch (e) { link = ''; }
  return { external_id: pub.id, url: link || 'https://www.instagram.com/' };
}

function testMeta_() {
  var page = getProp_('META_PAGE_ID', ''), token = getProp_('META_PAGE_ACCESS_TOKEN', '');
  if (!page || !token) throw appError_(412, 'MISSING_API_KEY', 'META_PAGE_ID and META_PAGE_ACCESS_TOKEN are required');
  var p = fetchJson_(null, 'FACEBOOK', META_GRAPH + '/' + page + '?fields=name,instagram_business_account&access_token=' + encodeURIComponent(token), {}).json;
  return 'Page "' + p.name + '" reachable.' + (p.instagram_business_account ? ' Linked Instagram account ID: ' + p.instagram_business_account.id : ' No Instagram business account is linked to this Page.');
}

/* ───────────────────────────── X / Twitter API v2 ───────────────────────────── */

function pctEncode_(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); });
}

/** OAuth 1.0a (HMAC-SHA1) user-context header. JSON bodies are not part of the signature base. */
function xOAuthHeader_(method, url, query) {
  var oauth = {
    oauth_consumer_key: getProp_('X_API_KEY', ''),
    oauth_nonce: Utilities.getUuid().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: getProp_('X_ACCESS_TOKEN', ''),
    oauth_version: '1.0'
  };
  var all = {};
  Object.keys(oauth).forEach(function (k) { all[k] = oauth[k]; });
  Object.keys(query || {}).forEach(function (k) { all[k] = query[k]; });
  var paramString = Object.keys(all).sort().map(function (k) { return pctEncode_(k) + '=' + pctEncode_(all[k]); }).join('&');
  var base = method.toUpperCase() + '&' + pctEncode_(url) + '&' + pctEncode_(paramString);
  var signingKey = pctEncode_(getProp_('X_API_SECRET', '')) + '&' + pctEncode_(getProp_('X_ACCESS_SECRET', ''));
  oauth.oauth_signature = Utilities.base64Encode(Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, base, signingKey));
  return 'OAuth ' + Object.keys(oauth).sort().map(function (k) { return pctEncode_(k) + '="' + pctEncode_(oauth[k]) + '"'; }).join(', ');
}

function publishX_(post, toolKey) {
  assertSystemActive();
  var url = 'https://api.x.com/2/tweets';
  var parts = (post.thread && post.thread.length) ? post.thread.slice() : [post.text];
  if (post.link) {
    var last = parts.length - 1;
    parts[last] = String(parts[last]).slice(0, 280 - 24) + ' ' + post.link; // links count as 23 characters
  }
  var firstId = '', replyTo = '';
  parts.forEach(function (text) {
    var body = { text: text };
    if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
    var r = fetchJson_(toolKey, 'X_TWITTER', url, {
      method: 'post', contentType: 'application/json', headers: { Authorization: xOAuthHeader_('POST', url, null) }, payload: JSON.stringify(body)
    }).json;
    replyTo = r.data.id;
    if (!firstId) firstId = r.data.id;
  });
  return { external_id: firstId, url: 'https://x.com/i/web/status/' + firstId };
}

function testX_() {
  var url = 'https://api.x.com/2/users/me';
  var me = fetchJson_(null, 'X_TWITTER', url, { headers: { Authorization: xOAuthHeader_('GET', url, null) } }).json;
  return 'Authenticated as @' + me.data.username;
}

/* ───────────────────────────── LinkedIn ───────────────────────────── */

function linkedInVersion_() {
  var d = new Date();
  d.setMonth(d.getMonth() - 2); // a version that is certainly released and still supported
  return getProp_('LINKEDIN_API_VERSION', Utilities.formatDate(d, 'UTC', 'yyyyMM'));
}

function linkedInHeaders_() {
  return { Authorization: 'Bearer ' + getProp_('LINKEDIN_ACCESS_TOKEN', ''), 'LinkedIn-Version': linkedInVersion_(), 'X-Restli-Protocol-Version': '2.0.0' };
}

function publishLinkedIn_(post, toolKey) {
  assertSystemActive();
  var body = {
    author: 'urn:li:organization:' + getProp_('LINKEDIN_ORG_ID', ''),
    commentary: post.text,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false
  };
  if (post.link) body.content = { article: { source: post.link, title: post.title || 'NodeTelehealth — Florida telehealth', description: String(post.text).slice(0, 200) } };
  var r = fetchJson_(toolKey, 'LINKEDIN', 'https://api.linkedin.com/rest/posts', {
    method: 'post', contentType: 'application/json', headers: linkedInHeaders_(), payload: JSON.stringify(body)
  });
  var urn = header_(r.headers, 'x-restli-id') || (r.json && r.json.id) || '';
  return { external_id: urn, url: urn ? 'https://www.linkedin.com/feed/update/' + urn : '' };
}

/* ───────────────────────────── YouTube Shorts ───────────────────────────── */

/** Uses YT_REFRESH_TOKEN when configured (brand channels); otherwise the script owner's own channel. */
function youtubeAccessToken_(toolKey) {
  var refresh = getProp_('YT_REFRESH_TOKEN', '');
  if (!refresh) return ScriptApp.getOAuthToken();
  var r = formPost_(toolKey, 'YOUTUBE', 'https://oauth2.googleapis.com/token', {
    client_id: getProp_('YT_CLIENT_ID', ''), client_secret: getProp_('YT_CLIENT_SECRET', ''), refresh_token: refresh, grant_type: 'refresh_token'
  });
  return r.access_token;
}

function publishYouTubeShort_(post, toolKey) {
  assertSystemActive();
  if (!post.video_file_id) throw appError_(412, 'NO_MEDIA', 'YouTube Shorts requires a rendered video');
  var token = youtubeAccessToken_(toolKey);
  var blob = DriveApp.getFileById(post.video_file_id).getBlob();
  var title = String(post.title || 'NodeTelehealth').slice(0, 90) + ' #Shorts';
  var init = guardedFetch_(toolKey, 'YOUTUBE', 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'post', contentType: 'application/json; charset=UTF-8',
    headers: { Authorization: 'Bearer ' + token, 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(blob.getBytes().length) },
    payload: JSON.stringify({
      snippet: { title: title, description: (post.caption || '') + '\n\nFlorida telehealth with Florida-licensed providers: https://nodetelehealth.com\nGeneral information only, not medical advice. In an emergency call 911.', categoryId: '26' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    })
  });
  if (init.getResponseCode() >= 400) throw appError_(502, 'UPSTREAM_ERROR', 'YouTube upload init HTTP ' + init.getResponseCode() + ': ' + init.getContentText().slice(0, 300));
  var uploadUrl = header_(init.getHeaders(), 'Location');
  var done = fetchJson_(toolKey, 'YOUTUBE', uploadUrl, { method: 'put', contentType: 'video/mp4', headers: { Authorization: 'Bearer ' + token }, payload: blob.getBytes() }).json;
  return { external_id: done.id, url: 'https://www.youtube.com/shorts/' + done.id };
}

function testYouTube_() {
  var token = youtubeAccessToken_(null);
  var r = fetchJson_(null, 'YOUTUBE', 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + token } }).json;
  if (!r.items || !r.items.length) throw appError_(412, 'NO_CHANNEL', 'This Google account has no YouTube channel');
  return 'Uploads will go to channel "' + r.items[0].snippet.title + '"';
}

/* ───────────────────────────── TikTok Content Posting API ───────────────────────────── */

/** TikTok access tokens last 24 h; refresh when a refresh token + client credentials are configured. */
function tiktokAccessToken_(toolKey) {
  var refresh = getProp_('TIKTOK_REFRESH_TOKEN', ''), clientKey = getProp_('TIKTOK_CLIENT_KEY', ''), secret = getProp_('TIKTOK_CLIENT_SECRET', '');
  var expires = num_(getProp_('TIKTOK_TOKEN_EXPIRES_AT', '0'));
  if (refresh && clientKey && secret && Date.now() > expires - 10 * 60e3) {
    var r = formPost_(toolKey, 'TIKTOK', 'https://open.tiktokapis.com/v2/oauth/token/', { client_key: clientKey, client_secret: secret, grant_type: 'refresh_token', refresh_token: refresh });
    if (r.access_token) {
      setProp_('TIKTOK_ACCESS_TOKEN', r.access_token);
      if (r.refresh_token) setProp_('TIKTOK_REFRESH_TOKEN', r.refresh_token);
      setProp_('TIKTOK_TOKEN_EXPIRES_AT', String(Date.now() + num_(r.expires_in) * 1000));
    }
  }
  return getProp_('TIKTOK_ACCESS_TOKEN', '');
}

/** Direct Post with FILE_UPLOAD (Drive URLs cannot pass TikTok's PULL_FROM_URL domain verification). */
function publishTikTok_(post, toolKey) {
  assertSystemActive();
  if (!post.video_file_id) throw appError_(412, 'NO_MEDIA', 'TikTok requires a rendered video');
  var token = tiktokAccessToken_(toolKey);
  var bytes = DriveApp.getFileById(post.video_file_id).getBlob().getBytes();
  var size = bytes.length;
  if (size > 64 * 1024 * 1024) throw appError_(413, 'TOO_LARGE', 'Video exceeds the 64 MB single-chunk TikTok upload limit');
  var init = fetchJson_(toolKey, 'TIKTOK', 'https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'post', contentType: 'application/json; charset=UTF-8', headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      // Unaudited TikTok apps may only post SELF_ONLY; set TIKTOK_PRIVACY_LEVEL=PUBLIC_TO_EVERYONE after your app audit.
      post_info: { title: String(post.caption || post.title || '').slice(0, 2100), privacy_level: getProp_('TIKTOK_PRIVACY_LEVEL', 'SELF_ONLY'), disable_duet: false, disable_comment: false, disable_stitch: false },
      source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 }
    })
  }).json;
  if (!init.data || !init.data.upload_url) throw appError_(502, 'UPSTREAM_ERROR', 'TikTok init failed: ' + JSON.stringify(init.error || init).slice(0, 300));
  var up = guardedFetch_(toolKey, 'TIKTOK', init.data.upload_url, {
    method: 'put', contentType: 'video/mp4', headers: { 'Content-Range': 'bytes 0-' + (size - 1) + '/' + size }, payload: bytes
  });
  if (up.getResponseCode() >= 400) throw appError_(502, 'UPSTREAM_ERROR', 'TikTok upload HTTP ' + up.getResponseCode());
  return { external_id: init.data.publish_id, url: 'https://www.tiktok.com/' };
}

/* ───────────────────────────── Google Business Profile ───────────────────────────── */

/** Local post with a LEARN_MORE button. Uses the script owner's Google account (business.manage scope). */
function publishGoogleBusiness_(post, toolKey) {
  assertSystemActive();
  var body = { languageCode: 'en-US', topicType: 'STANDARD', summary: String(post.text).slice(0, 1450) };
  if (post.link) body.callToAction = { actionType: 'LEARN_MORE', url: post.link };
  if (post.image_url) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: post.image_url }];
  var r = fetchJson_(toolKey, 'GOOGLE_BUSINESS',
    'https://mybusiness.googleapis.com/v4/accounts/' + getProp_('GBP_ACCOUNT_ID', '') + '/locations/' + getProp_('GBP_LOCATION_ID', '') + '/localPosts', {
      method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, payload: JSON.stringify(body)
    }).json;
  return { external_id: r.name || '', url: r.searchUrl || '' };
}
