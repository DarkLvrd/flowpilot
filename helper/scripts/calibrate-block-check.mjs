// Sends the labelled fixture messages to Jev in one request and prints each score next to its
// hand label, so the halt threshold can be chosen from data. Network call; costs TypeSafe usage.
// Usage: TYPESAFE_API_KEY=… node helper/scripts/calibrate-block-check.mjs
import { readFileSync } from 'node:fs';
import { createBlockJudge, HALT_AT } from '../lib/block-check.js';

const { notices } = JSON.parse(readFileSync(new URL('../test/fixtures/flow-notices.json', import.meta.url)));
if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not set');
const r = await createBlockJudge({ apiKey: process.env.TYPESAFE_API_KEY }).check(notices.map((n) => n.text));
if (r.error) throw new Error(r.error);

const label = new Map(notices.map((n) => [n.text, n.block]));
for (const { message, p } of r.scores.sort((a, b) => b.p - a.p)) {
  const wrong = (p >= HALT_AT) !== label.get(message) ? '  <-- disagrees at ' + HALT_AT : '';
  console.log(`${p.toFixed(3)}  ${label.get(message) ? 'BLOCK' : 'ok   '}  ${message}${wrong}`);
}
const lowestBlock = Math.min(...r.scores.filter((s) => label.get(s.message)).map((s) => s.p));
const highestOk = Math.max(...r.scores.filter((s) => !label.get(s.message)).map((s) => s.p));
console.log(`\nlowest BLOCK ${lowestBlock.toFixed(3)} · highest ok ${highestOk.toFixed(3)} · clean gap: ${lowestBlock > highestOk}`);
