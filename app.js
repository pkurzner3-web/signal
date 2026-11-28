// Signal: live meeting copilot. Browser side.
// Flow: audio -> AssemblyAI (live transcript) -> term map + Gemini (concept cards, questions, call notes).
// Pure helpers (blocks, quotes, parsing, stats) live in logic.js as window.SignalLogic.

(function () {
  'use strict';
  const L = window.SignalLogic;

  // ---------- Settings you can tweak ----------
  const CONFIG = {
    speechModel: 'assemblyai-stt-3-7-realtime', // AssemblyAI model that supports speaker labels
    turnMode: 'min_latency',                     // AssemblyAI end-of-turn speed: min_latency | balanced | max_accuracy
    keyterms: true,                              // send term-map words to AssemblyAI to improve accuracy on jargon
    pauseMs: 1500,                               // a pause longer than this starts a new transcript block
    windowSeconds: 60,                           // recent conversation the AI sees for questions (hybrid mode)
    notesEverySeconds: 45,                       // how often call notes refresh
    questionDelayMs: 600,                        // wait after the other side stops before asking for questions
    midTurnQuestionGapMs: 15000,                 // during a long answer, refresh questions at most this often
    liveQuestionWords: 45,                       //   and only after about this many new words
    minWordsForConcepts: 5,
    liveConceptWords: 18,                        // during a long answer, check for new terms every ~18 new words
    liveConceptGapMs: 4000,                      //   but no more often than every 4 s
    visibleCards: 3,                             // concept cards shown before older ones fold away
    topMaxAgeMs: 45000,                          // the top question can be replaced after this long even without a better score
    maxAiPerMinute: 14,                          // request budget to stay under Gemini free-tier limits
  };

  const params = new URLSearchParams(location.search);
  const MODEL_OVERRIDE = params.get('model') || undefined; // used by the eval runner to compare models
  const EVAL = params.has('eval');

  // ---------- State ----------
  const S = {
    passcode: '',
    running: false,
    mode: null, // 'live' | 'test'
    contextMode: 'hybrid',
    qGapMs: 8000,
    qQuality: 'fast',
    debug: false,
    meetingType: 'Sales discovery',
    types: [],
    type: null,
    skillTexts: {},
    activeSkills: [],
    skill: '',
    checklist: [],        // guide questions: { id, q, asked }
    sources: {},          // name -> { ws, node, stream, startWall, chunks }
    audioCtx: null,
    callStart: 0,
    turns: new Map(),     // key -> turn
    finals: [],           // finalized turns in order
    speakers: {},         // src -> { order: [letters], role: { letter: 'you' } }
    docs: [],
    briefs: { other: '', ours: '' },
    glossary: [],
    matchers: [],
    shown: new Set(),
    cards: [],            // newest first
    known: [],            // terms the user marked "I know this"
    summary: '',
    notes: {},
    notesIndex: 0,
    notesAt: 0,
    notesBusy: false,
    signals: [],          // { type, label, lineId }
    recap: '',
    q: { ctl: null, lastAt: 0, timer: null, current: [], history: [], dismissed: [], inflight: false, seq: 0, changes: [], shown: [], feedback: [] },
    cQueue: [],
    cBusy: false,
    cLastAt: 0,
    coverQueue: [],
    coverTimer: null,
    talk: { you: 0, other: 0 },
    latRun: [],
    latAll: [],
    stats: { requests: 0, retries: 0, errors: 0, s429: 0, fallbacks: 0, gaveUp: 0 },
    reqTimes: [],
    aiPausedUntil: 0,
    chip: null,
    models: null,
    lastWordsAt: 0,
  };

  const $ = (id) => document.getElementById(id);
  const els = {};
  ('lock lockForm passcode lockMsg app liveDot meetingType talkBar talkLabel talkYou status startBtn testLabel testFile askBtn docsBtn docCount ' +
   'contextMode qModel qGap debugToggle setupStatus logoutBtn stopBtn testAudio transcript transcriptEmpty sourceHint jumpLive questions qState ' +
   'qHistoryWrap qHistory guideBlock guideDetails guideCount guideList notesDetails notesHint notes recapWrap copyRecap recap concepts ' +
   'conceptHistoryWrap conceptHistoryCount conceptHistory debugBar latGrid modelInfo copyLog exportBtn drawer closeDrawer setupIntro skillList ' +
   'docHelp docTag docFiles docList prepareBtn prepareMsg otherBriefLabel otherBrief ourBriefLabel ourBrief checklistCount checklistText termCount termList')
    .split(' ').forEach((id) => { els[id] = $(id); });

  // ---------- Small helpers ----------
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const words = (s) => (String(s || '').trim().match(/\S+/g) || []).length;
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const now = () => performance.now();
  const lastWords = (s, k) => String(s || '').trim().split(/\s+/).slice(-k).join(' ');
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(id); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
  const callMs = () => (S.callStart ? Date.now() - S.callStart : 0);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function store(key, value) {
    try { localStorage.setItem('signal.' + key, JSON.stringify(value)); return true; } catch { return false; }
  }
  function load(key, fallback) {
    try { const v = localStorage.getItem('signal.' + key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  }

  // ---------- Status chip (header) ----------
  // One small message at a time. key lets a later success clear the matching message.
  function setChip(key, text, kind, ttlMs) {
    clearTimeout(S.chipTimer);
    S.chip = { key, text, kind };
    els.status.textContent = text;
    els.status.className = 'chip' + (kind ? ' ' + kind : '');
    els.status.hidden = false;
    if (ttlMs) S.chipTimer = setTimeout(() => clearChip(key), ttlMs);
  }
  function clearChip(key) {
    if (!S.chip || (key && S.chip.key !== key)) return;
    S.chip = null;
    els.status.hidden = true;
  }
  const info = (text) => setChip('info', text, 'info', 6000);
  const warn = (text) => setChip('warn', text, 'warn', 20000);

  // ---------- Network ----------
  async function api(path, body, opts) {
    opts = opts || {};
    const r = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-passcode': S.passcode },
      body: JSON.stringify(body || {}),
      signal: opts.signal,
    });
    if (!r.ok) {
      let msg = '';
      try { msg = (await r.json()).error; } catch { msg = r.statusText; }
      const err = new Error(msg || 'Error ' + r.status);
      err.status = r.status;
      if (r.status === 401 && /passcode/i.test(msg)) lockApp('Passcode changed or wrong. Enter it again.');
      throw err;
    }
    return opts.stream ? r : r.json();
  }

  // Request budget so bursts of cards, questions and notes stay under free-tier limits.
  function canSpend(priority) {
    const t = Date.now();
    S.reqTimes = S.reqTimes.filter((x) => t - x < 60000);
    if (priority !== 'high' && t < S.aiPausedUntil) return false;
    const limit = priority === 'high' ? CONFIG.maxAiPerMinute + 4 : CONFIG.maxAiPerMinute;
    return S.reqTimes.length < limit;
  }

  // AI requests: retry with backoff and jitter on busy or rate-limit errors; report backup-model use.
  async function ai(body, opts) {
    opts = opts || {};
    const delays = L.backoffDelays(500, 4, 0.3); // about 0.5 s, 1 s, 2 s, 4 s
    const payload = JSON.stringify(Object.assign({ model: MODEL_OVERRIDE }, body));
    for (let attempt = 0; ; attempt++) {
      let err = null;
      let retryable = false;
      try {
        S.stats.requests++;
        S.reqTimes.push(Date.now());
        const r = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-passcode': S.passcode },
          body: payload,
          signal: opts.signal,
        });
        if (r.ok) {
          clearChip('retry');
          const data = opts.stream ? null : await r.json();
          const fallback = opts.stream ? r.headers.get('x-fallback') === '1' : Boolean(data && data.fallback);
          if (fallback) {
            S.stats.fallbacks++;
            setChip('backup', 'Using backup model', 'info', 60000);
          } else {
            clearChip('backup');
          }
          return opts.stream ? r : data;
        }
        let msg = '';
        try { msg = (await r.json()).error; } catch { msg = r.statusText; }
        err = new Error(msg || 'Error ' + r.status);
        err.status = r.status;
        if (r.status === 401 && /passcode/i.test(msg)) { lockApp('Passcode changed or wrong. Enter it again.'); throw err; }
        if (r.status === 429) S.stats.s429++;
        retryable = [429, 500, 502, 503, 504].includes(r.status);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (e.status === 401) throw e;
        err = err || e;
        retryable = retryable || e instanceof TypeError; // network error
      }
      if (!retryable || attempt >= delays.length) {
        S.stats.errors++;
        if (retryable) {
          S.stats.gaveUp++;
          S.aiPausedUntil = Date.now() + 15000;
          setChip('retry', 'AI is busy. Pausing for 15 seconds.', 'warn', 15000);
        }
        renderLatency();
        throw err;
      }
      S.stats.retries++;
      setChip('retry', 'Retrying…', 'warn');
      await sleep(delays[attempt], opts.signal);
    }
  }

  // ---------- Passcode ----------
  async function unlock(passcode) {
    S.passcode = passcode;
    const status = await api('auth', {});
    store('passcode', passcode);
    els.lock.hidden = true;
    els.app.hidden = false;
    showSetup(status);
  }

  function lockApp(msg) {
    stopAll();
    S.passcode = '';
    store('passcode', '');
    els.app.hidden = true;
    els.drawer.hidden = true;
    els.lock.hidden = false;
    els.lockMsg.textContent = msg || '';
  }

  function showSetup(st) {
    S.models = st.models;
    const line = (ok, text) => `<div class="${ok ? 'good' : 'bad'}">${ok ? '✓' : '✗'} ${escapeHtml(text)}</div>`;
    els.setupStatus.innerHTML =
      line(st.assemblyai, 'AssemblyAI key') +
      line(st.gemini && st.models, 'Gemini key' + (st.models ? ` (fast: ${st.models.fast}, smart: ${st.models.smart})` : '')) +
      (st.problem ? `<div class="bad">${escapeHtml(st.problem)}</div>` : '');
    els.modelInfo.textContent = st.models ? `Models: ${MODEL_OVERRIDE || st.models.fast} / ${MODEL_OVERRIDE || st.models.smart}` : '';
    if (st.problem) warn('Setup problem: ' + st.problem);
  }

  // ---------- Call types and skills ----------
  function otherLabel() { return (S.type && S.type.otherLabel) || 'Other side'; }
  function tagInfo(id) { return ((S.type && S.type.docTags) || []).find((t) => t.id === id) || { id, label: id, side: 'other' }; }
  function sideTag(side) { return ((S.type && S.type.docTags) || []).find((t) => t.side === side) || { label: side === 'ours' ? 'Our side' : 'Other side' }; }
  function noteCategories() { return (S.type && S.type.notes) || ['Key points', 'Next steps']; }

  function skillMeta(text) {
    const name = (text.match(/^name:\s*(.+)$/m) || [])[1] || 'Skill';
    const goal = ((text.match(/^Goal:\s*(.+)$/m) || [])[1] || '').trim();
    return { name: name.trim(), goal: goal ? goal[0].toUpperCase() + goal.slice(1) : '' };
  }

  async function loadTypes() {
    try {
      const idx = await (await fetch('/skills/index.json', { cache: 'no-store' })).json();
      S.types = idx.meetingTypes || [];
    } catch {
      S.types = [];
    }
    if (!S.types.length) S.types = [{ id: 'sales', label: 'Sales discovery', otherLabel: 'Prospect', docTags: [{ id: 'account', label: 'Account', side: 'other' }, { id: 'team', label: 'Team', side: 'ours' }], skills: [] }];
    els.meetingType.innerHTML = '';
    S.types.forEach((t) => {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.label;
      els.meetingType.appendChild(o);
    });
    const saved = load('type', S.types[0].id);
    await applyType(S.types.some((t) => t.id === saved) ? saved : S.types[0].id);
  }

  async function applyType(id) {
    S.type = S.types.find((t) => t.id === id) || S.types[0];
    S.meetingType = S.type.label;
    els.meetingType.value = S.type.id;
    store('type', S.type.id);
    await Promise.all((S.type.skills || []).map(async (sk) => {
      if (S.skillTexts[sk.file] != null) return;
      try { S.skillTexts[sk.file] = await (await fetch('/skills/' + sk.file, { cache: 'no-store' })).text(); } catch { S.skillTexts[sk.file] = ''; }
    }));
    const defaults = (S.type.skills || []).filter((sk) => sk.on).map((sk) => sk.file);
    S.activeSkills = load('skills.' + S.type.id, defaults).filter((f) => (S.type.skills || []).some((sk) => sk.file === f));
    updateSkillText();
    loadDocs();
    renderSetup();
    renderDocs();
    renderGuide();
    renderNotes();
    els.sourceHint.textContent = 'Use headphones on live calls';
  }

  function updateSkillText() {
    S.skill = S.activeSkills.map((f) => S.skillTexts[f] || '').filter(Boolean).join('\n\n');
  }

  function renderSetup() {
    els.setupIntro.textContent = S.type.intro || '';
    els.skillList.innerHTML = '';
    (S.type.skills || []).forEach((sk, i) => {
      const meta = skillMeta(S.skillTexts[sk.file] || '');
      const row = document.createElement('label');
      row.className = 'skill';
      row.htmlFor = 'skill-' + i;
      row.innerHTML = '<input type="checkbox"><span><span class="skill-name"></span><span class="skill-goal"></span></span>';
      const box = row.querySelector('input');
      box.id = 'skill-' + i;
      box.checked = S.activeSkills.includes(sk.file);
      row.querySelector('.skill-name').textContent = meta.name;
      row.querySelector('.skill-goal').textContent = meta.goal;
      box.onchange = () => {
        S.activeSkills = (S.type.skills || []).map((x) => x.file).filter((f) => (f === sk.file ? box.checked : S.activeSkills.includes(f)));
        store('skills.' + S.type.id, S.activeSkills);
        updateSkillText();
        if (S.docs.length) els.prepareMsg.textContent = 'Skills changed. Click Prepare for the call to refresh the term map.';
      };
      els.skillList.appendChild(row);
    });
    els.docHelp.textContent = (S.type.docTags || []).map((t) => `${t.label}: ${t.hint || ''}`).join('. ') + '. Then click Prepare so Signal builds briefs, a term map and your guide questions before the call.';
    els.docTag.innerHTML = '';
    (S.type.docTags || []).forEach((t) => {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.label;
      els.docTag.appendChild(o);
    });
    els.otherBriefLabel.textContent = sideTag('other').label + ' brief';
    els.ourBriefLabel.textContent = sideTag('ours').label + ' brief';
  }

  // ---------- Speakers ----------
  function spk(src) { return S.speakers[src] || (S.speakers[src] = { order: [], role: {} }); }
  function noteLetter(src, letter) {
    if (!letter || letter === 'PENDING') return false;
    const s = spk(src);
    if (s.order.includes(letter)) return false;
    s.order.push(letter);
    return true;
  }
  function isYou(src, letter) { return src === 'you' || Boolean(letter && spk(src).role[letter] === 'you'); }
  function canMapSpeakers(src) { return src !== 'you' && !S.sources.you; }
  function speakerName(src, letter) {
    if (src === 'you') return 'You';
    const s = spk(src);
    if (letter && s.role[letter] === 'you') return 'You';
    const hasYou = Object.values(s.role).includes('you');
    const others = s.order.filter((l) => s.role[l] !== 'you');
    const n = letter ? others.indexOf(letter) + 1 : 0;
    if (src === 'file' && !hasYou) return n > 0 ? 'Speaker ' + n : 'Speaker';
    return others.length > 1 && n > 0 ? otherLabel() + ' ' + n : otherLabel();
  }
  function toggleYou(src, letter) {
    if (!letter || !canMapSpeakers(src)) return;
    const s = spk(src);
    const was = s.role[letter] === 'you';
    s.role = {};
    if (!was) s.role[letter] = 'you';
    S.turns.forEach((t) => { if (t.src === src) renderTurn(t); });
    recomputeTalk();
  }

  // ---------- Guide questions ----------
  function renderGuide() {
    const list = S.checklist;
    els.guideBlock.hidden = !list.length;
    const asked = list.filter((x) => x.asked).length;
    els.guideCount.textContent = list.length ? `${asked} of ${list.length} asked` : '';
    els.guideList.innerHTML = '';
    list.forEach((item) => {
      const li = document.createElement('li');
      li.className = item.asked ? 'asked' : '';
      li.innerHTML = '<span class="mark" aria-hidden="true"></span><span class="gq"></span>';
      li.querySelector('.mark').textContent = item.asked ? '✓' : '';
      li.querySelector('.gq').textContent = item.q;
      li.title = item.asked ? 'Asked' : 'Not asked yet';
      els.guideList.appendChild(li);
    });
    els.checklistCount.textContent = list.length;
    els.checklistText.textContent = list.map((x) => '- ' + x.q).join('\n') || 'None found. Upload an interview guide or discovery checklist and click Prepare.';
  }
  const pendingGuide = () => S.checklist.filter((x) => !x.asked);

  // Detects when You asked a guide question or a suggested question (batched every few seconds).
  function queueCoverage(t) {
    const youBlocks = (t.blocks || []).filter((b) => isYou(t.src, b.speaker));
    const anyMapped = S.sources.you || Object.values(spk(t.src).role).includes('you');
    let text = youBlocks.map((b) => b.text).join(' ');
    if (!anyMapped && S.mode === 'test') text = t.text; // nobody marked as You yet: count any speaker for guide questions
    if (words(text) < 4) return;
    S.coverQueue.push(text);
    clearTimeout(S.coverTimer);
    S.coverTimer = setTimeout(flushCoverage, 2500);
  }

  async function flushCoverage() {
    const said = S.coverQueue.splice(0).join(' ');
    const items = pendingGuide().map((x) => ({ id: x.id, q: x.q }))
      .concat(S.q.current.filter((x) => !x.asked).map((x) => ({ id: 'q' + x.id, q: x.q })));
    if (!said || !items.length) return;
    if (!canSpend('normal')) { S.coverQueue.unshift(said); S.coverTimer = setTimeout(flushCoverage, 4000); return; }
    try {
      const d = await ai({ mode: 'coverage', meetingType: S.meetingType, items, said });
      const hit = new Set(d.covered || []);
      if (!hit.size) return;
      S.checklist.forEach((x) => { if (hit.has(x.id)) x.asked = true; });
      renderGuide();
      let changed = false;
      S.q.current.forEach((x) => { if (hit.has('q' + x.id)) { x.asked = true; changed = true; } });
      if (changed) {
        S.q.current.filter((x) => x.asked).forEach((x) => S.q.history.unshift(x));
        S.q.current = S.q.current.filter((x) => !x.asked);
        renderQuestions(S.q.current, false);
        renderHistory();
      }
    } catch (e) {
      console.warn('coverage', e);
    }
  }

  // ---------- Audio capture ----------
  async function ensureAudio() {
    if (!S.audioCtx) {
      S.audioCtx = new AudioContext();
      await S.audioCtx.audioWorklet.addModule('/audio-worklet.js');
    }
    if (S.audioCtx.state === 'suspended') await S.audioCtx.resume();
    return S.audioCtx;
  }

  async function getToken() {
    const d = await api('token', {});
    return d.token;
  }

  function keyterms() {
    const out = [];
    S.glossary.forEach((g) => [g.term].concat(g.aliases || []).forEach((t) => {
      const s = String(t || '').trim();
      if (s.length > 1 && s.length <= 50 && !out.includes(s)) out.push(s);
    }));
    return out.slice(0, 100);
  }

  function wsUrl(token, labels, useKeyterms) {
    const p = new URLSearchParams({ token, speech_model: CONFIG.speechModel, sample_rate: '16000', encoding: 'pcm_s16le', mode: CONFIG.turnMode });
    if (labels) { p.set('speaker_labels', 'true'); p.set('max_speakers', '4'); }
    const kt = useKeyterms ? keyterms() : [];
    if (kt.length) p.set('keyterms_prompt', JSON.stringify(kt));
    // Testing only: a fake transcription server on this machine. Any other address is ignored.
    const asr = EVAL ? params.get('asr') || '' : '';
    const base = /^ws:\/\/(localhost|127\.0\.0\.1):\d+(\/|$)/.test(asr) ? asr : 'wss://streaming.assemblyai.com/v3/ws';
    return base + '?' + p.toString();
  }

  // Connects one audio source (mic, tab or file) to its own AssemblyAI session.
  function connectSource(name, sourceNode, token, labels, extra) {
    const ctx = S.audioCtx;
    const node = new AudioWorkletNode(ctx, 'pcm-sender');
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sourceNode.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    const src = Object.assign({ name, node, sourceNode, sink, ws: null, startWall: 0, chunks: 0 }, extra);
    S.sources[name] = src;

    const open = (useKeyterms) => {
      const ws = new WebSocket(wsUrl(token, labels, useKeyterms));
      ws.binaryType = 'arraybuffer';
      src.ws = ws;
      let begun = false;
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'Turn') onTurn(name, m);
        else if (m.type === 'Begin') begun = true;
        else if (m.type === 'Error') warn(`Transcription error: ${m.error || m.error_code}`);
      };
      ws.onclose = (ev) => {
        if (!S.running || S.sources[name] !== src) return;
        if (!begun && useKeyterms && keyterms().length) { open(false); return; } // retry without key terms
        if (ev.code !== 1000 && ev.code !== 1005) warn(`Transcription stopped for ${labelForSource(name)} (code ${ev.code}).`);
      };
    };
    open(CONFIG.keyterms);

    node.port.onmessage = (ev) => {
      src.chunks++;
      const ws = src.ws;
      if (!ws || ws.readyState !== 1) return;
      if (!src.startWall) {
        src.startWall = Date.now();
        if (name === 'file') S.audioOffsetMs = Math.round(els.testAudio.currentTime * 1000); // where in the file the stream began
      }
      if (!S.callStart) S.callStart = src.startWall;
      ws.send(ev.data);
    };
    return src;
  }

  function labelForSource(name) {
    return name === 'you' ? 'your mic' : name === 'file' ? 'the audio file' : 'the call tab';
  }

  async function startLive() {
    if (S.running) return;
    resetSession();
    setChip('start', 'Pick the call tab and tick “Share tab audio”', 'info');
    try {
      await ensureAudio();
      let tabStream = null;
      try {
        tabStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          selfBrowserSurface: 'exclude',
          systemAudio: 'include',
        });
        if (!tabStream.getAudioTracks().length) {
          tabStream.getTracks().forEach((t) => t.stop());
          tabStream = null;
          warn('No tab audio was shared. Continuing with your mic only.');
        }
      } catch {
        tabStream = null;
        warn('Tab sharing was skipped. Continuing with your mic only.');
      }
      let micStream = null;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        micStream = null;
      }
      if (!tabStream && !micStream) throw new Error('Signal needs your mic or a shared tab to listen.');
      const token = await getToken(); // after the share dialog: the token only lasts 60 seconds
      clearChip('start');
      S.mode = 'live';
      S.running = true;
      if (micStream) connectSource('you', S.audioCtx.createMediaStreamSource(micStream), token, false, { stream: micStream });
      if (tabStream) {
        const audioOnly = new MediaStream(tabStream.getAudioTracks());
        connectSource('other', S.audioCtx.createMediaStreamSource(audioOnly), token, true, { stream: tabStream });
        tabStream.getAudioTracks()[0].addEventListener('ended', () => { if (S.running) stopAll('Tab sharing ended.'); });
      }
      els.sourceHint.textContent = micStream
        ? ['Mic is You', tabStream ? 'tab is ' + otherLabel() : ''].filter(Boolean).join(', ')
        : 'Click a speaker name to mark them as You';
      setRunningUi(true);
    } catch (e) {
      stopAll();
      warn(e.message || 'Could not start.');
    }
  }

  async function startTest(file) {
    if (S.running) return;
    resetSession();
    try {
      await ensureAudio();
      const token = await getToken();
      const audio = els.testAudio;
      if (audio.dataset.url) URL.revokeObjectURL(audio.dataset.url);
      const url = URL.createObjectURL(file);
      audio.dataset.url = url;
      audio.src = url;
      audio.hidden = false;
      if (!S.fileNode) S.fileNode = S.audioCtx.createMediaElementSource(audio);
      S.fileNode.disconnect();
      S.fileNode.connect(S.audioCtx.destination);
      S.mode = 'test';
      S.running = true;
      S.testFile = file.name;
      connectSource('file', S.fileNode, token, true, {});
      audio.onended = () => setTimeout(() => stopAll('Test file finished.'), 2500);
      setRunningUi(true);
      els.sourceHint.textContent = 'Click a speaker name to mark them as You';
      info('Test mode: playing ' + file.name);
      await audio.play();
    } catch (e) {
      stopAll();
      warn(e.message || 'Could not start test mode.');
    }
  }

  function stopAll(msg) {
    const wasRunning = S.running;
    S.running = false;
    Object.values(S.sources).forEach((src) => {
      try { src.node.port.onmessage = null; src.sourceNode.disconnect(src.node); } catch {}
      try { src.node.disconnect(); src.sink.disconnect(); } catch {}
      if (src.stream) src.stream.getTracks().forEach((t) => t.stop());
      const ws = src.ws;
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'Terminate' })); } catch {}
        setTimeout(() => { try { ws.close(1000); } catch {} }, 3000);
      } else if (ws) {
        try { ws.close(1000); } catch {}
      }
    });
    S.sourcesUsed = Object.keys(S.sources);
    S.sources = {};
    if (S.mode === 'test') { try { els.testAudio.pause(); } catch {} }
    if (S.fileNode) { try { S.fileNode.disconnect(); S.fileNode.connect(S.audioCtx.destination); } catch {} }
    clearTimeout(S.q.timer);
    setRunningUi(false);
    if (wasRunning) {
      S.endedAt = Date.now();
      info(msg || 'Stopped.');
      finishCall();
    }
  }

  function setRunningUi(on) {
    els.startBtn.hidden = on;
    els.testLabel.hidden = on;
    els.stopBtn.hidden = !on;
    els.meetingType.disabled = on;
    els.liveDot.classList.toggle('live', on);
    if (!on && S.checklist.length) els.guideDetails.open = true;
    updateJump();
  }

  function resetSession() {
    S.sourcesUsed = [];
    S.turns.clear();
    S.finals = [];
    S.speakers = {};
    S.callStart = 0;
    S.audioOffsetMs = 0;
    S.endedAt = 0;
    S.shown = new Set(S.known.map(norm));
    S.cards = [];
    S.summary = '';
    S.notes = {};
    S.notesIndex = 0;
    S.notesAt = Date.now();
    S.signals = [];
    S.recap = '';
    S.talk = { you: 0, other: 0 };
    S.latRun = [];
    S.stats = { requests: 0, retries: 0, errors: 0, s429: 0, fallbacks: 0, gaveUp: 0 };
    S.aiPausedUntil = 0;
    if (S.q.ctl) S.q.ctl.abort();
    S.q = { ctl: null, lastAt: 0, timer: null, current: [], history: [], dismissed: [], inflight: false, seq: 0, changes: [], shown: [], feedback: [] };
    S.cQueue = [];
    S.coverQueue = [];
    S.checklist.forEach((x) => { x.asked = false; });
    renderGuide();
    els.transcript.innerHTML = '';
    renderCards();
    els.questions.innerHTML = `<p class="empty-small">Questions appear when the ${otherLabel().toLowerCase()} stops talking.</p>`;
    renderHistory();
    els.qState.textContent = '';
    els.recapWrap.hidden = true;
    renderNotes();
    renderTalk();
    renderLatency();
  }

  // ---------- Transcript ----------
  // Interim text and final text are kept apart: interim is replaced whole on every update,
  // final text is never changed by later interim messages.
  function onTurn(srcName, m) {
    const key = srcName + ':' + m.turn_order;
    let t = S.turns.get(key);
    if (!t) {
      t = { key, src: srcName, final: false, partial: '', text: '', speaker: null, blocks: null, el: null, firstWall: Date.now(), partials: [], sampledAt: 0 };
      S.turns.set(key, t);
    }
    if (m.speaker_label && m.speaker_label !== 'PENDING') {
      t.speaker = m.speaker_label;
      if (noteLetter(srcName, m.speaker_label)) S.turns.forEach((x) => { if (x.src === srcName && x !== t) renderTurn(x); });
    }

    if (!m.end_of_turn) {
      if (t.final) return; // a late interim message never touches final text
      t.partial = (m.transcript || '').trim();
      const ws = m.words || [];
      const src = S.sources[srcName];
      if (ws.length && src && src.startWall && Date.now() - S.lastWordsAt > 1000) {
        const ms = Date.now() - (src.startWall + ws[ws.length - 1].end);
        if (ms > 0 && ms < 20000) { recordLat('words', ms); S.lastWordsAt = Date.now(); }
      }
      if (EVAL && t.partial && Date.now() - t.sampledAt >= 2000) { t.partials.push(t.partial); t.sampledAt = Date.now(); }
      renderTurn(t);
      if (t.partial) onPartial(t);
      return;
    }

    const raw = m.words || [];
    const ws = L.punctuateWords(raw, m.transcript || m.utterance);
    let changedLetters = false;
    ws.forEach((w) => { if (noteLetter(srcName, w.speaker)) changedLetters = true; });
    const blocks = L.buildBlocks(ws, { pauseMs: CONFIG.pauseMs, fallbackSpeaker: t.speaker });
    t.blocks = blocks.length ? blocks : [{ speaker: t.speaker, text: (m.transcript || m.utterance || '').trim(), start: null, end: null }];
    t.words = ws;
    t.text = t.blocks.map((b) => b.text).join(' ').trim();
    const first = !t.final;
    t.final = true;
    t.partial = '';
    if (changedLetters) S.turns.forEach((x) => { if (x.src === srcName && x !== t) renderTurn(x); });
    if (first) {
      t.wall = Date.now();
      const src = S.sources[srcName];
      if (raw.length && src && src.startWall) {
        const ms = Date.now() - (src.startWall + raw[raw.length - 1].end);
        if (ms > 0 && ms < 30000) recordLat('transcript', ms);
      }
      addTalk(t);
    }
    renderTurn(t);
    if (first && t.text) onFinalTurn(t);
  }

  function blockWall(t, b) {
    const src = S.sources[t.src];
    const startWall = (src && src.startWall) || t.startWall || 0;
    if (src && src.startWall) t.startWall = src.startWall;
    return b && b.start != null && startWall ? startWall + b.start : t.firstWall;
  }

  function renderTurn(t) {
    const text = t.final ? t.text : t.partial;
    if (!text) return;
    const intro = document.getElementById('transcriptEmpty');
    if (intro) intro.remove();
    if (!t.el) {
      t.el = document.createElement('div');
      els.transcript.appendChild(t.el);
    }
    const nearBottom = els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight < 80;
    t.el.className = 'turn-group' + (t.final ? '' : ' interim');
    const parts = t.final ? t.blocks : [{ speaker: t.speaker, text: t.partial, start: null }];
    t.el.innerHTML = '';
    parts.forEach((part, i) => {
      const id = t.final ? t.key + '#' + i : t.key + '#p';
      const row = document.createElement('div');
      row.className = 'turn';
      row.dataset.line = id;
      const mappable = canMapSpeakers(t.src) && part.speaker;
      row.innerHTML = `<div class="meta"><${mappable ? 'button type="button"' : 'span'} class="who"></${mappable ? 'button' : 'span'}><span class="time"></span></div><p class="text"></p>`;
      const who = row.querySelector('.who');
      who.textContent = speakerName(t.src, part.speaker);
      who.classList.add(isYou(t.src, part.speaker) ? 'you' : 'other');
      if (mappable) {
        who.title = isYou(t.src, part.speaker) ? 'Click to unmark as You' : 'Click to mark this speaker as You';
        who.onclick = () => toggleYou(t.src, part.speaker);
      }
      row.querySelector('.time').textContent = S.callStart ? L.formatClock(blockWall(t, part) - S.callStart) : '';
      row.querySelector('.text').textContent = part.text;
      S.signals.filter((s) => s.lineId === id).forEach((s) => {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = (s.type === 'objection' ? 'Objection' : 'Competitor') + (s.label ? ': ' + s.label : '');
        row.querySelector('.text').appendChild(badge);
      });
      t.el.appendChild(row);
    });
    if (nearBottom) els.transcript.scrollTop = els.transcript.scrollHeight;
    updateJump();
  }

  function updateJump() {
    const away = els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight > 120;
    els.jumpLive.hidden = !(S.running && away);
  }

  // All transcript lines, newest last, for quotes and traceability.
  function allLines() {
    const out = [];
    S.finals.forEach((t) => (t.blocks || []).forEach((b, i) => out.push({ id: t.key + '#' + i, text: b.text, t, b })));
    liveTail().forEach((t) => out.push({ id: t.key + '#p', text: t.partial, t, b: { speaker: t.speaker } }));
    return out;
  }
  function liveTail() {
    const out = [];
    S.turns.forEach((t) => { if (!t.final && t.partial) out.push(t); });
    return out;
  }
  function lineText(l) { return speakerName(l.t.src, l.b.speaker) + ': ' + l.text; }

  function recentWindow() {
    const cutoff = Date.now() - CONFIG.windowSeconds * 1000;
    const lines = allLines();
    let recent = lines.filter((l) => !l.t.final || (l.t.wall || 0) >= cutoff);
    if (recent.length < 4) recent = lines.slice(-4);
    return recent.map(lineText).join('\n');
  }
  function fullTranscript() { return allLines().map(lineText).join('\n'); }

  function locate(quote) {
    if (!quote) return null;
    return L.findQuote(allLines().map((l) => ({ id: l.id, text: l.text })), quote);
  }

  // Click a question or card to highlight where it came from.
  function trace(ref, quote) {
    const find = (r) => (r ? els.transcript.querySelector(`[data-line="${CSS.escape(r.id)}"]`) : null);
    if (!find(ref)) ref = locate(quote); // the line was live text when this was created; find it again
    if (!ref) return;
    const turn = S.turns.get(ref.id.split('#')[0]);
    if (turn) renderTurn(turn); // clears any earlier highlight
    const row = find(ref);
    if (!row) return;
    const p = row.querySelector('.text');
    const text = p.firstChild && p.firstChild.nodeType === 3 ? p.firstChild.nodeValue : p.textContent;
    const badges = Array.from(p.querySelectorAll('.badge'));
    p.innerHTML = escapeHtml(text.slice(0, ref.start)) + '<mark>' + escapeHtml(text.slice(ref.start, ref.end)) + '</mark>' + escapeHtml(text.slice(ref.end));
    badges.forEach((b) => p.appendChild(b));
    row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    clearTimeout(S.traceTimer);
    S.traceTimer = setTimeout(() => {
      const mk = p.querySelector('mark');
      if (mk) mk.replaceWith(document.createTextNode(mk.textContent));
      p.normalize();
    }, 3000);
  }

  function onFinalTurn(t) {
    S.finals.push(t);
    const t0 = now();
    conceptsFor(t, t0);
    maybeQuestions(t, t0);
    maybeNotes();
    queueCoverage(t);
  }

  // ---------- Talk time ----------
  function addTalk(t) {
    (t.words || []).forEach((w) => {
      const d = Math.max(0, (w.end || 0) - (w.start || 0));
      if (isYou(t.src, w.speaker || t.speaker)) S.talk.you += d; else S.talk.other += d;
    });
    renderTalk();
  }
  function recomputeTalk() {
    S.talk = { you: 0, other: 0 };
    S.finals.forEach((t) => (t.words || []).forEach((w) => {
      const d = Math.max(0, (w.end || 0) - (w.start || 0));
      if (isYou(t.src, w.speaker || t.speaker)) S.talk.you += d; else S.talk.other += d;
    }));
    renderTalk();
  }
  function renderTalk() {
    const total = S.talk.you + S.talk.other;
    const anyYou = S.sources.you || (S.sourcesUsed || []).includes('you') || Object.values(S.speakers).some((s) => Object.values(s.role).includes('you'));
    els.talkBar.hidden = !(total > 0 && anyYou);
    if (!total) return;
    const pct = Math.round((S.talk.you / total) * 100);
    els.talkYou.style.width = pct + '%';
    els.talkLabel.textContent = `You ${pct}%`;
    els.talkBar.title = `Talk time: You ${pct}%, ${otherLabel()} ${100 - pct}%`;
  }

  // ---------- Live updates during long answers ----------
  function onPartial(t) {
    const t0 = now();
    glossaryCards(t.partial, t0, t.key + '#p');
    const n = words(t.partial);
    if (n - (t.aiWords || 0) >= CONFIG.liveConceptWords && Date.now() - S.cLastAt >= CONFIG.liveConceptGapMs) {
      const seg = lastWords(t.partial, n - (t.aiWords || 0));
      t.aiWords = n;
      S.cQueue.push({ text: seg, t0 });
      pumpConcepts();
    }
    const counts = !isYou(t.src, t.speaker) || !otherSideActive();
    if (counts && n - (t.qWords || 0) >= CONFIG.liveQuestionWords && !S.q.inflight && Date.now() - S.q.lastAt >= CONFIG.midTurnQuestionGapMs) {
      t.qWords = n;
      runQuestions(t0);
    }
  }

  // ---------- Concept cards ----------
  function buildMatchers() {
    S.matchers = S.glossary.map((g) => {
      const names = [g.term].concat(g.aliases || []).map((s) => String(s).trim()).filter((s) => s.length > 1);
      const acronymsOnly = names.every((n) => /^[A-Z0-9-]{2,6}$/.test(n));
      const re = new RegExp('(^|[^A-Za-z0-9])(' + names.map(escapeRe).join('|') + ')(?=$|[^A-Za-z0-9])', acronymsOnly ? '' : 'i');
      return { g, re };
    });
  }

  function glossaryCards(text, t0, lineId) {
    if (S.contextMode !== 'hybrid') return;
    for (const { g, re } of S.matchers) {
      const k = norm(g.term);
      if (S.shown.has(k)) continue;
      const m = re.exec(text);
      if (!m) continue;
      S.shown.add(k);
      const start = m.index + m[1].length;
      addCard({ term: g.term, what: g.explanation, here: g.why || '', tag: 'docs', quote: m[2], ref: lineId ? { id: lineId, start, end: start + m[2].length } : null });
      recordLat('card_docs', now() - t0);
    }
  }

  function conceptsFor(t, t0) {
    (t.blocks || []).forEach((b, i) => glossaryCards(b.text, t0, t.key + '#' + i));
    const n = words(t.text);
    const remaining = n - (t.aiWords || 0);
    if (remaining < CONFIG.minWordsForConcepts) return;
    t.aiWords = n;
    S.cQueue.push({ text: lastWords(t.text, remaining), t0 });
    pumpConcepts();
  }

  async function pumpConcepts() {
    if (S.cBusy || !S.cQueue.length) return;
    if (!canSpend('normal')) { setTimeout(pumpConcepts, 3000); return; }
    S.cBusy = true;
    S.cLastAt = Date.now();
    const batch = S.cQueue.splice(0);
    const t0 = batch[0].t0;
    try {
      const known = Array.from(S.shown).concat(S.contextMode === 'hybrid' ? S.glossary.map((g) => g.term) : []).slice(-300);
      const d = await ai({
        mode: 'concepts',
        contextMode: S.contextMode,
        meetingType: S.meetingType,
        otherLabel: otherLabel(),
        otherBrief: S.briefs.other,
        skill: S.skill,
        latest: batch.map((b) => b.text).join(' '),
        context: S.contextMode === 'full' ? fullTranscript() : recentWindow(),
        known,
      });
      for (const c of d.cards || []) {
        const k = norm(c.term);
        if (S.shown.has(k)) continue;
        S.shown.add(k);
        addCard({ term: c.term, what: c.what, here: c.here, tag: c.here ? 'call' : 'general', quote: c.quote || c.term, ref: locate(c.quote || c.term) });
        recordLat('card_ai', now() - t0);
      }
    } catch (e) {
      console.warn('concepts', e);
    } finally {
      S.cBusy = false;
      if (S.cQueue.length && S.running) pumpConcepts();
    }
  }

  function addCard(c) {
    c.at = callMs();
    S.cards.unshift(c);
    renderCards();
  }

  const TAGS = { call: 'From call', docs: 'From docs', general: 'General' };
  function cardEl(c, compact) {
    const el = document.createElement('div');
    el.className = 'card' + (compact ? ' compact' : '');
    el.innerHTML = '<div class="term"><button type="button" class="term-name"></button><span class="src"></span></div><p class="exp"></p><p class="here"></p><div class="card-actions"><button type="button" class="link">I know this</button></div>';
    const name = el.querySelector('.term-name');
    name.textContent = c.term;
    name.title = c.ref || c.quote ? 'Show where this came up' : '';
    name.onclick = () => trace(c.ref, c.quote);
    el.querySelector('.src').textContent = TAGS[c.tag] || '';
    el.querySelector('.exp').textContent = c.what || '';
    const here = el.querySelector('.here');
    if (c.here && !compact) here.textContent = (c.tag === 'docs' ? '' : 'Here: ') + c.here; else here.remove();
    el.querySelector('.link').onclick = () => {
      const k = norm(c.term);
      if (!S.known.includes(k)) { S.known.push(k); store('known', S.known.slice(-500)); }
      S.cards = S.cards.filter((x) => x !== c);
      S.q.feedback.push({ action: 'know', term: c.term, at: callMs() });
      renderCards();
    };
    return el;
  }

  function renderCards() {
    els.concepts.innerHTML = '';
    els.conceptHistory.innerHTML = '';
    if (!S.cards.length) {
      els.concepts.innerHTML = '<p class="empty-small">Technical terms are explained here as they come up.</p>';
      els.conceptHistoryWrap.hidden = true;
      return;
    }
    S.cards.slice(0, CONFIG.visibleCards).forEach((c) => els.concepts.appendChild(cardEl(c, false)));
    const older = S.cards.slice(CONFIG.visibleCards);
    older.forEach((c) => els.conceptHistory.appendChild(cardEl(c, true)));
    els.conceptHistoryWrap.hidden = !older.length;
    els.conceptHistoryCount.textContent = older.length || '';
  }

  // ---------- Follow-up questions ----------
  function otherSideActive() { return Boolean(S.sources.other || S.sources.file); }

  function maybeQuestions(t, t0) {
    const fromOther = !isYou(t.src, t.speaker);
    if (otherSideActive() ? !fromOther : words(t.text) < 6) return;
    clearTimeout(S.q.timer);
    const wait = Math.max(CONFIG.questionDelayMs, S.q.lastAt + S.qGapMs - Date.now());
    S.q.timer = setTimeout(() => runQuestions(t0), wait);
  }

  function askedList() {
    const yourLines = allLines().filter((l) => isYou(l.t.src, l.b.speaker)).slice(-8).map((l) => 'You asked: ' + l.text);
    const suggested = S.q.current.concat(S.q.history.slice(0, 12)).map((x) => (x.asked ? 'Asked: ' : 'Suggested: ') + x.q);
    const dismissed = S.q.dismissed.slice(-10).map((q) => 'Dismissed: ' + q);
    return yourLines.concat(suggested, dismissed);
  }

  async function runQuestions(t0, manual) {
    if (!S.finals.length && !liveTail().length) return;
    if (!manual && !canSpend('high')) { S.q.timer = setTimeout(() => runQuestions(t0), 4000); return; }
    if (S.q.ctl) S.q.ctl.abort();
    const ctl = new AbortController();
    S.q.ctl = ctl;
    S.q.inflight = true;
    S.q.lastAt = Date.now();
    const start = t0 || now();
    const progressive = !S.q.current.length; // stream into an empty panel; otherwise swap when done to keep it stable
    els.qState.textContent = 'thinking…';
    try {
      const r = await ai({
        mode: 'questions',
        contextMode: S.contextMode,
        meetingType: S.meetingType,
        skill: S.skill,
        otherLabel: otherLabel(),
        otherBrief: S.briefs.other,
        ourBrief: S.briefs.ours,
        guide: pendingGuide().map((x) => x.q),
        summary: S.contextMode === 'full' ? '' : notesText(),
        recent: S.contextMode === 'full' ? fullTranscript() : recentWindow(),
        asked: askedList(),
        quality: S.qQuality,
      }, { stream: true, signal: ctl.signal, priority: 'high' });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let text = '';
      let first = true;
      if (progressive) renderQuestions([], true);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        if (first && chunk.trim()) { recordLat('q_first', now() - start); first = false; }
        text += chunk;
        if (progressive) {
          const parsed = L.parseQuestions(text);
          if (parsed.length) renderQuestions(parsed, true);
        }
      }
      if (ctl.signal.aborted) return;
      recordLat('q_done', now() - start);
      const stamp = Date.now();
      const candidates = L.parseQuestions(text).map((c) => Object.assign(c, { id: ++S.q.seq, ref: locate(c.quote), shownAt: stamp }));
      const prev = S.q.current;
      const { list, topChanged } = L.chooseQuestions(prev, candidates, stamp, { maxAgeMs: CONFIG.topMaxAgeMs });
      prev.filter((x) => !list.includes(x)).forEach((x) => S.q.history.unshift(x));
      S.q.history = S.q.history.slice(0, 30);
      if (topChanged && list.length) S.q.changes.push(callMs());
      list.filter((x) => !prev.includes(x)).forEach((x) => S.q.shown.push({ id: x.id, q: x.q, why: x.why, quote: x.quote, score: x.score, guide: x.guide, at: callMs() }));
      S.q.current = list;
      renderQuestions(list, false);
      renderHistory();
      els.qState.textContent = '';
    } catch (e) {
      if (e.name === 'AbortError') return;
      els.qState.textContent = '';
      if (!S.chip || S.chip.key !== 'retry') warn('Questions failed: ' + e.message);
      renderQuestions(S.q.current, false);
    } finally {
      if (S.q.ctl === ctl) S.q.inflight = false;
    }
  }

  function renderQuestions(list, streaming) {
    els.questions.classList.toggle('streaming', streaming);
    els.questions.innerHTML = '';
    if (!list.length) {
      els.questions.innerHTML = streaming
        ? '<p class="empty-small">Thinking…</p>'
        : `<p class="empty-small">Questions refresh when the ${otherLabel().toLowerCase()} stops talking, or click Ask now.</p>`;
      return;
    }
    list.forEach((item) => els.questions.appendChild(questionEl(item, !streaming)));
  }

  function questionEl(item, withActions) {
    const el = document.createElement('div');
    el.className = 'q' + (item.guide ? ' from-guide' : '') + (item.pinned ? ' pinned' : '');
    el.innerHTML = '<button type="button" class="qtext"></button><div class="why"></div>';
    const qt = el.querySelector('.qtext');
    qt.textContent = item.q;
    qt.title = item.ref || item.quote ? 'Show what this builds on' : '';
    qt.onclick = () => trace(item.ref, item.quote);
    const why = item.guide ? 'From your guide' + (item.why ? ': ' + item.why : '') : item.why;
    el.querySelector('.why').textContent = (item.pinned ? 'Pinned. ' : '') + (why || '');
    if (withActions) {
      const actions = document.createElement('div');
      actions.className = 'q-actions';
      actions.innerHTML = '<button type="button" class="link pin"></button><button type="button" class="link dismiss">Dismiss</button>';
      const pin = actions.querySelector('.pin');
      pin.textContent = item.pinned ? 'Unpin' : 'Pin';
      pin.onclick = () => {
        item.pinned = !item.pinned;
        S.q.feedback.push({ action: item.pinned ? 'pin' : 'unpin', q: item.q, at: callMs() });
        if (item.pinned) S.q.current = [item].concat(S.q.current.filter((x) => x !== item));
        renderQuestions(S.q.current, false);
      };
      actions.querySelector('.dismiss').onclick = () => {
        item.dismissed = true;
        S.q.dismissed.push(item.q);
        S.q.feedback.push({ action: 'dismiss', q: item.q, at: callMs() });
        S.q.current = S.q.current.filter((x) => x !== item);
        renderQuestions(S.q.current, false);
      };
      el.appendChild(actions);
    }
    return el;
  }

  function renderHistory() {
    els.qHistory.innerHTML = '';
    const items = S.q.history.filter((x) => !x.dismissed);
    els.qHistoryWrap.hidden = !items.length;
    items.forEach((item) => {
      const el = questionEl(Object.assign({}, item, { pinned: false }), false);
      el.querySelector('.why').textContent = item.asked ? 'Asked' : '';
      if (item.asked) el.classList.add('asked');
      els.qHistory.appendChild(el);
    });
  }

  // ---------- Call notes, signals and recap ----------
  function notesText() {
    const parts = [S.summary];
    Object.keys(S.notes).forEach((k) => { if ((S.notes[k] || []).length) parts.push(k + ': ' + S.notes[k].join('; ')); });
    return parts.filter(Boolean).join('\n');
  }

  async function maybeNotes(force) {
    if (S.notesBusy) return;
    if (!force && Date.now() - S.notesAt < CONFIG.notesEverySeconds * 1000) return;
    if (S.finals.length - S.notesIndex < (force ? 1 : 2)) return;
    if (!force && !canSpend('normal')) return;
    S.notesBusy = true;
    const upTo = S.finals.length;
    try {
      const lines = [];
      S.finals.slice(S.notesIndex, upTo).forEach((t) => (t.blocks || []).forEach((b, i) => lines.push(speakerName(t.src, b.speaker) + ': ' + b.text)));
      const d = await ai({
        mode: 'notes',
        meetingType: S.meetingType,
        otherLabel: otherLabel(),
        categories: noteCategories(),
        previous: S.summary,
        previousNotes: S.notes,
        transcript: lines.join('\n'),
      });
      S.summary = d.summary || S.summary;
      S.notes = d.notes || S.notes;
      S.notesIndex = upTo;
      S.notesAt = Date.now();
      let keyMoment = false;
      (d.signals || []).forEach((sg) => {
        const ref = locate(sg.quote);
        if (!ref || S.signals.some((x) => x.lineId === ref.id && x.type === sg.type)) return;
        S.signals.push({ type: sg.type, label: sg.label, lineId: ref.id, at: callMs() });
        keyMoment = true;
        const t = S.turns.get(ref.id.split('#')[0]);
        if (t) renderTurn(t);
      });
      renderNotes();
      if (keyMoment && S.running && !S.q.inflight) runQuestions(now()); // an objection or competitor is a key moment
    } catch (e) {
      console.warn('notes', e);
    } finally {
      S.notesBusy = false;
    }
  }

  function renderNotes() {
    const cats = noteCategories();
    const filled = cats.filter((c) => (S.notes[c] || []).length);
    els.notesHint.textContent = filled.length ? `${filled.length} of ${cats.length} filled` : 'Updates as the call goes';
    if (!filled.length) {
      els.notes.innerHTML = `<p class="empty-small">${escapeHtml(cats.join(', '))} appear here during the call.</p>`;
      return;
    }
    els.notes.innerHTML = '';
    filled.forEach((c) => {
      const sec = document.createElement('div');
      sec.className = 'note-sec';
      sec.innerHTML = '<h3></h3><ul></ul>';
      sec.querySelector('h3').textContent = c;
      S.notes[c].forEach((item) => {
        const li = document.createElement('li');
        li.textContent = item;
        sec.querySelector('ul').appendChild(li);
      });
      els.notes.appendChild(sec);
    });
  }

  async function finishCall() {
    if (S.finals.length < 2) return;
    els.notesDetails.open = true;
    await maybeNotes(true);
    els.recapWrap.hidden = false;
    els.recap.textContent = 'Writing the recap…';
    try {
      const d = await ai({
        mode: 'recap',
        meetingType: S.meetingType,
        otherLabel: otherLabel(),
        categories: noteCategories(),
        notes: S.notes,
        transcript: fullTranscript(),
      });
      S.recap = d.recap || '';
      els.recap.textContent = S.recap || 'No recap available.';
    } catch (e) {
      els.recap.textContent = 'Recap failed: ' + e.message;
    }
  }

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      info(done);
    } catch {
      warn('Could not copy. Your browser blocked the clipboard.');
    }
  }

  // ---------- Latency and debug ----------
  const METRICS = [
    ['words', 'Words on screen'],
    ['transcript', 'Final text'],
    ['card_docs', 'Card from docs'],
    ['card_ai', 'Card from AI'],
    ['q_first', 'Questions start'],
    ['q_done', 'Questions done'],
  ];

  function recordLat(metric, ms) {
    const row = { at: new Date().toISOString(), metric, ms: Math.round(ms), mode: S.contextMode };
    S.latRun.push(row);
    S.latAll.push(row);
    if (S.latAll.length > 5000) S.latAll.shift();
    renderLatency();
  }

  function fmt(ms) { return ms == null ? '–' : ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s'; }

  function renderLatency() {
    if (!S.debug) return;
    const st = S.stats;
    els.latGrid.innerHTML = METRICS.map(([key, label]) => {
      const vals = S.latRun.filter((x) => x.metric === key).map((x) => x.ms);
      return `<span>${label} <b>${fmt(L.percentile(vals, 50))}</b> / <b>${fmt(L.percentile(vals, 95))}</b></span>`;
    }).join('') +
      `<span class="hint">p50 / p95 this run</span>` +
      `<span>Requests <b>${st.requests}</b>, retries <b>${st.retries}</b>, rate limited <b>${st.s429}</b>, backup model <b>${st.fallbacks}</b>, errors <b>${st.errors}</b></span>`;
  }

  async function copyLog() {
    const csv = ['time,metric,ms,context_mode'].concat(S.latAll.map((x) => [x.at, x.metric, x.ms, x.mode].join(','))).join('\n');
    copyText(csv, `Copied ${S.latAll.length} latency rows. Paste into a spreadsheet.`);
  }

  function exportSession() {
    const transcript = [];
    S.finals.forEach((t) => (t.blocks || []).forEach((b, i) => transcript.push({
      id: t.key + '#' + i,
      src: t.src,
      letter: b.speaker || null,
      speaker: speakerName(t.src, b.speaker),
      text: b.text,
      audioStartMs: b.start,
      audioEndMs: b.end,
      t: S.callStart ? blockWall(t, b) - S.callStart : null,
    })));
    const partials = [];
    S.finals.forEach((t) => t.partials.forEach((p) => partials.push({ turn: t.key, interim: p, final: t.text })));
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      meta: {
        callType: S.type && S.type.id,
        skills: S.activeSkills,
        contextMode: S.contextMode,
        questionModel: S.qQuality,
        modelOverride: MODEL_OVERRIDE || null,
        models: S.models,
        testFile: S.testFile || null,
        audioOffsetMs: S.audioOffsetMs || 0,
        durationMs: S.callStart ? (S.endedAt || Date.now()) - S.callStart : 0,
        docs: S.docs.map((d) => ({ name: d.name, tag: d.tag })),
        glossaryTerms: S.glossary.length,
      },
      transcript,
      partials,
      questionsShown: S.q.shown,
      topQuestionChanges: S.q.changes,
      questionsCurrent: S.q.current.map((x) => ({ q: x.q, why: x.why, quote: x.quote, score: x.score, pinned: Boolean(x.pinned) })),
      cards: S.cards.slice().reverse().map((c) => ({ term: c.term, what: c.what, here: c.here, tag: c.tag, at: c.at, sourceLine: c.ref && c.ref.id })),
      guide: S.checklist,
      notes: S.notes,
      summary: S.summary,
      signals: S.signals,
      recap: S.recap,
      feedback: S.q.feedback,
      talk: S.talk,
      latency: { run: S.latRun, all: S.latAll },
      stats: S.stats,
    };
  }

  function downloadExport() {
    const data = JSON.stringify(exportSession(), null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = `signal-session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function setDebug(on) {
    S.debug = on;
    els.debugToggle.checked = on;
    els.debugBar.hidden = !on;
    store('debug', on);
    renderLatency();
  }

  // ---------- Documents (kept per call type, in this browser) ----------
  function docsKey() { return 'docs.' + (S.type ? S.type.id : 'sales'); }

  function saveDocs() {
    const payload = { docs: S.docs, briefs: S.briefs, glossary: S.glossary, checklist: S.checklist.map((x) => x.q) };
    if (!store(docsKey(), payload)) store(docsKey(), Object.assign({}, payload, { docs: S.docs.map((d) => Object.assign({}, d, { text: d.text.slice(0, 20000) })) }));
  }

  function loadDocs() {
    let d = load(docsKey(), null);
    if (!d && S.type && S.type.id === 'sales') {
      const old = load('docs', null);
      if (old) d = Object.assign({}, old, { briefs: { other: (old.briefs || {}).account || '', ours: (old.briefs || {}).team || '' } });
    }
    d = d || {};
    S.docs = d.docs || [];
    S.briefs = d.briefs || { other: '', ours: '' };
    S.glossary = d.glossary || [];
    S.checklist = (d.checklist || []).map((q, i) => ({ id: 'g' + (i + 1), q, asked: false }));
    S.shown = new Set(S.known.map(norm));
    buildMatchers();
  }

  function renderDocs() {
    els.docCount.textContent = S.docs.length;
    els.docList.innerHTML = '';
    S.docs.forEach((d) => {
      const tagI = tagInfo(d.tag);
      const li = document.createElement('li');
      li.innerHTML = '<span class="name"></span><span class="tag"></span><button class="btn small" type="button">Remove</button>';
      li.querySelector('.name').textContent = d.name;
      const tag = li.querySelector('.tag');
      tag.textContent = tagI.label;
      if (tagI.side === 'ours') tag.classList.add('team');
      li.querySelector('button').onclick = () => {
        S.docs = S.docs.filter((x) => x.id !== d.id);
        saveDocs();
        renderDocs();
        els.prepareMsg.textContent = 'Documents changed. Click Prepare for the call to update.';
      };
      els.docList.appendChild(li);
    });
    if (!S.docs.length) els.docList.innerHTML = '<li class="empty-small">No documents yet. Add files above.</li>';
    els.otherBrief.textContent = S.briefs.other || 'Not prepared yet.';
    els.ourBrief.textContent = S.briefs.ours || 'Not prepared yet.';
    els.termCount.textContent = S.glossary.length;
    els.termList.textContent = S.glossary.map((g) => `${g.term}: ${g.explanation}`).join('\n') || 'Not prepared yet.';
  }

  async function pdfText(file) {
    if (!window.pdfjsLib) throw new Error('The PDF reader did not load. Check your connection and try again.');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 80); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => it.str).join(' '));
    }
    return pages.join('\n\n');
  }

  async function addFiles(files) {
    const tag = els.docTag.value;
    for (const file of files) {
      els.prepareMsg.textContent = 'Reading ' + file.name + '…';
      try {
        const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
        const text = isPdf ? await pdfText(file) : await file.text();
        if (!text.trim()) throw new Error('no readable text (scanned PDFs are not supported)');
        S.docs.push({ id: Date.now() + Math.random(), name: file.name, tag, text: text.slice(0, 60000) });
      } catch (e) {
        els.prepareMsg.textContent = `Could not read ${file.name}: ${e.message}`;
        renderDocs();
        return;
      }
    }
    saveDocs();
    renderDocs();
    els.prepareMsg.textContent = 'Added. Click Prepare for the call to build the briefs and term map.';
  }

  async function prepare() {
    if (!S.docs.length) { els.prepareMsg.textContent = 'Add at least one document first.'; return; }
    els.prepareBtn.disabled = true;
    els.prepareBtn.textContent = 'Preparing…';
    els.prepareMsg.textContent = 'This can take 10 to 40 seconds.';
    const t0 = now();
    try {
      const d = await api('prepare', {
        meetingType: S.meetingType,
        otherLabel: otherLabel(),
        docTags: S.type.docTags || [],
        skill: S.skill,
        model: MODEL_OVERRIDE,
        docs: S.docs.map((x) => ({ name: x.name, tag: x.tag, text: x.text })),
      });
      S.briefs = { other: d.otherBrief, ours: d.ourBrief };
      S.glossary = d.glossary || [];
      S.checklist = (d.checklist || []).map((q, i) => ({ id: 'g' + (i + 1), q, asked: false }));
      buildMatchers();
      saveDocs();
      renderDocs();
      renderGuide();
      const n = S.checklist.length;
      const g = S.glossary.length;
      els.prepareMsg.textContent = `Ready: ${g} term${g === 1 ? '' : 's'} and ${n} guide question${n === 1 ? '' : 's'} (${fmt(Math.round(now() - t0))}).`;
    } catch (e) {
      els.prepareMsg.textContent = 'Prepare failed: ' + e.message;
    } finally {
      els.prepareBtn.disabled = false;
      els.prepareBtn.textContent = 'Prepare for the call';
    }
  }

  // ---------- Wire up ----------
  els.lockForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.lockMsg.textContent = '';
    try { await unlock(els.passcode.value.trim()); } catch (err) { els.lockMsg.textContent = err.message; }
  });
  els.logoutBtn.onclick = () => lockApp('');
  els.startBtn.onclick = startLive;
  els.testFile.onchange = () => { const f = els.testFile.files[0]; els.testFile.value = ''; if (f) startTest(f); };
  els.stopBtn.onclick = () => stopAll();
  els.askBtn.onclick = () => {
    if (!S.finals.length && !liveTail().length) { info('Nothing to work from yet. Start a call or test first.'); return; }
    runQuestions(now(), true);
  };
  els.docsBtn.onclick = () => { els.drawer.hidden = false; renderDocs(); };
  els.closeDrawer.onclick = () => { els.drawer.hidden = true; };
  els.docFiles.onchange = () => { const f = Array.from(els.docFiles.files); els.docFiles.value = ''; if (f.length) addFiles(f); };
  els.prepareBtn.onclick = prepare;
  els.meetingType.onchange = () => { if (!S.running) applyType(els.meetingType.value); };
  els.copyLog.onclick = copyLog;
  els.exportBtn.onclick = downloadExport;
  els.copyRecap.onclick = () => copyText(S.recap, 'Recap copied. Paste it into your CRM or notes.');
  els.debugToggle.onchange = () => setDebug(els.debugToggle.checked);
  els.transcript.addEventListener('scroll', updateJump, { passive: true });
  els.jumpLive.onclick = () => { els.transcript.scrollTop = els.transcript.scrollHeight; updateJump(); };
  els.contextMode.onchange = () => { S.contextMode = els.contextMode.value; store('contextMode', S.contextMode); renderLatency(); };
  els.qGap.onchange = () => { const v = Math.max(2, Math.min(60, Number(els.qGap.value) || 8)); els.qGap.value = v; S.qGapMs = v * 1000; store('qGap', v); };
  els.qModel.onchange = () => { S.qQuality = els.qModel.value; store('qModel', S.qQuality); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') els.drawer.hidden = true; });

  // Start-up
  S.contextMode = load('contextMode', 'hybrid');
  els.contextMode.value = S.contextMode;
  S.qQuality = load('qModel', 'fast');
  els.qModel.value = S.qQuality;
  const gap = load('qGap', 8);
  els.qGap.value = gap;
  S.qGapMs = gap * 1000;
  S.known = load('known', []);
  setDebug(load('debug', false) || EVAL);
  loadTypes();
  const saved = load('passcode', '');
  if (saved) unlock(saved).catch(() => lockApp(''));

  // Hooks for the eval runner and quick checks in the browser console.
  window.__signal = { S, CONFIG, onTurn, exportSession, applyType, renderGuide, runQuestions, trace };
})();
