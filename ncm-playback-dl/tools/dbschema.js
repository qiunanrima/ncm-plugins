// 诊断用：打印指定表的建表语句 + 前几行
const { DatabaseSync } = require('node:sqlite');

const [dbPath, ...tables] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });

for (const t of tables) {
  console.log('\n=== ' + t + ' ===');
  try {
    const sql = db.prepare("select sql from sqlite_master where type='table' and name=?").get(t);
    console.log(sql ? sql.sql : '(no schema)');
  } catch (e) {
    console.log('schema err: ' + e.message);
  }
  try {
    const rows = db.prepare(`select * from "${t}" limit 5`).all();
    for (const r of rows) console.log(JSON.stringify(r));
  } catch (e) {
    console.log('rows err: ' + e.message);
  }
}
db.close();
