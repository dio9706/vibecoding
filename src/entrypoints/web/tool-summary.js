/** web 入口共享：工具调用摘要 / 只读工具集 / dialog 解析（纯函数，无副作用） */

/**
 * 从 Workflow 脚本开头的 `export const meta = {...}` 里正则取字段。
 * 不 eval：meta 按工具契约必须是纯字面量（无变量/调用/插值），正则足够，也不给脚本任何执行机会。
 * 必须锚到 meta 段：脚本正文的对象字面量（DIMENSIONS、JSON Schema）也常带 name:/description:，
 * 不锚定就会在脚本漏写 meta 时抓到它们，审批弹窗上显示的工作流身份是假的。
 * 契约保证 meta 是首条语句，从它起 2000 字的窗口足够覆盖。
 */
function workflowMetaField(script, key) {
  const src = String(script || '');
  const at = src.search(/export\s+const\s+meta\s*=\s*\{/);
  if (at < 0) return '';
  const re = new RegExp('\\b' + key + '\\s*:\\s*([\'"`])((?:\\\\.|[^\\\\])*?)\\1');
  const m = re.exec(src.slice(at, at + 2000));
  // 反转义 + 折叠空白：描述里的 \' 与多行 backtick 都要收成一行摘要
  return m
    ? m[2]
        .replace(/\\[nrt]/g, ' ') // 转义换行/制表先降成空格，交给下面折叠；否则通用反转义会把 \n 吃成裸字母 n
        .replace(/\\(.)/g, '$1') // 其余转义（\' \" \\）反转义
        .replace(/\s+/g, ' ')
        .trim()
    : '';
}

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
    case 'Workflow': {
      // 名字优先级：脚本 meta.name → 预定义工作流 input.name → scriptPath 文件名 → 兜底。
      // 名字由模型自拟、长度无约束，与其它分支一样必须过 clip；不叫 name 是为了不遮蔽外层的工具名
      const wfName = clip(
        workflowMetaField(inp.script, 'name') ||
          inp.name ||
          (inp.scriptPath ? String(inp.scriptPath).split(/[\\/]/).pop() : '') ||
          '未命名',
        24,
      );
      const desc = workflowMetaField(inp.script, 'description');
      // 与转录行（claude.logic.js 的「工作流(名)启动：…」）同形：同一实体在相邻两行里只用一种写法
      return desc ? `工作流(${wfName})：${clip(desc, 40)}` : `工作流(${wfName})`;
    }
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
  // Workflow 刻意不放行：它一次能拉起十几个子代理，风险不在改文件而在烧额度；询问模式下必须让用户点头
]);

/** 尽力从 dialog payload 解析出可渲染的问题/选项；结构不认识返回 null（→ cancelled） */
export function parseDialog(request) {
  const p = request.payload || {};
  // ---- AskUserQuestion（Claude 主动向用户拍板）----
  // 这个结构比下面的旧猜测更具体，必须先匹配：它的选项藏在 questions[].options 里，
  // 旧的 p.options 猜测认不出这层嵌套，于是每次 Claude 提问都被静默 cancelled ——
  // CLI 随后 fail closed 退化成 no-dialog 行为，表现为 Claude 在正文里列「1. 2. 3.」等人手打。
  // schema 见 sdk-tools.d.ts:800 AskUserQuestionInput。
  const q = Array.isArray(p.questions) ? p.questions[0] : null;
  if (q && Array.isArray(q.options) && q.options.length) {
    const options = q.options.map((o, i) => ({
      id: String(i),
      label: o?.label || String(i),
      desc: o?.description || '',
    }));
    return {
      // header 是 ≤12 字符的 chip 标签（如「状态方案」），当正文读是噪音；问句已在 title
      title: '❓ ' + String(q.question || '请选择'),
      body: '',
      options,
      // 按 AskUserQuestionOutput（sdk-tools.d.ts:3175）形状回传：输入结构原样 + answers。
      // multiSelect 本轮降级单选，answers 恒为单元素数组 —— 语义上是「多选题只答了一项」，
      // Claude 能继续；比压根不呈现好。
      toResult: (choice) => {
        const opt = options.find((x) => x.id === choice);
        return { questions: [{ ...q, answers: [opt ? opt.label : choice] }] };
      },
    };
  }
  // ---- 旧的通用猜测（保留：其它 dialogKind 可能是扁平结构）----
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
