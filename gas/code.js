const SESSION_DURATION_MS = 1000 * 60 * 60 * 24;
const ATMOSPHERE_PATTERNS = ['soft', 'wave', 'burst', 'rain', 'calm'];
const ATMOSPHERE_INTENSITIES = ['low', 'medium', 'high'];

function doGet(e) {
  const params = (e && e.parameter) || {};
  try {
    switch (params.mode) {
      case 'register_challenge': return jsonResponse(registerChallenge_(params));
      case 'register_user': return jsonResponse(registerUser_(params));
      case 'login_challenge': return jsonResponse(loginChallenge_(params));
      case 'logout': return jsonResponse(logout_(params));
      case 'list_diary': return jsonResponse(listDiary_(requireSession_(params)));
      case 'login': return jsonResponse(login_(params));
      case 'check_session': return jsonResponse(checkSession_(params));
      case 'save_diary': return jsonResponse(saveDiary_(authenticatedDiaryPayload_(params)));
      case 'delete_diary': return jsonResponse(deleteDiary_(authenticatedDiaryPayload_(params)));
      default: return jsonResponse({ ok: false, message: '不明な mode です。' });
    }
  } catch (error) {
    console.error(error);
    return jsonResponse({ ok: false, code: error.code || 'SERVER_ERROR', message: (error && error.message) || 'サーバーエラーが発生しました。' });
  }
}

function diaryPayload_(params) {
  if (!params.payload) return params;
  const bytes = Utilities.base64DecodeWebSafe(params.payload);
  return JSON.parse(Utilities.newBlob(bytes).getDataAsString('UTF-8'));
}

function saveDiary_(params) {
  const entry = validateDiaryParams_(params);
  const sheet = getSheet_('diary');
  const columns = getColumns_(sheet, ['owner_id', 'date', 'title', 'content', 'mood', 'updated_at']);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const values = sheet.getDataRange().getValues();
    const existingIndex = values.findIndex(function (row, index) {
      return index > 0 && String(row[columns.owner_id - 1]) === entry.ownerId && cellDate_(row[columns.date - 1]) === entry.date;
    });
    const row = new Array(sheet.getLastColumn()).fill('');
    row[columns.owner_id - 1] = entry.ownerId;
    row[columns.date - 1] = "'" + entry.date;
    row[columns.title - 1] = spreadsheetText_(entry.title);
    row[columns.content - 1] = spreadsheetText_(entry.content);
    row[columns.mood - 1] = entry.mood;
    row[columns.updated_at - 1] = entry.updatedAt;
    // atmosphere 列は任意。列があるときだけ AI の解析結果を保存する
    const atmosphereIndex = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].indexOf('atmosphere');
    if (atmosphereIndex !== -1) row[atmosphereIndex] = entry.atmosphere ? JSON.stringify(entry.atmosphere) : '';
    if (existingIndex === -1) sheet.appendRow(row);
    else sheet.getRange(existingIndex + 1, 1, 1, row.length).setValues([row]);
    return { ok: true, updatedAt: entry.updatedAt };
  } finally {
    lock.releaseLock();
  }
}

function deleteDiary_(params) {
  const entry = validateDiaryParams_(params);
  const sheet = getSheet_('diary');
  const columns = getColumns_(sheet, ['owner_id', 'date']);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const values = sheet.getDataRange().getValues();
    for (let i = values.length - 1; i > 0; i -= 1) {
      if (String(values[i][columns.owner_id - 1]) === entry.ownerId && cellDate_(values[i][columns.date - 1]) === entry.date) sheet.deleteRow(i + 1);
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function validateDiaryParams_(params) {
  const ownerId = String(params.owner_id || '');
  const date = String(params.date || '');
  const mood = String(params.mood || '');
  if (!/^[A-Za-z0-9-]{16,80}$/.test(ownerId)) throw new Error('owner_id が正しくありません。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date は YYYY-MM-DD 形式で入力してください。');
  if (!['', 'great', 'good', 'okay', 'low', 'tough'].includes(mood)) throw new Error('mood が正しくありません。');
  return {
    ownerId: ownerId,
    date: date,
    title: String(params.title || '').slice(0, 100),
    content: String(params.content || '').slice(0, 30000),
    mood: mood,
    atmosphere: sanitizeAtmosphere_(params.atmosphere),
    updatedAt: new Date().toISOString(),
  };
}

// フロントから送られた雰囲気の値を、安全な形だけに絞る
function sanitizeAtmosphere_(value) {
  if (!value || typeof value !== 'object') return null;
  const palette = (Array.isArray(value.palette) ? value.palette : [])
    .map(function (color) { return String(color).trim().toLowerCase(); })
    .filter(function (color) { return /^#[0-9a-f]{6}$/.test(color); })
    .slice(0, 4);
  if (palette.length < 2) return null;
  return {
    palette: palette,
    keywords: (Array.isArray(value.keywords) ? value.keywords : []).map(function (word) { return String(word).slice(0, 12); }).slice(0, 3),
    phrase: String(value.phrase || '').slice(0, 30),
    pattern: ATMOSPHERE_PATTERNS.indexOf(value.pattern) === -1 ? 'soft' : value.pattern,
    intensity: ATMOSPHERE_INTENSITIES.indexOf(value.intensity) === -1 ? 'medium' : value.intensity,
  };
}

// 数式インジェクション対策: 先頭が = + - @ タブ 改行 の値は文字列として保存する
function spreadsheetText_(value) {
  return /^[=+\-@\t\r\n]/.test(value) ? "'" + value : value;
}

// 既存行で日付型に変換されたセルも YYYY-MM-DD で比較する
function cellDate_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(value);
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
function digest_(text) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
}
function authError_() {
  const error = new Error('ログインの有効期限が切れました。もう一度ログインしてください。');
  error.code = 'AUTH_REQUIRED';
  return error;
}
function equalSecret_(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function findUser_(username) {
  const sheet = getSheet_('users');
  const columns = getColumns_(sheet, ['id', 'username', 'password_hash', 'salt', 'iterations', 'name']);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (String(row[columns.username - 1]).trim().toLowerCase() !== username) continue;
    const user = { id: String(row[columns.id - 1]), username: username, name: String(row[columns.name - 1]),
      hash: String(row[columns.password_hash - 1]), salt: String(row[columns.salt - 1]), iterations: Number(row[columns.iterations - 1]) };
    if (!/^[A-Za-z0-9-]{16,80}$/.test(user.id) || !/^[a-f0-9]{64}$/.test(user.hash) || !/^[a-f0-9]{32}$/.test(user.salt) || user.iterations !== 210000) throw new Error('ユーザーの設定を確認してください。');
    return user;
  }
  return null;
}
function publicUser_(user) { return { id: user.id, username: user.username, name: user.name }; }
// 登録用の一時キーはHTTPSの応答だけで渡し、URLに認証用ハッシュを載せない。
function registerChallenge_(params) {
  getColumns_(getSheet_('sessions'), ['user_id', 'token_hash', 'expired_at']);
  const username = String(params.username || '').trim().toLowerCase();
  if (!username) return { ok: false, message: 'ユーザー名を入力してください。' };
  if (findUser_(username)) return { ok: false, message: 'そのユーザー名はすでに使われています。' };
  const cache = CacheService.getScriptCache();
  const count = Number(cache.get('register-attempts:' + digest_(username)) || 0);
  if (count >= 5) return { ok: false, message: 'しばらく待ってからお試しください（約15分）。' };
  cache.put('register-attempts:' + digest_(username), String(count + 1), 900);
  const challenge = Utilities.getUuid() + Utilities.getUuid();
  const salt = Utilities.getUuid().replace(/-/g, '');
  const wrappingKey = digest_(Utilities.getUuid() + Utilities.getUuid());
  cache.put('register:' + challenge, JSON.stringify({ username: username, salt: salt, wrappingKey: wrappingKey }), 120);
  return { ok: true, challenge: challenge, salt: salt, wrappingKey: wrappingKey, iterations: 210000 };
}
function registerUser_(params) {
  const challenge = String(params.challenge || '');
  const wrapped = String(params.wrapped || '');
  const proof = String(params.proof || '');
  if (!/^[a-f0-9-]{72}$/.test(challenge) || !/^[a-f0-9]{64}$/.test(wrapped) || !/^[a-f0-9]{64}$/.test(proof))
    return { ok: false, message: '登録をもう一度お試しください。' };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const cache = CacheService.getScriptCache();
    const stored = cache.get('register:' + challenge);
    if (!stored) return { ok: false, message: '登録の有効期限が切れました。もう一度お試しください。' };
    cache.remove('register:' + challenge);
    const data = JSON.parse(stored);
    const expected = hex_(Utilities.computeHmacSha256Signature(challenge + ':' + wrapped, data.wrappingKey, Utilities.Charset.UTF_8));
    if (!equalSecret_(expected, proof)) return { ok: false, message: '登録をもう一度お試しください。' };
    // 同じユーザー名を同時に登録した場合も、ロック内で再確認する。
    if (findUser_(data.username)) return { ok: false, message: 'そのユーザー名はすでに使われています。' };
    let hash = '';
    for (let i = 0; i < 64; i += 2) {
      hash += ('0' + (parseInt(wrapped.slice(i, i + 2), 16) ^ parseInt(data.wrappingKey.slice(i, i + 2), 16)).toString(16)).slice(-2);
    }
    const sheet = getSheet_('users');
    const columns = getColumns_(sheet, ['id', 'username', 'password_hash', 'salt', 'iterations', 'name']);
    const row = new Array(sheet.getLastColumn()).fill('');
    row[columns.id - 1] = Utilities.getUuid();
    row[columns.username - 1] = "'" + data.username; // 数字だけの名前や先頭記号も文字列として保存
    row[columns.password_hash - 1] = hash;
    row[columns.salt - 1] = data.salt;
    row[columns.iterations - 1] = 210000;
    row[columns.name - 1] = spreadsheetText_(String(params.name || data.username).trim().slice(0, 40) || data.username);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const createdAtIndex = headers.indexOf('created_at');
    if (createdAtIndex !== -1) row[createdAtIndex] = new Date();
    // saltが数字だけの場合も先頭の0や精度を維持する。
    row[columns.salt - 1] = "'" + row[columns.salt - 1];
    row[columns.password_hash - 1] = "'" + row[columns.password_hash - 1];
    sheet.appendRow(row);
    cache.remove('register-attempts:' + digest_(data.username));
    return { ok: true };
  } finally { lock.releaseLock(); }
}

function loginChallenge_(params) {
  const username = String(params.username || '').trim().toLowerCase();
  if (!username) return { ok: false, message: 'ユーザー名を入力してください。' };
  const cache = CacheService.getScriptCache();
  if (Number(cache.get('attempts:' + digest_(username)) || 0) >= 5) return { ok: false, message: 'しばらく待ってからお試しください（約15分）。' };
  const user = findUser_(username);
  const challenge = Utilities.getUuid() + Utilities.getUuid();
  const properties = PropertiesService.getScriptProperties();
  let secret = properties.getProperty('AUTH_DUMMY_SECRET');
  if (!secret) { secret = Utilities.getUuid(); properties.setProperty('AUTH_DUMMY_SECRET', secret); }
  cache.put('challenge:' + challenge, JSON.stringify({ username: username }), 120);
  return { ok: true, challenge: challenge, salt: user ? user.salt : digest_(username + secret).slice(0, 32), iterations: 210000 };
}
function login_(params) {
  const challenge = String(params.challenge || '');
  const proof = String(params.proof || '');
  if (!/^[a-f0-9-]{72}$/.test(challenge)) return { ok: false, message: 'ログインをもう一度お試しください。' };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const cache = CacheService.getScriptCache();
    const stored = cache.get('challenge:' + challenge);
    if (!stored) return { ok: false, message: 'ログインをもう一度お試しください。' };
    cache.remove('challenge:' + challenge); // 一度だけ使える確認コード
    const username = JSON.parse(stored).username;
    const attempts = Number(cache.get('attempts:' + digest_(username)) || 0);
    if (attempts >= 5) return { ok: false, message: 'しばらく待ってからお試しください（約15分）。' };
    const user = findUser_(username);
    const expected = user ? hex_(Utilities.computeHmacSha256Signature(challenge, user.hash, Utilities.Charset.UTF_8)) : '';
    if (!user || !/^[a-f0-9]{64}$/.test(proof) || !equalSecret_(expected, proof)) {
      cache.put('attempts:' + digest_(username), String(attempts + 1), 900);
      return { ok: false, message: 'ユーザー名またはパスワードが正しくありません。' };
    }
    cache.remove('attempts:' + digest_(username));
    const token = Utilities.getUuid() + Utilities.getUuid();
    const expiredAt = new Date(Date.now() + SESSION_DURATION_MS);
    const sheet = getSheet_('sessions');
    const columns = getColumns_(sheet, ['user_id', 'token_hash', 'expired_at']);
    const row = new Array(sheet.getLastColumn()).fill('');
    row[columns.user_id - 1] = user.id;
    row[columns.token_hash - 1] = digest_(token);
    row[columns.expired_at - 1] = expiredAt;
    sheet.appendRow(row);
    return { ok: true, token: token, expiredAt: expiredAt.toISOString(), user: publicUser_(user) };
  } finally { lock.releaseLock(); }
}
function requireSession_(params) {
  const token = String(params.token || '');
  if (!/^[a-f0-9-]{72}$/.test(token)) throw authError_();
  const sheet = getSheet_('sessions');
  const columns = getColumns_(sheet, ['user_id', 'token_hash', 'expired_at']);
  const rows = sheet.getDataRange().getValues();
  const hash = digest_(token);
  for (let i = 1; i < rows.length; i += 1) {
    if (String(rows[i][columns.token_hash - 1]) !== hash) continue;
    const expires = new Date(rows[i][columns.expired_at - 1]).getTime();
    if (!Number.isFinite(expires) || expires <= Date.now()) throw authError_();
    const users = getSheet_('users');
    const uc = getColumns_(users, ['id', 'username', 'name']);
    const values = users.getDataRange().getValues();
    for (let j = 1; j < values.length; j += 1) {
      if (String(values[j][uc.id - 1]) === String(rows[i][columns.user_id - 1]))
        return { id: String(values[j][uc.id - 1]), username: String(values[j][uc.username - 1]), name: String(values[j][uc.name - 1]) };
    }
    throw authError_();
  }
  throw authError_();
}
function checkSession_(params) { return { ok: true, user: requireSession_(params) }; }
function authenticatedDiaryPayload_(params) {
  const user = requireSession_(params);
  const payload = diaryPayload_(params);
  payload.owner_id = user.id; // クライアントのowner_idは信頼しない
  return payload;
}
function logout_(params) {
  requireSession_(params);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_('sessions');
    const columns = getColumns_(sheet, ['user_id', 'token_hash', 'expired_at']);
    const rows = sheet.getDataRange().getValues();
    const hash = digest_(String(params.token));
    for (let i = rows.length - 1; i > 0; i -= 1) if (String(rows[i][columns.token_hash - 1]) === hash) sheet.deleteRow(i + 1);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function listDiary_(user) {
  const sheet = getSheet_('diary');
  const columns = getColumns_(sheet, ['owner_id', 'date', 'title', 'content', 'mood', 'updated_at']);
  return { ok: true, entries: sheet.getDataRange().getValues().slice(1)
    .filter(function (row) { return String(row[columns.owner_id - 1]) === user.id; })
    .map(function (row) { return { date: cellDate_(row[columns.date - 1]), title: String(row[columns.title - 1]), content: String(row[columns.content - 1]), mood: String(row[columns.mood - 1]), updatedAt: new Date(row[columns.updated_at - 1]).toISOString() }; }) };
}

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('GASがスプレッドシートに紐づいていません。');
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('シート「' + name + '」が見つかりません。');
  return sheet;
}

function getColumns_(sheet, requiredHeaders) {
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const columns = {};
  requiredHeaders.forEach(function (name) {
    const index = header.indexOf(name);
    if (index === -1) throw new Error('シート「' + sheet.getName() + '」に「' + name + '」列がありません。');
    columns[name] = index + 1;
  });
  return columns;
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
