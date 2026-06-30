/**
 * 内存数据存储管理器
 * 管理当前加载的数据集、字段信息，支持回滚和回收站恢复
 */

class DataStore {
  constructor() {
    this.data = [];           // 当前数据（对象数组）
    this.fields = [];         // 字段名列表
    this.history = [];        // 历史快照栈，用于回滚
    this.sourceInfo = null;   // 数据源信息 { type, name, table/sheet }
    this.totalRows = 0;
    this.recycleBin = [];     // 回收站：被删除的行 [{id, timestamp, operation, row, originalIndex}]
    this._recycleId = 0;      // 回收站自增ID
  }

  /**
   * 加载新数据集
   */
  load(rows, fields, sourceInfo = null, totalRowsOverride = null) {
    this.data = rows;
    this.fields = fields;
    this.totalRows = totalRowsOverride || rows.length;
    this.sourceInfo = sourceInfo;
    this.history = [];
    this.recycleBin = [];
    this._recycleId = 0;
  }

  /**
   * 保存当前快照（在清洗操作前调用）
   */
  snapshot() {
    this.history.push({
      data: JSON.parse(JSON.stringify(this.data)),
      totalRows: this.totalRows
    });
    if (this.history.length > 20) {
      this.history.shift();
    }
  }

  /**
   * 回滚到上一个快照（也会清空当次回收站记录）
   */
  rollback() {
    if (this.history.length === 0) return false;
    const snap = this.history.pop();
    this.data = snap.data;
    this.totalRows = snap.totalRows;
    return true;
  }

  /**
   * 替换当前数据（清洗操作后调用）
   */
  updateData(newData) {
    this.data = newData;
    this.totalRows = newData.length;
  }

  /**
   * 将行添加到回收站
   * @param {Array<Object>} rows - 被删除的行
   * @param {string} operationDesc - 操作描述
   */
  addToRecycleBin(rows, operationDesc) {
    const timestamp = new Date().toISOString();
    const entries = rows.map((row, i) => ({
      id: ++this._recycleId,
      timestamp,
      operation: operationDesc,
      row: JSON.parse(JSON.stringify(row)),
      originalIndex: null // 后续可扩展
    }));
    this.recycleBin.push(...entries);
    // 最多保留500条回收记录
    if (this.recycleBin.length > 500) {
      this.recycleBin = this.recycleBin.slice(-500);
    }
    return entries.length;
  }

  /**
   * 获取回收站内容
   * @returns {Array}
   */
  getRecycleBin() {
    return this.recycleBin.slice().reverse(); // 最新在前
  }

  /**
   * 从回收站恢复指定行
   * @param {number} id - 回收站条目ID
   * @returns {{success: boolean, restored: Object|null}}
   */
  restoreFromRecycleBin(id) {
    const idx = this.recycleBin.findIndex(e => e.id === id);
    if (idx === -1) return { success: false, restored: null };

    const entry = this.recycleBin[idx];
    // 从回收站移除
    this.recycleBin.splice(idx, 1);

    // 添加回数据末尾
    this.data.push(entry.row);
    this.totalRows = this.data.length;

    return { success: true, restored: entry.row };
  }

  /**
   * 批量恢复回收站中最近N条
   * @param {number} count
   * @returns {number} 恢复的数量
   */
  restoreRecent(count = 1) {
    const toRestore = this.recycleBin.splice(-count);
    toRestore.forEach(entry => {
      this.data.push(entry.row);
    });
    this.totalRows = this.data.length;
    return toRestore.length;
  }

  /**
   * 清空回收站
   */
  clearRecycleBin() {
    const count = this.recycleBin.length;
    this.recycleBin = [];
    return count;
  }

  /**
   * 在指定位置插入新行
   * @param {Object} rowData - 新行数据
   * @param {number} index - 插入位置（默认末尾）
   */
  insertRow(rowData, index = -1) {
    const newRow = {};
    // 确保包含所有字段
    this.fields.forEach(f => {
      newRow[f] = rowData[f] !== undefined ? rowData[f] : '';
    });
    if (index >= 0 && index < this.data.length) {
      this.data.splice(index, 0, newRow);
    } else {
      this.data.push(newRow);
    }
    this.totalRows = this.data.length;
    return newRow;
  }

  /**
   * 更新符合条件的行
   * @param {Function} matchFn - 匹配函数
   * @param {Object} updates - 要更新的字段和值
   * @returns {number} 更新的行数
   */
  updateRows(matchFn, updates) {
    let count = 0;
    this.data = this.data.map(row => {
      if (matchFn(row)) {
        count++;
        return { ...row, ...updates };
      }
      return row;
    });
    return count;
  }

  /**
   * 获取预览数据（自动脱敏密码等敏感信息）
   */
  getPreview(limit = 100, offset = 0) {
    const info = this.sourceInfo ? { ...this.sourceInfo } : null;
    // 脱敏：隐藏数据库密码
    if (info && info.config && info.config.password && info.config.password !== '******') {
      info.config = { ...info.config, password: '******' };
    }
    return {
      fields: this.fields,
      rows: this.data.slice(offset, offset + limit),
      totalRows: this.totalRows,
      sourceInfo: info,
      recycleBinCount: this.recycleBin.length
    };
  }

  /**
   * 获取字段信息
   */
  getSchema() {
    const schema = this.fields.map(field => {
      const sampleValues = this.data.slice(0, 50).map(row => row[field]).filter(v => v !== null && v !== undefined && v !== '');
      const types = sampleValues.map(v => typeof v);
      const uniqueValues = [...new Set(sampleValues)].length;
      return {
        name: field,
        type: types.length > 0 ? inferFieldType(types) : 'unknown',
        sampleCount: sampleValues.length,
        uniqueCount: uniqueValues,
        nullCount: this.data.filter(row => row[field] === null || row[field] === undefined || row[field] === '').length
      };
    });
    return schema;
  }

  /**
   * 导出为对象数组
   */
  exportData() {
    return { fields: this.fields, rows: this.data };
  }

  /** 检查是否有数据 */
  hasData() {
    return this.data.length > 0 && this.fields.length > 0;
  }
}

function inferFieldType(types) {
  const allNumbers = types.every(t => t === 'number');
  if (allNumbers) return 'number';
  const allStrings = types.every(t => t === 'string');
  if (allStrings) return 'string';
  return new Set(types).size > 1 ? 'mixed' : types[0];
}

const store = new DataStore();
module.exports = store;
