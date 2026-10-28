import { Schema } from 'koishi'

/** 常见称谓后缀：名片带这些后缀时，额外登记去掉后缀的短名（`小明さん` → 也能被 `@小明` 命中） */
export const DEFAULT_HONORIFICS = [
  '主人',
  'さん',
  '酱',
  '大人',
  '君'
]

export interface Config {
  /** 单条回复最多渲染几个 @，超出的退化为纯文本 */
  maxPerMessage: number
  /** 允许 @全体成员（还需要 bot 在群里是管理员） */
  allowAll: boolean
  /** 允许把 @123456789 直接当 QQ 号 @ */
  allowRawId: boolean
  /** 不 @ bot 自己 */
  skipSelf: boolean
  /** 群成员名单缓存时间，单位秒 */
  memberCacheTtl: number
  /** 重名策略：skip=不转（默认，避免 @ 错人）/ first=取名单第一个 */
  ambiguous: 'skip' | 'first'
  /** 称谓后缀表 */
  honorifics: string[]
  /** 固定映射：基础名 → QQ 号（优先级高于成员名单，用于兜住“主人”这类要害身份） */
  fixedMentions: Record<string, string>
  /** 显式 <at id="…"/> 是否校验“这个人确实在群里” */
  validateExplicitId: boolean
}

export const Config = Schema.intersect([
  Schema.object({
    maxPerMessage: Schema.number()
      .min(1)
      .max(10)
      .step(1)
      .default(3)
      .description('单条回复最多渲染几个 @；超出的部分保持纯文本，避免连 @ 一串人。'),
    skipSelf: Schema.boolean()
      .default(true)
      .description('不 @ 机器人自己：回复里写到自己的名字时保持普通文本。'),
  }).description('基础设置'),

  Schema.object({
    memberCacheTtl: Schema.number()
      .min(0)
      .default(300)
      .description('群成员名单缓存（秒）。成员进群/退群会自动失效；0 = 每条回复都重新拉取。'),
    ambiguous: Schema.union([
      Schema.const('skip').description('skip：不转换（推荐，避免 @ 错人）'),
      Schema.const('first').description('first：取名单里的第一个人'),
    ])
      .default('skip')
      .description('同一个名字对应多个人时怎么办。'),
    honorifics: Schema.array(Schema.string())
      .default(DEFAULT_HONORIFICS)
      .description(
        '称谓后缀。名片是「小明さん」时，模型写 @小明 也能命中；命中后后缀会留在正文里（@小明 + さん）。',
      ),
    fixedMentions: Schema.dict(Schema.string())
      .default({})
      .description(
        '固定映射：基础名 → QQ 号，优先于成员名单。只填基础名（如 小明: 123456789），不要填「小明大大」这类带称谓的写法——那会把称谓一起吃掉。',
      ),
  }).description('名单与匹配'),

  Schema.object({
    allowAll: Schema.boolean()
      .default(false)
      .description('允许 @全体成员。需要机器人是群管理员，否则 QQ 侧会报错；默认关闭。'),
    allowRawId: Schema.boolean()
      .default(false)
      .description('允许把 @123456789 直接当作 QQ 号。默认关闭：开启后模型写出的数字可能 @ 到任意人。'),
    validateExplicitId: Schema.boolean()
      .default(true)
      .description(
        '校验回复里的 <at id="…"/> 是否为本群成员；不是则整段丢弃，绝不回显 QQ 号。只有在你确实需要跨群 @ 时才关闭。',
      ),
  }).description('高级（默认值即可，非必要不要改）'),
]) as unknown as Schema<Config>