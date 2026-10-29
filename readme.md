# koishi-plugin-chatluna-mention

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-mention?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-mention)

让 ChatLuna 的回复里能真正 @ 人。

模型写 `@昵称`，插件按**群成员名单**把它渲染成 QQ 的 at 消息段；不需要模型知道或输出 QQ 号，也不会改变现有的 markdown 排版。

> **平台范围：仅 onebot（NapCat）。** 其它平台不在支持范围。

## 它做了什么

- 注册一个 ChatLuna 渲染器 `text-at`：文本 → 元素 → 按成员名解析 `@` → `h('at')`，再交给 adapter 发 `[CQ:at,qq=…]`。
- 与内置 `text` 渲染器共用 markdown 渲染，加粗 / 列表 / 代码块 / 图片行为不变。
- 名字 → QQ 号：群名片 + 昵称 + **去称谓变体**（名片是 `小明さん` 时，写 `@小明` 也能命中）。
- 重名默认**不转**（宁可 @ 不到，也不 @ 错人）；可用 `fixedMentions` 固定要害身份。
- 保留解析 `<at id="…"/>` 的能力：**不在本群就整段丢弃**，绝不把 QQ 号回显成文本。
- 支持 ChatLuna 的 `splitMessage`：`paragraph` 按空行、`punctuation` 按句读拆成多条 `h('message')`，
  每段独立解析 @；`maxPerMessage` 按每条对外消息计数。

## 使用

1. 安装并启用本插件。
2. 控制台 → chatluna → **消息渲染 → 输出模式** → 选 `text-at`。
3. 在人格预设里加一句：

   ```
   想 @ 某位群友时，直接写「@昵称」（例如 @小明），系统会自动变成真正的 @；
   绝对不要在回复里写 QQ 号，也不要用 <at id="..."> 之类的标记。
   ```

4. 预览（不会真的发消息）：

   ```
   chatluna.mention.preview @小明 早上好
   → [at:123456789:小明] 早上好
   ```

   带称谓时，称谓会留在正文里：

   ```
   chatluna.mention.preview @小明大大 早上好
   → [at:123456789:小明]大大 早上好
   ```

## 配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `maxPerMessage` | `3` | 单条最多几个 @，超出的保持纯文本 |
| `allowAll` | `true` | 允许 `@全体成员`（发送前校验权限，无权限自动降级） |
| `checkAtAllPermission` | `true` | 发送前用 `get_group_at_all_remain` 校验 `can_at_all` |
| `allowRawId` | `false` | 允许 `@123456789` 直接当 QQ 号 |
| `skipSelf` | `true` | 不 @ bot 自己 |
| `memberCacheTtl` | `300` | 成员名单缓存（秒），成员变动自动失效 |
| `ambiguous` | `skip` | 重名策略：`skip` 不转 / `first` 取第一个 |
| `honorifics` | `主人, 大大, さん, …` | 称谓后缀表，去掉后缀的短名也能命中 |
| `fixedMentions` | `{}` | 基础名 → QQ 号，优先于名单 |
| `validateExplicitId` | `true` | 校验显式 `<at id>` 是否本群成员 |

固定映射示例（只填基础名，不要带称谓）：

```yaml
fixedMentions:
  小明: '123456789'
```

## 重要：回滚顺序

**先把 chatluna 的 `outputMode` 改回 `text`，再停用本插件。**

否则 ChatLuna 找不到 `text-at` 渲染器，每一轮回复都会报 `RENDER_ERROR`。

## 已知限制

- 只支持 onebot；官方 QQ 机器人与其它适配器不在支持范围。
- 流式固定为 buffer（整条生成完再发），避免 `@小明` 被切成两半。
- `splitMessage` 支持 `none` / `paragraph` / `punctuation`；分段时每段单独发送并在段内解析 @，
  `maxPerMessage` 按每条消息计数。
- 合并转发（`isForwardMsg`）：插件启动 5 秒后会检测该配置，若已开启则**自动暂停 @ 解析**（控制台 notifier 显示警告），避免转发节点里的 at 导致整条消息发送失败；关闭合并转发并重载插件即可恢复。

## 开发

```bash
# 构建（tsc 产 d.ts + esbuild 产 lib/index.js）
yarn workspace koishi-plugin-chatluna-mention build

# 测试（50 条）
yarn workspace koishi-plugin-chatluna-mention test
```

> 等价的手写命令见 `package.json` 的 `scripts`；仓库根目录的 `yarn build`（yakumo）也会构建本包。

## License

MIT

## 更新日志

### 1.2.0

- **支持 ChatLuna 的消息分段**：`text-at` 渲染器此前完全忽略 `options.split`，开启
  `splitMessage=paragraph/punctuation` 后仍整段发送。现在按内置 `TextRenderer` 的约定，
  把每段包成 `h('message', ...)` 后交给 adapter；`paragraph` 按空行切、`punctuation` 按句读切，
  markdown 结构与 `@昵称` 解析都保留。
- **@ 预算按消息计数**：分段后每个 `message` 分组独立计算 `maxPerMessage`，符合“单条最多几个 @”的语义；
  `split: none` 保持原有扁平行为。
- **测试**：新增 `paragraph` / `punctuation` / `none` 三条分段用例，测试总数 50 条。

### 1.1.0

- **修复：无管理员权限时 @全体成员 会导致整条回复丢失。**
  开启 `allowAll` 但机器人不是群管理员时，NapCat 会让这次 `send_group_msg` 整体失败
  （WS 路径返回 `retcode: 1200`），而 koishi 的 `Session.send` 会吞掉异常——表现为群里
  **什么都收不到**、只在日志里留一条 `Error with request send_group_msg ... retcode: 1200` 的 warn。
  现在发送前会调用 `get_group_at_all_remain` 校验 `can_at_all`：无权限时把 `@全体成员`
  降级为普通文本，消息照常发出；探测接口不存在或查询失败时按“允许”处理，避免误伤。
- **变更**：`allowAll` 默认值由 `false` 改为 `true`（由上述权限校验兜底）。
- **新增配置**：`checkAtAllPermission`（默认 `true`），关闭后不再探测权限（无权限时可能整条消息发送失败，一般不建议关）。
- **合并转发保护**：插件初始化 5 秒后读取 chatluna 的 `isForwardMsg`；若已开启，则暂停所有 @ 解析
  （回复里的 `@昵称` 按普通文字发出，也不查询成员名单），并在控制台 notifier 显示一条 warning，
  避免转发节点里的 `at` 段导致 `send_group_forward_msg` 失败、整条回复静默丢失。
- **性能**：权限查询按 `memberCacheTtl` 缓存，且只在回复里真的出现 `@全体成员` 时才查询，平时零额外请求。

### 1.0.0

- 初始版本