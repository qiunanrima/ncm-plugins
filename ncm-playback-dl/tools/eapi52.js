// 按 52pojie 的 PC 3.x 方案验证 Android 抓包（params 是 hex，不是 base64）
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

const KEY = Buffer.from('e82ckenh8dichen8', 'utf8'); // 16 bytes
const SALT = '-36cd479b6b5-';
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

function aesEcbDecrypt(buf) {
  const d = crypto.createDecipheriv('aes-128-ecb', KEY, null); // PKCS7 默认
  return Buffer.concat([d.update(buf), d.final()]);
}

function aesEcbEncrypt(buf) {
  const c = crypto.createCipheriv('aes-128-ecb', KEY, null);
  return Buffer.concat([c.update(buf), c.final()]);
}

// PC 3.x 明文格式：path + salt + json + salt + md5('nobody'+path+'use'+json+'md5forencrypt')
function buildPlain(path, json) {
  const sign = md5('nobody' + path + 'use' + json + 'md5forencrypt');
  return path + SALT + json + SALT + sign;
}

function encryptParams(path, json) {
  return aesEcbEncrypt(Buffer.from(buildPlain(path, json), 'utf8')).toString('hex').toUpperCase();
}

function decryptParams(paramsHex) {
  return aesEcbDecrypt(Buffer.from(paramsHex, 'hex')).toString('utf8');
}

const mode = process.argv[2];
if (mode === 'params') {
  const hex = fs.readFileSync(process.argv[3], 'utf8').trim().replace(/^params=/, '');
  console.log('hex len', hex.length, '=> bytes', hex.length / 2);
  try {
    console.log(decryptParams(hex));
  } catch (e) {
    console.log('ERR', e.message);
  }
} else if (mode === 'resp') {
  const raw = fs.readFileSync(process.argv[3]);
  const sep = raw.indexOf('\r\n\r\n');
  const body = raw.subarray(sep + 4);
  let plain;
  try {
    plain = zlib.brotliDecompressSync(body);
  } catch (e) {
    plain = body;
  }
  console.log('after brotli:', plain.length, 'bytes');
  try {
    console.log(aesEcbDecrypt(plain).toString('utf8'));
  } catch (e) {
    console.log('ERR', e.message);
  }
} else if (mode === 'encrypt') {
  const path = process.argv[3];
  const json = process.argv[4];
  console.log(encryptParams(path, json));
} else {
  console.log('usage: params <hexfile> | resp <rawfile> | encrypt <path> <json>');
}
