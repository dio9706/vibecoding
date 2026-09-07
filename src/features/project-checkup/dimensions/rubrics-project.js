/**
 * 项目级维度的审计准则（纯数据，无逻辑）。字段契约与 rubrics-code.js 完全一致，见那个文件的头注释。
 *
 * 与代码级 rubric 的区别在**判据的依据来源**：代码级可以只看那段代码本身，
 * 项目级几乎都要参照「项目自己声明的意图」——分层约定写在 CLAUDE.md 里、
 * 真实脚本写在 package.json 里。所以这几份 rubric 都会用到引擎注入的 sharedContext，
 * 并且都明写「以项目自己的声明为准，而不是以你偏好的架构为准」。
 */

const NO_SPECULATION = '判定必须基于给出的证据本身。证据不足时判「可接受」并在 reason 里写明'
  + '「片段信息不足以断定」——**不要**为了补上下文去猜测代码其它部分长什么样。';

export const structure = {
  role: '你是软件架构审查员，依据《架构整洁之道》的依赖规则（依赖只能指向更稳定、更抽象的一侧）'
    + '与 SOLID 的依赖倒置原则做判断。',
  intro: '下面是目录之间的依赖边与 import 环。**判据必须以「本项目自己声明的分层约定」为准**'
    + '（见上文共享上下文），而不是以你偏好的某种分层。项目没有声明约定时，先从目录命名推断'
    + '它想要的层序，并在 reason 里说明你的推断。',
  criteria: [
    '- `violation`：这条边**违反了项目声明的依赖方向**（下层反过来 import 上层），或者构成 import 环。',
    '  两者的共同后果是：无法单独理解、单独测试、单独替换任何一侧。',
    '  ⛔ 判 violation 前先确认两件事：① 相关模块文档里有没有把它写成刻意设计（有就判 acceptable）；',
    '  ② 你说的「环」是不是真的存在——目录级的两条反向边**不构成**文件级环，',
    '  真环会作为独立候选给出（详见共享上下文的形状说明）。',
    '- `smell`：方向没错，但**跨过了中间层**（例如入口层直接 import 最底层，绕过了本该经过的编排层），',
    '  或者一个模块被异常多的上层直接依赖，成了事实上的耦合枢纽。',
    '- `acceptable`：这条边符合声明的方向，或者项目已经明确权衡过。注意几类**看起来可疑但正常**的边：',
    '  ① 任何层都可以依赖「共享基础设施 / 类型 / 常量」层——那正是它存在的目的；',
    '  ② 入口层依赖多个下层是入口的职责（它就是组装点）；',
    '  ③ 测试文件依赖被测模块；',
    '  ④ **模块文档写明是刻意设计的反向依赖**——例如「某个零依赖叶子模块刻意放在上层，',
    '     好让下层都能 import 它而不成环」，或「某类跨层聚合刻意收在一个出口」。',
    '     这种边不是疏漏而是已经权衡过的决定，判 acceptable 并引用那条理由；',
    '  ⑤ **发起这条边的文件没有任何人 import**（示例、演示、归档代码）。',
    '     它压根不参与运行，架构上无害——那属于「死代码」维度的问题，不是这一维的。',
  ].join('\n'),
  examples: [
    '### 示例 A —— 判 violation',
    '共享上下文声明：`entrypoints → app → features → capabilities → integrations/store → shared`，下层不得 import 上层。',
    '证据：`依赖边：\\`src/store\\` → \\`src/features\\`，共 3 处引用`。',
    'verdict: `violation`',
    'reason: store 是声明层序里的下层，features 是上层。这条边让持久化层反过来知道业务特性，',
    '后果是无法在不引入整个 features 的情况下测试 store，也无法替换某个 feature 而不动 store。',
    'suggestion: 把 store 需要的那部分抽成 store 自己的类型/接口，或改为由 features 在调用时把数据传进来（依赖倒置）。',
    '',
    '### 示例 B —— 判 acceptable（看似跨层，实为共享层）',
    '证据：`依赖边：\\`src/store\\` → \\`src/shared\\`，共 21 处引用`。',
    'verdict: `acceptable`',
    'reason: shared 是声明层序的最底层（config / logger / 常量），任何层依赖它都符合方向。',
    '21 处引用密集恰恰说明它承担了「唯一权威来源」的角色，不是耦合枢纽。',
  ].join('\n'),
  outputRule: [
    `- ${NO_SPECULATION}`,
    '- 判 `violation` / `smell` 时，`reason` 必须引用**项目声明的层序**并指出这条边违反了其中哪一条；',
    '  `suggestion` 必须给出解耦方向（把什么抽到哪一层、或让哪一侧改成接收参数）。',
    '- 判 import 环时，`suggestion` 要指明**该断哪一条边**以及为什么断那条代价最小。',
  ].join('\n'),
};

export const deps = {
  role: '你是依赖管理审查员，依据《Google 软件工程》第 21 章（依赖管理的成本、'
    + '每个依赖都是长期负债）与最小依赖面原则做判断。',
  intro: '下面是依赖清单与源码 import 的差集，以及完整清单（用于判断有无功能重复）。'
    + '静态分析**看不到**这些引用形式：构建工具配置、CLI 可执行文件、框架按约定加载的插件、'
    + '类型声明包、只在脚本或 CI 里用到的包。判定时必须先考虑它们。',
  criteria: [
    '- `remove`：确实没有任何用途，删掉能减少安装体积与供应链面。',
    '- `add`：源码确实 import 了它却没声明——这会在别人 clone 后安装依赖时才暴露，',
    '  是典型的「在我机器上能跑」缺陷（它可能是通过其它包的传递依赖偶然可用的）。',
    '- `consolidate`：清单里有两个及以上依赖在做同一件事，应当收敛到一个。',
    '- `acceptable`：无需改动。常见情形：',
    '  ① 构建工具 / 打包器 / 测试运行器 / linter —— 它们由配置文件或命令行调用，源码里当然没有 import；',
    '  ② 类型声明包（`@types/*`）与 polyfill；',
    '  ③ CLI 可执行依赖（通过 `npx` 或 package scripts 调用）；',
    '  ④ 看起来重复但分工不同的库（例如一个负责解析、一个负责渲染）。',
  ].join('\n'),
  examples: [
    '### 示例 A —— 判 add',
    '证据：`\\`lodash\\` 被 6 个文件 import，但没有出现在依赖清单里`。',
    'verdict: `add`',
    'reason: 6 处源码依赖它却没有声明，当前能跑只是因为某个包把它作为传递依赖装进了 node_modules。',
    '那个包一升级换掉 lodash，本项目就会在运行时报模块找不到，而清单里看不出任何线索。',
    'suggestion: `npm i lodash` 把它显式加入 dependencies。',
    '',
    '### 示例 B —— 判 acceptable（构建工具没有 import 是正常的）',
    '证据：`依赖 \\`@tauri-apps/cli@^2\\`（devDependencies）在源码里找不到任何 import`。',
    'verdict: `acceptable`',
    'reason: 它是命令行构建工具，由 package scripts 里的 `tauri build` 调用，本来就不会出现在 import 里。',
    '删掉它会让桌面端构建命令直接失效。',
  ].join('\n'),
  outputRule: [
    `- ${NO_SPECULATION}`,
    '- 判 `remove` 时，`reason` 必须逐一排除上面列出的**全部** acceptable 情形（是否是构建工具、',
    '  是否可能被 scripts 调用、是否是类型包），并说明依据。误删依赖会让构建直接崩，判据要保守。',
    '- 判 `consolidate` 时，`reason` 必须点名**哪两个包重复**、各自被用在哪里，`suggestion` 说明留哪个、为什么。',
  ].join('\n'),
};

export const docs = {
  role: '你是开发者体验审查员，依据《Google 软件工程》第 10 章（文档即代码、'
    + '文档要为读者的具体任务服务）与「新人第一小时」标准做判断。',
  intro: '下面是项目自述文件里的命令块（或它的缺失）。**判据是：一个刚 clone 下来的人'
    + '照着它做，能不能把项目跑起来。**项目真实可用的脚本见上文共享上下文，以它为准。',
  criteria: [
    '- `broken`：照着做会**直接失败**。典型形状：命令引用的脚本在清单里不存在、',
    '  脚本名拼写与真实清单不一致、缺少前置步骤（未装依赖就启动）、或者根本没有上手入口。',
    '- `outdated`：能跑但与现状不符——脚本还在但行为已变、命令仍可用但已被更好的方式取代、',
    '  文档里的命令只覆盖了部分必要步骤。',
    '- `acceptable`：命令与真实脚本一致且足以完成它声称的任务。',
  ].join('\n'),
  examples: [
    '### 示例 A —— 判 broken',
    '共享上下文里的真实脚本只有 `npm run dev` 与 `npm test`。',
    '证据：README 命令块 `npm install` / `npm start`。',
    'verdict: `broken`',
    'reason: 清单里没有 `start` 脚本，照着执行会得到 "Missing script: start"。新人的第一条命令就断在这里。',
    'suggestion: 把文档里的 `npm start` 改成 `npm run dev`，或在 package.json 里补一个 `start` 脚本指向同一命令。',
    '',
    '### 示例 B —— 判 acceptable',
    '共享上下文里有 `start: node server.js`。证据：README 命令块 `npm install` / `npm start`。',
    'verdict: `acceptable`',
    'reason: 两条命令都与真实脚本对得上，且顺序完整（先装依赖再启动），足以让新人跑起来。',
  ].join('\n'),
  outputRule: [
    `- ${NO_SPECULATION}`,
    '- 判 `broken` / `outdated` 时，`reason` 必须指出**具体哪一条命令、会怎么失败**；',
    '  `suggestion` 给出改写后的命令原文，让人可以直接替换。',
    '- 只依据共享上下文里的真实脚本判断，不要假设项目「应该」有某个脚本。',
  ].join('\n'),
};

export const hygiene = {
  role: '你是版本库卫生审查员，依据「版本库只应包含人编写的、需要协同演进的内容」'
    + '这一原则，以及运行期产物入库带来的具体成本（工作区永久脏、clone 变慢、本地数据外泄）做判断。',
  intro: '下面是 git 追踪中的可疑文件。它们已经通过了零误报的确定性规则（那一层只认 '
    + '`.jsonl` / `.log` 与 `tmp-|temp-|debug-` 前缀），这里要补的是**召回率**：'
    + '命名或体积可疑、但需要理解语义才能判断的那些。',
  criteria: [
    '- `should-ignore`：它是运行期产物、一次性调试脚本、或个人临时文件，不该入库。',
    '  判据是「删掉它，其他人 clone 后仍能正常构建与运行」。',
    '- `keep`：它本该在版本库里。常见情形：',
    '  ① 项目实际需要的资源（图标、字体、设计稿、示例数据）；',
    '  ② 依赖锁文件、构建配置、CI 配置；',
    '  ③ 名字里带 temp/old/draft 但实际是**业务语义**的一部分',
    '     （`temp-sensor-reading.js` 里的 temp 是温度、`draft-order.js` 是草稿订单这个领域概念）；',
    '  ④ 刻意归档的历史文件，且有文档或目录名说明它被归档的原因。',
  ].join('\n'),
  examples: [
    '### 示例 A —— 判 should-ignore',
    '证据：`git 追踪中的可疑文件 \\`cobe-probe.tmp.mjs\\`：路径里含临时/废弃语义的命名`。',
    'verdict: `should-ignore`',
    'reason: `.tmp.` 与 `probe` 同时出现，是一次性探测脚本的典型命名；它不被任何构建脚本引用，',
    '删掉不影响任何人构建或运行。留在库里会被下一个读者误当成正式工具去理解。',
    'suggestion: 加入 .gitignore 并 `git rm --cached cobe-probe.tmp.mjs`；确认不再需要就直接删除文件。',
    '',
    '### 示例 B —— 判 keep（名字里的 temp 是领域词）',
    '证据：`git 追踪中的可疑文件 \\`src/sensors/temp-calibration.json\\`：路径里含临时/废弃语义的命名`。',
    'verdict: `keep`',
    'reason: 目录 `sensors/` 说明这里的 temp 是 temperature（温度）而不是 temporary，',
    '这是温度传感器的标定数据，属于运行必需的资源。命名规则命中的是一个同形异义词。',
  ].join('\n'),
  outputRule: [
    `- ${NO_SPECULATION}`,
    '- 判 `should-ignore` 时，`reason` 必须说明「删掉它为什么不影响别人构建/运行」；',
    '  `suggestion` 给出具体的 .gitignore 条目与是否需要 `git rm --cached`。',
    '- 特别小心同形异义词（temp=温度 / draft=草稿业务 / old=历史版本资源），',
    '  拿不准就判 `keep`——误删别人需要的资源比多留一个临时文件糟得多。',
  ].join('\n'),
};
