/**
 * VideoPipeline.gs — Voiceover + video production.
 *   ElevenLabs TTS  → MP3 saved to Drive (NodeTelehealth_Media_Assets/Voiceovers)
 *   Mode A  HEYGEN_AVATAR   → HeyGen v2 talking-head avatar, 9:16, burned-in captions
 *   Mode B  FACELESS_BROLL  → Creatomate (or JSON2Video): stock b-roll + voiceover + word-by-word captions
 *   Async pattern: submit (POST) → Video_Render_Jobs row RENDERING → 5-minute trigger polls (GET)
 *                  → MP4 downloaded to Drive/Videos → Content_Queue row READY_TO_PUBLISH.
 */

var VIDEO_BRAND_COLOR = '#0E3A53';

function cronPollVideoRenders() {
  assertSystemActive();
  return runCron_('cronPollVideoRenders', 'TOGGLE_VIDEO_RENDER', runVideoPoll_);
}

/* ───────────────────────────── ElevenLabs TTS ───────────────────────────── */

function synthesizeVoiceover_(item, narration) {
  requireTool_('TOGGLE_ELEVENLABS_VOICE');
  var key = getProp_('ELEVENLABS_API_KEY', ''), voice = getProp_('ELEVENLABS_VOICE_ID', '');
  if (!key || !voice) throw appError_(412, 'MISSING_API_KEY', 'ElevenLabs API key and voice ID are required');
  var cfg = getConfig();
  var res = guardedFetch_('TOGGLE_ELEVENLABS_VOICE', 'ELEVENLABS',
    'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voice) + '?output_format=mp3_44100_128', {
      method: 'post', contentType: 'application/json',
      headers: { 'xi-api-key': key, Accept: 'audio/mpeg' },
      payload: JSON.stringify({ text: narration, model_id: cfg.elevenlabs_model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
    });
  var chars = narration.length;
  var cost = chars / 1000 * num_(cfg.cost.elevenlabs_per_1k_chars);
  if (res.getResponseCode() >= 400) {
    logCost_({ service: 'ELEVENLABS', tool_key: 'TOGGLE_ELEVENLABS_VOICE', operation: 'tts', ok: false, queue_id: item.id, detail: 'HTTP ' + res.getResponseCode() });
    throw appError_(502, 'UPSTREAM_ERROR', 'ElevenLabs HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  var blob = res.getBlob().setContentType('audio/mpeg');
  var saved = saveMediaToDrive_(blob, 'voiceover_' + item.id + '.mp3', 'Voiceovers');
  logCost_({ service: 'ELEVENLABS', tool_key: 'TOGGLE_ELEVENLABS_VOICE', operation: 'tts', units: chars, unit_type: 'characters', est_cost_usd: cost, ok: true, queue_id: item.id, detail: cfg.elevenlabs_model });
  recordToolRun_('TOGGLE_ELEVENLABS_VOICE', chars, 'characters', cost);
  // mp3_44100_128 is constant 128 kbps → 16,000 bytes per second.
  return { fileId: saved.fileId, url: saved.url, chars: chars, duration: Math.max(5, Math.round(saved.size / 16000)), blob: blob };
}

function testElevenLabs_() {
  var key = getProp_('ELEVENLABS_API_KEY', ''), voice = getProp_('ELEVENLABS_VOICE_ID', '');
  if (!key || !voice) throw appError_(412, 'MISSING_API_KEY', 'ElevenLabs API key and voice ID are required');
  var v = fetchJson_(null, 'ELEVENLABS', 'https://api.elevenlabs.io/v1/voices/' + encodeURIComponent(voice), { headers: { 'xi-api-key': key } }).json;
  return 'Voice "' + v.name + '" is available. Model: ' + getConfig().elevenlabs_model;
}

/* ───────────────────────────── Production entry point ───────────────────────────── */

/**
 * Voice + render submission for one VIDEO queue item. This is where media credits are spent,
 * so it requires TOGGLE_VIDEO_RENDER (and TOGGLE_ELEVENLABS_VOICE for the faceless mode).
 */
function startVideoProduction_(queueId) {
  assertSystemActive();
  var cfg = getConfig();
  if (cfg.video_mode === 'SCRIPT_ONLY') return null;
  requireTool_('TOGGLE_VIDEO_RENDER');
  if (cfg.video_mode === 'FACELESS_BROLL') requireTool_('TOGGLE_ELEVENLABS_VOICE');
  var item = loadItem_(queueId);
  var script = item.payload;
  if (!script.narration) throw appError_(400, 'BAD_REQUEST', 'Item has no narration script');
  try {
    var audio = null;
    if (isToolEnabled('TOGGLE_ELEVENLABS_VOICE')) {
      if (item.audio_file_id && script.voiced_narration === script.narration) {
        audio = { fileId: item.audio_file_id, url: item.audio_url, duration: script.audio_duration || script.est_duration_sec, blob: null }; // reuse → no new TTS spend
      } else {
        audio = synthesizeVoiceover_(item, script.narration);
        script.voiced_narration = script.narration;
        script.audio_duration = audio.duration;
      }
    }
    var hook = item.hook_variant === 'B' ? script.hook_b : script.hook_a;
    var job = cfg.video_mode === 'HEYGEN_AVATAR'
      ? heygenSubmit_(item, script, audio)
      : (cfg.faceless_provider === 'JSON2VIDEO' ? json2videoSubmit_(item, script, audio, hook) : creatomateSubmit_(item, script, audio, hook));
    dbAppend_(TABS.VIDEO_JOBS, { id: uid_('job'), queue_id: item.id, provider: job.provider, job_id: job.job_id, status: 'RENDERING', submitted_at: nowIso_(), updated_at: nowIso_(), attempts: 0 });
    dbUpdate_(TABS.QUEUE, item.id, {
      status: 'RENDERING', audio_file_id: audio ? audio.fileId : '', audio_url: audio ? audio.url : '',
      payload_json: packPayload_(script), error: ''
    });
    logEvent_('RENDERING', 'Video render submitted (' + job.provider + ')', item.title, item.id);
    return job;
  } catch (err) {
    if (err.code !== 'SYSTEM_HALTED' && err.code !== 'TOOL_DISABLED') {
      dbUpdate_(TABS.QUEUE, item.id, { status: 'FAILED', error: err.message });
      logEvent_('ERROR', 'Video production failed', err.message, item.id);
    }
    throw err;
  }
}

/* ───────────────────────────── Mode A: HeyGen avatar ───────────────────────────── */

function heygenSubmit_(item, script, audio) {
  var key = getProp_('HEYGEN_API_KEY', ''), avatar = getProp_('HEYGEN_AVATAR_ID', '');
  if (!key || !avatar) throw appError_(412, 'MISSING_API_KEY', 'HeyGen API key and avatar ID are required');
  var voice;
  if (audio) {
    // Prefer uploading the MP3 as a HeyGen asset; fall back to the public Drive URL.
    voice = { type: 'audio', audio_url: audio.url };
    if (audio.blob) {
      try {
        var up = fetchJson_('TOGGLE_VIDEO_RENDER', 'HEYGEN', 'https://upload.heygen.com/v1/asset', {
          method: 'post', contentType: 'audio/mpeg', headers: { 'X-Api-Key': key }, payload: audio.blob.getBytes()
        }).json;
        if (up && up.data && up.data.id) voice = { type: 'audio', audio_asset_id: up.data.id };
      } catch (e) { if (e.code === 'SYSTEM_HALTED' || e.code === 'TOOL_DISABLED') throw e; }
    }
  } else {
    var voiceId = getProp_('HEYGEN_VOICE_ID', '');
    if (!voiceId) throw appError_(412, 'MISSING_API_KEY', 'Enable ElevenLabs voice or set HEYGEN_VOICE_ID for HeyGen\'s built-in voices');
    voice = { type: 'text', input_text: script.narration, voice_id: voiceId };
  }
  var res = fetchJson_('TOGGLE_VIDEO_RENDER', 'HEYGEN', 'https://api.heygen.com/v2/video/generate', {
    method: 'post', contentType: 'application/json', headers: { 'X-Api-Key': key },
    payload: JSON.stringify({
      title: script.title, caption: true, dimension: { width: 720, height: 1280 },
      video_inputs: [{ character: { type: 'avatar', avatar_id: avatar, avatar_style: 'normal' }, voice: voice, background: { type: 'color', value: VIDEO_BRAND_COLOR } }]
    })
  }).json;
  if (res.error || !res.data || !res.data.video_id) throw appError_(502, 'UPSTREAM_ERROR', 'HeyGen rejected the job: ' + JSON.stringify(res.error || res).slice(0, 300));
  return { provider: 'HEYGEN', job_id: res.data.video_id };
}

function heygenStatus_(jobId) {
  var d = fetchJson_('TOGGLE_VIDEO_RENDER', 'HEYGEN', 'https://api.heygen.com/v1/video_status.get?video_id=' + encodeURIComponent(jobId), {
    headers: { 'X-Api-Key': getProp_('HEYGEN_API_KEY', '') }
  }).json.data || {};
  if (d.status === 'completed') return { state: 'DONE', url: d.video_url_caption || d.video_url, duration: num_(d.duration) };
  if (d.status === 'failed') return { state: 'FAILED', error: JSON.stringify(d.error || 'render failed').slice(0, 300) };
  return { state: 'RENDERING' };
}

function testHeyGen_() {
  var key = getProp_('HEYGEN_API_KEY', '');
  if (!key) throw appError_(412, 'MISSING_API_KEY', 'HEYGEN_API_KEY is not configured');
  var q = fetchJson_(null, 'HEYGEN', 'https://api.heygen.com/v2/user/remaining_quota', { headers: { 'X-Api-Key': key } }).json;
  return 'Key accepted. Remaining quota: ' + JSON.stringify((q.data && q.data.remaining_quota) !== undefined ? q.data.remaining_quota : q.data);
}

/* ───────────────────────────── Mode B: faceless b-roll ───────────────────────────── */

/** One portrait stock clip per scene: Pexels search first, then random files from Drive/Broll. */
function findBrollClips_(script) {
  var scenes = script.scenes || [];
  var pexels = getProp_('PEXELS_API_KEY', '');
  var local = [];
  var it = mediaFolder_('Broll').getFiles();
  while (it.hasNext()) { var f = it.next(); if (/^video\//.test(f.getMimeType())) local.push(f); }
  var used = {};
  var clips = scenes.map(function (scene) {
    var url = '';
    if (pexels) {
      try {
        var r = fetchJson_('TOGGLE_VIDEO_RENDER', 'PEXELS', 'https://api.pexels.com/videos/search?orientation=portrait&size=medium&per_page=5&query=' + encodeURIComponent(scene.broll_search || 'florida lifestyle'), { headers: { Authorization: pexels } }).json;
        (r.videos || []).some(function (v) {
          if (used[v.id]) return false;
          var files = (v.video_files || []).filter(function (vf) { return vf.file_type === 'video/mp4' && vf.height >= 1280 && vf.height > vf.width; })
            .sort(function (a, b) { return a.height - b.height; });
          if (!files.length) return false;
          used[v.id] = 1; url = files[0].link; return true;
        });
      } catch (e) { if (e.code === 'SYSTEM_HALTED' || e.code === 'TOOL_DISABLED') throw e; }
    }
    if (!url && local.length) {
      var file = local[Math.floor(Math.random() * local.length)];
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e2) { /* keep existing sharing */ }
      url = driveDirectUrl_(file.getId());
    }
    return { url: url, seconds: Math.max(3, num_(scene.seconds) || 5), caption: scene.on_screen_caption };
  }).filter(function (c) { return c.url; });
  if (!clips.length) throw appError_(412, 'NO_BROLL', 'No b-roll available: add a PEXELS_API_KEY or upload vertical clips to Drive → NodeTelehealth_Media_Assets/Broll');
  return clips;
}

/** Stretches/shrinks scene lengths so the b-roll track matches the real voiceover length. */
function fitClipsToAudio_(clips, audioSeconds) {
  var total = clips.reduce(function (s, c) { return s + c.seconds; }, 0);
  var scale = (audioSeconds + 0.8) / total;
  return clips.map(function (c) { return { url: c.url, caption: c.caption, seconds: Math.round(c.seconds * scale * 10) / 10 }; });
}

function creatomateSubmit_(item, script, audio, hook) {
  var key = getProp_('CREATOMATE_API_KEY', '');
  if (!key) throw appError_(412, 'MISSING_API_KEY', 'CREATOMATE_API_KEY is not configured');
  var clips = fitClipsToAudio_(findBrollClips_(script), audio.duration);
  var template = getProp_('CREATOMATE_TEMPLATE_ID', '');
  var body;
  if (template) {
    // Template mode: elements named Voiceover, Hook, CTA and Background-1…N in your Creatomate template.
    var mods = { 'Voiceover.source': audio.url, 'Hook.text': hook, 'CTA.text': 'nodetelehealth.com' };
    clips.forEach(function (c, i) { mods['Background-' + (i + 1) + '.source'] = c.url; });
    body = { template_id: template, modifications: mods };
  } else {
    // No template needed: a self-contained RenderScript (1080×1920, b-roll track, voiceover, animated captions).
    var elements = clips.map(function (c, i) {
      var el = { type: 'video', track: 1, source: c.url, duration: c.seconds, fit: 'cover', volume: '0%' };
      if (i > 0) el.animations = [{ time: 'start', duration: 0.4, transition: true, type: 'fade' }];
      return el;
    });
    elements.push({ id: 'Voiceover', name: 'Voiceover', type: 'audio', track: 2, source: audio.url });
    elements.push({
      type: 'text', track: 3, time: 0, duration: 2.8, text: hook, y: '17%', width: '86%', x_alignment: '50%',
      font_family: 'Montserrat', font_weight: '800', font_size: '8 vmin', fill_color: '#ffffff',
      background_color: 'rgba(14,58,83,0.88)', background_x_padding: '38%', background_y_padding: '28%', background_border_radius: '18%'
    });
    elements.push({
      type: 'text', track: 4, transcript_source: 'Voiceover', transcript_effect: 'highlight', transcript_maximum_length: 14, transcript_color: '#5EEAD4',
      y: '74%', width: '84%', height: '22%', x_alignment: '50%', y_alignment: '50%',
      font_family: 'Montserrat', font_weight: '800', font_size: '7.5 vmin', fill_color: '#ffffff', stroke_color: '#000000', stroke_width: '1.4 vmin'
    });
    body = { source: { output_format: 'mp4', width: 1080, height: 1920, frame_rate: 30, elements: elements } };
  }
  var res = fetchJson_('TOGGLE_VIDEO_RENDER', 'CREATOMATE', 'https://api.creatomate.com/v1/renders', {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + key }, payload: JSON.stringify(body)
  }).json;
  var render = Array.isArray(res) ? res[0] : res;
  if (!render || !render.id) throw appError_(502, 'UPSTREAM_ERROR', 'Creatomate returned no render id');
  return { provider: 'CREATOMATE', job_id: render.id };
}

function creatomateStatus_(jobId) {
  var r = fetchJson_('TOGGLE_VIDEO_RENDER', 'CREATOMATE', 'https://api.creatomate.com/v1/renders/' + encodeURIComponent(jobId), {
    headers: { Authorization: 'Bearer ' + getProp_('CREATOMATE_API_KEY', '') }
  }).json;
  if (r.status === 'succeeded') return { state: 'DONE', url: r.url, duration: num_(r.duration) };
  if (r.status === 'failed') return { state: 'FAILED', error: String(r.error_message || 'render failed').slice(0, 300) };
  return { state: 'RENDERING' };
}

function testCreatomate_() {
  var key = getProp_('CREATOMATE_API_KEY', '');
  if (!key) throw appError_(412, 'MISSING_API_KEY', 'CREATOMATE_API_KEY is not configured');
  var t = fetchJson_(null, 'CREATOMATE', 'https://api.creatomate.com/v1/templates', { headers: { Authorization: 'Bearer ' + key } }).json;
  return 'Key accepted. ' + (Array.isArray(t) ? t.length : 0) + ' template(s) in the project.';
}

function json2videoSubmit_(item, script, audio, hook) {
  var key = getProp_('JSON2VIDEO_API_KEY', '');
  if (!key) throw appError_(412, 'MISSING_API_KEY', 'JSON2VIDEO_API_KEY is not configured');
  var clips = fitClipsToAudio_(findBrollClips_(script), audio.duration);
  var movie = {
    resolution: 'instagram-story', quality: 'high',
    scenes: clips.map(function (c, i) {
      var els = [{ type: 'video', src: c.url, muted: true, resize: 'cover', duration: c.seconds }];
      if (i === 0) els.push({ type: 'text', text: hook, duration: 2.8, settings: { 'font-family': 'Montserrat', 'font-weight': '800', 'font-size': '64px', 'font-color': '#ffffff', 'background-color': VIDEO_BRAND_COLOR, 'vertical-position': 'top', 'horizontal-position': 'center' } });
      return { duration: c.seconds, elements: els };
    }),
    elements: [
      { type: 'audio', src: audio.url },
      { type: 'subtitles', settings: { style: 'classic-progressive', 'font-family': 'Montserrat', 'font-size': 90, position: 'bottom-center', 'word-color': '#5EEAD4', 'line-color': '#ffffff', 'outline-color': '#000000', 'outline-width': 6, 'max-words-per-line': 3 } }
    ]
  };
  var res = fetchJson_('TOGGLE_VIDEO_RENDER', 'JSON2VIDEO', 'https://api.json2video.com/v2/movies', {
    method: 'post', contentType: 'application/json', headers: { 'x-api-key': key }, payload: JSON.stringify(movie)
  }).json;
  if (!res.success || !res.project) throw appError_(502, 'UPSTREAM_ERROR', 'JSON2Video rejected the job: ' + JSON.stringify(res).slice(0, 300));
  return { provider: 'JSON2VIDEO', job_id: res.project };
}

function json2videoStatus_(jobId) {
  var m = (fetchJson_('TOGGLE_VIDEO_RENDER', 'JSON2VIDEO', 'https://api.json2video.com/v2/movies?project=' + encodeURIComponent(jobId), {
    headers: { 'x-api-key': getProp_('JSON2VIDEO_API_KEY', '') }
  }).json || {}).movie || {};
  if (m.status === 'done') return { state: 'DONE', url: m.url, duration: num_(m.duration) };
  if (m.status === 'error') return { state: 'FAILED', error: String(m.message || 'render failed').slice(0, 300) };
  return { state: 'RENDERING' };
}

/* ───────────────────────────── Asynchronous poller ───────────────────────────── */

function runVideoPoll_() {
  assertSystemActive();
  var jobs = dbReadAll_(TABS.VIDEO_JOBS).filter(function (j) { return j.status === 'RENDERING'; });
  var out = { checked: jobs.length, ready: [], failed: [] };
  if (!jobs.length) return out; // fast exit keeps the 5-minute trigger nearly free
  var cfg = getConfig();
  var started = Date.now();
  for (var i = 0; i < jobs.length && Date.now() - started < 240000; i++) {
    var job = jobs[i];
    try {
      var st = job.provider === 'HEYGEN' ? heygenStatus_(job.job_id)
        : job.provider === 'JSON2VIDEO' ? json2videoStatus_(job.job_id) : creatomateStatus_(job.job_id);
      var ageMin = (Date.now() - new Date(job.submitted_at).getTime()) / 60000;
      if (st.state === 'RENDERING' && ageMin > 45) st = { state: 'FAILED', error: 'Render timed out after 45 minutes' };

      if (st.state === 'DONE') {
        var dl = guardedFetch_('TOGGLE_VIDEO_RENDER', job.provider, st.url, { method: 'get' });
        if (dl.getResponseCode() >= 400) throw appError_(502, 'UPSTREAM_ERROR', 'Could not download rendered MP4 (HTTP ' + dl.getResponseCode() + ')');
        var saved = saveMediaToDrive_(dl.getBlob().setContentType('video/mp4'), 'video_' + job.queue_id + '.mp4', 'Videos');
        var item = loadItem_(job.queue_id);
        var duration = st.duration || item.payload.audio_duration || item.payload.est_duration_sec || 40;
        var cost = job.provider === 'HEYGEN' ? duration / 60 * num_(cfg.cost.heygen_per_minute)
          : job.provider === 'JSON2VIDEO' ? num_(cfg.cost.json2video_per_video) : num_(cfg.cost.creatomate_per_video);
        item.payload.provider_video_url = st.url;
        item.payload.provider_video_at = nowIso_();
        item.payload.publish_results = {};
        dbUpdate_(TABS.VIDEO_JOBS, job.id, { status: 'DONE', video_url: saved.url, duration_sec: duration, error: '' });
        dbUpdate_(TABS.QUEUE, job.queue_id, {
          status: 'READY_TO_PUBLISH', video_file_id: saved.fileId, video_url: saved.url, scheduled_at: nowIso_(),
          approved: cfg.workflow_mode === 'AUTONOMOUS', // Approval mode: a human previews the MP4 and presses Publish Now
          payload_json: packPayload_(item.payload), error: ''
        });
        logCost_({ service: job.provider, tool_key: 'TOGGLE_VIDEO_RENDER', operation: 'render', units: 1, unit_type: 'videos', est_cost_usd: cost, ok: true, queue_id: job.queue_id, detail: Math.round(duration) + 's' });
        recordToolRun_('TOGGLE_VIDEO_RENDER', 1, 'videos', cost);
        logEvent_('RENDERED', 'Video ready to publish', item.title, job.queue_id);
        out.ready.push(job.queue_id);
      } else if (st.state === 'FAILED') {
        dbUpdate_(TABS.VIDEO_JOBS, job.id, { status: 'FAILED', error: st.error });
        dbUpdate_(TABS.QUEUE, job.queue_id, { status: 'FAILED', error: 'Render failed: ' + st.error });
        logCost_({ service: job.provider, tool_key: 'TOGGLE_VIDEO_RENDER', operation: 'render', ok: false, queue_id: job.queue_id, detail: st.error });
        logEvent_('ERROR', 'Video render failed', st.error, job.queue_id);
        out.failed.push(job.queue_id);
      } else {
        dbUpdate_(TABS.VIDEO_JOBS, job.id, { attempts: num_(job.attempts) + 1 });
      }
    } catch (err) {
      if (err.code === 'SYSTEM_HALTED' || err.code === 'TOOL_DISABLED') throw err;
      var attempts = num_(job.attempts) + 1;
      if (attempts >= 12) {
        dbUpdate_(TABS.VIDEO_JOBS, job.id, { status: 'FAILED', attempts: attempts, error: err.message });
        dbUpdate_(TABS.QUEUE, job.queue_id, { status: 'FAILED', error: err.message });
        out.failed.push(job.queue_id);
      } else {
        dbUpdate_(TABS.VIDEO_JOBS, job.id, { attempts: attempts, error: err.message });
      }
    }
  }
  return out;
}
