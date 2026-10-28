// 解码抓包的 eapi 响应：HTTP 头 → (brotli) → AES-128-ECB → (gzip) → JSON
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const KEY = Buffer.from('e82ckenh8dichen8', 'utf8');

const buf = fs.readFileSync(process.argv[2]);
const sep = buf.indexOf('\r\n\r\n');
let body = sep >= 0 ? buf.subarray(sep + 4) : buf;
console.log('body bytes:', body.length);

// 1) 传输层压缩
try {
  const br = zlib.brotliDecompressSync(body);
  console.log('brotli ->', br.length);
  body = br;
} catch (e) { /* 没压缩 */ }

// 2) 如果看起来是明文 JSON，直接输出
const asText = body.toString('utf8');
if (asText.trim().startsWith('{')) {
  console.log('[plain json]');
  console.log(asText);
  process.exit(0);
}

// 3) AES 解密
let dec;
try {
  const d = crypto.createDecipheriv('aes-128-ecb', KEY, null);
  dec = Buffer.concat([d.update(body), d.final()]);
  console.log('aes ->', dec.length, 'head', dec.subarray(0, 4).toString('hex'));
} catch (e) {
  console.log('aes err:', e.message);
  process.exit(1);
}

// 4) 内层压缩
for (const fn of ['gunzipSync', 'inflateSync', 'brotliDecompressSync']) {
  try {
    const out = zlib[fn](dec);
    console.log('[' + fn + ']');
    console.log(out.toString('utf8'));
    process.exit(0);
  } catch (e) { /* 继续 */ }
}
console.log('[raw after aes]');
console.log(dec.toString('utf8'));
