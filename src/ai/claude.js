/**
 * Claude API 调用封装
 * 支持文本对话和图片识别（Claude Vision）
 */

const Anthropic = require('@anthropic-ai/sdk');

let client = null;
function getClient() {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === 'your-api-key-here') {
      throw new Error('请先设置 ANTHROPIC_API_KEY 环境变量，或在 .env 文件中配置');
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

/**
 * 构建系统提示词
 */
function buildSystemPrompt(dataContext) {
  const { fields, sampleRows, totalRows, fieldStats } = dataContext;

  return `你是一个专业的数据清洗助手。用户会用自然语言描述数据清洗需求，也可能上传图片让你识别其中的信息。

## 当前数据集信息
- 总行数：${totalRows}
- 字段列表及统计：
${fieldStats.map(f => `  · ${f.name} (类型:${f.type}, 空值:${f.nullCount}个, 唯一值:${f.uniqueCount}个)`).join('\n')}

- 数据样本（前5行）：
${JSON.stringify(sampleRows.slice(0, 5), null, 2)}

## 图片识别能力
如果用户上传了图片（Excel截图、纸质表格照片、数据库截图等），你需要：
1. 识别图片中的文字、数字、表格结构
2. 理解图片中标记/圈注/高亮的内容（比如红框标记要删的数据）
3. 根据识别结果生成对应的清洗操作

## 支持的清洗操作

### 删除与筛选（被删数据自动进入回收站，可恢复）
| 操作类型 | condition支持 | 示例 |
|---------|--------------|------|
| delete_rows | contains, equals, not_equals, starts_with, ends_with, is_empty, not_empty, regex, greater_than, less_than | 删除"等级"字段包含"二甲"的行 |
| filter_rows | 同上 | 只保留"等级"等于"三甲医院"的行 |

### 修改数据
| 操作类型 | 说明 | 示例 |
|---------|------|------|
| replace_value | 替换字段中部分文本 | 把"等级"中的"二曱"替换为"二甲" |
| set_value | 将符合条件的字段设为新值 | 把所有"城市"为空的设为"未知" |
| update_row | 同时更新多个字段（用updates对象） | 更新某行，改为等级="三甲"、城市="省会" |

### 新增 & 结构
| 操作类型 | 说明 |
|---------|------|
| add_row | 新增一行（用rowData对象） |
| drop_column | 删除整列 |
| fill_empty | 填充空值 |
| trim | 去除首尾空格 |
| rename_column | 重命名列（newName） |

## 返回格式（必须严格JSON，不要其他文字）
{
  "explanation": "中文说明，如果是图片识别，说明从图片中识别到了什么信息",
  "confidence": "high|medium|low",
  "askConfirm": true,
  "imageAnalysis": "从图片中识别到的内容简述（无图片时可省略）",
  "operations": [
    {
      "type": "操作类型",
      "field": "目标字段名",
      "condition": "匹配条件",
      "conditionField": "update_row时指定匹配字段",
      "value": "匹配值",
      "newValue": "新值",
      "newName": "新字段名",
      "updates": {"字段1":"新值1"},
      "rowData": {"字段1":"值1"},
      "position": -1
    }
  ]
}

## 重要规则
1. field 必须与数据集字段名完全一致
2. 如果图片中有标记/圈注，优先处理标记的内容
3. 智能匹配用户说的字段名到实际字段名
4. 不确定时设置 askConfirm: true 和 confidence: "low"
5. 可以一次返回多个操作
6. 仅返回JSON，不要包含\`\`\`json\`\`\`标记或其他文字`;
}

/**
 * 将 base64 数据 URL 转为纯 base64 和 media_type
 * 支持 image/png, image/jpeg, image/gif, image/webp, image/bmp
 */
function parseDataUrl(dataUrl) {
  // 尝试标准 data URL 格式
  let match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (match) {
    const mediaType = match[1];
    // Claude 只支持 png/jpeg/gif/webp，将 bmp 等转为 png
    const supportedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    return {
      mediaType: supportedTypes.includes(mediaType) ? mediaType : 'image/png',
      base64: match[2]
    };
  }

  // 尝试原始 base64（无 data: 前缀），默认当做 png
  match = dataUrl.match(/^[A-Za-z0-9+/]+=*$/);
  if (match && dataUrl.length > 100) {
    console.log('[Claude] 检测到纯base64字符串，按 image/png 处理，长度:', dataUrl.length);
    return { mediaType: 'image/png', base64: dataUrl };
  }

  throw new Error('不支持的图片格式，需要 data:image/...;base64,... 或纯base64字符串');
}

/**
 * 构建消息内容（支持文本+图片）
 * @param {string} userMessage
 * @param {string|null} imageBase64 - 纯base64或data URL
 * @returns {Array|string} content数组或纯文本
 */
function buildMessageContent(userMessage, imageBase64) {
  if (!imageBase64) {
    return userMessage;
  }

  // 解析图片
  const { mediaType, base64 } = parseDataUrl(imageBase64);

  // 验证图片大小（Claude 限制约 5MB base64编码后）
  const sizeMB = (base64.length / (1024 * 1024)).toFixed(2);
  console.log(`[Claude] 接收图片: 格式=${mediaType}, base64大小=${sizeMB}MB`);

  if (base64.length > 10 * 1024 * 1024) {
    console.warn(`[Claude] 图片过大 (${sizeMB}MB)，可能导致API拒绝`);
  }

  // 返回多模态内容
  return [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: base64
      }
    },
    {
      type: 'text',
      text: userMessage || '请分析这张图片，根据当前数据集信息，识别图片中的内容（包括文字、数字、表格、标注/圈注/高亮部分），并给出对应的数据清洗操作计划。'
    }
  ];
}

/**
 * 发送对话给Claude，获取清洗计划（支持图片）
 * @param {string} userMessage - 用户输入
 * @param {Object} dataContext - 数据上下文
 * @param {string|null} imageBase64 - 图片base64（可选）
 * @returns {Promise<Object>} 清洗计划JSON
 */
async function getCleaningPlan(userMessage, dataContext, imageBase64 = null) {
  const anthropic = getClient();
  const systemPrompt = buildSystemPrompt(dataContext);
  const content = buildMessageContent(userMessage, imageBase64);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096, // 图片分析可能需要更多token
    system: systemPrompt,
    messages: [
      { role: 'user', content }
    ]
  });

  // 提取文本回复
  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();

  // 解析JSON
  let jsonStr = text;
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    const plan = JSON.parse(jsonStr);
    if (!plan.operations || !Array.isArray(plan.operations)) {
      throw new Error('AI返回的清洗计划格式不正确: 缺少operations数组');
    }
    return plan;
  } catch (err) {
    if (err.message.includes('清洗计划格式不正确')) {
      throw err;
    }
    throw new Error(`AI返回格式解析失败: ${text.substring(0, 200)}`);
  }
}

/**
 * 无数据时的简单对话（支持图片）
 */
async function simpleChat(userMessage, imageBase64 = null) {
  const anthropic = getClient();
  const content = buildMessageContent(
    userMessage || '请分析这张图片的内容',
    imageBase64
  );

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: '你是一个专业的数据清洗助手。用户还没有加载任何数据。请友好地引导用户先上传Excel文件或连接数据库来加载数据。如果用户上传了图片，请分析图片内容并给出建议。用中文回复。',
    messages: [
      { role: 'user', content }
    ]
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  return {
    explanation: text,
    confidence: 'low',
    askConfirm: false,
    operations: [],
    noData: true
  };
}

module.exports = { getCleaningPlan, simpleChat };
