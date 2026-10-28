// 解压抓包响应（支持 brotli / gzip / 明文）
const fs = require('fs');
const zlib = require('zlib');

const buf = fs.readFileSync(process.argv[2]);
const sep = buf.indexOf('\r\n\r\n');
const body = sep >= 0 ? buf.subarray(sep + 4) : buf;

for (const fn of ['brotliDecompressSync', 'gunzipSync', 'inflateSync', 'inflateRawSync']) {
  try {
    const out = zlib[fn](body);
    console.log('[' + fn + ']');
    console.log(out.toString('utf8'));
    process.exit(0);
  } catch (e) { /* 继续试 */ }
}
console.log('[plain]');
console.log(body.toString('utf8'));
