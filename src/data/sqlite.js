/**
 * SQLite数据库文件读取模块
 * 使用 sql.js (纯JS实现，无需原生编译)
 */

const initSqlJs = require('sql.js');
const fs = require('fs');

/**
 * 读取SQLite文件并返回所有表的数据
 * @param {string} filePath - SQLite数据库文件路径
 * @returns {Promise<{tables: Array<{name: string, fields: string[], rows: Array<Object>}>}>}
 */
async function readSQLiteFile(filePath) {
  const SQL = await initSqlJs();
  const fileBuffer = fs.readFileSync(filePath);
  const db = new SQL.Database(fileBuffer);

  const tables = [];

  // 获取所有用户表名
  const tableList = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  );

  const tableNames = [];
  if (tableList.length > 0 && tableList[0].values.length > 0) {
    tableList[0].values.forEach(row => tableNames.push(row[0]));
  }

  // 读取每个表的数据
  for (const tableName of tableNames) {
    try {
      const safeName = '"' + tableName.replace(/"/g, '""') + '"';
      const result = db.exec(`SELECT * FROM ${safeName} LIMIT 5000`);

      if (result.length > 0) {
        const fields = result[0].columns;
        const rows = result[0].values.map(row => {
          const obj = {};
          fields.forEach((field, idx) => {
            obj[field] = row[idx];
          });
          return obj;
        });

        tables.push({ name: tableName, fields, rows });
      }
    } catch (err) {
      console.warn(`读取SQLite表 ${tableName} 失败:`, err.message);
    }
  }

  db.close();
  return { tables };
}

module.exports = { readSQLiteFile };
