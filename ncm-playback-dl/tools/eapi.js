// eapi 参数解密 / 加密（AES-128-ECB，key 由 URL 路径推导）
// 用法：
//   node tools/eapi.js decrypt <path> <paramsBase64OrUrlEncoded>
//   node tools/eapi.js encrypt <path> <jsonFile>
const fs = require('fs');
const crypto = require('crypto');

const EAPI_KEY_SEED = 'rFgB&h#%2?^eDg:Q';

function eapiKey(path) {
  const digest = crypto.createHash('md5').update(JSON.stringify(1)).digest('hex'); // 占位，避免误用
  void digest;
  const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
  const key = md5('nobody' + path + 'use' + md5(EAPI_KEY_SEED));
  return Buffer.from(key, 'utf8').subarray(0, 16);
}

function decrypt(path, b64) {
  const raw = Buffer.from(decodeURIComponent(b64), 'base64');
  const key = eapiKey(path);
  const d = crypto.createDecipheriv('aes-128-ecb', key, null);
  d.setAutoPadding(false);
  let out = Buffer.concat([d.update(raw), d.final()]);
  // 去 PKCS7
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);
  return out.toString('utf8');
}

function encrypt(path, text) {
  const key = eapiKey(path);
  const pad = 16 - (Buffer.byteLength(text, 'utf8') % 16);
  const buf = Buffer.concat([Buffer.from(text, 'utf8'), Buffer.alloc(pad, pad)]);
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return encodeURIComponent(Buffer.concat([c.update(buf), c.final()]).toString('base64'));
}

const [mode, path, arg] = process.argv.slice(2);
if (!mode || !path || !arg) {
  console.log('usage: node tools/eapi.js decrypt <path> <b64> | encrypt <path> <jsonFile>');
  process.exit(1);
}
if (mode === 'decrypt') {
  const b64 = arg.startsWith('params=') ? arg.slice(7) : arg;
  console.log(decrypt(path, b64));
} else if (mode === 'encrypt') {
  const text = fs.readFileSync(arg, 'utf8');
  console.log(encrypt(path, text));
} else {
  console.log('unknown mode');
  process.exit(1);
}
