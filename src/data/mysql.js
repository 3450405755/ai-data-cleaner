/**
 * MySQL数据库连接与查询模块
 */

const mysql = require('mysql2/promise');

/**
 * 创建MySQL连接
 */
async function createConnection(config) {
  const connection = await mysql.createConnection({
    host: config.host || 'localhost',
    port: parseInt(config.port) || 3306,
    user: config.user || 'root',
    password: config.password || '',
    database: config.database,
    connectTimeout: 10000,
    // 避免编码问题
    charset: 'utf8mb4'
  });
  return connection;
}

/**
 * 测试连接
 */
async function testConnection(config) {
  let conn;
  try {
    conn = await createConnection(config);
    await conn.ping();
    return { success: true, message: '连接成功' };
  } catch (err) {
    return { success: false, message: `连接失败: ${err.message}` };
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

/**
 * 获取数据库中所有表名
 */
async function getTables(config) {
  let conn;
  try {
    conn = await createConnection(config);
    // 使用 query 而非 execute，兼容性更好
    const [rows] = await conn.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [config.database]
    );
    return rows.map(r => r.TABLE_NAME);
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

/**
 * 从表中获取数据
 * @param {Object} config - 连接配置
 * @param {string} tableName - 表名
 * @param {number} limit - 返回行数限制
 * @returns {Promise<{fields: string[], rows: Array<Object>, totalRows: number}>}
 */
async function getTableData(config, tableName, limit = 5000) {
  let conn;
  try {
    console.log(`[MySQL] 连接数据库 ${config.database}，准备读取表 ${tableName}...`);
    conn = await createConnection(config);

    // 获取列信息
    const [columns] = await conn.query(
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [config.database, tableName]
    );

    if (!columns || columns.length === 0) {
      throw new Error(`表 "${tableName}" 不存在或无列信息`);
    }

    const fields = columns.map(c => c.COLUMN_NAME);
    console.log(`[MySQL] 表 ${tableName} 有 ${fields.length} 列: ${fields.join(', ')}`);

    // 获取真实总行数
    const safeTable = '`' + tableName.replace(/`/g, '``') + '`';
    const [countResult] = await conn.query(`SELECT COUNT(*) as cnt FROM ${safeTable}`);
    const realTotalRows = countResult[0].cnt;

    // 获取数据
    const [rows] = await conn.query(
      `SELECT * FROM ${safeTable} LIMIT ${parseInt(limit)}`
    );

    console.log(`[MySQL] 表真实行数: ${realTotalRows}, 已读取: ${rows.length} 行`);

    // 将RowDataPacket转为普通对象，处理特殊类型
    const cleanRows = rows.map(row => {
      const obj = {};
      fields.forEach(f => {
        let val = row[f];
        // 处理 Buffer/BLOB 类型
        if (Buffer.isBuffer(val)) {
          val = val.toString('utf8');
        }
        // 处理 Date 类型
        if (val instanceof Date) {
          val = val.toISOString();
        }
        // 处理 BigInt
        if (typeof val === 'bigint') {
          val = Number(val);
        }
        obj[f] = val;
      });
      return obj;
    });

    return { fields, rows: cleanRows, totalRows: realTotalRows };
  } catch (err) {
    console.error(`[MySQL] 读取表 ${tableName} 失败:`, err.message);
    throw new Error(`读取表数据失败: ${err.message}`);
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

module.exports = { testConnection, getTables, getTableData, createConnection };
