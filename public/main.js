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
  let entries = loadEntries();
  let syncQueue = loadSyncQueue();
  let ownerId = loadOwnerId();
  let selectedDate = '';
  let toastTimer;
  let syncInFlight = false;

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
      return `<button class="entry-item" type="button" data-date="${escapeHtml(entry.date)}" aria-current="${entry.date === selectedDate}">
        <span class="entry-item-date">${formatDate(entry.date, { month: 'long', day: 'numeric', weekday: 'short' })}${mood ? `<span class="entry-item-mood" aria-label="気分: ${mood.label}">${mood.symbol}</span>` : ''}</span>
        <span class="entry-item-title">${escapeHtml(title)}</span>
        <span class="entry-item-preview">${escapeHtml(preview.replace(/\s+/g, ' '))}</span>
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