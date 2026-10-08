const crypto = require('node:crypto');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let hidden = false;
const originalWrite = rl._writeToOutput.bind(rl);
rl._writeToOutput = text => { if (!hidden) originalWrite(text); };
const ask = prompt => new Promise(resolve => rl.question(prompt, resolve));
(async () => {
  try {
    const username = (await ask('Username: ')).trim().toLowerCase();
    if (!username) throw new Error('Enter a username.');
    process.stdout.write('Password (5+ characters, hidden): ');
    hidden = true;
    const password = await ask('');
    hidden = false;
    process.stdout.write('\n');
    if (password.length < 5) throw new Error('Use at least 5 characters.');
    process.stdout.write('Repeat password (hidden): ');
    hidden = true;
    const repeat = await ask('');
    hidden = false;
    process.stdout.write('\n');
    if (password !== repeat) throw new Error('Passwords do not match.');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), 210000, 32, 'sha256').toString('hex');
    console.log('Paste the following row into the users sheet. Keep it private:');
    console.log([crypto.randomUUID(), "'" + username, hash, salt, 210000, "'" + username].map(value => { const text = String(value); return /[\t\r\n"]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text; }).join('\t'));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { hidden = false; rl.close(); }
})();
