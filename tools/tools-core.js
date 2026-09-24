// tools-core.js — everything the Contract Tools page encodes, with no DOM and no wallet.
//
// It is split out of tools.html so the exact bytes the page puts on chain can be
// produced outside a browser and replayed through the node's own simulator
// (chainv2::sim). A page that encodes arguments in inline script can only be tested
// by spending real TCC; this file can be tested for free, and was.
//
// RULE: no `document`, no `window`, no `fetch`, no side effect at load. Anything that
// talks to the chain or the page belongs in tools.html.

// ── chain facts ────────────────────────────────────────────────────────────────
export const CHAIN_ID = 91338;
export const BLK_DAY = 8640;            // ~10 s blocks (measured 9.9 s on 2026-09-21)
export const CHUNK = 2048;              // bytes per BufferWrite; a tx stays < 8 KB with its signature
export const GAS_CALL = 3_000_000;      // what the live market page sends per trade
export const GAS_INIT = 10_000_000;     // initialize_* parses JSON state; the NFT app sends this
export const WEI = 10n ** 18n;

// The NFT markets, active first — the same list market-core.js (the live market page)
// reads. A contract address is blake3(code), so every fix to the market contract
// minted a NEW address and the old one kept its listings: new listings go to the
// first entry, but anything acting on an EXISTING listing must use the market that
// holds it, or real TCC goes to a contract that has never heard of the item.
export const OFFERS_MARKET = '0x2f08d1d0cdc8a16267f9cb73e8578f2a648929e9af7c96f85abdba5540221842';
export const MARKETS = [
  OFFERS_MARKET,                                                          // active, has offers
  '0x2b7ac2f77a6ddaa317e8a6590398b58fb94052d3215d8b62d8970b76e5905249',  // first public market
  '0x95985e21254c3046539bda020242c82fd50b7f938e7908ccde9ffaab32b9282e',  // v2, a few listings left
];

// ── bytes ──────────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
export const utf8 = s => enc.encode(s);
export function hexToBytes(h) {
  const s = String(h || '').replace(/^0x/i, '').replace(/\s+/g, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('not hex: ' + String(h).slice(0, 20));
  const o = new Uint8Array(s.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16);
  return o;
}
export const toHex = b => '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export const norm0x = h => '0x' + String(h || '').replace(/^0x/i, '').toLowerCase();
export function cat(...parts) {
  let n = 0; for (const p of parts) n += p.length;
  const o = new Uint8Array(n); let k = 0;
  for (const p of parts) { o.set(p, k); k += p.length; }
  return o;
}
function uNle(bytes, v) {
  let n = BigInt(v);
  if (n < 0n || n >= 1n << BigInt(8 * bytes)) throw new Error(`${v} does not fit in ${bytes} bytes`);
  const b = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) { b[i] = Number(n & 0xffn); n >>= 8n; }
  return b;
}
export const u64le = v => uNle(8, v);
export const u128le = v => uNle(16, v);
export function readUle(b, off, bytes) {
  let n = 0n;
  for (let i = bytes - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[off + i]);
  return n;
}
// Length-prefixed UTF-8 (1-byte length), capped by the contract's own limit.
export function lp(str, max, what) {
  const b = utf8(str);
  if (!b.length) throw new Error(`${what} is empty`);
  if (b.length > max) throw new Error(`${what} is ${b.length} bytes; the contract allows ${max}`);
  return cat(new Uint8Array([b.length]), b);
}
// A 32-byte address. Only 0x + 64 hex: a short or padded value is a different
// address, and a typo there sends the call to a contract that does not exist.
export function addr32(s, what = 'address') {
  const h = String(s || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error(`${what}: enter 0x followed by 64 hex characters`);
  return hexToBytes(h);
}
// A token id. The NFT app mints each token under 32 RANDOM bytes and shows it as
// 0x + 64 hex, so that is the only form accepted: padding a short value or reading a
// decimal would name a different token, silently.
export const tokenId32 = s => addr32(s, 'token id');

// ── money ──────────────────────────────────────────────────────────────────────
// TCC as typed ("1.5") → wei, exactly. Never through a float: 0.1 TCC is not
// representable in binary and a rounded price is a rejected buy.
export function tccToWei(s, what = 'amount') {
  const t = String(s ?? '').trim();
  if (!/^\d+(\.\d{0,18})?$/.test(t)) throw new Error(`${what}: enter a TCC amount like 1.5 (up to 18 decimals)`);
  const [i, f = ''] = t.split('.');
  return BigInt(i) * WEI + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
export function weiToTcc(w) {
  const v = BigInt(w), i = v / WEI, f = (v % WEI).toString().padStart(18, '0').replace(/0+$/, '');
  return f ? `${i}.${f}` : `${i}`;
}

// ── programs ───────────────────────────────────────────────────────────────────
// Salting a template so a second instance gets its own address lives in the shared
// client, because the NFT app needs it too — one implementation, re-exported here so
// this module stays the single import for the tools page and its tests.
export { saltedWasm } from '../tcc-client.js';

// token program — initialize_mint(mint_id[32] ‖ authority[32] ‖ decimals[1] ‖ lp(name)
//                ‖ lp(symbol) ‖ cap_flag[1] ‖ cap[16]?)        contracts/token/src/lib.rs
export function encInitMint({ mintId, authority, decimals, name, symbol, capWhole }) {
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 18) throw new Error('decimals: 0 to 18');
  const cap = BigInt(capWhole || 0);
  if (cap < 0n) throw new Error('max supply cannot be negative');
  return cat(mintId, authority, new Uint8Array([d]), lp(name, 32, 'name'), lp(symbol, 12, 'symbol'),
    cap > 0n ? cat(new Uint8Array([1]), u128le(cap * 10n ** BigInt(d))) : new Uint8Array([0]));
}
// token program — mint_to(mint_id[32] ‖ recipient[32] ‖ amount[16])
export const encMintTo = ({ mintId, to, amount }) => cat(mintId, to, u128le(amount));

// erc721 — initialize_collection(lp(name) ‖ lp(symbol) ‖ mint_authority[32])
export const encInitCollection = ({ name, symbol, authority }) =>
  cat(lp(name, 32, 'name'), lp(symbol, 12, 'symbol'), authority);
// erc721 — set_approval_for_all(operator[32] ‖ approved[1])
export const encApproveAll = (operator, on = true) => cat(operator, new Uint8Array([on ? 1 : 0]));

// poll (tcc-sdk/examples/poll.rs) — create(n[1] ‖ close_height[8]), vote(option[1])
export function encPollCreate(nOptions, closeHeight) {
  if (nOptions < 2 || nOptions > 32) throw new Error('a poll needs 2 to 32 options');
  return cat(new Uint8Array([nOptions]), u64le(closeHeight));
}
export const encPollVote = i => new Uint8Array([i]);
// results() → n[1] ‖ tally[8] × n
export function decPollResults(b) {
  const n = b[0], out = [];
  for (let i = 0; i < n; i++) out.push(readUle(b, 1 + 8 * i, 8));
  return out;
}

// nft-market (contracts/nft-market, NATIVE TCC). Every call that moves or checks the
// NFT CPIs into the collection, so the collection goes in the tx's account list —
// without it the market reads an empty collection and the call fails.
export const encNftTid = (nft, tid) => cat(nft, tid);
export const encListSale = (nft, tid, priceWei) => cat(nft, tid, u128le(priceWei));
export const encStartAuction = (nft, tid, reserveWei, blocks) => cat(nft, tid, u128le(reserveWei), u64le(blocks));
export const encListRent = (nft, tid, ppbWei) => cat(nft, tid, u128le(ppbWei));
export const encRent = (nft, tid, blocks) => cat(nft, tid, u64le(blocks));
export const encMakeOffer = (nft, tid, expiresBlocks) => cat(nft, tid, u64le(expiresBlocks));
export const encAcceptOffer = (nft, tid, buyer) => cat(nft, tid, buyer);

// get_listing → kind[1] ‖ party[32] ‖ amount_a[16] ‖ time[8] ‖ counter[32] ‖ amount_b[16]
// kind: 0 none · 1 sale · 2 auction · 3 rental. For a sale amount_a is the price;
// for an auction it is the reserve and amount_b the high bid; for a rental amount_a is
// the price per block.
export const LISTING_KIND = { 0: 'none', 1: 'sale', 2: 'auction', 3: 'rental' };
export function decListing(b) {
  if (!b || b.length < 105 || b[0] === 0) return null;
  return {
    kind: LISTING_KIND[b[0]] || `kind ${b[0]}`,
    party: toHex(b.slice(1, 33)),
    amountA: readUle(b, 33, 16),
    time: readUle(b, 49, 8),
    counter: toHex(b.slice(57, 89)),
    amountB: readUle(b, 89, 16),
  };
}

// What the market's status codes mean (contracts/nft-market/src/lib.rs), so a refusal
// reads as a reason instead of a number.
export const MARKET_STATUS = {
  1: 'bad arguments (an auction needs a duration above 0)',
  2: 'this market is not initialised',
  4: 'there is no listing for this NFT on this market',
  5: 'the listing is a different kind (sale / auction / rental) than this action',
  6: 'only the seller, owner or high bidder may do this',
  7: 'not allowed at this time (auction still open, already closed, or grace period running)',
  8: 'the TCC sent does not match the price exactly',
  9: 'the NFT is still rented out',
  10: 'the payout failed',
  11: 'the NFT could not be moved — the seller no longer owns it or revoked the market',
  12: 'you do not own this NFT',
  13: 'approve the market on this collection first (the “Approve market” action)',
  14: 'the collection did not answer owner_of — is this an NFT collection address?',
  15: 'more than the accrued fee',
  16: 'no bid is escrowed',
  17: 'a bid is escrowed — the auction can only be settled, not cancelled',
  18: 'this NFT already has a listing — cancel, settle or reclaim it first',
  19: 'no offer from that buyer on this NFT',
  20: 'the offer has expired',
  21: 'an open-ended offer can only be withdrawn by the buyer',
  22: 'the offer has not expired yet',
};

// Every TCC contract frames its return value as status[4, i32 LE] ‖ payload (the
// erc721 program's write_response, the market's ret_data, tcc-sdk's ret). A view call
// hands back that whole frame as `data`, so the payload starts at byte 4 — reading
// from byte 0 turns a listing's kind byte into part of a status word.
export function splitReturn(dataHex) {
  const b = hexToBytes(dataHex || '');
  if (b.length < 4) return { code: null, payload: new Uint8Array(0) };
  return { code: new DataView(b.buffer, b.byteOffset).getInt32(0, true), payload: b.slice(4) };
}
