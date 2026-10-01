(() => {
  const storageKey = 'hibi-journal.entries.v1';
  const ownerStorageKey = 'hibi-journal.owner.v1';
  const syncQueueStorageKey = 'hibi-journal.sync-queue.v1';
  const maxSyncUrlLength = 6000;
  const retryIntervalMs = 30000;
  const gasEndpoint = 'https://script.google.com/macros/s/AKfycbyyjZigB9NvChT9dhJHPZ1xTsaqlR2QvKFYGqK1KASHZEIg85gTOGQ6pEWxUaK8uCL0/exec';
  const moods = {
    great: { label: '最高', symbol: '☀' },
    good: { label: 'いい感じ', symbol: '☺' },
    okay: { label: 'ふつう', symbol: '◡' },
    low: { label: 'いまひとつ', symbol: '☁' },
    tough: { label: 'たいへん', symbol: '☂' },
  };

  const form = document.querySelector('#entry-form');
  const dateInput = document.querySelector('#entry-date');
  const titleInput = document.querySelector('#entry-title');
  const contentInput = document.querySelector('#entry-content');
  const list = document.querySelector('#entry-list');
  const searchInput = document.querySelector('#search');
  const saveMessage = document.querySelector('#save-message');
  const saveState = document.querySelector('#save-state');
  const deleteButton = document.querySelector('#delete-entry');
  const toast = document.querySelector('#toast');
  const atmosphereCard = document.querySelector('#atmosphere');
  const atmospherePatterns = ['soft', 'wave', 'burst', 'rain', 'calm'];
  let entries = loadEntries();
  let syncQueue = loadSyncQueue();
  let ownerId = loadOwnerId();
  let selectedDate = '';
  let toastTimer;
  let syncInFlight = false;
  let currentAtmosphere = null;
  let atmosphereTimer;

  function localDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function loadEntries() {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || '[]');
      return Array.isArray(stored) ? stored.filter((entry) => entry && typeof entry.date === 'string') : [];
    } catch {
      return [];
    }
  }

  function loadOwnerId() {
    try {
      const stored = localStorage.getItem(ownerStorageKey);
      if (stored && /^[A-Za-z0-9-]{16,80}$/.test(stored)) return stored;
      const generated = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(ownerStorageKey, generated);
      return generated;
    } catch {
      return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    }
  }

  function loadSyncQueue() {
    try {
      const stored = JSON.parse(localStorage.getItem(syncQueueStorageKey) || '[]');
      return Array.isArray(stored) ? stored.filter((item) => item && ['save', 'delete'].includes(item.action) && item.entry && typeof item.entry.date === 'string') : [];
    } catch {
      return [];
    }
  }

  function persistSyncQueue() {
    try {
      localStorage.setItem(syncQueueStorageKey, JSON.stringify(syncQueue));
      return true;
    } catch {
      showToast('同期待ちの記録を保存できませんでした。');
      return false;
    }
  }

  function saveEntries() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(entries));
      return true;
    } catch {
      showToast('保存できませんでした。ブラウザーの空き容量をご確認ください。');
      return false;
    }
  }

  function formatDate(date, options) {
    return new Intl.DateTimeFormat('ja-JP', options).format(new Date(`${date}T12:00:00`));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function sortedEntries() {
    return [...entries].sort((first, second) => second.date.localeCompare(first.date));
  }

  function renderList() {
    const query = searchInput.value.trim().toLocaleLowerCase('ja');
    const filtered = sortedEntries().filter((entry) => `${entry.title} ${entry.content} ${entry.date}`.toLocaleLowerCase('ja').includes(query));
    document.querySelector('#entry-count').textContent = String(entries.length);

    if (filtered.length === 0) {
      list.innerHTML = `<div class="empty-list">${query ? '見つかりませんでした。' : 'まだ日記がありません。<br>今日のことを書いてみましょう。'}</div>`;
      return;
    }

    list.innerHTML = filtered.map((entry) => {
      const mood = moods[entry.mood];
      const title = entry.title || 'タイトルなし';
      const preview = entry.content || '本文なし';
      const palette = buildAtmosphere(entry.title || '', entry.content || '', entry.mood)?.palette;
      return `<button class="entry-item" type="button" data-date="${escapeHtml(entry.date)}" aria-current="${entry.date === selectedDate}">
        <span class="entry-item-date">${formatDate(entry.date, { month: 'long', day: 'numeric', weekday: 'short' })}${mood ? `<span class="entry-item-mood" aria-label="気分: ${mood.label}">${mood.symbol}</span>` : ''}</span>
        <span class="entry-item-title">${escapeHtml(title)}</span>
        <span class="entry-item-preview">${escapeHtml(preview.replace(/\s+/g, ' '))}</span>
        ${palette ? `<span class="entry-item-palette" style="background: linear-gradient(90deg, ${palette.join(', ')})" aria-hidden="true"></span>` : ''}
      </button>`;
    }).join('');
  }

  function updateDateLabel() {
    const today = localDateString();
    document.querySelector('#date-label').textContent = selectedDate === today
      ? '今日の記録'
      : formatDate(selectedDate, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  }

  function setSavedState(isDirty, message = isDirty ? '未保存の変更' : '保存されています') {
    saveMessage.textContent = message;
    saveState.classList.toggle('is-dirty', isDirty);
  }

  function setSyncState(state, message) {
    saveMessage.textContent = message;
    saveState.classList.toggle('is-dirty', state === 'dirty' || state === 'error');
    saveState.classList.toggle('is-syncing', state === 'syncing');
  }

  function showPendingSyncState() {
    if (!syncQueue.some((item) => item.entry.date === selectedDate)) return false;
    setSyncState('error', navigator.onLine ? '同期できません。再試行待ちです' : 'オフライン：再接続時に同期します');
    return true;
  }

  function encodeBase64Url(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function enqueueSync(action, entry) {
    syncQueue = syncQueue.filter((item) => item.entry.date !== entry.date);
    syncQueue.push({ action, entry: { ...entry } });
    if (!persistSyncQueue()) return;
    if (entry.date === selectedDate) setSyncState('syncing', 'スプレッドシートへ同期中');
    flushSyncQueue();
  }

  async function flushSyncQueue() {
    if (syncInFlight || syncQueue.length === 0) return;
    if (!navigator.onLine) {
      showPendingSyncState();
      return;
    }
    syncInFlight = true;
    try {
      while (syncQueue.length > 0) {
        const operation = syncQueue[0];
        const payload = { ...operation.entry, owner_id: ownerId };
        const url = new URL(gasEndpoint);
        url.searchParams.set('mode', operation.action === 'save' ? 'save_diary' : 'delete_diary');
        url.searchParams.set('payload', encodeBase64Url(JSON.stringify(payload)));
        if (url.href.length > maxSyncUrlLength) {
          // 長文はGETで送れないため同期対象から外し、ローカル保存のみにする
          syncQueue.shift();
          persistSyncQueue();
          if (operation.entry.date === selectedDate) setSyncState('error', '長文のためシートへ同期しません（ブラウザーには保存済み）');
          showToast('日記が長いためスプレッドシートには同期しませんでした。');
          continue;
        }

        if (operation.entry.date === selectedDate) setSyncState('syncing', 'スプレッドシートへ同期中');
        const response = await fetch(url.href);
        if (!response.ok) throw new Error('GASに接続できませんでした。');
        const result = await response.json();
        if (!result.ok) throw new Error(result.message || 'スプレッドシートへ保存できませんでした。');

        syncQueue.shift();
        persistSyncQueue();
        if (operation.entry.date === selectedDate) {
          setSyncState('saved', 'スプレッドシートに同期済み');
          showToast(operation.action === 'save' ? 'スプレッドシートに日記を保存しました' : 'スプレッドシートから日記を削除しました');
        }
      }
    } catch (error) {
      const failedEntry = syncQueue[0]?.entry;
      if (failedEntry?.date === selectedDate) setSyncState('error', '同期できません。再試行待ちです');
      showToast(error.message || 'スプレッドシートに接続できません。再試行します。');
    } finally {
      syncInFlight = false;
    }
  }

  // localStorage や GAS から来た値を、SVG に埋め込んでも安全な形だけに絞る
  function sanitizeAtmosphere(value) {
    if (!value || typeof value !== 'object') return null;
    const palette = (Array.isArray(value.palette) ? value.palette : [])
      .map((color) => String(color).toLowerCase())
      .filter((color) => /^#[0-9a-f]{6}$/.test(color))
      .slice(0, 4);
    if (palette.length < 2) return null;
    return {
      palette,
      keywords: (Array.isArray(value.keywords) ? value.keywords : []).map((word) => String(word).slice(0, 12)).slice(0, 3),
      phrase: String(value.phrase || '').slice(0, 30),
      pattern: atmospherePatterns.includes(value.pattern) ? value.pattern : 'soft',
      intensity: ['low', 'medium', 'high'].includes(value.intensity) ? value.intensity : 'medium',
    };
  }

  // 同じ日記からは毎回同じ絵になるよう、日付と一言から乱数の種を作る
  function seededRandom(text) {
    let seed = 2166136261;
    for (const character of text) seed = Math.imul(seed ^ character.codePointAt(0), 16777619);
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createAtmosphereSvg(atmosphere, seedText) {
    const { palette, pattern, intensity } = atmosphere;
    const random = seededRandom(seedText);
    const level = { low: 0.6, medium: 1, high: 1.5 }[intensity];
    const color = (index) => palette[index % palette.length];
    const between = (min, max) => Number((min + random() * (max - min)).toFixed(1));
    const width = 600;
    const height = 240;
    const shapes = [];

    if (pattern === 'soft') {
      for (let i = 0; i < Math.round(14 * level); i += 1) {
        shapes.push(`<circle cx="${between(0, width)}" cy="${between(0, height)}" r="${between(18, 80)}" fill="${color(i)}" opacity="${between(0.3, 0.7)}" filter="url(#blur)"/>`);
      }
    } else if (pattern === 'wave') {
      for (let i = 0; i < 5; i += 1) {
        const baseY = 70 + i * 36;
        const amplitude = between(10, 26) * level;
        const phase = between(0, Math.PI * 2);
        const frequency = between(50, 80);
        let d = `M0 ${height}`;
        for (let x = 0; x <= width; x += 20) d += ` L${x} ${(baseY + Math.sin(x / frequency + phase) * amplitude).toFixed(1)}`;
        shapes.push(`<path d="${d} L${width} ${height} Z" fill="${color(i + 1)}" opacity="${(0.35 + i * 0.1).toFixed(2)}"/>`);
      }
    } else if (pattern === 'burst') {
      const cx = between(220, 380);
      const cy = between(90, 150);
      const rays = Math.round(18 * level);
      for (let i = 0; i < rays; i += 1) {
        const angle = (Math.PI * 2 * i) / rays + between(-0.08, 0.08);
        const length = between(120, 320);
        shapes.push(`<line x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(angle) * length).toFixed(1)}" y2="${(cy + Math.sin(angle) * length).toFixed(1)}" stroke="${color(i)}" stroke-width="${between(2, 7)}" stroke-linecap="round" opacity="${between(0.4, 0.85)}"/>`);
      }
      for (let i = 0; i < Math.round(10 * level); i += 1) {
        shapes.push(`<circle cx="${between(0, width)}" cy="${between(0, height)}" r="${between(3, 12)}" fill="${color(i + 2)}" opacity="${between(0.5, 0.9)}"/>`);
      }
      shapes.push(`<circle cx="${cx}" cy="${cy}" r="${30 * level}" fill="${color(0)}" filter="url(#blur)"/>`);
    } else if (pattern === 'rain') {
      for (let i = 0; i < Math.round(60 * level); i += 1) {
        const x = between(0, width);
        const y = between(-20, height);
        shapes.push(`<line x1="${x}" y1="${y}" x2="${x - 6}" y2="${(y + between(14, 34)).toFixed(1)}" stroke="${color(i)}" stroke-width="${between(1, 2.5)}" stroke-linecap="round" opacity="${between(0.35, 0.8)}"/>`);
      }
      for (let i = 0; i < 4; i += 1) {
        shapes.push(`<ellipse cx="${between(40, width - 40)}" cy="${between(height - 40, height - 10)}" rx="${between(20, 50)}" ry="${between(3, 6)}" fill="none" stroke="${color(i + 1)}" opacity="0.5"/>`);
      }
    } else {
      for (let i = 0; i < 4; i += 1) {
        const y = 120 + i * 30;
        shapes.push(`<rect x="0" y="${y}" width="${width}" height="${height - y}" fill="${color(i + 1)}" opacity="${(0.25 + i * 0.12).toFixed(2)}"/>`);
      }
      shapes.push(`<circle cx="${between(120, 480)}" cy="${between(60, 100)}" r="${(between(24, 34) * level).toFixed(1)}" fill="${color(0)}" opacity="0.9" filter="url(#blur)"/>`);
    }

    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color(0)}" stop-opacity="0.35"/><stop offset="1" stop-color="${color(palette.length - 1)}" stop-opacity="0.55"/></linearGradient>
        <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${pattern === 'soft' ? 14 : 8}"/></filter>
      </defs>
      <rect width="${width}" height="${height}" fill="#fffefa"/>
      <rect width="${width}" height="${height}" fill="url(#sky)"/>
      ${shapes.join('')}
    </svg>`;
  }

  function renderAtmosphere(value) {
    currentAtmosphere = sanitizeAtmosphere(value);
    atmosphereCard.hidden = !currentAtmosphere;
    if (!currentAtmosphere) return;
    document.querySelector('#atmosphere-art').innerHTML = createAtmosphereSvg(currentAtmosphere, `${selectedDate}${currentAtmosphere.phrase}`);
    document.querySelector('#atmosphere-phrase').textContent = currentAtmosphere.phrase;
    document.querySelector('#atmosphere-keywords').innerHTML = currentAtmosphere.keywords.map((word) => `<span>${escapeHtml(word)}</span>`).join('');
    document.querySelector('#atmosphere-palette').innerHTML = currentAtmosphere.palette.map((color) => `<span style="background: ${color}" title="${color}"></span>`).join('');
  }

  // ことばの辞書: 感情の言葉から模様と基本の色を決める（端末内で解析するので無料・オフラインでも動く）
  const emotionLexicon = [
    {
      pattern: 'burst', tags: ['よろこび', 'きらめき'], palette: ['#ff9f5a', '#ffd166', '#ef6f8e', '#4cc9a0'],
      words: ['嬉し', 'うれし', '楽し', 'たのし', '最高', '合格', '成功', 'やった', '笑', '幸せ', 'しあわせ', 'お祝い', '誕生日', 'ワクワク', 'わくわく', '感動', '大好き', '優勝', 'ライブ', 'はしゃ'],
      phrases: ['光が弾けるような一日', '胸の奥がきらめいた日', '笑い声が色になった日'],
    },
    {
      pattern: 'soft', tags: ['ぬくもり', 'やすらぎ'], palette: ['#f6c38b', '#f3e1c7', '#9dc5bb', '#e8a598'],
      words: ['穏やか', 'おだやか', 'のんびり', 'ゆっくり', '癒', 'ほっと', '陽だまり', '散歩', 'カフェ', '昼寝', 'ありがとう', '感謝', '優し', 'やさし', 'ぽかぽか', 'あたたか', '温か', 'おいしい', '美味し'],
      phrases: ['やわらかな光に包まれた日', 'ぬくもりがそっと残る日', 'ひだまりのような一日'],
    },
    {
      pattern: 'rain', tags: ['しずく', '内省'], palette: ['#6c7a89', '#a3b1c2', '#3d4a5c', '#c9d6df'],
      words: ['悲し', 'かなし', '寂し', 'さみし', '辛', 'つら', '泣', '落ち込', '疲れ', 'つかれ', '不安', '憂鬱', '失敗', '後悔', 'しんど', '眠れな', '怒', 'イライラ', 'ため息', '孤独'],
      phrases: ['しずくが静かに落ちる日', '心の中に雨が降った日', '涙のあとに澄んでいく日'],
    },
    {
      pattern: 'wave', tags: ['揺らぎ', '移ろい'], palette: ['#7fb3c8', '#bfe0e3', '#4e6e81', '#e9d8b4'],
      words: ['迷', '悩', '揺れ', '複雑', '旅', '変化', '考え', '思い出', '懐かし', 'なつかし', '緊張', 'ドキドキ', 'どきどき', '新しい', '引っ越', '初めて', 'はじめて', 'そわそわ', 'もやもや'],
      phrases: ['気持ちが波のように揺れた日', '移ろう心を見つめた日', 'さざなみが続いた一日'],
    },
    {
      pattern: 'calm', tags: ['凪', '静けさ'], palette: ['#f4a261', '#e9c46a', '#2a9d8f', '#264653'],
      words: ['静か', 'しずか', '夕方', '帰り道', '一人', 'ひとり', '読書', '本を', '安心', '落ち着', '夜', 'ぼんやり', 'まったり', '休み', '休日', '整', '深呼吸', '音楽'],
      phrases: ['凪いだ水面のような日', '静けさに耳をすませた日', 'ゆっくり日が暮れていく日'],
    },
  ];

  // 情景の言葉: 見つかったら、その色をパレットに混ぜる
  const sceneryColors = [
    { words: ['桜', 'さくら', '花見'], color: '#f4b6c2', keyword: '桜色' },
    { words: ['海', '波打ち際', 'ビーチ'], color: '#3d8fb8', keyword: '海' },
    { words: ['空', '青空', '晴れ', '快晴'], color: '#8ecae6', keyword: '青空' },
    { words: ['夕焼け', '夕日', '夕暮れ'], color: '#f08a5d', keyword: '夕焼け' },
    { words: ['緑', '森', '公園', '木漏れ日', '山'], color: '#7fb77e', keyword: '緑' },
    { words: ['雪', '冬', '寒'], color: '#dfe9f5', keyword: '雪' },
    { words: ['紅葉', '秋', '落ち葉'], color: '#d9783f', keyword: '紅葉' },
    { words: ['雨', '傘', '梅雨'], color: '#8a9bb0', keyword: '雨' },
    { words: ['夜', '星', '月'], color: '#2b3a67', keyword: '夜空' },
    { words: ['コーヒー', '珈琲', 'カフェ', 'チョコ'], color: '#a47551', keyword: 'コーヒー' },
    { words: ['夏', '太陽', 'ひまわり', '暑'], color: '#ffc93c', keyword: '夏' },
    { words: ['ラベンダー', '紫', '藤'], color: '#b8a1d9', keyword: '紫' },
  ];

  const moodWeights = {
    great: { burst: 3 }, good: { soft: 3 }, okay: { calm: 2 }, low: { wave: 2, rain: 1 }, tough: { rain: 3 },
  };

  function countMatches(text, words) {
    return words.reduce((sum, word) => sum + text.split(word).length - 1, 0);
  }

  function buildAtmosphere(title, content, mood) {
    const text = `${title} ${content}`;
    if (!text.trim()) return null;

    const scores = emotionLexicon.map((emotion) => {
      const matches = countMatches(text, emotion.words);
      return { emotion, matches, score: matches * 2 + (moodWeights[mood]?.[emotion.pattern] || 0) };
    });
    scores.sort((first, second) => second.score - first.score);
    const top = scores[0].score > 0 ? scores[0].emotion : emotionLexicon[1];

    const sceneries = sceneryColors
      .map((scenery) => ({ ...scenery, count: countMatches(text, scenery.words) }))
      .filter((scenery) => scenery.count > 0)
      .sort((first, second) => second.count - first.count)
      .slice(0, 2);
    // 情景の色を主役のすぐ後ろに差し込み、その日だけの配色にする
    const palette = [top.palette[0], ...sceneries.map((scenery) => scenery.color), ...top.palette.slice(1)].slice(0, 4);

    // 2番目に強い感情があれば、そのことばも添える
    const second = scores[1].matches > 0 ? scores[1].emotion.tags[0] : null;
    const keywords = [...new Set([...sceneries.map((scenery) => scenery.keyword), top.tags[0], second, top.tags[1]].filter(Boolean))].slice(0, 3);

    const random = seededRandom(text);
    const basePhrase = top.phrases[Math.floor(random() * top.phrases.length)];
    const phrase = sceneries[0] && !basePhrase.includes(sceneries[0].keyword) ? `${sceneries[0].keyword}と、${basePhrase}` : basePhrase;

    const exclamations = (text.match(/[!！]/g) || []).length;
    const strength = scores[0].matches + exclamations + (['great', 'tough'].includes(mood) ? 2 : 0);
    const intensity = strength >= 6 ? 'high' : strength >= 2 ? 'medium' : 'low';

    return { palette, keywords, phrase: phrase.slice(0, 30), pattern: top.pattern, intensity };
  }

  function currentFormAtmosphere() {
    const mood = form.querySelector('input[name="mood"]:checked')?.value || '';
    return buildAtmosphere(titleInput.value.trim(), contentInput.value.trim(), mood);
  }

  function updateWordCount() {
    document.querySelector('#word-count').textContent = `${contentInput.value.length.toLocaleString('ja-JP')}文字`;
  }

  function openEntry(date) {
    selectedDate = date;
    const entry = entries.find((item) => item.date === date);
    dateInput.value = date;
    titleInput.value = entry?.title || '';
    contentInput.value = entry?.content || '';
    form.querySelectorAll('input[name="mood"]').forEach((radio) => {
      radio.checked = Boolean(entry?.mood && radio.value === entry.mood);
    });
    deleteButton.hidden = !entry;
    renderAtmosphere(entry ? buildAtmosphere(entry.title || '', entry.content || '', entry.mood) : null);
    updateDateLabel();
    updateWordCount();
    if (!showPendingSyncState()) setSavedState(false);
    renderList();
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  function handleInput() {
    updateWordCount();
    setSavedState(true);
    // 書いている途中から雰囲気の絵を描き変える
    window.clearTimeout(atmosphereTimer);
    atmosphereTimer = window.setTimeout(() => renderAtmosphere(currentFormAtmosphere()), 400);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const title = titleInput.value.trim();
    const content = contentInput.value.trim();
    if (!title && !content) {
      showToast('タイトルか本文を入力してください。');
      contentInput.focus();
      return;
    }

    const mood = form.querySelector('input[name="mood"]:checked')?.value || '';
    const updatedAt = new Date().toISOString();
    const index = entries.findIndex((entry) => entry.date === selectedDate);
    const entry = { date: selectedDate, title, content, mood, updatedAt };
    renderAtmosphere(currentFormAtmosphere());
    if (currentAtmosphere) entry.atmosphere = currentAtmosphere;
    if (index < 0) entries.push(entry);
    else entries[index] = entry;

    if (!saveEntries()) {
      if (index < 0) entries.pop();
      else entries[index] = loadEntries().find((saved) => saved.date === selectedDate) || entries[index];
      return;
    }

    deleteButton.hidden = false;
    setSavedState(false, '保存しました');
    renderList();
    enqueueSync('save', entry);
    if (syncQueue.length > 0) showToast('このブラウザーに保存しました。シートへ同期しています。');
  });

  document.querySelector('#new-entry').addEventListener('click', () => openEntry(localDateString()));
  dateInput.addEventListener('change', () => openEntry(dateInput.value || localDateString()));
  list.addEventListener('click', (event) => {
    const item = event.target.closest('[data-date]');
    if (item) openEntry(item.dataset.date);
  });
  searchInput.addEventListener('input', renderList);
  [titleInput, contentInput].forEach((input) => input.addEventListener('input', handleInput));
  form.querySelectorAll('input[name="mood"]').forEach((radio) => radio.addEventListener('change', handleInput));

  deleteButton.addEventListener('click', () => {
    if (!window.confirm('この日の日記を削除しますか？')) return;
    const previousEntries = entries;
    entries = entries.filter((entry) => entry.date !== selectedDate);
    if (!saveEntries()) {
      entries = previousEntries;
      return;
    }
    enqueueSync('delete', { date: selectedDate });
    openEntry(selectedDate);
    showToast('日記を削除しました');
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      form.requestSubmit();
    }
    if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      event.preventDefault();
      searchInput.focus();
    }
  });

  window.addEventListener('online', flushSyncQueue);
  window.addEventListener('offline', () => {
    showPendingSyncState();
    showToast('オフラインです。ブラウザーに保存し、再接続時に同期します。');
  });
  window.setInterval(flushSyncQueue, retryIntervalMs);
  openEntry(localDateString());
  flushSyncQueue();
})();