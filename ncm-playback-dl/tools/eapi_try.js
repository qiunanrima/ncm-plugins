// 尝试多种 eapi 解密方案，找出能解出 JSON 的那一种
const crypto = require('crypto');

const SEEDS = [
  'rFgB&h#%2?^eDg:Q',
  'e82ckenh8dichen8',
];

const path = process.argv[2];
const rawParams = process.argv[3];
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

let b64 = decodeURIComponent(rawParams || '').replace(/^params=/, '');
const buf = Buffer.from(b64, 'base64');
console.log('cipher bytes:', buf.length, 'b64 head:', b64.slice(0, 24));

function printableScore(s) {
  let ok = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c < 127) ok++;
  }
  return s.length ? ok / s.length : 0;
}

function tryDec(mode, key, iv, name) {
  try {
    const d = crypto.createDecipheriv(mode, key, iv || null);
    d.setAutoPadding(false);
    let out = Buffer.concat([d.update(buf), d.final()]);
    const pad = out[out.length - 1];
    let body = out;
    if (pad > 0 && pad <= 16 && pad <= out.length) {
      const tail = out.subarray(out.length - pad);
      if (tail.every((x) => x === pad) && pad > 0) body = out.subarray(0, out.length - pad);
    }
    const s = body.toString('latin1');
    const score = printableScore(s);
    const head = s.slice(0, 70).replace(/[^\x20-\x7e]/g, '.');
    console.log(`[${name}] score=${score.toFixed(2)} :: ${head}`);
  } catch (e) {
    console.log(`[${name}] ERR ${e.message}`);
  }
}

for (const seed of SEEDS) {
  const h = md5('nobody' + path + 'use' + md5(seed));
  const k128 = Buffer.from(h.slice(0, 16), 'utf8');
  const k256 = Buffer.from(h, 'utf8');
  const kb = Buffer.from(h, 'hex');
  tryDec('aes-128-ecb', k128, null, `ecb128-hex16 seed=${seed.slice(0, 6)}`);
  tryDec('aes-128-cbc', k128, Buffer.from('0102030405060708'), `cbc128-hex16 seed=${seed.slice(0, 6)}`);
  tryDec('aes-256-ecb', k256, null, `ecb256-hex32 seed=${seed.slice(0, 6)}`);
  tryDec('aes-128-ecb', kb, null, `ecb128-bin16 seed=${seed.slice(0, 6)}`);
}
