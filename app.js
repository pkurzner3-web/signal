// Signal: live meeting copilot. Browser side.
// Flow: audio -> AssemblyAI (live transcript) -> term map + Gemini (concept cards, questions).

(function () {
  'use strict';

  // ---------- Settings you can tweak ----------
  const CONFIG = {
    speechModel: 'assemblyai-stt-3-7-realtime', // AssemblyAI model that supports speaker labels
    turnMode: 'min_latency',                     // AssemblyAI end-of-turn speed: min_latency | balanced | max_accuracy
    windowSeconds: 90,                           // how much recent conversation the AI sees (hybrid mode)
    summaryEverySeconds: 90,                     // how often the running summary refreshes
    questionDelayMs: 600,                        // wait after the other side stops before asking for questions
    minWordsForConcepts: 5,
    liveConceptWords: 18,                        // while someone is still talking: check for new terms every ~18 new words
    liveConceptGapMs: 4000,                      //   but no more often than every 4 s
    liveQuestionWords: 45,                       // while the other side is still talking: refresh questions every ~45 new words
  };

  // ---------- State ----------
  const S = {
    passcode: '',
    running: false,
    mode: null, // 'live' | 'test'
    contextMode: 'hybrid',
    qGapMs: 8000,
    qQuality: 'fast',
    cLastAt: 0,
    meetingType: 'Sales discovery',
    types: [],            // call types from skills/index.json
    type: null,           // current call type
    skillTexts: {},       // file -> text
    activeSkills: [],     // files switched on for the current type
    skill: '',
    checklist: [],        // guide questions: { id, q, asked }
    sources: {},          // name -> { ws, node, stream, startWall, letters:Set }
    audioCtx: null,
    turns: new Map(),     // key -> turn object
    finals: [],           // finalized turns in order
    docs: [],             // { id, name, tag, text }
    briefs: { other: '', ours: '' },
    glossary: [],
    matchers: [],
    shown: new Set(),     // normalized terms already shown as cards
    summary: '',
    summaryIndex: 0,
    summaryAt: 0,
    summaryBusy: false,
    q: { ctl: null, lastAt: 0, timer: null, current: [] },
    cQueue: [],
    cBusy: false,
    lat: [],              // { at, metric, ms, mode }
    models: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {};
  ['lock', 'lockForm', 'passcode', 'lockMsg', 'app', 'liveDot', 'meetingType', 'startBtn', 'testFile', 'testLabel', 'stopBtn', 'askBtn',
   'docsBtn', 'docCount', 'contextMode', 'qModel', 'qGap', 'setupStatus', 'logoutBtn', 'status', 'testAudio', 'transcript', 'transcriptEmpty',
   'sourceHint', 'jumpLive', 'questions', 'qState', 'qHistory', 'concepts', 'latGrid', 'modelInfo', 'copyLog', 'drawer', 'closeDrawer', 'docTag',
   'docFiles', 'docList', 'prepareBtn', 'prepareMsg', 'otherBrief', 'ourBrief', 'otherBriefLabel', 'ourBriefLabel', 'termCount', 'termList',
   'setupIntro', 'skillList', 'docHelp', 'checklistCount', 'checklistText', 'guideBlock', 'guideDetails', 'guideCount', 'guideList'].forEach((id) => { els[id] = $(id); });

  // ---------- Small helpers ----------
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const words = (s) => (String(s || '').trim().match(/\S+/g) || []).length;
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const now = () => performance.now();
  const lastWords = (s, k) => String(s || '').trim().split(/\s+/).slice(-k).join(' ');

  function setStatus(msg, kind) {
    els.status.textContent = msg || '';
    els.status.className = 'status' + (kind === 'info' ? ' info' : '');
  }

  function store(key, value) {
    try { localStorage.setItem('signal.' + key, JSON.stringify(value)); return true; } catch { return false; }
  }
  function load(key, fallback) {
    try { const v = localStorage.getItem('signal.' + key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  }

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
    const line = (ok, text) => `<div class="${ok ? 'good' : 'bad'}">${ok ? '✓' : '✗'} ${text}</div>`;
    els.setupStatus.innerHTML =
      line(st.assemblyai, 'AssemblyAI key') +
      line(st.gemini && st.models, 'Gemini key' + (st.models ? ` (fast: ${st.models.fast}, smart: ${st.models.smart})` : '')) +
      (st.problem ? `<div class="bad">${escapeHtml(st.problem)}</div>` : '');
    els.modelInfo.textContent = st.models ? `Models: ${st.models.fast} / ${st.models.smart}` : '';
    if (st.problem) setStatus('Setup problem: ' + st.problem);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Call types and skills ----------
  function otherLabel() { return (S.type && S.type.otherLabel) || 'Other side'; }
  function tagInfo(id) { return ((S.type && S.type.docTags) || []).find((t) => t.id === id) || { id, label: id, side: 'other' }; }
  function sideTag(side) { return ((S.type && S.type.docTags) || []).find((t) => t.side === side) || { label: side === 'ours' ? 'Our side' : 'Other side' }; }

  function skillMeta(text) {
    const name = (text.match(/^name:\s*(.+)$/m) || [])[1] || 'Skill';
    const goal = (text.match(/^Goal:\s*(.+)$/m) || [])[1] || '';
    const g = goal.trim();
    return { name: name.trim(), goal: g ? g[0].toUpperCase() + g.slice(1) : '' };
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
    // Skills: load text once, remember which are switched on per call type
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

  function pendingGuide() { return S.checklist.filter((x) => !x.asked); }

  async function checkCoverage(t) {
    const pending = pendingGuide();
    if (!pending.length || words(t.text) < 4) return;
    if (S.mode === 'live' && t.src !== 'you') return; // only count questions you ask
    try {
      const d = await api('analyze', {
        mode: 'coverage',
        meetingType: S.meetingType,
        items: pending.map((x) => ({ id: x.id, q: x.q })),
        said: t.text,
      });
      const hit = new Set(d.covered || []);
      if (!hit.size) return;
      S.checklist.forEach((x) => { if (hit.has(x.id)) x.asked = true; });
      renderGuide();
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

  function wsUrl(token, labels) {
    const p = new URLSearchParams({
      token,
      speech_model: CONFIG.speechModel,
      sample_rate: '16000',
      encoding: 'pcm_s16le',
      mode: CONFIG.turnMode,
    });
    if (labels) { p.set('speaker_labels', 'true'); p.set('max_speakers', '4'); }
    return 'wss://streaming.assemblyai.com/v3/ws?' + p.toString();
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

    const src = { name, node, sourceNode, sink, ws: null, startWall: 0, letters: new Set(), open: false, ...extra };
    S.sources[name] = src;

    const ws = new WebSocket(wsUrl(token, labels));
    ws.binaryType = 'arraybuffer';
    src.ws = ws;
    ws.onopen = () => { src.open = true; };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'Turn') onTurn(name, m);
      else if (m.type === 'Begin') {
        const cfg = m.configuration || {};
        if (cfg.model && cfg.model !== CONFIG.speechModel) console.warn('AssemblyAI used model', cfg.model);
      } else if (m.type === 'Error') {
        setStatus(`Transcription error (${name}): ${m.error || m.error_code}`);
      }
    };
    ws.onerror = () => setStatus(`Lost the transcription connection for ${labelForSource(name)}.`);
    ws.onclose = (ev) => {
      src.open = false;
      if (S.running && ev.code !== 1000 && ev.code !== 1005) setStatus(`Transcription stopped for ${labelForSource(name)} (code ${ev.code}${ev.reason ? ': ' + ev.reason : ''}).`);
    };
    node.port.onmessage = (ev) => {
      if (ws.readyState !== 1) return;
      if (!src.startWall) src.startWall = Date.now();
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
    setStatus('Starting… pick the call tab and tick “Share tab audio”.', 'info');
    try {
      await ensureAudio();
      const token = await getToken();

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
          setStatus('No tab audio was shared. Stop, then start again and tick “Share tab audio”. Continuing with your mic only.');
        }
      } catch {
        tabStream = null;
        setStatus('Tab sharing was skipped. Continuing with your mic only.');
      }

      let micStream = null;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        micStream = null;
      }

      if (!tabStream && !micStream) throw new Error('Signal needs your mic or a shared tab to listen.');

      S.mode = 'live';
      S.running = true;
      if (micStream) connectSource('you', S.audioCtx.createMediaStreamSource(micStream), token, false, { stream: micStream });
      if (tabStream) {
        const audioOnly = new MediaStream(tabStream.getAudioTracks());
        connectSource('other', S.audioCtx.createMediaStreamSource(audioOnly), token, true, { stream: tabStream });
        tabStream.getAudioTracks()[0].addEventListener('ended', () => { if (S.running) stopAll('Tab sharing ended.'); });
      }
      if (tabStream && micStream) setStatus('');
      els.sourceHint.textContent = [micStream ? 'Mic is You' : '', tabStream ? 'tab is ' + otherLabel() : ''].filter(Boolean).join(', ');
      setRunningUi(true);
    } catch (e) {
      stopAll();
      setStatus(e.message || 'Could not start.');
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
      if (!S.fileNode) S.fileNode = S.audioCtx.createMediaElementSource(audio); // one per audio element, reused
      S.fileNode.disconnect();
      S.fileNode.connect(S.audioCtx.destination); // so you can hear it
      S.mode = 'test';
      S.running = true;
      connectSource('file', S.fileNode, token, true, { keepNode: true });
      audio.onended = () => setTimeout(() => stopAll('Test file finished.'), 1500);
      setRunningUi(true);
      els.sourceHint.textContent = 'Test mode: speakers labeled A, B…';
      setStatus('Test mode: playing ' + file.name, 'info');
      await audio.play();
    } catch (e) {
      stopAll();
      setStatus(e.message || 'Could not start test mode.');
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
    S.sources = {};
    if (S.mode === 'test') { try { els.testAudio.pause(); } catch {} }
    if (S.fileNode) { try { S.fileNode.disconnect(); S.fileNode.connect(S.audioCtx.destination); } catch {} }
    clearTimeout(S.q.timer);
    setRunningUi(false);
    if (wasRunning) setStatus(msg || 'Stopped.', 'info');
  }

  function setRunningUi(on) {
    els.startBtn.hidden = on;
    els.testLabel.hidden = on;
    els.stopBtn.hidden = !on;
    els.meetingType.disabled = on;
    els.liveDot.classList.toggle('live', on);
    if (!on && S.checklist.length) els.guideDetails.open = true; // show what was covered after the call
  }

  function resetSession() {
    S.turns.clear();
    S.finals = [];
    S.shown = new Set();
    S.summary = '';
    S.summaryIndex = 0;
    S.summaryAt = Date.now();
    S.q.current = [];
    S.cQueue = [];
    S.checklist.forEach((x) => { x.asked = false; });
    renderGuide();
    if (S.q.ctl) S.q.ctl.abort();
    els.transcript.innerHTML = '';
    els.concepts.innerHTML = '<p class="empty-small">Technical terms are explained here as they come up.</p>';
    els.questions.innerHTML = `<p class="empty-small">Questions appear when the ${otherLabel().toLowerCase()} stops talking.</p>`;
    els.qHistory.innerHTML = '';
    els.qState.textContent = '';
  }

  // ---------- Transcript ----------
  function speakerLabel(t, speaker) {
    if (t.src === 'you') return 'You';
    const sp = speaker || t.speaker;
    const src = S.sources[t.src];
    const letters = src ? src.letters.size : 0;
    const base = t.src === 'file' ? 'Speaker' : otherLabel();
    if (sp && sp !== 'PENDING' && (t.src === 'file' || letters > 1)) return base + ' ' + sp;
    return base;
  }

  // Splits one turn into speaker segments using AssemblyAI's per-word speaker labels,
  // so two people talking without a pause still show as two speakers.
  function segmentsFrom(m, fallback) {
    const ws = Array.isArray(m.words) ? m.words : [];
    if (!ws.some((w) => w.speaker && w.speaker !== 'PENDING')) return null;
    const segs = [];
    for (const w of ws) {
      const known = w.speaker && w.speaker !== 'PENDING' ? w.speaker : null;
      const last = segs[segs.length - 1];
      const sp = known || (last ? last.speaker : null);
      if (!last || (known && last.speaker && known !== last.speaker)) segs.push({ speaker: sp, words: [w.text] });
      else { if (!last.speaker) last.speaker = sp; last.words.push(w.text); }
    }
    // Fold tiny fragments (1 to 2 words) into the previous segment to avoid flicker.
    const merged = [];
    for (const sg of segs) {
      const prev = merged[merged.length - 1];
      if (prev && (sg.words.length < 3 || prev.speaker === sg.speaker)) prev.words.push(...sg.words);
      else merged.push({ speaker: sg.speaker || fallback, words: sg.words.slice() });
    }
    return merged.map((x) => ({ speaker: x.speaker || fallback, text: x.words.join(' ') }));
  }

  function onTurn(srcName, m) {
    const key = srcName + ':' + m.turn_order;
    let t = S.turns.get(key);
    if (!t) {
      t = { key, src: srcName, text: '', speaker: null, final: false, el: null };
      S.turns.set(key, t);
    }
    const text = (m.transcript || m.utterance || '').trim();
    if (text) t.text = text;
    if (m.speaker_label) t.speaker = m.speaker_label;
    if (srcName !== 'you') {
      const segs = segmentsFrom(m, t.speaker);
      if (segs) t.segments = segs;
      const src = S.sources[srcName];
      const seen = [t.speaker].concat((t.segments || []).map((x) => x.speaker));
      if (src) {
        const before = src.letters.size;
        seen.forEach((l) => { if (l && l !== 'PENDING') src.letters.add(l); });
        if (before < 2 && src.letters.size >= 2) S.turns.forEach((x) => { if (x.src === srcName && x !== t) renderTurn(x); }); // relabel earlier turns
      }
    }
    renderTurn(t);
    if (!m.end_of_turn && !t.final && t.text) onPartial(t);

    if (m.end_of_turn && !t.final) {
      t.final = true;
      t.wall = Date.now();
      const w = m.words || [];
      const src = S.sources[srcName];
      if (w.length && src && src.startWall) {
        const ms = Date.now() - (src.startWall + w[w.length - 1].end);
        if (ms > 0 && ms < 30000) recordLat('transcript', ms);
      }
      renderTurn(t);
      if (t.text) onFinalTurn(t);
    }
  }

  function renderTurn(t) {
    if (!t.text) return;
    const intro = document.getElementById('transcriptEmpty');
    if (intro) intro.remove();
    if (!t.el) {
      t.el = document.createElement('div');
      els.transcript.appendChild(t.el);
    }
    const nearBottom = els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight < 80;
    t.el.className = 'turn-group' + (t.final ? '' : ' partial');
    const parts = t.segments && t.segments.length > 1 ? t.segments : [{ speaker: t.speaker, text: t.text }];
    t.el.innerHTML = '';
    parts.forEach((part) => {
      const row = document.createElement('div');
      row.className = 'turn';
      row.innerHTML = '<span class="who"></span><p class="text"></p>';
      row.firstChild.textContent = speakerLabel(t, part.speaker);
      row.firstChild.className = 'who ' + (t.src === 'you' ? 'you' : 'other');
      row.lastChild.textContent = part.text;
      t.el.appendChild(row);
    });
    if (nearBottom) els.transcript.scrollTop = els.transcript.scrollHeight;
    updateJump();
  }

  // "Jump to live" appears when you scroll up during a call.
  function updateJump() {
    const away = els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight > 120;
    els.jumpLive.hidden = !(S.running && away);
  }

  function lineOf(t) {
    if (t.segments && t.segments.length > 1) return t.segments.map((x) => speakerLabel(t, x.speaker) + ': ' + x.text).join('\n');
    return speakerLabel(t) + ': ' + t.text;
  }

  function liveTail() {
    const out = [];
    S.turns.forEach((t) => { if (!t.final && t.text) out.push(t); });
    return out;
  }

  function recentWindow() {
    const cutoff = Date.now() - CONFIG.windowSeconds * 1000;
    let list = S.finals.filter((t) => t.wall >= cutoff);
    if (list.length < 4) list = S.finals.slice(-4);
    return list.concat(liveTail()).map(lineOf).join('\n');
  }

  function fullTranscript() { return S.finals.concat(liveTail()).map(lineOf).join('\n'); }

  // While someone is still talking: explain terms and refresh questions without waiting for them to stop.
  function onPartial(t) {
    const t0 = now();
    glossaryCards(t.text, t0);
    const n = words(t.text);
    if (n - (t.aiWords || 0) >= CONFIG.liveConceptWords && Date.now() - S.cLastAt >= CONFIG.liveConceptGapMs) {
      const seg = lastWords(t.text, n - (t.aiWords || 0));
      t.aiWords = n;
      S.cQueue.push({ text: seg, t0 });
      pumpConcepts();
    }
    const counts = otherSideActive() ? t.src !== 'you' : true;
    if (counts && n - (t.qWords || 0) >= CONFIG.liveQuestionWords && !S.q.inflight && Date.now() - S.q.lastAt >= S.qGapMs) {
      t.qWords = n;
      runQuestions(t0);
    }
  }

  function onFinalTurn(t) {
    S.finals.push(t);
    const t0 = now();
    conceptsFor(t, t0);
    maybeQuestions(t, t0);
    maybeSummary();
    checkCoverage(t);
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

  function glossaryCards(text, t0) {
    if (S.contextMode !== 'hybrid') return;
    for (const { g, re } of S.matchers) {
      const k = norm(g.term);
      if (S.shown.has(k) || !re.test(text)) continue;
      S.shown.add(k);
      addCard(g, 'docs');
      recordLat('card_docs', now() - t0);
    }
  }

  function conceptsFor(t, t0) {
    glossaryCards(t.text, t0);
    const n = words(t.text);
    const remaining = n - (t.aiWords || 0);
    if (remaining < CONFIG.minWordsForConcepts) return;
    t.aiWords = n;
    S.cQueue.push({ text: lastWords(t.text, remaining), t0 });
    pumpConcepts();
  }

  async function pumpConcepts() {
    if (S.cBusy || !S.cQueue.length) return;
    S.cBusy = true;
    S.cLastAt = Date.now();
    const batch = S.cQueue.splice(0);
    const t0 = batch[0].t0;
    try {
      const known = Array.from(S.shown).concat(S.contextMode === 'hybrid' ? S.glossary.map((g) => g.term) : []).slice(-300);
      const d = await api('analyze', {
        mode: 'concepts',
        otherLabel: otherLabel(),
        contextMode: S.contextMode,
        meetingType: S.meetingType,
        skill: S.skill,
        latest: batch.map((b) => b.text).join(' '),
        context: S.contextMode === 'full' ? fullTranscript() : recentWindow(),
        known,
      });
      for (const c of d.cards || []) {
        const k = norm(c.term);
        if (S.shown.has(k)) continue;
        S.shown.add(k);
        addCard(c, 'ai');
        recordLat('card_ai', now() - t0);
      }
    } catch (e) {
      if (e.status === 429) setStatus('Gemini free-tier limit reached for a moment. Cards will resume shortly.');
      else setStatus('Concept cards failed: ' + e.message);
    } finally {
      S.cBusy = false;
      if (S.cQueue.length && S.running) pumpConcepts();
    }
  }

  function addCard(c, source) {
    const empty = els.concepts.querySelector('.empty-small');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = '<div class="term"><span></span><span class="src"></span></div><p class="exp"></p><p class="why"></p>';
    el.querySelector('.term span').textContent = c.term;
    const src = el.querySelector('.src');
    src.textContent = source === 'docs' ? 'From your docs' : 'AI';
    src.classList.add(source);
    el.querySelector('.exp').textContent = c.explanation;
    el.querySelector('.why').textContent = c.why || '';
    els.concepts.prepend(el);
    while (els.concepts.children.length > 40) els.concepts.lastChild.remove();
  }

  // ---------- Follow-up questions ----------
  function otherSideActive() { return Boolean(S.sources.other || S.sources.file); }

  function maybeQuestions(t, t0) {
    const fromOther = t.src !== 'you';
    if (otherSideActive() ? !fromOther : words(t.text) < 6) return;
    clearTimeout(S.q.timer);
    const wait = Math.max(CONFIG.questionDelayMs, S.q.lastAt + S.qGapMs - Date.now());
    S.q.timer = setTimeout(() => runQuestions(t0), wait);
  }

  function parseQuestions(text) {
    const out = [];
    text.split('\n').forEach((line) => {
      const m = line.match(/^\s*(\d)[.)]\s*(.+)$/);
      if (!m) return;
      let body = m[2].trim();
      const guide = /^\[guide\]\s*/i.test(body);
      body = body.replace(/^\[guide\]\s*/i, '');
      const parts = body.split('::');
      out.push({ q: parts[0].trim(), why: (parts[1] || '').trim(), guide });
    });
    return out.slice(0, 3);
  }

  function renderQuestions(list, streaming) {
    els.questions.classList.toggle('streaming', streaming);
    els.questions.innerHTML = '';
    if (!list.length) {
      els.questions.innerHTML = streaming
        ? '<p class="empty-small">Thinking…</p>'
        : '<p class="empty-small">No questions yet. They refresh when the other side stops talking, or click Ask now.</p>';
      return;
    }
    list.forEach((item) => els.questions.appendChild(questionEl(item)));
  }

  function questionEl(item) {
    const el = document.createElement('div');
    el.className = 'q';
    el.innerHTML = '<p></p><div class="why"></div>';
    el.firstChild.textContent = item.q;
    el.lastChild.textContent = item.guide ? 'From your guide' + (item.why ? ': ' + item.why : '') : item.why;
    if (item.guide) el.classList.add('from-guide');
    return el;
  }

  async function runQuestions(t0) {
    if (!S.finals.length && !liveTail().length) return;
    if (S.q.ctl) S.q.ctl.abort();
    const ctl = new AbortController();
    S.q.ctl = ctl;
    S.q.inflight = true;
    S.q.lastAt = Date.now();
    const start = t0 || now();
    if (S.q.current.length) {
      const frag = document.createDocumentFragment();
      S.q.current.forEach((item) => frag.appendChild(questionEl(item)));
      els.qHistory.prepend(frag);
      while (els.qHistory.children.length > 12) els.qHistory.lastChild.remove();
    }
    els.qState.textContent = 'thinking…';
    try {
      const r = await api('analyze', {
        mode: 'questions',
        contextMode: S.contextMode,
        meetingType: S.meetingType,
        skill: S.skill,
        otherLabel: otherLabel(),
        otherBrief: S.briefs.other,
        ourBrief: S.briefs.ours,
        guide: pendingGuide().map((x) => x.q),
        summary: S.contextMode === 'full' ? '' : S.summary,
        recent: S.contextMode === 'full' ? fullTranscript() : recentWindow(),
        asked: S.q.current.map((x) => x.q),
        quality: S.qQuality,
      }, { stream: true, signal: ctl.signal });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let text = '';
      let first = true;
      renderQuestions([], true);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        if (first && chunk.trim()) { recordLat('q_first', now() - start); first = false; }
        text += chunk;
        const parsed = parseQuestions(text);
        if (parsed.length) renderQuestions(parsed, true);
      }
      if (ctl.signal.aborted) return;
      recordLat('q_done', now() - start);
      if (/failed|busy|limit/i.test(els.status.textContent)) setStatus('');
      S.q.current = parseQuestions(text);
      renderQuestions(S.q.current, false);
      els.qState.textContent = '';
    } catch (e) {
      if (e.name === 'AbortError') return;
      els.qState.textContent = '';
      if (e.status === 429) setStatus('Gemini is busy or at its free-tier limit. Try “Ask now” in a few seconds.');
      else setStatus('Questions failed: ' + e.message);
      renderQuestions(S.q.current, false);
    } finally {
      if (S.q.ctl === ctl) S.q.inflight = false;
    }
  }

  // ---------- Running summary ----------
  async function maybeSummary() {
    if (S.contextMode !== 'hybrid' || S.summaryBusy) return;
    if (Date.now() - S.summaryAt < CONFIG.summaryEverySeconds * 1000) return;
    if (S.finals.length - S.summaryIndex < 3) return;
    S.summaryBusy = true;
    const upTo = S.finals.length;
    try {
      const d = await api('analyze', {
        mode: 'summary',
        meetingType: S.meetingType,
        skill: '',
        previous: S.summary,
        transcript: S.finals.slice(S.summaryIndex, upTo).map(lineOf).join('\n'),
      });
      S.summary = d.summary || S.summary;
      S.summaryIndex = upTo;
      S.summaryAt = Date.now();
    } catch (e) {
      console.warn('summary', e);
    } finally {
      S.summaryBusy = false;
    }
  }

  // ---------- Latency readout ----------
  const METRICS = [
    ['transcript', 'Transcript'],
    ['card_docs', 'Card from docs'],
    ['card_ai', 'Card from AI'],
    ['q_first', 'Questions start'],
    ['q_done', 'Questions done'],
  ];

  function recordLat(metric, ms) {
    S.lat.push({ at: new Date().toISOString(), metric, ms: Math.round(ms), mode: S.contextMode });
    if (S.lat.length > 2000) S.lat.shift();
    renderLatency();
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  }

  function fmt(ms) { return ms == null ? '–' : ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s'; }

  function renderLatency() {
    els.latGrid.innerHTML = METRICS.map(([key, label]) => {
      const vals = S.lat.filter((x) => x.metric === key && x.mode === S.contextMode).slice(-10).map((x) => x.ms);
      return `<span>${label} <b>${fmt(median(vals))}</b></span>`;
    }).join('') + `<span class="hint">Median of last 10, ${S.contextMode === 'full' ? 'full transcript' : 'hybrid'}</span>`;
  }

  async function copyLog() {
    const csv = ['time,metric,ms,context_mode'].concat(S.lat.map((x) => [x.at, x.metric, x.ms, x.mode].join(','))).join('\n');
    try {
      await navigator.clipboard.writeText(csv);
      setStatus(`Copied ${S.lat.length} latency rows. Paste into a spreadsheet.`, 'info');
    } catch {
      setStatus('Could not copy. Your browser blocked the clipboard.');
    }
  }

  // ---------- Documents (kept per call type, in this browser) ----------
  function docsKey() { return 'docs.' + (S.type ? S.type.id : 'sales'); }

  function saveDocs() {
    const payload = { docs: S.docs, briefs: S.briefs, glossary: S.glossary, checklist: S.checklist.map((x) => x.q) };
    if (!store(docsKey(), payload)) {
      store(docsKey(), { ...payload, docs: S.docs.map((d) => ({ ...d, text: d.text.slice(0, 20000) })) });
    }
  }

  function loadDocs() {
    let d = load(docsKey(), null);
    if (!d && S.type && S.type.id === 'sales') {
      const old = load('docs', null); // documents saved before call types existed
      if (old) d = { ...old, briefs: { other: (old.briefs || {}).account || '', ours: (old.briefs || {}).team || '' } };
    }
    d = d || {};
    S.docs = d.docs || [];
    S.briefs = d.briefs || { other: '', ours: '' };
    S.glossary = d.glossary || [];
    S.checklist = (d.checklist || []).map((q, i) => ({ id: 'g' + (i + 1), q, asked: false }));
    S.shown = new Set();
    buildMatchers();
  }

  function renderDocs() {
    els.docCount.textContent = S.docs.length;
    els.docList.innerHTML = '';
    S.docs.forEach((d) => {
      const info = tagInfo(d.tag);
      const li = document.createElement('li');
      li.innerHTML = '<span class="name"></span><span class="tag"></span><button class="btn small" type="button">Remove</button>';
      li.querySelector('.name').textContent = d.name;
      const tag = li.querySelector('.tag');
      tag.textContent = info.label;
      if (info.side === 'ours') tag.classList.add('team');
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
    els.prepareMsg.textContent = 'Added. Click Prepare to build the briefs and term map.';
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
  els.askBtn.onclick = () => { if (!S.finals.length && !liveTail().length) { setStatus('Nothing to work from yet. Start a call or test first.', 'info'); return; } runQuestions(); };
  els.docsBtn.onclick = () => { els.drawer.hidden = false; renderDocs(); };
  els.closeDrawer.onclick = () => { els.drawer.hidden = true; };
  els.docFiles.onchange = () => { const f = Array.from(els.docFiles.files); els.docFiles.value = ''; if (f.length) addFiles(f); };
  els.prepareBtn.onclick = prepare;
  els.meetingType.onchange = () => { if (!S.running) applyType(els.meetingType.value); };
  els.copyLog.onclick = copyLog;
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
  renderLatency();
  loadTypes();
  const saved = load('passcode', '');
  if (saved) unlock(saved).catch(() => lockApp(''));

  // Exposed for quick checks in the browser console.
  window.__signal = { S, parseQuestions, buildMatchers, onTurn, applyType, renderGuide, CONFIG };
})();
