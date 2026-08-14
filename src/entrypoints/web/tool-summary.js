/** web 入口共享：工具调用摘要 / 只读工具集 / dialog 解析（纯函数，无副作用） */

/** 工具调用 → 简短中文状态（用于 activity 事件展示，让前端能看到 Claude 在干嘛） */
export function summarizeTool(a) {
  const name = a.name || '工具';
  const inp = a.input || {};
  const clip = (s, n = 48) => {
    const str = String(s ?? '');
    return str.length > n ? str.slice(0, n) + '…' : str;
  };
  switch (name) {
    case 'Read':
      return `读取 ${clip(inp.file_path)}`;
    case 'Write':
      return `写入 ${clip(inp.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `编辑 ${clip(inp.file_path)}`;
    case 'Grep':
      return `搜索 “${clip(inp.pattern, 32)}”`;
    case 'Glob':
      return `匹配 ${clip(inp.pattern, 32)}`;
    case 'Bash':
      return `执行 ${clip(inp.command, 40)}`;
    case 'Task':
    case 'Agent': // SDK 0.3.210+ 子代理工具名为 Agent（旧名 Task 保留兼容）
      return `子任务 ${clip(inp.description, 32)}`;
    case 'WebFetch':
      return `抓取 ${clip(inp.url)}`;
    case 'WebSearch':
      return `搜网 “${clip(inp.query, 32)}”`;
    case 'TodoWrite':
      return '更新任务清单';
    default:
      return `调用 ${name}`;
  }
}

// 只读工具自动放行；其余（Write/Edit/Bash 等改动类）执行前询问用户
export const READONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'WebSearch',
  'WebFetch',
  'Task',
  'Agent', // SDK 0.3.210+ 子代理工具改名 Agent；子代理内部的改动类工具仍会逐个走审批
]);

/** 尽力从 dialog payload 解析出可渲染的问题/选项；结构不认识返回 null（→ cancelled） */
export function parseDialog(request) {
  const p = request.payload || {};
  const question = p.question || p.message || p.prompt || p.title || request.dialogKind || '请选择';
  const rawOpts = p.options || p.choices || p.answers || null;
  if (Array.isArray(rawOpts) && rawOpts.length) {
    const options = rawOpts.map((o, i) => ({
      id: String(i),
      label: typeof o === 'string' ? o : o.label || o.title || o.name || String(o.value ?? i),
      desc: typeof o === 'string' ? '' : o.description || o.desc || '',
      _raw: o,
    }));
    return {
      title: '❓ ' + String(question),
      body: p.description || '',
      options,
      toResult: (choice) => {
        const opt = options.find((x) => x.id === choice);
        return opt ? opt._raw : choice; // 尽力回传原始选项对象
      },
    };
  }
  return null;
}
