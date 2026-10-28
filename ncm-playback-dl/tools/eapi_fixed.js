// 用固定 key 试解 eapi 请求/响应
const fs = require('fs');
const crypto = require('crypto');

const KEYS = [
  'e82ckenh8dichen8',
  'rFgB&h#%2?^eDg:Q',
  '0CoJUm6Qyw8W8jud',
  '36cd479b6b5',
];

function tryDec(label, buf, keyStr) {
  const key = Buffer.from(keyStr, 'utf8');
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) return;
  const algo = 'aes-' + key.length * 8 + '-ecb';
  try {
    const d = crypto.createDecipheriv(algo, key, null);
    d.setAutoPadding(false);
    let out = Buffer.concat([d.update(buf), d.final()]);
    const pad = out[out.length - 1];
    let body = out;
    if (pad > 0 && pad <= 16 && pad <= out.length) {
      const tail = out.subarray(out.length - pad);
      if (tail.every((x) => x === pad)) body = out.subarray(0, out.length - pad);
    }
    const s = body.toString('utf8');
    let score = 0;
    for (const ch of s) { const c = ch.charCodeAt(0); if (c >= 32 && c < 127) score++; }
    const ratio = s.length ? score / s.length : 0;
    const head = s.slice(0, 80).replace(/[^\x20-\x7e]/g, '.');
    console.log(`[${label} key=${keyStr}] printable=${ratio.toFixed(2)} :: ${head}`);
  } catch (e) {
    console.log(`[${label} key=${keyStr}] ERR ${e.message}`);
  }
}

const bodyBuf = fs.readFileSync('tmp/resp.bin');
const brotli = require('zlib').brotliDecompressSync(bodyBuf);
console.log('== response: brotli 后 ' + brotli.length + ' 字节 ==');
for (const k of KEYS) tryDec('resp', brotli, k);

const paramsPath = 'tmp/params.bin';
if (fs.existsSync(paramsPath)) {
  const p = fs.readFileSync(paramsPath);
  console.log('\n== params: ' + p.length + ' 字节 ==');
  for (const k of KEYS) tryDec('params', p, k);
}
