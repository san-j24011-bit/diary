const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const tables = {};
function sheet(name, headers, rows = []) {
  const data = [headers, ...rows];
  tables[name] = { data, getName: () => name, getLastColumn: () => headers.length,
    getDataRange: () => ({ getValues: () => data.map(row => row.map(value => typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value)) }),
    getRange: (r, c, n, width) => ({ getValues: () => data.slice(r - 1, r - 1 + n).map(row => row.slice(c - 1, c - 1 + width)), setValues: rows => rows.forEach((row, i) => { data[r - 1 + i] = [...row]; }) }),
    appendRow: row => data.push(row), deleteRow: row => data.splice(row - 1, 1) };
}
const salt = 'abcdef0123456789abcdef0123456789';
const verifier = crypto.pbkdf2Sync('test-password-only', Buffer.from(salt, 'hex'), 210000, 32, 'sha256').toString('hex');
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
sheet('users', ['id', 'username', 'password_hash', 'salt', 'iterations', 'name', 'created_at'], [[alice, 'alice', verifier, salt, 210000, 'Alice'], [bob, 'bob', verifier, salt, 210000, 'Bob']]);
sheet('sessions', ['user_id', 'token_hash', 'expired_at']);
sheet('diary', ['owner_id', 'date', 'title', 'content', 'mood', 'updated_at']);
const cache = new Map();
const properties = new Map();
const context = vm.createContext({ console: { error() {} }, SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: name => tables[name] }) },
  Utilities: { getUuid: () => crypto.randomUUID(), Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (_, text) => [...crypto.createHash('sha256').update(text).digest()],
    computeHmacSha256Signature: (text, key) => [...crypto.createHmac('sha256', key).update(text).digest()],
    base64DecodeWebSafe: value => [...Buffer.from(value, 'base64url')], newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }) },
  CacheService: { getScriptCache: () => ({ get: key => cache.get(key), put: (key, value) => cache.set(key, value), remove: key => cache.delete(key) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value) }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ value, setMimeType() { return this; } }) } });
vm.runInContext(fs.readFileSync(__dirname + '/code.js', 'utf8'), context);
function call(params) { return JSON.parse(context.doGet({ parameter: params }).value); }
function login(username) {
  const ch = call({ mode: 'login_challenge', username });
  assert.equal(ch.ok, true);
  const proof = crypto.createHmac('sha256', verifier).update(ch.challenge).digest('hex');
  const result = call({ mode: 'login', challenge: ch.challenge, proof });
  assert.equal(result.ok, true);
  assert.equal(call({ mode: 'login', challenge: ch.challenge, proof }).ok, false, 'challenge replay');
  return result;
}
const sessionA = login('alice');
assert.equal(tables.sessions.data[1][1], crypto.createHash('sha256').update(sessionA.token).digest('hex'));
const ch = call({ mode: 'login_challenge', username: 'alice' });
assert.equal(call({ mode: 'login', challenge: ch.challenge, proof: '0'.repeat(64) }).ok, false, 'wrong password');
const payload = Buffer.from(JSON.stringify({ owner_id: bob, date: '2026-10-08', title: '=formula', content: 'private', mood: 'good' })).toString('base64url');
assert.equal(call({ mode: 'save_diary', payload }).code, 'AUTH_REQUIRED');
assert.equal(call({ mode: 'save_diary', payload, token: sessionA.token }).ok, true);
assert.equal(tables.diary.data[1][0], alice, 'owner spoof must be ignored');
assert.equal(tables.diary.data[1][2], "'=formula", 'formula escaping');
const sessionB = login('bob');
assert.equal(call({ mode: 'list_diary', token: sessionA.token }).entries.length, 1);
assert.equal(call({ mode: 'list_diary', token: sessionB.token }).entries.length, 0);
assert.equal(call({ mode: 'delete_diary', payload, token: sessionB.token }).ok, true);
assert.equal(call({ mode: 'list_diary', token: sessionA.token }).entries.length, 1, 'other user cannot delete');
assert.equal(call({ mode: 'list_diary' }).code, 'AUTH_REQUIRED');
assert.equal(call({ mode: 'logout', token: sessionA.token }).ok, true);
assert.equal(call({ mode: 'check_session', token: sessionA.token }).code, 'AUTH_REQUIRED');
for (let i = 0; i < 5; i++) {
  const ch = call({ mode: 'login_challenge', username: 'missing' });
  assert.equal(call({ mode: 'login', challenge: ch.challenge, proof: '0'.repeat(64) }).ok, false);
}
assert.equal(call({ mode: 'login_challenge', username: 'missing' }).ok, false, 'retry limit');
console.log('PASS: login, password failure, nonce replay, token hashing, ownership, read/delete isolation, logout, retry limit');

for (const username of ['あ', '日記 太郎', '🌸', 'user@example.com', '長'.repeat(50), '00123', '=登録者']) {
  const challenge = call({ mode: 'register_challenge', username });
  assert.equal(challenge.ok, true, 'unrestricted username: ' + username);
  const hash = crypto.pbkdf2Sync('abcde', Buffer.from(challenge.salt, 'hex'), 210000, 32, 'sha256').toString('hex');
  const wrapped = Buffer.from(hash, 'hex').map((byte, i) => byte ^ Buffer.from(challenge.wrappingKey, 'hex')[i]).toString('hex');
  const proof = crypto.createHmac('sha256', challenge.wrappingKey).update(challenge.challenge + ':' + wrapped).digest('hex');
  assert.equal(call({ mode: 'register_user', challenge: challenge.challenge, wrapped, proof }).ok, true);
  const next = call({ mode: 'login_challenge', username });
  const loginProof = crypto.createHmac('sha256', hash).update(next.challenge).digest('hex');
  assert.equal(call({ mode: 'login', challenge: next.challenge, proof: loginProof }).ok, true, 'login with unrestricted username');
  assert.equal(call({ mode: 'register_challenge', username }).ok, false, 'duplicate rejected');
  const row = tables.users.data.find(row => row[1] === "'" + username.toLowerCase());
  assert.ok(row, 'username preserved as spreadsheet text');
}
assert.equal(call({ mode: 'register_challenge', username: '   ' }).ok, false);
assert.equal(call({ mode: 'login_challenge', username: '' }).ok, false);
console.log('PASS: Japanese, 1 character, emoji, symbols, internal space, 50 characters, leading zeros, formula prevention');

(async () => {
  const elements = new Map();
  const listeners = {};
  const tasks = [];
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
      handlers: {}, setAttribute(name, value) { this[name] = value; }, classList: { toggle() {}, add() {}, remove() {} }, addEventListener(event, fn) { this.handlers[event] = fn; },
      querySelector: sub => sub.includes(':checked') ? null : element(selector + ' ' + sub), querySelectorAll: () => [], focus() {} });
    return elements.get(selector);
  }
  const memory = new Map();
  const store = { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  const window = { crypto: crypto.webcrypto, addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    dispatchEvent: event => { for (const fn of listeners[event.type] || []) tasks.push(Promise.resolve(fn(event))); return true; },
    setInterval() {}, setTimeout() {}, clearTimeout() {}, confirm: () => true };
  const urls = [];
  const frontend = vm.createContext({ window, crypto: crypto.webcrypto, navigator: { onLine: true },
    document: { querySelector: element, addEventListener() {} }, localStorage: store, sessionStorage: store, URL, TextEncoder,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    btoa: text => Buffer.from(text, 'binary').toString('base64'),
    fetch: async url => { urls.push(url); const params = Object.fromEntries(new URL(url).searchParams); return { ok: true, json: async () => call(params) }; } });
  vm.runInContext(fs.readFileSync(__dirname + '/../public/auth.js', 'utf8'), frontend);
  vm.runInContext(fs.readFileSync(__dirname + '/../public/main.js', 'utf8'), frontend);
  async function settle() { while (tasks.length) await Promise.all(tasks.splice(0)); }
  await settle();
  assert.equal(element('#diary-workspace').hidden, true);
  async function browserLogin(username) {
    element('#login-username').value = username;
    element('#login-password').value = 'test-password-only';
    await element('#login-form').handlers.submit({ preventDefault() {} });
    await settle();
    assert.equal(element('#login-message').textContent, '');
    assert.equal(element('#diary-workspace').hidden, false);
    assert.equal(element('#login-password').value, '');
  }
  await browserLogin('alice');
  assert.equal(element('#entry-count').textContent, '1');
  element('#entry-date').value = '2026-10-08';
  element('#entry-date').handlers.change();
  assert.equal(element('#entry-content').value, 'private');
  element('#new-entry').handlers.click();
  assert.equal(element('#entry-content').value, '', 'plus opens empty draft');
  assert.equal(element('#entry-title').value, '');
  assert.equal(element('#date-label').textContent, '新しい日記');
  assert.equal(element('#delete-entry').hidden, true);
  assert.equal(JSON.parse(memory.get('hibi-journal.entries.account.' + alice)).length, 1, 'plus preserves saved diary');

  await element('#logout').handlers.click(); await settle();
  assert.equal(element('#diary-workspace').hidden, true);
  assert.equal(element('#entry-list').innerHTML, '');
  await browserLogin('bob');
  assert.equal(element('#entry-count').textContent, '0');
  assert.equal(urls.some(url => url.includes('test-password-only') || url.includes(verifier)), false, 'no password/verifier in URL');
  assert.equal(memory.has('hibi-journal.entries.account.' + alice), true);
  assert.equal(memory.has('hibi-journal.entries.account.' + bob), true);
  console.log('PASS: browser PBKDF2/HMAC login, hidden password, logout clearing, account storage isolation');
  await element('#logout').handlers.click(); await settle();
  await element('#mode-signup').handlers.click();
  assert.equal(element('#signup-fields').hidden, false);
  element('#login-username').value = 'charlie';
  assert.equal(element('#login-password').minLength, 5);
  element('#login-password').value = 'abcd';
  element('#login-password-repeat').value = 'abcd';
  const shortBefore = urls.length;
  await element('#login-form').handlers.submit({ preventDefault() {} });
  assert.equal(urls.length, shortBefore, '4 characters must not register');
  assert.equal(element('#login-message').textContent.includes('5文字以上'), true);

  element('#login-password').value = 'abcde';
  element('#login-password-repeat').value = 'different-password';
  const before = urls.length;
  await element('#login-form').handlers.submit({ preventDefault() {} });
  assert.equal(urls.length, before, 'mismatched password must not register');
  assert.equal(element('#login-message').textContent.includes('一致しません'), true);
  element('#login-password').value = 'abcde';
  element('#login-password-repeat').value = 'abcde';
  element('#signup-name').value = 'Charlie';
  await element('#login-form').handlers.submit({ preventDefault() {} }); await settle();
  assert.equal(element('#login-message').textContent, '');
  assert.equal(element('#diary-workspace').hidden, false, 'signup automatically logs in');
  assert.equal(element('#account-name').textContent, 'Charlie');
  assert.equal(element('#entry-count').textContent, '0');
  const created = tables.users.data.find(row => String(row[1]).replace(/^'/, '') === 'charlie');
  assert.ok(created);
  assert.equal(Object.prototype.toString.call(created[6]), '[object Date]', 'registered_at recorded');
  assert.equal(tables.users.data.filter(row => String(row[1]).replace(/^'/, '') === 'charlie').length, 1, 'one row per user');
  assert.equal(tables.users.data.find(row => row[1] === 'alice')[6], undefined, 'existing dates not fabricated');
  const signupSalt = created[3].slice(1);
  const signupVerifier = crypto.pbkdf2Sync('abcde', Buffer.from(signupSalt, 'hex'), 210000, 32, 'sha256').toString('hex');
  assert.equal(created[2].slice(1), signupVerifier, 'registration verifier matches password');
  assert.equal(urls.some(url => url.includes('abcde') || url.includes(signupVerifier)), false, 'registration must not leak password/verifier in URL');
  assert.equal(call({ mode: 'register_challenge', username: 'charlie' }).ok, false, 'duplicate name rejected');
  const registerParams = Object.fromEntries(new URL(urls.find(url => new URL(url).searchParams.get('mode') === 'register_user')).searchParams);
  assert.equal(call(registerParams).ok, false, 'registration replay rejected');
  const tamper = call({ mode: 'register_challenge', username: 'tamper' });
  assert.equal(call({ mode: 'register_user', challenge: tamper.challenge, wrapped: '0'.repeat(64), proof: '0'.repeat(64) }).ok, false);
  assert.equal(tables.users.data.some(row => row[1] === 'tamper'), false);
  console.log('PASS: signup, confirmation, auto login, duplicate name, replay, tampered registration, no password/verifier in URL');

})().catch(error => { console.error(error); process.exitCode = 1; });
