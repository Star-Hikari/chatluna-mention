import { Context, h } from 'koishi'
import 'koishi-plugin-chatluna'
import { Config } from './config'
import { MentionRenderer, RENDER_TYPE } from './renderer'
import { MentionResolver } from './resolver'
import { serializeElements } from './serialize'

export const name = 'chatluna-mention'
export const inject = { required: ['chatluna'], optional: ['notifier'] }

export { Config }
export { RENDER_TYPE, MentionRenderer } from './renderer'
export { MentionResolver } from './resolver'

export const usage = `
<style>
.markdown .mention-usage { line-height: 1.8; color: var(--fg1); }
.markdown .mention-usage p { margin: .6em 0; }
.markdown .mention-usage strong { color: var(--fg1); font-weight: 600; }
.markdown .mention-usage code { color: var(--fg1); font-weight: 600; padding: .12em .45em; background: var(--k-color-primary-fade); border-radius: 4px; }
.markdown .mention-usage h3 { margin: 1.1em 0 .35em; font-size: 1rem; color: var(--fg1); }
.markdown .mention-usage ol, .markdown .mention-usage ul { margin: .35em 0 .7em; padding-left: 1.5em; }
.markdown .mention-usage li { margin: .28em 0; }
.markdown .mention-usage .note { margin-top: .9em; padding: .6em .95em; border-left: 3px solid var(--k-color-primary); background: var(--k-color-primary-fade); border-radius: 0 6px 6px 0; font-size: .96em; }
.markdown .mention-usage .warn { margin-top: .9em; padding: .6em .95em; border-left: 3px solid #e6a23c; background: rgba(230, 162, 60, .12); border-radius: 0 6px 6px 0; font-size: .96em; }
</style>

<div class="mention-usage">

<p><strong>让 ChatLuna 的回复里能真正 @ 人。</strong>模型写 <code>@昵称</code>，插件按群成员名单把它渲染成 QQ 的 at 消息段——不需要模型知道 QQ 号，也不改变现有的 markdown 排版。</p>

<div class="note">平台范围：仅 onebot（NapCat）。其它平台不在支持范围。</div>

<h3>启用步骤</h3>

<ol>
<li>在控制台启用本插件（此时输出模式仍是 <code>text</code> 也没关系）。</li>
<li>打开 <strong>chatluna → 消息渲染 → 输出模式</strong>，选择 <code>text-at</code>。</li>
<li>在人格预设里加一句：<code>想 @ 谁就直接写 @昵称，不要写 QQ 号，也不要用 &lt;at id="..."&gt; 标记。</code></li>
<li>用 <code>chatluna.mention.preview 文本</code> 预览解析结果（不会真的发消息）。</li>
</ol>

<h3>怎么确认它在工作</h3>

<p>运行日志出现 <code>已生效：outputMode=text-at</code>；预览命令返回 <code>[at:QQ号:昵称]</code>；群里让模型 @ 你一次，看到蓝色 @ 就说明链路通了。</p>

<p>如果模型写了 <code>@某人</code> 却没变蓝：先用预览命令确认名字能否命中——群名片改过、重名、名字里带空格都可能影响；实在不行用下方 <code>fixedMentions</code> 固定映射兜底。</p>

<p>如果 chatluna 开启了<strong>合并转发</strong>，插件会在启动 5 秒后检测到并自动暂停 @ 解析（控制台会显示警告），避免转发节点里的 @ 导致整条消息发送失败。</p>

<h3>关闭插件顺序（重要）</h3>

<div class="warn">先把 chatluna 的 <code>outputMode</code> 改回 <code>text</code>，<strong>再</strong>停用本插件。反过来会让 ChatLuna 找不到 <code>text-at</code> 渲染器，之后每轮回复都会报 <code>RENDER_ERROR</code>。</div>

<h3>下方配置</h3>

<ul>
<li><strong>基础设置</strong>：单条最多几个 @、是否 @ 自己。</li>
<li><strong>名单与匹配</strong>：成员缓存、重名策略、称谓后缀、固定映射。</li>
<li><strong>高级</strong>：@全体（默认开，发送前校验权限）、纯数字 ID、显式标签校验——默认值即可，非必要不要改。</li>
</ul>

</div>
`.trim()

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('chatluna-mention')
  const resolver = new MentionResolver(ctx, config, logger)
  const renderer = new MentionRenderer(ctx, resolver, logger)

  // 注册自定义渲染器；ctx.effect 保证 HMR / 停用 / dispose 时自动摘掉
  ctx.effect(() => ctx.chatluna.renderer.addRenderer(RENDER_TYPE, () => renderer))

  // ── 合并转发保护 ──
  // chatluna 的 isForwardMsg 会把回复塞进转发节点；节点里的 at 段在部分 NapCat 版本上
  // 会导致整条 send_group_forward_msg 失败（同样被 Session.send 吞掉 → 回复静默丢失）。
  // 因此启动 5 秒后读一次配置：开启合并转发就暂停 @ 解析，并在控制台 notifier 里给出警告。
  let notifier: any = null
  let forwardBlocked = false

  const showForwardWarning = () => {
    if (!forwardBlocked || notifier == null) return
    notifier.update({
      type: 'warning',
      content: [
        h('p', '检测到 chatluna 已开启「合并转发（isForwardMsg）」。'),
        h(
          'p',
          '为避免 @ 被写进转发节点、导致整条消息发送失败，本插件已暂停解析 @ 文本；回复里的 @昵称 会按普通文字发出。',
        ),
        h('p', '需要恢复 @：先在 chatluna 关闭合并转发，再重载本插件。'),
      ],
    })
  }

  // notifier 是可选服务：没装/未启用时静默跳过
  ctx.inject(['notifier'], (ctx) => {
    notifier = (ctx as any).notifier.create()
    showForwardWarning()
  })

  ctx.setTimeout(() => {
    const isForwardMsg = (ctx.chatluna as any)?.currentConfig?.isForwardMsg === true
    if (!isForwardMsg) {
      logger.debug('未开启合并转发，@ 解析保持启用')
      return
    }
    forwardBlocked = true
    resolver.setSkipAt(true)
    logger.warn(
      '检测到 chatluna 已开启合并转发（isForwardMsg）：已暂停 @ 解析，避免转发节点里的 @ 导致整条消息发送失败。',
    )
    showForwardWarning()
  }, 5000)

  // 成员变动 → 失效该群缓存（onebot 的 group_increase/decrease 会映射成这两个事件）
  const onMemberChange = (session: any) => {
    const guildId =
      session?.guildId ??
      (String(session?.channelId ?? '').startsWith('private:') ? undefined : session?.channelId)
    if (guildId) resolver.invalidate(String(guildId))
  }
  ctx.on('guild-member-added' as any, onMemberChange)
  ctx.on('guild-member-removed' as any, onMemberChange)

  ctx.on('ready', () => {
    const mode = (ctx.chatluna as any)?.currentConfig?.outputMode
    if (mode !== RENDER_TYPE) {
      logger.warn(
        `chatluna.outputMode 当前是 "${mode}"，本插件尚未生效。` +
          `请到控制台把「消息渲染 → 输出模式」改为 "${RENDER_TYPE}"。`,
      )
      return
    }
    logger.info(
      `已生效：outputMode=${RENDER_TYPE}，成员缓存 ${config.memberCacheTtl}s，` +
        `固定映射 ${Object.keys(config.fixedMentions ?? {}).length} 条`,
    )
  })

  // 停用前提醒顺序（否则 chatluna 会一直报 RENDER_ERROR）
  ctx.on('dispose', () => {
    const mode = (ctx.chatluna as any)?.currentConfig?.outputMode
    if (mode === RENDER_TYPE) {
      logger.warn(
        `正在停用 chatluna-mention，但 chatluna.outputMode 仍是 "${RENDER_TYPE}"。` +
          '请先把它改回 "text"，否则之后的回复会报 RENDER_ERROR。',
      )
    }
  })

  // 诊断命令：只算不发，用于排查“模型写了 @ 却没亮”
  ctx
    .command('chatluna.mention.preview <text:text>', '预览 @ 解析结果（不会发送消息）', {
      authority: 3,
    })
    .action(async ({ session }, text) => {
      if (!text || !text.trim()) return '用法：chatluna.mention.preview <文本>'
      const result = await renderer.render(
        { content: text },
        { type: RENDER_TYPE, session, split: 'none' } as any,
      )
      const elements = Array.isArray(result.element) ? result.element : [result.element]
      return serializeElements(elements)
    })
}