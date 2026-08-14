/**
 * dispatch 分发信号量（**叶子模块，禁止 import 任何东西**）。
 *
 * 为什么单独成文件：PASS 需要被 dispatch.js 和各 plugin 的 feature 同时引用，而
 * dispatch.js → features/index.js → plugins/… → feature 本身就是一条链；若把 PASS 定义在
 * dispatch.js 里，feature 反向 import 就形成环，而 features/index.js 带**顶层 await**
 * （loadEnabledPluginFeatures），ESM 循环 + 顶层 await 会直接死锁在模块图上。
 */

/**
 * feature 的「我不接这条」信号。
 *
 * 用途：hasPending 是**同步**判定，无法预知用户这条消息到底是不是在回答追问
 *（要判断得先做一次异步抽取）。所以允许 feature 先接进去看一眼，发现不是给自己的，
 * 就返回 PASS 把消息还给 dispatch 继续走常规意图识别。
 *
 * 契约：只有 hasPending 通道（dispatch 第 0 步）识别 PASS；返回 PASS 前 feature 应已
 * 清理掉自己的中间态，否则下一条消息会再被劫持一次。
 */
export const PASS = Symbol('dispatch:pass');
