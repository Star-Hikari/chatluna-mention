import { Context, h, Logger, Session } from 'koishi'
import type { Config } from './config'

/** 索引里的一条“名字 → QQ 号”；fixed=true 表示来自配置的固定映射 */
export interface NameEntry {
  name: string
  id: string
  fixed: boolean
}

/** 群成员名字索引 */
export interface NameIndex {
  /** 按名字长度倒序；同长时 fixed 优先 */
  entries: NameEntry[]
  /** name → 所有可能的 QQ 号（fixed 排最前，用于重名判定） */
  ids: Map<string, string[]>
  /** 所有已知 QQ 号（含 fixed），用于校验显式 <at id> */
  known: Set<string>
}

/** 同一条回复内共享的 @ 预算（多段 text 也只算一条消息的额度） */
export interface MentionBudget {
  count: number
}

/** 不进入 @ 解析的容器：代码块里的 @ 必须保持原样 */
const OPAQUE = new Set(['code', 'code-block', 'a'])

/** 只认自闭合形式；非自闭合的 <at ...>正文</at> 原样保留，避免吞正文 */
const AT_TAG = /<at\s+([^>]*?)\s*\/>/gi
const ATTR = /(\w+)\s*=\s*"([^"]*)"/g
const DIGITS = /^\d{5,12}/

/** 归一化：全角转半角、去零宽字符、trim */
function normalizeName(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim()
}

function emptyIndex(): NameIndex {
  return { entries: [], ids: new Map(), known: new Set() }
}

function sortEntries(index: NameIndex) {
  index.entries.sort((a, b) => {
    if (b.name.length !== a.name.length) return b.name.length - a.name.length
    return Number(b.fixed) - Number(a.fixed)
  })
}

/**
 * 成员名 → QQ 号 的解析器。
 *
 * 设计要点：
 * - 只按群成员名单解析名字；拿不到名单时退化为“仅固定映射”，不报错、不猜；
 * - 原文里的 @ 永远不被原地修改，返回新数组；
 * - 显式 <at id> 做名单校验，校验失败整段丢弃（绝不把 QQ 号回显成文本）。
 */
export class MentionResolver {
  private cache = new Map<string, { at: number; index: NameIndex }>()
  /** @全体成员 权限缓存：key 同成员名单，value 为 can_at_all */
  private atAllCache = new Map<string, { at: number; can: boolean }>()
  /** 失败日志节流：同一个群在缓存周期内只 warn 一次 */
  private warned = new Set<string>()
  /** 合并转发模式下暂停解析（由 index 在启动 5 秒后按 isForwardMsg 设置） */
  private skipAt = false
  private logger: Logger

  constructor(
    private ctx: Context,
    private config: Config,
    logger?: Logger,
  ) {
    this.logger = logger ?? ctx.logger('chatluna-mention')
  }

  /** 暂停/恢复 @ 解析。暂停时回复里的 @ 一律按普通文本发送，也不会查询成员名单。 */
  setSkipAt(value: boolean) {
    this.skipAt = value
  }

  /** 成员变动后失效缓存；不传 guildId 则全清 */
  invalidate(guildId?: string) {
    if (!guildId) {
      this.cache.clear()
      this.atAllCache.clear()
      return
    }
    const suffix = `:${guildId}`
    for (const key of [...this.cache.keys()]) {
      if (key.endsWith(suffix)) this.cache.delete(key)
    }
    for (const key of [...this.atAllCache.keys()]) {
      if (key.endsWith(suffix)) this.atAllCache.delete(key)
    }
  }

  /** 深度遍历元素树，只改写 text 节点；budget 跨 text 段共享，保证“一条消息 N 个 @” */
  async rewrite(root: h[], session?: Session, budget: MentionBudget = { count: 0 }): Promise<h[]> {
    // 合并转发模式：完全不碰 @（也不查名单），只保留 markdown 渲染结果
    if (this.skipAt) return this.unwrapFirstParagraph(root)

    // 拿不到名单（私聊 / 接口失败）时不要提前 return：显式 <at id> 仍应生效，
    // 只是名字匹配自然匹配不到；同时保证首个 <p> 解包逻辑对所有路径一致。
    const index = await this.indexOf(session)
    const allowAll = await this.resolveAtAll(root, session)
    const state = { budget, index, allowAll }

    const walk = (elements: h[]): h[] => {
      const out: h[] = []
      for (const el of elements) {
        if (el.type === 'text') {
          out.push(...this.convertText(String(el.attrs.content ?? ''), state, session))
          continue
        }
        if (OPAQUE.has(el.type)) {
          out.push(el)
          continue
        }
        if (el.children?.length) {
          out.push(h(el.type, el.attrs, walk(el.children)))
          continue
        }
        out.push(el)
      }
      return out
    }

    const result = walk(root)
    return this.unwrapFirstParagraph(result)
  }

  /** 与内置 TextRenderer 一致：首个 <p> 解包，否则 onebot 侧会多出空行 */
  private unwrapFirstParagraph(elements: h[]): h[] {
    const result = elements.slice()
    if (result[0]?.type === 'p') {
      const first = result.shift()!
      const content = first.attrs.content
      if (content) result.unshift(h.text(content))
      else result.unshift(...first.children)
    }
    return result
  }

  /** 群号：onebot 群里 guildId 与 channelId 都是群号；私聊 channelId 形如 private:xxx */
  private guildIdOf(session?: Session): string | undefined {
    const guildId = session?.guildId
    if (guildId) return String(guildId)
    const channelId = session?.channelId
    if (channelId && !String(channelId).startsWith('private:')) return String(channelId)
    return undefined
  }

  private async indexOf(session?: Session): Promise<NameIndex> {
    const fixed = this.fixedIndex()
    if (!session) return fixed

    const guildId = this.guildIdOf(session)
    const bot = session.bot as any
    if (!guildId || !bot || typeof bot.getGuildMemberList !== 'function') return fixed

    const platform = bot.platform ?? session.platform ?? 'unknown'
    const selfId = bot.selfId ?? session.selfId ?? 'unknown'
    const key = `${platform}:${selfId}:${guildId}`

    const hit = this.cache.get(key)
    const now = Date.now()
    if (hit && now - hit.at < this.config.memberCacheTtl * 1000) return hit.index

    try {
      const { data } = await bot.getGuildMemberList(guildId)
      const index = this.buildIndex(Array.isArray(data) ? data : [], fixed)
      this.cache.set(key, { at: now, index })
      this.warned.delete(key)
      this.logger.debug(`成员索引已刷新 ${key}：${index.entries.length} 条名字 / ${index.known.size} 人`)
      return index
    } catch (e) {
      if (!this.warned.has(key)) {
        this.warned.add(key)
        this.logger.warn(`获取群成员名单失败（本次仅使用固定映射）：${key}`, e)
      } else {
        this.logger.debug(`获取群成员名单再次失败：${key}`)
      }
      return fixed
    }
  }

  /**
   * 本次回复是否真的需要 @全体成员（避免为无关回复白查一次权限）。
   * 只扫描可解析的文本节点；代码块里出现的不算。
   */
  private wantsAtAll(elements: h[]): boolean {
    for (const el of elements) {
      if (OPAQUE.has(el.type)) continue
      if (el.type === 'text') {
        const content = String(el.attrs.content ?? '')
        if (content.includes('@全体成员')) return true
        if (/<at[^>]*type\s*=\s*["']all["']/i.test(content)) return true
        continue
      }
      if (el.children?.length && this.wantsAtAll(el.children)) return true
    }
    return false
  }

  /**
   * 是否允许本次 @全体成员。
   *
   * 背景：NapCat 在无权限时会让整条 send_group_msg 失败（retcode 1200），
   * 而 koishi 的 Session.send 会把错误吞掉 → 整条回复静默丢失。
   * 所以这里先用 get_group_at_all_remain 查 can_at_all，拿不到明确的 false 才放行。
   */
  private async resolveAtAll(elements: h[], session?: Session): Promise<boolean> {
    if (!this.config.allowAll) return false
    if (session?.isDirect) return false
    if (!this.wantsAtAll(elements)) return false
    if (!this.config.checkAtAllPermission) return true

    const bot = session?.bot as any
    const guildId = this.guildIdOf(session)
    const probe = bot?.internal?.getGroupAtAllRemain
    if (!guildId || typeof probe !== 'function') {
      // 老版本 NapCat 没有该接口：保持“配置即放行”的旧行为
      return true
    }

    const platform = bot.platform ?? session?.platform ?? 'unknown'
    const selfId = bot.selfId ?? session?.selfId ?? 'unknown'
    const key = `${platform}:${selfId}:${guildId}:at-all`
    const hit = this.atAllCache.get(key)
    const now = Date.now()
    if (hit && now - hit.at < this.config.memberCacheTtl * 1000) return hit.can

    try {
      const data = await probe.call(bot.internal, guildId)
      const flag = data?.can_at_all
      // 只有明确的 false 才拦截；字段缺失（老版本/异常返回）按允许处理
      const can = flag !== false
      this.atAllCache.set(key, { at: now, can })
      if (flag === true) {
        this.logger.debug(
          `@全体成员可用（群剩余 ${data?.remain_at_all_count_for_group ?? '?'} / 账号剩余 ${data?.remain_at_all_count_for_uin ?? '?'}）：${key}`,
        )
      } else if (flag === false) {
        this.logger.debug(`@全体成员无权限，本次降级为普通文本：${key}`)
      } else {
        this.logger.debug(`@全体成员权限未返回 can_at_all，本次按允许处理：${key}`)
      }
      return can
    } catch (e) {
      // 探测失败 ≠ 无权限：按配置放行，避免误伤；只记录一次
      if (!this.warned.has(key)) {
        this.warned.add(key)
        this.logger.warn(`查询 @全体成员 权限失败，本次按允许处理：${key}`, e)
      } else {
        this.logger.debug(`查询 @全体成员 权限再次失败：${key}`)
      }
      return true
    }
  }

  /** fixedMentions 单独成索引：名单拿不到时也要能用 */
  private fixedIndex(): NameIndex {
    const index = emptyIndex()
    const seen = new Set<string>()
    for (const [rawName, rawId] of Object.entries(this.config.fixedMentions ?? {})) {
      const name = normalizeName(rawName)
      const id = String(rawId ?? '').trim()
      if (!name || !id) continue
      this.addEntry(index, seen, name, id, true)
      index.known.add(id)
    }
    sortEntries(index)
    return index
  }

  private buildIndex(members: any[], fixed: NameIndex): NameIndex {
    const index: NameIndex = {
      entries: fixed.entries.slice(),
      ids: new Map([...fixed.ids].map(([name, ids]) => [name, ids.slice()])),
      known: new Set(fixed.known),
    }
    const seen = new Set<string>(fixed.entries.map((entry) => `${entry.name}\u0000${entry.id}`))

    for (const member of members) {
      const id = String(member?.user?.id ?? member?.user_id ?? '').trim()
      if (!id) continue
      index.known.add(id)

      for (const raw of [member?.nick, member?.user?.name]) {
        const name = normalizeName(raw)
        if (!name) continue
        this.addEntry(index, seen, name, id, false)

        // 「小明さん」→ 额外登记「小明」，这样模型只写 @小明 也能命中
        for (const suffix of this.config.honorifics ?? []) {
          if (!suffix || !name.endsWith(suffix)) continue
          const short = name.slice(0, -suffix.length).trim()
          if (short.length >= 2) this.addEntry(index, seen, short, id, false)
        }
      }
    }

    sortEntries(index)
    return index
  }

  private addEntry(index: NameIndex, seen: Set<string>, name: string, id: string, fixed: boolean) {
    const ids = index.ids.get(name)
    if (!ids) index.ids.set(name, [id])
    else if (!ids.includes(id)) ids.push(id)

    const key = `${name}\u0000${id}`
    if (seen.has(key)) return
    seen.add(key)
    index.entries.push({ name, id, fixed })
  }

  private convertText(
    text: string,
    state: { budget: MentionBudget; index: NameIndex; allowAll: boolean },
    session?: Session,
  ): h[] {
    const out: h[] = []
    let buffer = ''
    const flush = () => {
      if (!buffer) return
      out.push(h.text(buffer))
      buffer = ''
    }
    const push = (element: h | null) => {
      if (element == null) return
      if (state.budget.count >= this.config.maxPerMessage) {
        // 超限：@ 元素直接丢弃（绝不把 <at id> 回显成文本）；其它元素退化为文本
        if (element.type !== 'at') buffer += element.toString(true)
        return
      }
      state.budget.count++
      flush()
      out.push(element)
    }

    let i = 0
    while (i < text.length) {
      // ① 显式 <at ... />（只认自闭合）
      if (text[i] === '<' && /^<at[\s/>]/i.test(text.slice(i, i + 4))) {
        AT_TAG.lastIndex = 0
        const matched = AT_TAG.exec(text.slice(i))
        if (matched) {
          const parsed = this.parseTag(matched[1], state, session)
          push(parsed.element)
          if (parsed.text) buffer += parsed.text
          i += matched[0].length
          continue
        }
      }

      // ② @ 开头的几种形态
      if (text[i] === '@' && state.budget.count < this.config.maxPerMessage) {
        if (state.allowAll && text.startsWith('@全体成员', i)) {
          push(h('at', { type: 'all' }))
          i += 5
          continue
        }

        const digits = DIGITS.exec(text.slice(i + 1))?.[0]
        if (digits && this.config.allowRawId) {
          push(h('at', { id: digits }))
          i += 1 + digits.length
          continue
        }

        const hit = this.resolveName(text, i + 1, state.index)
        if (hit && !(this.config.skipSelf && hit.id === session?.selfId)) {
          push(h('at', { id: hit.id, name: hit.name }))
          i += 1 + hit.name.length
          continue
        }
      }

      buffer += text[i]
      i++
    }
    flush()
    return out
  }

  /** 最长前缀命中 + 重名策略；fixed 条目优先（同名时 fixed 的 id 排第一） */
  private resolveName(
    text: string,
    from: number,
    index: NameIndex,
  ): { name: string; id: string } | null {
    for (const entry of index.entries) {
      if (!text.startsWith(entry.name, from)) continue
      const ids = index.ids.get(entry.name) ?? []
      // 重名且配置为 skip：不转，避免 @ 错人（同名冒充场景）
      if (!entry.fixed && ids.length > 1 && this.config.ambiguous === 'skip') return null
      return { name: entry.name, id: entry.fixed ? entry.id : (ids[0] ?? entry.id) }
    }
    return null
  }

  /**
   * 解析显式 <at ... />：
   * - element=null 且无 text：整段吞掉（非法 id，绝不回显数字）
   * - element=null 且有 text：转不成但名字不敏感（<at name="…">），保留文字
   */
  private parseTag(
    inner: string,
    state: { budget: MentionBudget; index: NameIndex; allowAll: boolean },
    session?: Session,
  ): { element: h | null; text?: string } {
    const attrs: Record<string, string> = {}
    let matched: RegExpExecArray | null
    ATTR.lastIndex = 0
    while ((matched = ATTR.exec(inner))) attrs[matched[1]] = matched[2]

    if (attrs.type === 'all') {
      return { element: state.allowAll ? h('at', { type: 'all' }) : null }
    }

    if (attrs.id) {
      const id = String(attrs.id).trim()
      if (this.config.skipSelf && id === session?.selfId) return { element: null }

      const known = state.index.known
      if (this.config.validateExplicitId && known.size > 0 && !known.has(id)) {
        // 不在本群：不 @、也不把数字写出来（避免泄露 QQ 号）
        this.logger.debug(`丢弃不在本群的 <at id="${id}"/>`)
        return { element: null }
      }
      return { element: h('at', { id, ...(attrs.name ? { name: attrs.name } : {}) }) }
    }

    if (attrs.name) {
      const name = normalizeName(attrs.name)
      const hit = this.resolveName(name, 0, state.index)
      if (hit && !(this.config.skipSelf && hit.id === session?.selfId)) {
        return { element: h('at', { id: hit.id, name: hit.name }) }
      }
      return { element: null, text: `@${name}` }
    }

    return { element: null }
  }
}