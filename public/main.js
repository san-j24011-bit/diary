(() => {
  let storageKey = '';
  let syncQueueStorageKey = '';
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
  let entries = [];
  let syncQueue = [];
  let ownerId = null;
  let selectedDate = '';
  let isNewDraft = false;
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
      return `<button class="entry-item" type="button" data-date="${escapeHtml(entry.date)}" aria-current="${!isNewDraft && entry.date === selectedDate}">
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
    if (!ownerId || !window.diaryAuth.token() || syncInFlight || syncQueue.length === 0) return;
    if (!navigator.onLine) {
      showPendingSyncState();
      return;
    }
    syncInFlight = true;
    const syncingOwner = ownerId;
    document.querySelector('#logout').disabled = true;
    try {
      while (syncQueue.length > 0 && ownerId === syncingOwner) {
        const operation = syncQueue[0];
        const payload = { ...operation.entry, owner_id: ownerId };
        const url = new URL(gasEndpoint);
        url.searchParams.set('mode', operation.action === 'save' ? 'save_diary' : 'delete_diary');
        url.searchParams.set('payload', encodeBase64Url(JSON.stringify(payload)));
        url.searchParams.set('token', window.diaryAuth.token());
        if (url.href.length > maxSyncUrlLength) {
          // 長文はGETで送れないため同期対象から外し、ローカル保存のみにする
          syncQueue.shift();
          persistSyncQueue();
          if (operation.entry.date === selectedDate) setSyncState('error', '長文のためシートへ同期しません（ブラウザーには保存済み）');
          showToast('日記が長いためスプレッドシートには同期しませんでした。');
          continue;
        }

        if (operation.entry.date === selectedDate) setSyncState('syncing', 'スプレッドシートへ同期中');
        const response = await fetch(url.href, { cache: 'no-store', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error('GASに接続できませんでした。');
        const result = await response.json();
        if (ownerId !== syncingOwner) return;
        if (result.code === 'AUTH_REQUIRED') window.diaryAuth.expire();
        if (!result.ok) throw new Error(result.message || 'スプレッドシートへ保存できませんでした。');

        syncQueue.shift();
        persistSyncQueue();
        if (operation.entry.date === selectedDate) {
          setSyncState('saved', 'スプレッドシートに同期済み');
          showToast(operation.action === 'save' ? 'スプレッドシートに日記を保存しました' : 'スプレッドシートから日記を削除しました');
        }
      }
    } catch (error) {
      if (ownerId !== syncingOwner) return;
      const failedEntry = syncQueue[0]?.entry;
      if (failedEntry?.date === selectedDate) setSyncState('error', '同期できません。再試行待ちです');
      showToast(error.message || 'スプレッドシートに接続できません。再試行します。');
    } finally {
      syncInFlight = false;
      document.querySelector('#logout').disabled = false;
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

  // 原典を確認した名言。日本語はこのアプリでの訳。
  const encouragementQuotes = [
    {
      text: '世界は苦しみに満ちていますが、それを乗り越えることにも満ちています。',
      author: 'ヘレン・ケラー', work: 'Optimism（1903年）',
      source: 'https://www.afb.org/about-afb/history/helen-keller/books-essays-speeches/optimism-1903',
    },
    {
      text: '行く手を阻むものが、その道を進む助けになる。',
      author: 'マルクス・アウレリウス', work: '自省録 第5巻20節',
      source: 'https://www.gutenberg.org/files/6920/6920-h/6920-h.htm',
    },
  ];

  function renderEncouragement(isNegative) {
    const quoteCard = document.querySelector('#encouragement');
    quoteCard.hidden = !isNegative;
    if (!isNegative) return;
    // 同じ日付は再入力・再読み込みでも同じ名言。翌日は次の名言へ。
    const day = Math.floor(Date.parse(selectedDate + 'T00:00:00Z') / 86400000);
    const index = Number.isFinite(day) ? ((day % encouragementQuotes.length) + encouragementQuotes.length) % encouragementQuotes.length : 0;
    const quote = encouragementQuotes[index];
    document.querySelector('#encouragement-text').textContent = quote.text;
    document.querySelector('#encouragement-author').textContent = quote.author;
    const source = document.querySelector('#encouragement-source');
    source.textContent = quote.work + '（日本語はアプリ訳）';
    source.href = quote.source;
  }

  function renderAtmosphere(value) {
    currentAtmosphere = sanitizeAtmosphere(value);
    atmosphereCard.hidden = !currentAtmosphere;
    const isRain = currentAtmosphere?.pattern === 'rain';
    atmosphereCard.classList.toggle('is-negative', isRain);
    renderEncouragement(isRain);
    document.querySelector('#atmosphere-label').textContent = isRain ? '心に雨が降る日' : currentAtmosphere?.phrase === '平凡な日' ? '平凡な日' : "TODAY'S ATMOSPHERE";
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
      words: [
        "嬉し", "うれし", "楽し", "たのし", "最高", "さいこう", "合格", "成功",
        "やった", "笑", "幸せ", "しあわせ", "お祝い", "おいわい", "誕生日", "ワクワク",
        "わくわく", "感動", "大好き", "だいすき", "優勝", "ライブ", "はしゃ", "喜び",
        "喜ん", "よろこび", "よろこん", "感激", "感無量", "満足", "まんぞく", "充実",
        "じゅうじつ", "達成", "達成感", "やり遂げ", "やりとげ", "成し遂げ", "なしとげ", "できた",
        "出来た", "できるようにな", "出来るようにな", "うまくいった", "上手くいった", "うまく行った", "うまくいく", "上手くいく",
        "順調", "じゅんちょう", "好調", "こうちょう", "絶好調", "手応え", "手ごたえ", "てごたえ",
        "自信がついた", "自信が付いた", "自信が持て", "自信を持て", "自信がもて", "自信をもて", "誇らし", "ほこらし",
        "褒められ", "ほめられ", "認められ", "報われた", "むくわれた", "叶った", "かなった", "夢が叶",
        "夢がかな", "楽しみ", "たのしみ", "期待して", "期待でき", "希望が", "希望を", "前向き",
        "まえむき", "元気が出", "元気にな", "元気をもら", "げんきにな", "勇気が出", "勇気をもら", "やる気が出た",
        "やる気がでた", "やる気にな", "気分が上が", "テンションが上が", "気分がいい", "気分が良い", "気分がよい", "気分がよかった",
        "気分が良かった", "ハッピー", "はっぴー", "ラッキー", "らっきー", "幸運", "いいことが", "良いことが",
        "いい一日", "良い一日", "素晴らし", "すばらし", "素敵", "すてき", "面白", "おもしろ",
        "面白かった", "おもしろかった",
      ],
      phrases: ['光が弾けるような一日', '胸の奥がきらめいた日', '笑い声が色になった日'],
    },
    {
      pattern: 'soft', tags: ['ぬくもり', 'やすらぎ'], palette: ['#f6c38b', '#f3e1c7', '#9dc5bb', '#e8a598'],
      words: [
        "穏やか", "おだやか", "のんびり", "ゆっくり", "癒", "いやされ", "いやし", "ほっと",
        "ホッと", "陽だまり", "ひだまり", "散歩", "カフェ", "昼寝", "ありがとう", "有難",
        "ありがた", "感謝", "優し", "やさし", "ぽかぽか", "ポカポカ", "あたたか", "温か",
        "暖か", "おいしい", "美味し", "おいしかった", "安心", "あんしん", "安らぎ", "やすらぎ",
        "安らい", "やすらい", "落ち着", "落ちつ", "おちつ", "リラックス", "りらっくす", "くつろ",
        "寛い", "寛げ", "和ん", "なごん", "和やか", "なごやか", "心地よ", "ここちよ",
        "居心地がいい", "居心地が良い", "居心地がよい", "居心地がよかった", "居心地が良かった", "気持ちがいい", "気持ちが良い", "気持ちよ",
        "気持ち良", "きもちよ", "爽やか", "さわやか", "清々し", "すがすがし", "すっきり", "スッキリ",
        "さっぱり", "サッパリ", "晴れやか", "晴れ晴れ", "晴ればれ", "はればれ", "気が楽", "気がらく",
        "肩の荷が下り", "肩の荷がおり", "救われ", "すくわれ", "助かった", "たすかった", "助けてもら", "たすけてもら",
        "支えてもら", "支えられ", "寄り添って", "よりそって", "励まされ", "はげまされ", "励ましてもら", "はげましてもら",
        "温もり", "ぬくもり", "思いやり", "おもいやり", "愛情", "愛され", "大切にされ", "大事にされ",
        "受け入れてもら", "受け入れられ", "仲良く", "仲よく", "なかよく", "仲直り", "なかなおり", "ほっこり",
        "ホッコリ", "ほのぼの", "平和", "へいわ", "癒や", "満たされ", "みたされ", "癒され",
        "癒やされ",
      ],
      phrases: ['やわらかな光に包まれた日', 'ぬくもりがそっと残る日', 'ひだまりのような一日'],
    },
    {
      pattern: 'rain', tags: ['しずく', '内省'], palette: ['#6c7a89', '#a3b1c2', '#3d4a5c', '#c9d6df'],
      // 悲しみ・疲労・不安・怒り・自己否定を、漢字／かな／口語で拾う。
      // 同じ表現を重複加点しないよう、活用形は共通の語幹で登録する。
      words: [
        '悲し', 'かなし', '寂し', 'さみし', 'さびし', '淋し', '辛', 'つら',
        '泣', '涙', 'なみだ', '落ち込', '落ちこ', 'おちこ', 'へこ', '凹', 'がっかり', 'ガッカリ',
        '疲れ', '疲労', 'つかれ', 'くたくた', 'クタクタ', 'ぐったり', 'しんど', 'だる', '怠',
        '消耗', '限界', '燃え尽き', '燃えつき', 'やる気が出ない', 'やる気がでない',
        '気力がない', '気力が出ない', '何もしたくない', 'なにもしたくない',
        '不安', '心配', '怖', 'こわ', '恐怖', '恐れ', '怯え', 'おびえ', '焦り', '焦る', '焦っ',
        'あせり', 'あせる', 'あせっ', 'プレッシャー', 'ストレス', '憂鬱', '憂うつ', 'ゆううつ',
        '眠れな', 'ねむれな', '寝られな', '不眠', '寝不足', '息苦し', 'いきぐるし',
        '失敗', '後悔', '挫折', '絶望', '失望', '虚し', 'むなし', '空し', '虚無',
        '孤独', '孤立', '疎外感', '取り残され', 'とり残され', '居場所がない', '居場所がなかった',
        '怒', '腹が立', '腹立', 'むかつ', 'ムカつ', 'ムカツ', 'イライラ', 'いらいら',
        '苛立', 'いらだ', '悔し', 'くやし', '理不尽', '納得できな', '許せな', 'ゆるせな',
        '傷つ', '傷付', 'きずつ', 'ショック', '裏切', '裏ぎ', 'うらぎ', '嫌われ', 'きらわれ',
        '嫌な', '嫌だ', '嫌で', 'いやな', 'いやだ', 'いやで', '嫌い', 'きらい', 'うんざり',
        '最悪', 'さいあく', '苦し', 'くるし', '苦痛', '苦労', 'しょんぼり', 'ため息', '溜め息', 'ためいき',
        '自信がない', '自信がなかった', '自信をなく', '自信を失', '自己嫌悪', '自分が嫌',
        '自分がいや', '自分を責め', '情けな', 'なさけな', '無力', '無価値',
        '報われな', 'むくわれな', 'うまくいかな', '上手くいかな', 'うまく行かな',
        'もう無理', 'もうむり', '耐えられな', 'たえられな', '逃げたい', '逃げたく',
        '消えたい', '消えたく', '死にたい', '死にたく', '生きるのがつら', '生きるのが辛',
      ],
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
    // 同じ箇所の「恐怖」と「怖」などは、長い表現を優先して1件と数える。
    const uniqueWords = [...new Set(words)].filter(Boolean);
    let count = 0;
    let cursor = 0;
    while (cursor < text.length) {
      let nextIndex = text.length;
      let matchLength = 0;
      for (const word of uniqueWords) {
        const index = text.indexOf(word, cursor);
        if (index >= 0 && (index < nextIndex || (index === nextIndex && word.length > matchLength))) {
          nextIndex = index;
          matchLength = word.length;
        }
      }
      if (!matchLength) break;
      count += 1;
      cursor = nextIndex + matchLength;
    }
    return count;
  }

  function buildAtmosphere(title, content, mood) {
    const text = `${title} ${content}`;
    if (!text.trim()) return null;

    const scores = emotionLexicon.map((emotion) => {
      const matches = countMatches(text, emotion.words);
      return { emotion, matches, score: matches * 2 + (moodWeights[mood]?.[emotion.pattern] || 0) };
    });
    const positiveScores = scores.filter(({ emotion }) => ['burst', 'soft'].includes(emotion.pattern));
    const positiveCount = countMatches(text, positiveScores.flatMap(({ emotion }) => emotion.words));
    const negativeScore = scores.find(({ emotion }) => emotion.pattern === 'rain');
    const negativeCount = negativeScore.matches;
    const isNeutral = positiveCount === negativeCount;
    // 気分選択は件数に加えない。同数（0件同士を含む）は平凡な日。
    positiveScores.sort((a, b) => b.matches - a.matches || b.score - a.score);
    const top = isNeutral
      ? { pattern: 'calm', tags: ['日常', '平穏'], palette: ['#b7c4be', '#dce3dd', '#a6b5af', '#eef0e9'], phrases: ['平凡な日'] }
      : positiveCount > negativeCount ? positiveScores[0].emotion : negativeScore.emotion;
    scores.sort((a, b) => b.matches - a.matches);

    const sceneries = sceneryColors
      .map((scenery) => ({ ...scenery, count: countMatches(text, scenery.words) }))
      .filter((scenery) => scenery.count > 0)
      .sort((first, second) => second.count - first.count)
      .slice(0, 2);
    // 情景の色を主役のすぐ後ろに差し込み、その日だけの配色にする
    const palette = top.pattern === 'rain' || isNeutral
      ? [...top.palette]
      : [top.palette[0], ...sceneries.map((scenery) => scenery.color), ...top.palette.slice(1)].slice(0, 4);

    // 2番目に強い感情があれば、そのことばも添える
    const second = scores.find(({ emotion, matches }) => matches > 0 && emotion.pattern !== top.pattern)?.emotion.tags[0];
    const keywords = isNeutral ? ['日常', '平穏', 'いつもの日']
      : [...new Set([...sceneries.map((scenery) => scenery.keyword), top.tags[0], second, top.tags[1]].filter(Boolean))].slice(0, 3);

    const random = seededRandom(text);
    const basePhrase = top.phrases[Math.floor(random() * top.phrases.length)];
    const phrase = !isNeutral && sceneries[0] && !basePhrase.includes(sceneries[0].keyword) ? `${sceneries[0].keyword}と、${basePhrase}` : basePhrase;

    const exclamations = (text.match(/[!！]/g) || []).length;
    const strength = isNeutral ? 0 : Math.max(positiveCount, negativeCount) + exclamations;
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
    isNewDraft = false;
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

  function startNewEntry() {
    if (!ownerId) return;
    const previous = isNewDraft ? null : entries.find(entry => entry.date === selectedDate);
    const mood = form.querySelector('input[name="mood"]:checked')?.value || '';
    const changed = titleInput.value.trim() !== (previous?.title || '') || contentInput.value.trim() !== (previous?.content || '') || mood !== (previous?.mood || '');
    if (changed && !window.confirm('未保存の文章があります。新しい日記を開くと入力内容が消えます。続けますか？')) return;
    window.clearTimeout(atmosphereTimer);
    isNewDraft = true;
    selectedDate = localDateString();
    dateInput.value = selectedDate;
    titleInput.value = '';
    contentInput.value = '';
    form.querySelectorAll('input[name="mood"]').forEach(radio => { radio.checked = false; });
    deleteButton.hidden = true;
    renderAtmosphere(null);
    updateWordCount();
    document.querySelector('#date-label').textContent = '新しい日記';
    setSavedState(true, '新しい日記を書いています');
    renderList();
    titleInput.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    titleInput.focus({ preventScroll: true });
    showToast(entries.some(entry => entry.date === selectedDate) ? '今日は記録済みです。別の日付を選ぶか、保存時に上書きできます。' : '新しい日記を開きました');
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
    if (!ownerId) { showToast('ログインしてください。'); return; }
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
    if (isNewDraft && index >= 0 && !window.confirm('この日付の日記はすでにあります。新しい内容で上書きしますか？')) return;
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

    isNewDraft = false;
    updateDateLabel();
    deleteButton.hidden = false;
    setSavedState(false, '保存しました');
    renderList();
    enqueueSync('save', entry);
    if (syncQueue.length > 0) showToast('このブラウザーに保存しました。シートへ同期しています。');
  });

  document.querySelector('#new-entry').addEventListener('click', startNewEntry);
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
  function legacyEntries() {
    try {
      const stored = JSON.parse(localStorage.getItem('hibi-journal.entries.v1') || '[]');
      return Array.isArray(stored) ? stored.filter(entry => entry && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)) : [];
    } catch { return []; }
  }
  document.querySelector('#import-legacy').addEventListener('click', () => {
    if (!ownerId || !window.confirm('以前の日記を、現在ログインしているアカウントへ取り込みます。同じ日付の記録は上書きしません。よろしいですか？')) return;
    const knownDates = new Set([...entries.map(entry => entry.date), ...syncQueue.map(item => item.entry.date)]);
    const imported = legacyEntries().filter(entry => !knownDates.has(entry.date));
    const previous = entries;
    entries = [...entries, ...imported];
    if (!saveEntries()) { entries = previous; return; }
    imported.forEach(entry => {
      syncQueue.push({ action: 'save', entry: { ...entry } });
    });
    persistSyncQueue();
    renderList();
    showToast(imported.length + '件の日記を取り込みました');
    flushSyncQueue();
  });

  window.addEventListener('diary-auth-change', async event => {
    window.clearTimeout(atmosphereTimer);
    const user = event.detail;
    ownerId = user?.id || null;
    entries = [];
    syncQueue = [];
    titleInput.value = '';
    contentInput.value = '';
    searchInput.value = '';
    renderAtmosphere(null);
    list.innerHTML = '';
    document.querySelector('#auth-status').textContent = '';
    document.querySelector('#import-legacy').hidden = !user || legacyEntries().length === 0;
    if (!user) { document.querySelector('#entry-count').textContent = '0'; return; }
    storageKey = 'hibi-journal.entries.account.' + user.id;
    syncQueueStorageKey = 'hibi-journal.queue.account.' + user.id;
    entries = loadEntries();
    syncQueue = loadSyncQueue();
    openEntry(localDateString());
    const workspace = document.querySelector('#diary-workspace');
    workspace.inert = true;
    try {
      const result = await window.diaryAuth.request('list_diary');
      if (ownerId !== user.id) return;
      const merged = new Map(entries.map(entry => [entry.date, entry]));
      const pendingDates = new Set(syncQueue.map(item => item.entry.date));
      for (const entry of result.entries || []) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || pendingDates.has(entry.date)) continue;
        const local = merged.get(entry.date);
        if (!local || (Date.parse(entry.updatedAt) || 0) >= (Date.parse(local.updatedAt) || 0)) merged.set(entry.date, entry);
      }
      entries = [...merged.values()];
      saveEntries();
      openEntry(localDateString());
      flushSyncQueue();
    } catch (error) {
      if (ownerId === user.id) document.querySelector('#auth-status').textContent = 'シートから取得できませんでした。この端末の記録を表示しています。';
    } finally { workspace.inert = false; }
  });
  window.diaryAuth.start();

})();