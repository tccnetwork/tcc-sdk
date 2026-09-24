// tcc-client.js — talking to a TCC node from a browser: RPC, the wallet, signing,
// sending a transaction and waiting for it, and publishing a program.
//
// WHY THIS FILE EXISTS. Four pages (the wallet, the NFT app, the market, the
// contract tools) each carried their own copy of this. Copies drift, and drift here
// is expensive: the tools page derived a buffer address with the v3 formula long
// after the node had changed it, so every upload went to a buffer that did not
// exist — the page was broken for months and nobody could tell why. One copy, one
// place to fix.
//
// RULES: no DOM, no page state, no side effect at load. It knows how to reach a
// node; it does not know what your page looks like. What a contract's arguments mean
// belongs to the page (see tools/tools-core.js for the tools page's own encoders).

const CFG = {
  // Endpoints in order. A NETWORK failure moves to the next; an answer from the node
  // — even an error — is final, because retrying a rejected transaction elsewhere
  // just repeats it.
  rpcs: ['https://rpc2.tcc-coin.com/rpc', 'https://rpc3.tcc-coin.com/rpc'],
  // Where the Dilithium3 signer package lives, relative to the page.
  pkgDir: 'public/pkg/',
  timeoutMs: 20000,
};

/// Point the client somewhere else: `configure({ rpcs: [...], pkgDir: '../public/pkg/' })`.
export function configure(opts = {}) { Object.assign(CFG, opts); }
export const config = () => ({ ...CFG });

const hex = b => '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => {
  const s = String(h || '').replace(/^0x/i, '');
  const o = new Uint8Array(s.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16);
  return o;
};
const norm0x = h => '0x' + String(h || '').replace(/^0x/i, '').toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── RPC ────────────────────────────────────────────────────────────────────────

/// One JSON-RPC call. Throws with the node's own message when the node refuses.
export async function rpc(method, params = [], ms = CFG.timeoutMs) {
  let lastErr;
  for (const url of CFG.rpcs) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    let j;
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl.signal,
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      j = await r.json();
    } catch (e) { lastErr = e; continue; } finally { clearTimeout(t); }
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.result;
  }
  throw lastErr || new Error('no RPC endpoint reachable');
}

/// The finalized height.
export async function tipHeight() {
  const t = await rpc('tcc_getChainTip');
  return Number(t.finalized_height ?? t.height ?? t.tip_height);
}
/// An account's balance in wei.
export const balanceOf = async addr => BigInt(await rpc('tcc_getBalance', [addr]));
/// Whether a contract is deployed at `addr`.
export async function codeExists(addr) {
  const r = await rpc('tcc_getContractCode', [addr]);
  return !!(r && r.code);
}
/// One raw storage value of a contract, or null.
export async function contractState(addr, key) {
  const k = typeof key === 'string' ? key : hex(key).slice(2);
  const r = await rpc('tcc_queryContractState', [addr, k]);
  return r && r.value ? unhex(r.value) : null;
}

// Every TCC contract frames its answer as status[4, i32 LE] ‖ payload.
function splitReturn(dataHex) {
  const b = unhex(dataHex || '');
  if (b.length < 4) return { code: null, payload: new Uint8Array(0) };
  return { code: new DataView(b.buffer, b.byteOffset).getInt32(0, true), payload: b.slice(4) };
}

/// A read-only call: free, changes nothing, and the only way to learn WHY a call
/// would be refused — a transaction that fails is simply dropped, with its status
/// recorded nowhere. Run this before asking anyone to sign.
export async function view(contract, method, args, caller) {
  const a = args && args.length ? hex(args).slice(2) : '';
  const r = await rpc('tcc_callContract', [contract, method, a, caller || '']);
  if (!r || r.status === undefined) {
    throw new Error(`${method}: the node did not run the call (${JSON.stringify(r).slice(0, 120)})`);
  }
  return { code: r.status, payload: splitReturn(r.data).payload };
}

// ── wallet ─────────────────────────────────────────────────────────────────────

let wasm = null;

/// Load the Dilithium3 signer (from `CFG.pkgDir`). Called for you by `connect`.
export async function loadSigner() {
  if (wasm) return wasm;
  wasm = await import(`${CFG.pkgDir}tcc_dilithium3_mldsa.js`);
  await wasm.default(`${CFG.pkgDir}tcc_dilithium3_mldsa_bg.wasm`);
  return wasm;
}
/// blake3-256, the chain's hash. Needs the signer loaded.
export const blake3 = b => wasm.blake3_256(b);
/// A contract's address is the hash of its code.
export const addressOfCode = code => hex(blake3(code));

/// The TCC wallet's own derivation: a valid 24-word BIP39 phrase becomes its
/// ENTROPY HEX first; anything else is used as a raw seed string. Hashing the words
/// themselves derives a different key — that bug put users at an address that was
/// not theirs, with an empty balance.
///
/// `bip39` is `{ validateMnemonic, mnemonicToEntropy, wordlist }`; pass it when the
/// page supports recovery phrases, leave it out to accept raw seeds only.
export function seedFrom(input, bip39 = null, rawMin = 100) {
  const v = String(input).trim();
  const m = v.toLowerCase().replace(/\s+/g, ' ');
  if (m.split(' ').length === 24) {
    if (!bip39) throw new Error('this page cannot read recovery phrases');
    if (!bip39.validateMnemonic(m, bip39.wordlist)) {
      throw new Error('those 24 words are not a valid recovery phrase (checksum failed) — check for a typo');
    }
    return Array.from(bip39.mnemonicToEntropy(m, bip39.wordlist), x => x.toString(16).padStart(2, '0')).join('');
  }
  if (v.length < rawMin) {
    throw new Error(`not a 24-word recovery phrase, and too short (${v.length} characters) to be a raw TCC seed`);
  }
  return v;
}

/// Derive a wallet from a seed or recovery phrase: `{ address, pubHex, sk }`. The
/// secret stays in this tab's memory and is never sent anywhere.
export async function walletFrom(input, bip39 = null) {
  await loadSigner();
  const kp = wasm.generate_keypair(seedFrom(input, bip39));
  return { address: hex(blake3(kp.public_key)), pubHex: hex(kp.public_key), sk: kp.private_key };
}

const sigBytes = s => (s instanceof Uint8Array ? s : (s.signature || s));
/// Sign a message the node asked to be signed.
export const signMessage = (msgHex, sk) => sigBytes(wasm.sign_detached(unhex(msgHex), sk));

// ── transactions ───────────────────────────────────────────────────────────────

/// Build (on the node), sign (here) and submit one transaction. Returns the node's
/// unsigned tx — it carries `nonce`, and for a BufferInit the `buffer` address —
/// plus the transaction hash.
export async function buildSignSubmit(wallet, method, params) {
  const u = await rpc(method, params);
  const sig = signMessage(u.signing_message_hex, wallet.sk);
  const res = await rpc('tcc_submitSignedTransfer', [u.unsigned_tx_base64, hex(sig), wallet.pubHex]);
  return { u, hash: (res && res.tx_hash) || res };
}

/// The next nonce this account will use.
export const nextNonce = async wallet => Number(await rpc('tcc_getNextNonce', [wallet.address]));

/// Wait until the account nonce passes `target`, which is how a transaction is
/// confirmed: a tx lookup can lag or miss, the nonce cannot. A transaction that is
/// rejected never moves it — after the wait, check state rather than assuming.
export async function waitNonce(wallet, target, what = 'the transaction', seconds = 150) {
  for (let i = 0; i < seconds / 1.5; i++) {
    if (await nextNonce(wallet) >= target) return true;
    await sleep(1500);
  }
  throw new Error(`${what} was not confirmed within ${seconds} s — it may still land; check the explorer before retrying`);
}

/// Call a contract method. `accounts` MUST list every other contract the call
/// reaches with `tcc_invoke`, or the callee reads empty state and the call fails.
/// The gas price climbs 1-2-4-8 only when the node says another transaction from
/// this wallet already holds the nonce — a retry has to outbid it.
export async function contractCall(wallet, { contract, method, args, value = 0n, accounts = [], gas = 3_000_000 }) {
  let last;
  for (const gp of [1, 2, 4, 8]) {
    try {
      return await buildSignSubmit(wallet, 'tcc_buildUnsignedContractCall',
        [wallet.address, contract, method, hex(args), value.toString(), gas, gp, accounts]);
    } catch (e) {
      last = e;
      if (!/underbid|already holds this nonce/i.test(e.message)) throw e;
    }
  }
  throw last;
}

/// Run a call as a view first, as this wallet. A refusal costs nothing here and a
/// fee on chain. Only for calls that send no TCC — a view carries no value.
export async function preflight(wallet, { contract, method, args }, why = c => `status ${c}`) {
  const r = await view(contract, method, args, wallet.address);
  if (r.code !== 0) throw new Error(`${method} would be refused: ${why(r.code)}`);
  return r;
}

/// Preflight (when it can), send, and wait. `log(text, cls)` is optional.
export async function sendCall(wallet, call, { dry = true, why, log = () => {} } = {}) {
  if (dry && !call.value) await preflight(wallet, call, why);
  const { u, hash } = await contractCall(wallet, call);
  log(`${call.method} sent — tx ${norm0x(hash).slice(0, 12)}…`, 'dim');
  await waitNonce(wallet, Number(u.nonce) + 1, call.method);
  log(`${call.method} confirmed`, 'ok');
  return hash;
}

// ── publishing a program ───────────────────────────────────────────────────────

/// Two programs with the same bytes share one address, because the address IS the
/// hash of the code. Appending a WASM custom section (id 0, ignored by the VM) with
/// a random salt gives a second instance its own address.
export function saltedWasm(base, salt) {
  if (!salt) { salt = new Uint8Array(8); crypto.getRandomValues(salt); }
  const name = new TextEncoder().encode('s');
  const content = new Uint8Array(1 + name.length + salt.length);
  content[0] = name.length; content.set(name, 1); content.set(salt, 1 + name.length);
  const out = new Uint8Array(base.length + 2 + content.length);
  out.set(base, 0);
  out[base.length] = 0x00; out[base.length + 1] = content.length;
  out.set(content, base.length + 2);
  return out;
}

const CHUNK = 2048;   // bytes per BufferWrite; a transaction stays under 8 KB with its signature

/// Publish `code` and return its address (`blake3(code)`). If that address already
/// holds code, nothing is sent.
///
/// The buffer address is the one the NODE returns from BufferInit — never derived
/// here. Deriving it is what broke the tools page: v4 hashes a different domain and
/// nonce byte order than v3 did, so every chunk went to a buffer that did not exist.
///
/// Parts are sent without waiting for each (one block per part would be ten minutes
/// for a 128 KB program), numbered with explicit nonces. Then the ACCOUNT NONCE is
/// watched: it names exactly the part that went missing, and that part is re-sent.
export async function publishProgram(wallet, code, log = () => {}) {
  await loadSigner();
  const addr = addressOfCode(code);
  if (await codeExists(addr)) { log(`program already on chain at ${addr}`, 'ok'); return addr; }

  const n = Math.ceil(code.length / CHUNK);
  log(`uploading ${(code.length / 1024).toFixed(1)} KB in ${n} parts — ${n + 2} transactions`);
  const init = await buildSignSubmit(wallet, 'tcc_buildUnsignedBufferInit', [wallet.address, code.length, n, 1]);
  const buffer = norm0x(init.u.buffer || '');
  if (!/^0x[0-9a-f]{64}$/.test(buffer)) throw new Error('the node did not return a buffer address — not uploading blind');
  const base = Number(init.u.nonce);
  await waitNonce(wallet, base + 1, 'buffer init');

  const part = i => buildSignSubmit(wallet, 'tcc_buildUnsignedBufferWrite',
    [wallet.address, buffer, i, hex(code.slice(i * CHUNK, (i + 1) * CHUNK)), 1, base + 1 + i]);
  for (let i = 0; i < n; i++) {
    await part(i);
    if ((i + 1) % 10 === 0 || i === n - 1) log(`sent part ${i + 1}/${n}`, 'dim');
  }

  const done = base + 1 + n;
  let last = -1, stalls = 0, resends = 0;
  for (;;) {
    const nn = await nextNonce(wallet);
    if (nn >= done) break;
    if (nn === last) {
      if (++stalls >= 8) {
        const p = nn - base - 1;
        if (resends >= 3) throw new Error(`upload stalled at part ${p + 1}/${n} after 3 re-sends — nothing is lost; try again later`);
        resends++; stalls = 0;
        log(`part ${p + 1} did not land — re-sending (${resends}/3)`, 'dim');
        await part(p);
      }
    } else { stalls = 0; last = nn; }
    await sleep(1500);
  }
  log(`all ${n} parts applied`, 'ok');

  await buildSignSubmit(wallet, 'tcc_buildUnsignedContractDeploy', [wallet.address, buffer, 1, done]);
  await waitNonce(wallet, done + 1, 'contract deploy');
  if (!await codeExists(addr)) throw new Error(`the deploy confirmed but ${addr} holds no code — the upload was incomplete`);
  log(`program live at ${addr}`, 'ok');
  return addr;
}

/// Publish a program and run its first method in ONE transaction, so nobody can
/// initialise it in between. The chain accepts this only from the untrusted-code
/// activation height (PLAN-untrusted-contracts.md) — until then use
/// `publishProgram` followed by `sendCall`.
export async function publishProgramAndInit(wallet, code, { method, args = new Uint8Array(0), accounts = [], value = 0n, gas = 10_000_000 }, log = () => {}) {
  await loadSigner();
  const addr = addressOfCode(code);
  const n = Math.ceil(code.length / CHUNK);
  const init = await buildSignSubmit(wallet, 'tcc_buildUnsignedBufferInit', [wallet.address, code.length, n, 1]);
  const buffer = norm0x(init.u.buffer || '');
  const base = Number(init.u.nonce);
  await waitNonce(wallet, base + 1, 'buffer init');
  for (let i = 0; i < n; i++) {
    await buildSignSubmit(wallet, 'tcc_buildUnsignedBufferWrite',
      [wallet.address, buffer, i, hex(code.slice(i * CHUNK, (i + 1) * CHUNK)), 1, base + 1 + i]);
  }
  await waitNonce(wallet, base + 1 + n, 'the upload');
  log(`deploying and running ${method}`, 'dim');
  await buildSignSubmit(wallet, 'tcc_buildUnsignedContractDeployInit',
    [wallet.address, buffer, method, hex(args), value.toString(), gas, 1, accounts, base + 1 + n]);
  await waitNonce(wallet, base + 2 + n, 'deploy + initialize');
  if (!await codeExists(addr)) throw new Error(`${addr} holds no code — the deploy did not apply`);
  return addr;
}

export { hex, unhex, norm0x, splitReturn, sleep };
