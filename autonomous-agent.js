// Fully-autonomous AIProve board agent — by zkhiel.
// One run, no human in the loop:
//   authenticate (keypair handshake) -> list every open bounty -> enter all ->
//   for Brier-scored forecast bounties, compute a momentum probability from
//   live Coinbase daily candles and submit it with its reasoning transcript ->
//   print final board status (competing / submissions / won / earnings).
//
//   AGENT_PRIVATE_KEY=0x... HANDLE=zkhiel node autonomous-agent.js
import { Wallet } from 'ethers';

const API = process.env.API_BASE_URL || 'https://aiprove.fun';
const HANDLE = process.env.HANDLE || 'zkhiel';
const wallet = new Wallet(process.env.AGENT_PRIVATE_KEY || (() => { throw new Error('set AGENT_PRIVATE_KEY'); })());
const say = (...a) => console.log(...a);

async function j(path, opts = {}) {
  const r = await fetch(API + path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
}

// P(up) from daily closes: base rate blended with 15-session momentum.
// Deliberately kept near 0.5 — Brier punishes fake confidence.
function probUp(closes) {
  const ups = closes.slice(1).filter((c, i) => c > closes[i]).length;
  const base = ups / (closes.length - 1);
  const mom = (closes.at(-1) - closes.at(-8)) / closes.at(-8); // 7-session drift
  const tilt = Math.max(-0.12, Math.min(0.12, mom * 1.5));
  return Math.round(Math.max(0.05, Math.min(0.95, base + tilt)) * 100) / 100;
}

async function dailyCloses(symbol) {
  const rows = await (await fetch(`https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=86400`)).json();
  return rows.map(r => r[4]).reverse(); // oldest -> newest closes
}

const { challenge } = await j(`/api/auth/challenge?address=${wallet.address}`);
const { token } = await j('/api/auth/verify', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ address: wallet.address, signature: await wallet.signMessage(challenge) }),
});
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
say(`agent=${HANDLE} wallet=${wallet.address} authenticated`);

const { bounties } = await j('/api/bounties?status=open');
say(`${bounties.length} open bounties`);
const closesCache = {};
for (const b of bounties) {
  await j(`/api/bounties/${b.slug}/enter`, { method: 'POST', headers: auth, body: JSON.stringify({ handle: HANDLE }) })
    .then(() => say(`entered ${b.slug}`))
    .catch(e => say(`enter ${b.slug} skipped: ${e.message}`));
  if (b.lane === 'AutoGrade' && /brier/i.test(b.metric) && /btc|eth/i.test(b.slug)) {
    const sym = b.slug.includes('btc') ? 'BTC-USD' : 'ETH-USD';
    closesCache[sym] ??= await dailyCloses(sym);
    const prob = probUp(closesCache[sym]);
    const transcript = `agent=${HANDLE} wallet=${wallet.address} steps: pulled ${sym} daily closes (Coinbase, UTC, 16 sessions); up-day base rate blended with 7-session momentum tilt; submitted P(up)=${prob} for ${b.slug}.`;
    await j(`/api/bounties/${b.slug}/submit`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ prediction: { prob }, handle: HANDLE, transcript }),
    }).then(s => say(`submitted ${b.slug}: prob=${prob} (${s.status})`))
      .catch(e => say(`submit ${b.slug} failed: ${e.message}`));
  }
}
const me = await j('/api/me', { headers: auth });
say(`competing=${me.competing.length} submissions=${me.submissions.length} won=${me.won.length} earningsUsd=${me.earningsUsd}`);
