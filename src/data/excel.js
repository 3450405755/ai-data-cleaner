/**
 * Excel文件读取模块
 * 使用 SheetJS (xlsx) 解析Excel文件
 */

const XLSX = require('xlsx');
const path = require('path');

/**
 * 读取Excel文件并返回数据结构
 * @param {string} filePath - Excel文件路径
 * @returns {{sheets: Array<{name: string, fields: string[], rows: Array<Object>}>}}
 */
function readExcelFile(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheets = [];

  workbook.SheetNames.forEach(sheetName => {
    const worksheet = workbook.Sheets[sheetName];
    // 转换为JSON对象数组
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

    if (jsonData.length === 0) {
      sheets.push({
        name: sheetName,
        fields: [],
        rows: []
      });
      return;
    }

    // 获取字段名（第一行的key）
    const fields = Object.keys(jsonData[0]);

    // 清理数据：将所有值转为合适的类型
    const rows = jsonData.map((row, idx) => {
      const cleanRow = {};
      fields.forEach(field => {
        let val = row[field];
        // 尝试转换为数字
        if (typeof val === 'string' && val.trim() !== '' && !isNaN(val) && !isNaN(parseFloat(val))) {
          const num = parseFloat(val);
          // 如果转换后与原始字符串表示一致，使用数字
          if (String(num) === val.trim()) {
            val = num;
          }
        }
        // 日期类型转换
        if (val instanceof Date) {
          val = val.toISOString().split('T')[0];
        }
        cleanRow[field] = val;
      });
      return cleanRow;
    });

    sheets.push({
      name: sheetName,
      fields,
      rows
    });
  });

  return { sheets };
}

/**
 * 将数据写入Excel Buffer
 * @param {Array<string>} fields - 字段名列表
 * @param {Array<Object>} rows - 数据行
 * @returns {Buffer} Excel文件的Buffer
 */
function writeExcelBuffer(fields, rows) {
  const worksheet = XLSX.utils.json_to_sheet(rows, { header: fields });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'cleaned_data');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { readExcelFile, writeExcelBuffer };
