/**
 * AI数据清洗对话工具 - Express服务器
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const store = require('./src/data/store');
const { readExcelFile, writeExcelBuffer } = require('./src/data/excel');
const { testConnection, getTables, getTableData } = require('./src/data/mysql');
const { readSQLiteFile } = require('./src/data/sqlite');
const { getCleaningPlan, simpleChat } = require('./src/ai/claude');
const { executeCleaning } = require('./src/cleaner/executor');
const { syncToMySQL, syncToSQLite } = require('./src/data/sync');

// 追踪最后执行的操作（用于同步到数据库）
let lastOperations = [];
let syncPreviewInfo = null;

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 配置文件上传
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.xlsx', '.xls', '.csv', '.db', '.sqlite', '.sqlite3'];
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的文件类型: ${ext}。支持: ${allowed.join(', ')}`));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// ==================== API 路由 ====================

/**
 * POST /api/chat
 * 获取数据上下文（浏览器端直接调用 Anthropic API，绕过服务器网络限制）
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, image } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: '消息不能为空' });
    }

    // 如果没有加载数据，返回引导信息
    if (!store.hasData()) {
      return res.json({
        noData: true,
        explanation: '请先上传Excel文件或连接数据库来加载数据，然后我才能帮你进行数据清洗。',
        operations: []
      });
    }

    // 构建数据上下文（不含 AI 调用，由浏览器端处理）
    const preview = store.getPreview(5, 0);
    const schema = store.getSchema();

    res.json({
      dataContext: {
        fields: preview.fields,
        sampleRows: preview.rows,
        totalRows: preview.totalRows,
        fieldStats: schema
      },
      systemPrompt: buildCleaningSystemPrompt(preview, schema),
      noData: false
    });
  } catch (err) {
    console.error('Chat context error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 构建清洗系统提示词（替代 claude.js 中的 buildSystemPrompt）
 */
function buildCleaningSystemPrompt(preview, schema) {
  return '你是一个专业的数据清洗助手。用户会用自然语言描述数据清洗需求，也可能上传图片让你识别其中的信息。\n\n## 当前数据集信息\n- 总行数：' + preview.totalRows + '\n- 字段列表及统计：\n' +
    schema.map(f => '  · ' + f.name + ' (类型:' + f.type + ', 空值:' + f.nullCount + '个, 唯一值:' + f.uniqueCount + '个)').join('\n') +
    '\n\n- 数据样本（前5行）：\n' + JSON.stringify(preview.rows.slice(0, 5), null, 2) +
    '\n\n## 支持的清洗操作\n### 删除与筛选\n| delete_rows | 删除符合条件的行 | 条件: contains, equals, not_equals, starts_with, ends_with, is_empty, regex, greater_than, less_than |\n| filter_rows | 只保留符合条件的行 |\n\n### 修改\n| replace_value | 替换字段中部分文本 |\n| set_value | 将符合条件的字段设为新值 |\n| update_row | 同时更新多个字段（用updates对象 + conditionField指定匹配字段）|\n\n### 新增与结构\n| add_row | 新增一行（用rowData对象）|\n| drop_column | 删除整列 |\n| fill_empty | 填充空值 |\n| trim | 去除首尾空格 |\n| rename_column | 重命名列（newName）|\n\n## 返回格式（严格JSON）\n{"explanation":"操作说明","confidence":"high|medium|low","askConfirm":true,"operations":[{"type":"操作类型","field":"字段名","condition":"条件","value":"匹配值","newValue":"新值","updates":{},"rowData":{},"newName":"新字段名"}]}\n\n## 规则\n1. field 必须与数据集字段名完全一致\n2. 如果上传了图片，识别图片中标记/圈注的内容\n3. 不确定时设置 askConfirm: true\n4. 如果用户只是问问题（如\"有多少行\"\"有哪些字段\"\"有没有空值\"），在 explanation 里用中文详细回答，operations 设为空数组 []
5. 不要返回空白的 explanation，始终在 explanation 里给用户有用的回复
6. 仅返回JSON，不要包含\`\`\`json\`\`\`标记';
}

/**
 * POST /api/execute
 * 执行清洗操作
 */
app.post('/api/execute', (req, res) => {
  try {
    const { operations } = req.body;
    if (!operations || !Array.isArray(operations) || operations.length === 0) {
      return res.status(400).json({ error: '没有可执行的清洗操作' });
    }

    // 记录操作（用于后续同步到数据库）
    lastOperations = operations;
    syncPreviewInfo = {
      sourceType: store.sourceInfo?.type,
      sourceName: store.sourceInfo?.name,
      table: store.sourceInfo?.table,
      rowsBefore: store.totalRows
    };

    const result = executeCleaning(operations);
    if (result.success) {
      result._canSync = (store.sourceInfo?.type === 'mysql' || store.sourceInfo?.type === 'sqlite');
      result._syncInfo = syncPreviewInfo;
    }
    res.json(result);
  } catch (err) {
    console.error('Execute error:', err);
    res.status(500).json({ error: `执行失败: ${err.message}` });
  }
});

/**
 * POST /api/upload-excel
 * 上传Excel文件并加载数据
 */
app.post('/api/upload-excel', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择文件' });
    }

    const filePath = req.file.path;
    const result = readExcelFile(filePath);

    if (result.sheets.length === 0) {
      return res.status(400).json({ error: 'Excel文件中没有找到有效数据' });
    }

    const sheets = result.sheets.map(s => ({
      name: s.name,
      fields: s.fields,
      rowCount: s.rows.length
    }));

    // 默认加载第一个sheet
    const firstSheet = result.sheets[0];
    store.load(firstSheet.rows, firstSheet.fields, {
      type: 'excel',
      name: req.file.originalname,
      sheet: firstSheet.name,
      filePath: filePath,
      allSheets: result.sheets // 保留所有sheet用于切换
    });

    res.json({
      success: true,
      fileName: req.file.originalname,
      sheets,
      activeSheet: firstSheet.name,
      data: store.getPreview()
    });
  } catch (err) {
    console.error('Upload Excel error:', err);
    res.status(500).json({ error: `Excel读取失败: ${err.message}` });
  }
});

/**
 * POST /api/switch-sheet
 * 切换当前活动的sheet
 */
app.post('/api/switch-sheet', (req, res) => {
  try {
    const { sheetName } = req.body;
    const sourceInfo = store.sourceInfo;

    if (!sourceInfo || sourceInfo.type !== 'excel' || !sourceInfo.allSheets) {
      return res.status(400).json({ error: '当前数据源不支持切换sheet' });
    }

    const targetSheet = sourceInfo.allSheets.find(s => s.name === sheetName);
    if (!targetSheet) {
      return res.status(404).json({ error: `Sheet "${sheetName}" 不存在` });
    }

    store.load(targetSheet.rows, targetSheet.fields, {
      ...sourceInfo,
      sheet: sheetName
    });

    res.json({
      success: true,
      activeSheet: sheetName,
      data: store.getPreview()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/connect-mysql
 * 连接MySQL数据库
 */
app.post('/api/connect-mysql', async (req, res) => {
  try {
    const config = {
      host: req.body.host || 'localhost',
      port: req.body.port || 3306,
      user: req.body.user || 'root',
      password: req.body.password || '',
      database: req.body.database
    };

    if (!config.database) {
      return res.status(400).json({ error: '请指定数据库名' });
    }

    // 测试连接
    const testResult = await testConnection(config);
    if (!testResult.success) {
      return res.status(400).json({ error: testResult.message });
    }

    // 获取表列表
    const tables = await getTables(config);

    res.json({
      success: true,
      message: '连接成功',
      config: { ...config, password: '******' },
      tables
    });
  } catch (err) {
    console.error('MySQL connect error:', err);
    res.status(500).json({ error: `连接失败: ${err.message}` });
  }
});

/**
 * POST /api/load-mysql-table
 * 加载MySQL表数据
 */
app.post('/api/load-mysql-table', async (req, res) => {
  try {
    const config = {
      host: req.body.host || 'localhost',
      port: req.body.port || 3306,
      user: req.body.user || 'root',
      password: req.body.password || '',
      database: req.body.database
    };
    const { table } = req.body;

    if (!config.database || !table) {
      return res.status(400).json({ error: '请提供数据库连接信息和表名' });
    }

    const data = await getTableData(config, table);

    // 保存真实密码用于后续同步（仅存在服务端内存）
    store.load(data.rows, data.fields, {
      type: 'mysql',
      name: `${config.host}/${config.database}`,
      table: table,
      config: { ...config }  // 保留真实密码
    });

    res.json({
      success: true,
      table,
      data: store.getPreview()
    });
  } catch (err) {
    console.error('MySQL load table error:', err);
    res.status(500).json({ error: `加载表数据失败: ${err.message}` });
  }
});

/**
 * POST /api/connect-sqlite
 * 上传并读取SQLite数据库文件
 */
app.post('/api/connect-sqlite', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择SQLite数据库文件' });
    }

    const result = await readSQLiteFile(req.file.path);

    if (result.tables.length === 0) {
      return res.status(400).json({ error: '数据库中未找到用户表' });
    }

    const tables = result.tables.map(t => ({
      name: t.name,
      fields: t.fields,
      rowCount: t.rows.length
    }));

    // 默认加载第一个表
    const firstTable = result.tables[0];
    store.load(firstTable.rows, firstTable.fields, {
      type: 'sqlite',
      name: req.file.originalname,
      table: firstTable.name,
      filePath: req.file.path,
      allTables: result.tables
    });

    res.json({
      success: true,
      fileName: req.file.originalname,
      tables,
      activeTable: firstTable.name,
      data: store.getPreview()
    });
  } catch (err) {
    console.error('SQLite error:', err);
    res.status(500).json({ error: `SQLite读取失败: ${err.message}` });
  }
});

/**
 * POST /api/switch-table
 * 切换SQLite中的表
 */
app.post('/api/switch-table', (req, res) => {
  try {
    const { tableName } = req.body;
    const sourceInfo = store.sourceInfo;

    if (!sourceInfo || sourceInfo.type !== 'sqlite' || !sourceInfo.allTables) {
      return res.status(400).json({ error: '当前数据源不支持切换表' });
    }

    const targetTable = sourceInfo.allTables.find(t => t.name === tableName);
    if (!targetTable) {
      return res.status(404).json({ error: `表 "${tableName}" 不存在` });
    }

    store.load(targetTable.rows, targetTable.fields, {
      ...sourceInfo,
      table: tableName
    });

    res.json({
      success: true,
      activeTable: tableName,
      data: store.getPreview()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/data/preview
 * 预览当前数据
 */
app.get('/api/data/preview', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  res.json(store.getPreview(limit, offset));
});

/**
 * GET /api/data/schema
 * 获取数据字段信息
 */
app.get('/api/data/schema', (req, res) => {
  if (!store.hasData()) {
    return res.status(400).json({ error: '没有加载数据' });
  }
  res.json(store.getSchema());
});

/**
 * GET /api/data/download
 * 下载清洗后的数据为Excel
 */
app.get('/api/data/download', (req, res) => {
  try {
    if (!store.hasData()) {
      return res.status(400).json({ error: '没有数据可下载' });
    }

    const { fields, rows } = store.exportData();
    const buffer = writeExcelBuffer(fields, rows);

    const filename = `cleaned_data_${Date.now()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(buffer);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: `下载失败: ${err.message}` });
  }
});

/**
 * POST /api/data/rollback
 * 回滚到上一个快照
 */
app.post('/api/data/rollback', (req, res) => {
  const success = store.rollback();
  if (success) {
    res.json({
      success: true,
      message: '已回滚到上一步',
      data: store.getPreview()
    });
  } else {
    res.status(400).json({ error: '没有可回滚的操作' });
  }
});

/**
 * GET /api/data/status
 * 获取当前数据状态
 */
app.get('/api/data/status', (req, res) => {
  res.json({
    hasData: store.hasData(),
    totalRows: store.totalRows,
    fields: store.fields,
    sourceInfo: store.sourceInfo,
    historyCount: store.history.length,
    recycleBinCount: store.recycleBin ? store.recycleBin.length : 0
  });
});

// ==================== 回收站 API ====================

/**
 * GET /api/recycle-bin
 * 获取回收站内容
 */
app.get('/api/recycle-bin', (req, res) => {
  const items = store.getRecycleBin();
  res.json({
    count: items.length,
    items
  });
});

/**
 * POST /api/recycle-bin/restore/:id
 * 从回收站恢复指定行
 */
app.post('/api/recycle-bin/restore/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return res.status(400).json({ error: '无效的ID' });
  }
  const result = store.restoreFromRecycleBin(id);
  if (result.success) {
    res.json({
      success: true,
      message: '已恢复该行数据',
      restored: result.restored,
      data: store.getPreview()
    });
  } else {
    res.status(404).json({ error: '未找到该回收站记录' });
  }
});

/**
 * POST /api/recycle-bin/restore-recent
 * 恢复回收站中最近的N条
 */
app.post('/api/recycle-bin/restore-recent', (req, res) => {
  const count = parseInt(req.body.count) || 1;
  const restored = store.restoreRecent(count);
  res.json({
    success: true,
    restoredCount: restored,
    message: `恢复了 ${restored} 条数据`,
    data: store.getPreview()
  });
});

/**
 * POST /api/recycle-bin/clear
 * 清空回收站
 */
app.post('/api/recycle-bin/clear', (req, res) => {
  const count = store.clearRecycleBin();
  res.json({
    success: true,
    clearedCount: count,
    message: `已清空 ${count} 条回收站记录`
  });
});

// ==================== 数据库同步 API ====================

/**
 * POST /api/sync-to-db
 * 将当前内存中的清洗操作同步回真实数据库
 */
app.post('/api/sync-to-db', async (req, res) => {
  try {
    if (!store.hasData()) {
      return res.status(400).json({ error: '没有数据可同步' });
    }
    if (lastOperations.length === 0) {
      return res.status(400).json({ error: '没有待同步的清洗操作，请先执行清洗操作' });
    }

    const sourceInfo = store.sourceInfo;
    let result;

    if (sourceInfo.type === 'mysql') {
      // 使用存储的配置（含密码），而不是脱敏后的配置
      // 需要从lastOperations关联的原始配置中获取
      if (!sourceInfo.config || !sourceInfo.config.password) {
        return res.status(400).json({
          error: '缺少MySQL连接密码，请重新连接数据库后再同步',
          hint: '密码仅在内存中保存，刷新页面后会丢失。请重新连接MySQL并重新执行清洗操作。'
        });
      }
      result = await syncToMySQL(sourceInfo, lastOperations);
    } else if (sourceInfo.type === 'sqlite') {
      const data = store.exportData();
      result = await syncToSQLite(sourceInfo, data.rows, data.fields);
    } else {
      return res.status(400).json({
        error: `当前数据源类型"${sourceInfo.type}"不支持直接同步，请使用下载功能导出文件`
      });
    }

    if (result.success) {
      // 同步成功后清除待同步操作
      lastOperations = [];
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: '同步失败: ' + err.message });
  }
});

/**
 * GET /api/sync-preview
 * 预览将要同步的操作（不实际执行）
 */
app.get('/api/sync-preview', (req, res) => {
  if (lastOperations.length === 0) {
    return res.json({ hasPending: false, operations: [], message: '没有待同步的操作' });
  }

  const sourceInfo = store.sourceInfo;
  res.json({
    hasPending: true,
    sourceType: sourceInfo?.type,
    sourceName: sourceInfo?.name,
    table: sourceInfo?.table,
    operationCount: lastOperations.length,
    operations: lastOperations.map(op => ({
      type: op.type,
      field: op.field,
      condition: op.condition,
      value: op.value,
      newValue: op.newValue,
      updates: op.updates,
      rowData: op.rowData
    })),
    canSync: sourceInfo?.type === 'mysql' || sourceInfo?.type === 'sqlite',
    message: `有 ${lastOperations.length} 个操作待同步到 ${sourceInfo?.type} 数据库`
  });
});

// 全局错误处理
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '文件过大，最大支持50MB' });
    }
    return res.status(400).json({ error: `上传错误: ${err.message}` });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`\n🧹 AI数据清洗工具已启动`);
  console.log(`📍 访问地址: http://localhost:${PORT}`);
  console.log(`📁 上传目录: ${uploadDir}`);
  console.log(`🔑 API Key: ${process.env.ANTHROPIC_API_KEY ? '已配置 ✓' : '未配置 - 请编辑 .env 文件'}\n`);
});
