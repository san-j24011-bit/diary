const SESSION_DURATION_MS = 1000 * 60 * 60 * 24;

function doGet(e) {
  const params = (e && e.parameter) || {};
  try {
    switch (params.mode) {
      case 'login': return jsonResponse(login_(params));
      case 'check_session': return jsonResponse(checkSession_(params));
      case 'save_diary': return jsonResponse(saveDiary_(diaryPayload_(params)));
      case 'delete_diary': return jsonResponse(deleteDiary_(diaryPayload_(params)));
      default: return jsonResponse({ ok: false, message: '不明な mode です。' });
    }
  } catch (error) {
    console.error(error);
    return jsonResponse({ ok: false, message: (error && error.message) || 'サーバーエラーが発生しました。' });
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
    updatedAt: new Date().toISOString(),
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

function login_(params) {
  const email = String(params.email || '').trim().toLowerCase();
  const password = String(params.password || '');
  if (!email || !password) return { ok: false, message: 'メールアドレスとパスワードを入力してください。' };
  const user = findUser_(email, password);
  if (!user) return { ok: false, message: 'メールアドレスまたはパスワードが正しくありません。' };

  const token = Utilities.getUuid();
  const expiredAt = new Date(Date.now() + SESSION_DURATION_MS);
  const sheet = getSheet_('sessions');
  const columns = getColumns_(sheet, ['user_id', 'token', 'expired_at']);
  const row = new Array(sheet.getLastColumn()).fill('');
  row[columns.user_id - 1] = user.id;
  row[columns.token - 1] = token;
  row[columns.expired_at - 1] = expiredAt;
  sheet.appendRow(row);
  return { ok: true, token: token, expiredAt: expiredAt.toISOString(), user: user };
}

function checkSession_(params) {
  const token = String(params.token || '');
  if (!token) return { ok: false, message: 'セッションがありません。' };
  const sheet = getSheet_('sessions');
  const columns = getColumns_(sheet, ['user_id', 'token', 'expired_at']);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    const row = values[i];
    if (String(row[columns.token - 1]) !== token) continue;
    const expiredAt = new Date(row[columns.expired_at - 1]);
    if (Number.isNaN(expiredAt.getTime()) || expiredAt.getTime() <= Date.now()) return { ok: false, message: 'セッションの有効期限が切れています。' };
    const user = findUserById_(row[columns.user_id - 1]);
    return user ? { ok: true, user: user } : { ok: false, message: 'ユーザーが見つかりません。' };
  }
  return { ok: false, message: 'セッションが無効です。' };
}

function findUser_(email, password) {
  const sheet = getSheet_('users');
  const columns = getColumns_(sheet, ['id', 'email', 'password', 'name']);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    const row = values[i];
    if (String(row[columns.email - 1]).trim().toLowerCase() === email && String(row[columns.password - 1]) === password) return userFromRow_(row, columns);
  }
  return null;
}

function findUserById_(id) {
  const sheet = getSheet_('users');
  const columns = getColumns_(sheet, ['id', 'email', 'password', 'name']);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) if (String(values[i][columns.id - 1]) === String(id)) return userFromRow_(values[i], columns);
  return null;
}

function userFromRow_(row, columns) {
  return { id: String(row[columns.id - 1]), email: String(row[columns.email - 1]), name: String(row[columns.name - 1]) };
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
