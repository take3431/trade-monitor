// 入口のパスワード
// ・パスワードを通るまで、アプリ本体（株価の取得を含む）を一切読み込まない。
//   リンクを開いただけの人は、株価の取得先へ1回も通信しない。
// ・一度通った端末は覚えておき、次回からは聞かない（パスワードを変えたら聞き直す）。
// ・何度も間違えたら、しばらく入力できなくする。
// ※個人情報を守るためのものではなく、知らない人による通信を防ぐための簡易的な鍵です。
//   パスワードはそのまま置かず、照合用の値（SHA-256）だけを置いています。

const PASS_HASH = '185c812111b6d6e79b93c448cc8017b23f8b10abef069db13fd2762801c3b1a8';
const AUTH_KEY = 'tm.auth.v1';
const LOCK_KEY = 'tm.authlock.v1';
// 間違えた回数に応じた待ち時間：5回で5分、10回で30分、15回以上は1時間ずつ
const lockMinutes = (n) => (n >= 15 ? 60 : n >= 10 ? 30 : n >= 5 ? 5 : 0);

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function startApp() {
  document.body.classList.remove('locked');
  document.getElementById('gate')?.remove();
  import('./app.js?v=20261125124411');
}

function showGate() {
  document.body.classList.add('locked');
  const g = document.createElement('div');
  g.id = 'gate';
  g.className = 'gate';
  g.innerHTML = `
    <form class="gate-box" autocomplete="off">
      <div class="gate-title">TRADE MONITOR</div>
      <p class="gate-text">パスワードを入力してください<span class="gate-hint" title="ヒント" aria-label="ヒント：かぼちゃ"><svg viewBox="0 0 64 64" width="34" height="34" aria-hidden="true"><path d="M33 14c0-5 2-8 6-10" fill="none" stroke="#5a8f2e" stroke-width="4" stroke-linecap="round"/><path d="M36 11c5-4 11-3 14 1-5 3-10 3-14-1z" fill="#6fae3a"/><ellipse cx="18" cy="38" rx="12" ry="17" fill="#e8892b"/><ellipse cx="46" cy="38" rx="12" ry="17" fill="#e8892b"/><ellipse cx="25" cy="38" rx="11" ry="19" fill="#f39a33"/><ellipse cx="39" cy="38" rx="11" ry="19" fill="#f39a33"/><ellipse cx="32" cy="38" rx="9" ry="20" fill="#f7a944"/><path d="M32 19v38M24 21c-3 9-3 26 0 34M40 21c3 9 3 26 0 34" fill="none" stroke="#d47a22" stroke-width="1.6" opacity=".7"/></svg></span></p>
      <input id="gatePass" type="password" inputmode="text" autocapitalize="characters" spellcheck="false" aria-label="パスワード">
      <button type="submit" class="btn primary block" id="gateOk">開く</button>
      <p class="gate-msg" id="gateMsg"></p>
    </form>`;
  document.body.appendChild(g);
  const input = g.querySelector('#gatePass');
  const msg = g.querySelector('#gateMsg');
  const btn = g.querySelector('#gateOk');

  let timer = null;
  const refreshLock = () => {
    const l = load(LOCK_KEY, { n: 0, until: 0 });
    const left = Math.ceil((l.until - Date.now()) / 1000);
    const locked = left > 0;
    input.disabled = locked;
    btn.disabled = locked;
    if (locked) {
      msg.textContent = `入力の誤りが続いたため、${Math.floor(left / 60)}分${String(left % 60).padStart(2, '0')}秒 お待ちください`;
      msg.className = 'gate-msg err';
    } else if (msg.dataset.wasLocked) {
      msg.textContent = '';
      delete msg.dataset.wasLocked;
      input.focus();
    }
    if (locked) msg.dataset.wasLocked = '1';
    return locked;
  };
  refreshLock();
  timer = setInterval(refreshLock, 1000);
  setTimeout(() => { if (!input.disabled) input.focus(); }, 100);

  g.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (refreshLock()) return;
    // 全角・小文字で入力しても通るようにそろえる
    const v = input.value.normalize('NFKC').trim().toUpperCase();
    if (!v) return;
    if (await sha256(v) === PASS_HASH) {
      clearInterval(timer);
      save(AUTH_KEY, PASS_HASH);
      localStorage.removeItem(LOCK_KEY);
      startApp();
      return;
    }
    const l = load(LOCK_KEY, { n: 0, until: 0 });
    l.n += 1;
    const wait = lockMinutes(l.n);
    if (wait && l.n % 5 === 0) l.until = Date.now() + wait * 60e3;
    else if (l.n >= 15) l.until = Date.now() + wait * 60e3;
    save(LOCK_KEY, l);
    input.value = '';
    if (!refreshLock()) {
      const rest = 5 - (l.n % 5);
      msg.textContent = `パスワードが違います（あと${rest}回間違えると、しばらく入力できなくなります）`;
      msg.className = 'gate-msg err';
      input.focus();
    }
  });
}

if (load(AUTH_KEY, '') === PASS_HASH) startApp();
else showGate();
