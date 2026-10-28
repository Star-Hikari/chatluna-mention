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
| `allowAll` | `false` | 允许 `@全体成员`（还需 bot 是管理员） |
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
- `splitMessage` 需保持 `none`；开启后 @ 可能被拆成单独一条消息。
- 合并转发（`isForwardMsg`）里的 at 未验证。

## 开发

```bash
# 构建（tsc 产 d.ts + esbuild 产 lib/index.js）
yarn workspace koishi-plugin-chatluna-mention build

# 测试（37 条）
yarn workspace koishi-plugin-chatluna-mention test
```

> 等价的手写命令见 `package.json` 的 `scripts`；仓库根目录的 `yarn build`（yakumo）也会构建本包。

## License

MIT