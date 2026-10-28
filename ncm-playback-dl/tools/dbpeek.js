// 诊断用：只读打开客户端的 SQLite 库，列出表与行数
const { DatabaseSync } = require('node:sqlite');

const paths = process.argv.slice(2);
for (const p of paths) {
  console.log('=== ' + p);
  let db;
  try {
    db = new DatabaseSync(p, { readOnly: true });
  } catch (e) {
    console.log('  open failed: ' + e.message);
    continue;
  }
  let tables = [];
  try {
    tables = db.prepare("select name from sqlite_master where type='table' order by name").all();
  } catch (e) {
    console.log('  sqlite_master failed: ' + e.message);
  }
  for (const t of tables) {
    let n = -1;
    try {
      n = db.prepare(`select count(*) as c from "${t.name}"`).get().c;
    } catch (e) {
      n = 'ERR';
    }
    console.log(`  ${t.name.padEnd(28)} rows=${n}`);
  }
  db.close();
}
