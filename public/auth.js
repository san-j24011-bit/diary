(() => {
  const endpoint = 'https://script.google.com/macros/s/AKfycbyyjZigB9NvChT9dhJHPZ1xTsaqlR2QvKFYGqK1KASHZEIg85gTOGQ6pEWxUaK8uCL0/exec';
  const key = 'hibi-journal.session.v1';
  const loginForm = document.querySelector('#login-form');
  const message = document.querySelector('#login-message');
  let session = null;
  let busy = false;
  let isSignup = false;
  function setMode(signup) {
    isSignup = signup;
    document.querySelector('#login-heading').textContent = signup ? 'あなたの日記をはじめよう' : 'おかえりなさい';
    document.querySelector('#login-description').textContent = signup ? 'ユーザー名とパスワードで、あなた専用のアカウントを作れます。' : 'ログインして、あなたの日々の記録を開きましょう。';
    document.querySelector('#signup-fields').hidden = !signup;
    document.querySelector('#signup-repeat-field').hidden = !signup;
    document.querySelector('#login-password-repeat').required = signup;
    document.querySelector('#login-password-repeat').disabled = !signup;
    document.querySelector('#login-password').autocomplete = signup ? 'new-password' : 'current-password';
    document.querySelector('#login-password').minLength = signup ? 5 : 1;
    document.querySelector('#auth-submit').textContent = signup ? 'アカウントを作成' : 'ログイン';
    document.querySelector('#mode-login').setAttribute('aria-pressed', String(!signup));
    document.querySelector('#mode-signup').setAttribute('aria-pressed', String(signup));
    document.querySelector('#login-password').value = '';
    document.querySelector('#login-password-repeat').value = '';
    message.textContent = '';
  }
  document.querySelector('#mode-login').addEventListener('click', () => { if (!busy) setMode(false); });
  document.querySelector('#mode-signup').addEventListener('click', () => { if (!busy) setMode(true); });
  function readSession() { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } }
  function announce(user) {
    document.querySelector('#login-panel').hidden = Boolean(user);
    document.querySelector('#diary-workspace').hidden = !user;
    document.querySelector('#account-controls').hidden = !user;
    document.querySelector('#account-name').textContent = user ? user.name || user.username : '';
    window.dispatchEvent(new CustomEvent('diary-auth-change', { detail: user }));
  }
  function expire() {
    session = null;
    sessionStorage.removeItem(key);
    announce(null);
    message.textContent = 'ログインしてください。';
  }
  async function request(mode, params = {}, authenticated = true) {
    const url = new URL(endpoint);
    url.searchParams.set('mode', mode);
    Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value));
    if (authenticated) {
      if (!session || Date.parse(session.expiredAt) <= Date.now()) { expire(); throw new Error('もう一度ログインしてください。'); }
      url.searchParams.set('token', session.token);
    }
    const response = await fetch(url.href, { cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('接続できませんでした。');
    const result = await response.json();
    if (!result.ok) {
      if (result.code === 'AUTH_REQUIRED') expire();
      throw new Error(result.message || '処理できませんでした。');
    }
    return result;
  }
  const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  async function verifierFor(password, challenge) {
    if (!window.crypto?.subtle) throw new Error('HTTPSまたはlocalhostで開いてください。');
    if (!/^[a-f0-9]{32}$/.test(challenge.salt) || challenge.iterations !== 210000) throw new Error('サーバーの認証設定を確認してください。');
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const salt = Uint8Array.from(challenge.salt.match(/../g), byte => parseInt(byte, 16));
    const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: challenge.iterations }, keyMaterial, 256);
    return hex(derived);
  }
  async function proofFor(password, challenge) {
    const encoder = new TextEncoder();
    const verifier = await verifierFor(password, challenge);
    const hmacKey = await crypto.subtle.importKey('raw', encoder.encode(verifier), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(challenge.challenge)));
  }
  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const button = document.querySelector('#auth-submit');
    button.disabled = true;
    document.querySelector('#mode-login').disabled = true;
    document.querySelector('#mode-signup').disabled = true;
    message.textContent = isSignup ? 'アカウントを作成しています…' : 'ログインしています…';
    const passwordInput = document.querySelector('#login-password');
    let registered = false;
    try {
      const username = document.querySelector('#login-username').value.trim().toLowerCase();
      if (isSignup) {
        if (passwordInput.value.length < 5) throw new Error('パスワードは5文字以上で入力してください。');
        if (passwordInput.value !== document.querySelector('#login-password-repeat').value) throw new Error('確認用パスワードが一致しません。');
        const registration = await request('register_challenge', { username }, false);
        if (!/^[a-f0-9]{64}$/.test(registration.wrappingKey)) throw new Error('登録の設定を確認してください。');
        const verifier = await verifierFor(passwordInput.value, registration);
        const wrapped = verifier.match(/../g).map((byte, index) => (parseInt(byte, 16) ^ parseInt(registration.wrappingKey.slice(index * 2, index * 2 + 2), 16)).toString(16).padStart(2, '0')).join('');
        const encoder = new TextEncoder();
        const wrappingKey = await crypto.subtle.importKey('raw', encoder.encode(registration.wrappingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const proof = hex(await crypto.subtle.sign('HMAC', wrappingKey, encoder.encode(registration.challenge + ':' + wrapped)));
        await request('register_user', { challenge: registration.challenge, wrapped, proof, name: document.querySelector('#signup-name').value.trim() }, false);
        registered = true;
      }
      const challenge = await request('login_challenge', { username }, false);
      const proof = await proofFor(passwordInput.value, challenge);
      const result = await request('login', { challenge: challenge.challenge, proof }, false);
      session = { token: result.token, expiredAt: result.expiredAt, user: result.user };
      sessionStorage.setItem(key, JSON.stringify(session));
      setMode(false);
      passwordInput.value = '';
      message.textContent = '';
      announce(result.user);
    } catch (error) {
      passwordInput.value = '';
      document.querySelector('#login-password-repeat').value = '';
      if (registered) setMode(false);
      message.textContent = registered ? 'アカウントは作成できました。ログインをお試しください。' : error.message;
    } finally {
      busy = false; button.disabled = false;
      document.querySelector('#mode-login').disabled = false;
      document.querySelector('#mode-signup').disabled = false;
    }
  });
  document.querySelector('#logout').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try { await request('logout'); expire(); }
    catch (error) { document.querySelector('#auth-status').textContent = 'ログアウトできませんでした。オンラインで再試行してください。'; }
    finally { busy = false; }
  });
  setMode(false);
  window.diaryAuth = {
    request, expire,
    token: () => session?.token || '',
    async start() {
      session = readSession();
      if (!session) { announce(null); return; }
      try { const result = await request('check_session'); announce(result.user); }
      catch { expire(); message.textContent = navigator.onLine ? 'ログイン状態を確認できません。再度ログインしてください。' : 'ログインにはインターネット接続が必要です。'; }
    },
  };
})();
