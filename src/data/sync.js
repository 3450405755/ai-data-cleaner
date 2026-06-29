/**
 * 数据库同步模块
 * 将内存中的清洗操作同步回真实的MySQL/SQLite数据库
 */

const mysql = require('mysql2/promise');
const initSqlJs = require('sql.js');
const fs = require('fs');

/**
 * 将操作条件转换为 SQL WHERE 子句
 * 仅生成参数化的 WHERE 部分，返回 { clause, params }
 */
function conditionToSQL(field, condition, value) {
  const safeField = '`' + field.replace(/`/g, '``') + '`';
  switch (condition) {
    case 'contains':
      return { clause: `${safeField} LIKE ?`, params: [`%${value}%`] };
    case 'equals':
      return { clause: `${safeField} = ?`, params: [value] };
    case 'not_equals':
      return { clause: `${safeField} != ?`, params: [value] };
    case 'starts_with':
      return { clause: `${safeField} LIKE ?`, params: [`${value}%`] };
    case 'ends_with':
      return { clause: `${safeField} LIKE ?`, params: [`%${value}`] };
    case 'is_empty':
      return { clause: `(${safeField} IS NULL OR ${safeField} = '')`, params: [] };
    case 'not_empty':
      return { clause: `(${safeField} IS NOT NULL AND ${safeField} != '')`, params: [] };
    case 'greater_than':
      return { clause: `${safeField} > ?`, params: [parseFloat(value)] };
    case 'less_than':
      return { clause: `${safeField} < ?`, params: [parseFloat(value)] };
    default:
      return { clause: `${safeField} LIKE ?`, params: [`%${value}%`] };
  }
}

/**
 * 同步操作到 MySQL 数据库
 * @param {Object} sourceInfo - 数据源信息（含config）
 * @param {Array} operations - 已执行的操作列表
 * @returns {Promise<{success: boolean, sqlStatements: string[], message: string}>}
 */
async function syncToMySQL(sourceInfo, operations) {
  if (!sourceInfo || sourceInfo.type !== 'mysql') {
    return { success: false, message: '当前数据源不是MySQL，无法同步' };
  }
  if (!sourceInfo.config) {
    return { success: false, message: '缺少数据库连接配置，请重新连接MySQL' };
  }

  const config = sourceInfo.config;
  const tableName = sourceInfo.table;
  const safeTable = '`' + tableName.replace(/`/g, '``') + '`';
  const results = [];
  const sqlStatements = [];

  let conn;
  try {
    conn = await mysql.createConnection({
      host: config.host || 'localhost',
      port: parseInt(config.port) || 3306,
      user: config.user || 'root',
      password: config.password || '',
      database: config.database,
      charset: 'utf8mb4'
    });

    for (const op of operations) {
      switch (op.type) {
        case 'delete_rows': {
          const { clause, params } = conditionToSQL(op.field, op.condition, op.value);
          const sql = `DELETE FROM ${safeTable} WHERE ${clause}`;
          sqlStatements.push(`DELETE: ${sql} [${params.join(', ')}]`);
          const [res] = await conn.execute(sql, params);
          results.push(`删除 ${res.affectedRows} 行`);
          break;
        }

        case 'filter_rows': {
          // filter_rows 删除不符合条件的行，即 DELETE WHERE NOT (...)
          const { clause, params } = conditionToSQL(op.field, op.condition, op.value);
          const sql = `DELETE FROM ${safeTable} WHERE NOT (${clause})`;
          sqlStatements.push(`DELETE: ${sql} [${params.join(', ')}]`);
          const [res] = await conn.execute(sql, params);
          results.push(`删除 ${res.affectedRows} 行（筛选保留符合条件的）`);
          break;
        }

        case 'replace_value':
        case 'set_value': {
          const safeField = '`' + op.field.replace(/`/g, '``') + '`';
          const { clause, params } = conditionToSQL(op.field, op.condition || 'equals', op.value);
          const newVal = op.newValue !== undefined ? op.newValue : '';
          const sql = `UPDATE ${safeTable} SET ${safeField} = ? WHERE ${clause}`;
          sqlStatements.push(`UPDATE: ${sql} [${newVal}, ${params.join(', ')}]`);
          const [res] = await conn.execute(sql, [newVal, ...params]);
          results.push(`更新 ${res.affectedRows} 行`);
          break;
        }

        case 'update_row': {
          const condField = op.conditionField || op.field;
          const { clause, params } = conditionToSQL(condField, op.condition || 'equals', op.value);
          const updates = op.updates || {};
          const setClauses = [];
          const setParams = [];
          Object.entries(updates).forEach(([k, v]) => {
            setClauses.push('`' + k.replace(/`/g, '``') + '` = ?');
            setParams.push(v);
          });
          if (setClauses.length === 0) break;
          const sql = `UPDATE ${safeTable} SET ${setClauses.join(', ')} WHERE ${clause}`;
          sqlStatements.push(`UPDATE: ${sql} [${[...setParams, ...params].join(', ')}]`);
          const [res] = await conn.execute(sql, [...setParams, ...params]);
          results.push(`更新 ${res.affectedRows} 行`);
          break;
        }

        case 'add_row': {
          const rowData = op.rowData || {};
          const columns = Object.keys(rowData).filter(k => rowData[k] !== undefined);
          if (columns.length === 0) break;
          const safeCols = columns.map(c => '`' + c.replace(/`/g, '``') + '`').join(', ');
          const placeholders = columns.map(() => '?').join(', ');
          const values = columns.map(c => rowData[c]);
          const sql = `INSERT INTO ${safeTable} (${safeCols}) VALUES (${placeholders})`;
          sqlStatements.push(`INSERT: ${sql} [${values.join(', ')}]`);
          const [res] = await conn.execute(sql, values);
          results.push(`插入 ${res.affectedRows} 行`);
          break;
        }

        case 'drop_column': {
          const safeField = '`' + op.field.replace(/`/g, '``') + '`';
          const sql = `ALTER TABLE ${safeTable} DROP COLUMN ${safeField}`;
          sqlStatements.push(`ALTER: ${sql}`);
          await conn.execute(sql);
          results.push(`删除列 ${op.field}`);
          break;
        }

        case 'rename_column': {
          const newName = op.newName || op.value;
          const safeOld = '`' + op.field.replace(/`/g, '``') + '`';
          const safeNew = '`' + newName.replace(/`/g, '``') + '`';
          const sql = `ALTER TABLE ${safeTable} RENAME COLUMN ${safeOld} TO ${safeNew}`;
          sqlStatements.push(`ALTER: ${sql}`);
          await conn.execute(sql);
          results.push(`重命名列 ${op.field} → ${newName}`);
          break;
        }

        case 'fill_empty': {
          const safeField = '`' + op.field.replace(/`/g, '``') + '`';
          const fillVal = op.value || '未知';
          const sql = `UPDATE ${safeTable} SET ${safeField} = ? WHERE (${safeField} IS NULL OR ${safeField} = '')`;
          sqlStatements.push(`UPDATE: ${sql} [${fillVal}]`);
          const [res] = await conn.execute(sql, [fillVal]);
          results.push(`填充 ${res.affectedRows} 个空值`);
          break;
        }

        case 'trim': {
          const safeField = '`' + op.field.replace(/`/g, '``') + '`';
          const sql = `UPDATE ${safeTable} SET ${safeField} = TRIM(${safeField}) WHERE ${safeField} != TRIM(${safeField})`;
          sqlStatements.push(`UPDATE: ${sql}`);
          const [res] = await conn.execute(sql);
          results.push(`整理 ${res.affectedRows} 个值`);
          break;
        }
      }
    }

    return {
      success: true,
      message: '数据库同步完成: ' + results.join('; '),
      sqlStatements,
      details: results
    };
  } catch (err) {
    return {
      success: false,
      message: '数据库同步失败: ' + err.message,
      sqlStatements,
      details: results
    };
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

/**
 * 同步到 SQLite 文件（重写整个文件）
 * @param {Object} sourceInfo
 * @param {Array} currentRows - 当前内存中的所有行
 * @param {Array} fields - 字段列表
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function syncToSQLite(sourceInfo, currentRows, fields) {
  if (!sourceInfo || sourceInfo.type !== 'sqlite') {
    return { success: false, message: '当前数据源不是SQLite' };
  }
  if (!sourceInfo.filePath) {
    return { success: false, message: '缺少SQLite文件路径' };
  }

  try {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    const tableName = sourceInfo.table;
    const safeTable = '"' + tableName.replace(/"/g, '""') + '"';

    // 创建表结构（保持简单，所有列当 TEXT）
    const colDefs = fields.map(f => '"' + f.replace(/"/g, '""') + '" TEXT').join(', ');
    db.run(`CREATE TABLE ${safeTable} (${colDefs})`);

    // 插入当前数据
    const placeholders = fields.map(() => '?').join(', ');
    const stmt = db.prepare(`INSERT INTO ${safeTable} VALUES (${placeholders})`);
    for (const row of currentRows) {
      const values = fields.map(f => row[f] !== undefined && row[f] !== null ? String(row[f]) : '');
      stmt.run(values);
    }
    stmt.free();

    // 写入文件
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(sourceInfo.filePath, buffer);
    db.close();

    return {
      success: true,
      message: `SQLite同步完成: ${currentRows.length} 行数据已写入 ${sourceInfo.filePath}`
    };
  } catch (err) {
    return { success: false, message: 'SQLite同步失败: ' + err.message };
  }
}

module.exports = { syncToMySQL, syncToSQLite, conditionToSQL };
