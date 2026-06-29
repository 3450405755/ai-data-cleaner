/**
 * 数据清洗执行引擎
 * 支持：删除行(含回收站)、修改行、新增行、替换值、筛选、删列、填空、去空格、重命名
 */

const store = require('../data/store');

/**
 * 执行清洗操作
 * @param {Array<Object>} operations - AI返回的操作列表
 * @returns {{success: boolean, summary: Object, changes: Object}}
 */
function executeCleaning(operations) {
  if (!store.hasData()) {
    return { success: false, error: '没有加载数据' };
  }

  const data = store.exportData();
  let rows = JSON.parse(JSON.stringify(data.rows));
  let fields = [...data.fields];
  const changes = {
    rowsBefore: rows.length,
    rowsAfter: null,
    deletedRows: 0,
    modifiedRows: 0,
    addedRows: 0,
    deletedColumns: [],
    renamedColumns: [],
    recycleBinAdded: 0,
    operations: []
  };

  // 保存快照用于整体回滚
  store.snapshot();

  try {
    for (const op of operations) {
      const result = executeOperation(op, rows, fields);
      rows = result.rows;
      fields = result.fields;
      changes.operations.push({
        type: op.type,
        field: op.field,
        description: describeOperation(op),
        affected: result.affected,
        recycleAdded: result.recycleAdded || 0
      });

      if (op.type === 'delete_rows' || op.type === 'filter_rows') {
        changes.deletedRows += result.affected;
        changes.recycleBinAdded += (result.recycleAdded || 0);
      } else if (op.type === 'replace_value' || op.type === 'update_row' || op.type === 'set_value' || op.type === 'trim' || op.type === 'fill_empty') {
        changes.modifiedRows += result.affected;
      } else if (op.type === 'add_row') {
        changes.addedRows += result.affected;
      } else if (op.type === 'drop_column') {
        changes.deletedColumns.push(op.field);
      } else if (op.type === 'rename_column') {
        changes.renamedColumns.push({ old: op.field, new: op.newName || op.value });
      }
    }

    changes.rowsAfter = rows.length;

    // 更新存储
    store.updateData(rows);
    if (fields.length !== store.fields.length || !fields.every((f, i) => f === store.fields[i])) {
      store.fields = fields;
    }

    const summary = buildSummary(changes);
    return {
      success: true,
      summary,
      changes,
      data: store.getPreview()
    };
  } catch (err) {
    store.rollback();
    return {
      success: false,
      error: `执行清洗操作失败: ${err.message}`,
      changes
    };
  }
}

/**
 * 执行单个操作
 */
function executeOperation(op, rows, fields) {
  let affected = 0;
  let recycleAdded = 0;
  const field = op.field;

  switch (op.type) {

    // ========== 删除行（加入回收站） ==========
    case 'delete_rows': {
      const before = rows.length;
      const deletedRows = [];
      const keptRows = [];
      rows.forEach(row => {
        if (matchCondition(row[field], op.condition, op.value)) {
          deletedRows.push(row);
        } else {
          keptRows.push(row);
        }
      });
      rows = keptRows;
      affected = before - rows.length;

      // 将删除的行放入回收站
      if (deletedRows.length > 0) {
        store.addToRecycleBin(deletedRows, describeOperation(op));
        recycleAdded = deletedRows.length;
      }
      break;
    }

    // ========== 筛选（保留符合条件的，其余放入回收站） ==========
    case 'filter_rows': {
      const before = rows.length;
      const removedRows = [];
      const keptRows = [];
      rows.forEach(row => {
        if (matchCondition(row[field], op.condition, op.value)) {
          keptRows.push(row);
        } else {
          removedRows.push(row);
        }
      });
      rows = keptRows;
      affected = before - rows.length;

      if (removedRows.length > 0) {
        store.addToRecycleBin(removedRows, describeOperation(op));
        recycleAdded = removedRows.length;
      }
      break;
    }

    // ========== 替换字段值（部分匹配替换） ==========
    case 'replace_value': {
      rows = rows.map(row => {
        const rowCopy = { ...row };
        if (matchCondition(rowCopy[field], op.condition || 'contains', op.value)) {
          rowCopy[field] = op.newValue !== undefined ? op.newValue : '';
          affected++;
        }
        return rowCopy;
      });
      break;
    }

    // ========== 设置字段值（整行条件匹配） ==========
    case 'set_value': {
      rows = rows.map(row => {
        const rowCopy = { ...row };
        if (matchCondition(rowCopy[field], op.condition || 'equals', op.value)) {
          rowCopy[field] = op.newValue !== undefined ? op.newValue : '';
          affected++;
        }
        return rowCopy;
      });
      break;
    }

    // ========== 更新行（多字段同时修改） ==========
    case 'update_row': {
      // op.updates 是一个对象 { field1: newValue1, field2: newValue2 }
      // op.conditionField / op.condition / op.value 用于匹配目标行
      const condField = op.conditionField || op.field;
      const updates = op.updates || {};
      if (Object.keys(updates).length === 0) {
        throw new Error('update_row 操作需要提供 updates 对象');
      }
      rows = rows.map(row => {
        const rowCopy = { ...row };
        if (matchCondition(rowCopy[condField], op.condition || 'equals', op.value)) {
          Object.keys(updates).forEach(k => {
            if (fields.includes(k)) {
              rowCopy[k] = updates[k];
            }
          });
          affected++;
        }
        return rowCopy;
      });
      break;
    }

    // ========== 新增行 ==========
    case 'add_row': {
      // op.rowData 是新行的数据对象
      const rowData = op.rowData || {};
      if (op.value && op.field) {
        // 简化模式：单个字段
        rowData[op.field] = op.value;
      }
      const newRow = {};
      fields.forEach(f => {
        newRow[f] = rowData[f] !== undefined ? rowData[f] : '';
      });
      const position = op.position !== undefined ? op.position : -1;
      if (position >= 0 && position <= rows.length) {
        rows.splice(position, 0, newRow);
      } else {
        rows.push(newRow);
      }
      affected = 1;
      break;
    }

    // ========== 删除整列 ==========
    case 'drop_column': {
      if (!fields.includes(field)) {
        throw new Error(`字段 "${field}" 不存在`);
      }
      if (fields.length <= 1) {
        throw new Error('不能删除最后一列');
      }
      fields = fields.filter(f => f !== field);
      rows = rows.map(row => {
        const newRow = { ...row };
        delete newRow[field];
        return newRow;
      });
      affected = 1;
      break;
    }

    // ========== 填充空值 ==========
    case 'fill_empty': {
      const fillValue = op.value !== undefined ? op.value : '未知';
      rows = rows.map(row => {
        const rowCopy = { ...row };
        if (rowCopy[field] === null || rowCopy[field] === undefined || rowCopy[field] === '') {
          rowCopy[field] = fillValue;
          affected++;
        }
        return rowCopy;
      });
      break;
    }

    // ========== 去除首尾空格 ==========
    case 'trim': {
      rows = rows.map(row => {
        const rowCopy = { ...row };
        if (typeof rowCopy[field] === 'string' && rowCopy[field] !== rowCopy[field].trim()) {
          rowCopy[field] = rowCopy[field].trim();
          affected++;
        }
        return rowCopy;
      });
      break;
    }

    // ========== 重命名列 ==========
    case 'rename_column': {
      if (!fields.includes(field)) {
        throw new Error(`字段 "${field}" 不存在`);
      }
      const newName = op.newName || op.value;
      if (!newName) {
        throw new Error('重命名操作需要提供 newName');
      }
      if (fields.includes(newName)) {
        throw new Error(`字段 "${newName}" 已存在`);
      }
      fields = fields.map(f => f === field ? newName : f);
      rows = rows.map(row => {
        const newRow = {};
        Object.keys(row).forEach(key => {
          newRow[key === field ? newName : key] = row[key];
        });
        return newRow;
      });
      affected = rows.length;
      break;
    }

    default:
      throw new Error(`不支持的操作类型: ${op.type}`);
  }

  return { rows, fields, affected, recycleAdded };
}

/**
 * 条件匹配
 */
function matchCondition(value, condition, target) {
  const strVal = String(value ?? '').trim();
  const strTarget = String(target ?? '').trim();

  switch (condition) {
    case 'contains':
      return strVal.includes(strTarget);
    case 'equals':
      return strVal === strTarget ||
        (value != null && target != null && String(value) === String(target));
    case 'not_equals':
      return strVal !== strTarget && String(value) !== String(target);
    case 'starts_with':
      return strVal.startsWith(strTarget);
    case 'ends_with':
      return strVal.endsWith(strTarget);
    case 'is_empty':
      return value === null || value === undefined || String(value).trim() === '';
    case 'not_empty':
      return value !== null && value !== undefined && String(value).trim() !== '';
    case 'regex':
      try { return new RegExp(strTarget).test(strVal); }
      catch { return strVal.includes(strTarget); }
    case 'greater_than':
      return parseFloat(value) > parseFloat(target);
    case 'less_than':
      return parseFloat(value) < parseFloat(target);
    default:
      return strVal.includes(strTarget);
  }
}

/** 描述操作 */
function describeOperation(op) {
  switch (op.type) {
    case 'delete_rows':
      return `删除"${op.field}"${getCondDesc(op.condition)}"${op.value}"的行`;
    case 'filter_rows':
      return `筛选保留"${op.field}"${getCondDesc(op.condition)}"${op.value}"的行`;
    case 'replace_value':
      return `将"${op.field}"中${getCondDesc(op.condition || 'contains')}"${op.value}"替换为"${op.newValue}"`;
    case 'set_value':
      return `将"${op.field}"${getCondDesc(op.condition || 'equals')}"${op.value}"的行设为"${op.newValue}"`;
    case 'update_row':
      return `更新${getCondDesc(op.condition || 'equals')}"${op.value}"的行：${JSON.stringify(op.updates || {})}`;
    case 'add_row':
      return `新增一行: ${JSON.stringify(op.rowData || {})}`;
    case 'drop_column':
      return `删除字段"${op.field}"`;
    case 'fill_empty':
      return `填充"${op.field}"空值为"${op.value || '未知'}"`;
    case 'trim':
      return `去除"${op.field}"首尾空格`;
    case 'rename_column':
      return `将"${op.field}"重命名为"${op.newName || op.value}"`;
    default:
      return `${op.type}: ${op.field}`;
  }
}

function getCondDesc(condition) {
  const map = {
    contains: '包含', equals: '等于', not_equals: '不等于',
    starts_with: '以...开头', ends_with: '以...结尾',
    is_empty: '为空', not_empty: '不为空',
    regex: '匹配正则', greater_than: '大于', less_than: '小于'
  };
  return map[condition] || condition;
}

/** 构建操作摘要 */
function buildSummary(changes) {
  const parts = [];
  if (changes.deletedRows > 0) {
    parts.push(`删除了 ${changes.deletedRows} 行（已加入回收站）`);
  }
  if (changes.modifiedRows > 0) {
    parts.push(`修改了 ${changes.modifiedRows} 个单元格`);
  }
  if (changes.addedRows > 0) {
    parts.push(`新增了 ${changes.addedRows} 行`);
  }
  if (changes.deletedColumns.length > 0) {
    parts.push(`删除了 ${changes.deletedColumns.length} 列: ${changes.deletedColumns.join(', ')}`);
  }
  if (changes.renamedColumns.length > 0) {
    parts.push(`重命名了 ${changes.renamedColumns.length} 列`);
  }
  parts.push(`清洗后共 ${changes.rowsAfter} 行数据`);
  return parts.join('；');
}

module.exports = { executeCleaning };
