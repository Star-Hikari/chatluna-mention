import { Context, h, Logger, Schema } from 'koishi'
import {
  Renderer,
  type Message,
  type RenderMessage,
  type RenderOptions,
} from 'koishi-plugin-chatluna'
import { transformMessageContentToElements } from 'koishi-plugin-chatluna/utils/string'
import { transformToMarkdown } from 'koishi-plugin-chatluna/utils/koishi'
import type { MentionBudget, MentionResolver } from './resolver'

/** 渲染器类型名：必须与 chatluna 配置里的 outputMode 一致 */
export const RENDER_TYPE = 'text-at'

/**
 * 文本渲染器 + @ 解析。
 *
 * 与内置 TextRenderer 的关系：完全复用它的两步（content → 元素、文本 → markdown），
 * 只在 text 节点上多一遍 @ 解析，所以排版行为与内置 text 一致。
 *
 * 流式：不覆写 getStreamPlan。1.4.2 运行期基类默认就是 { mode: 'buffer' }，
 * 即整条回复生成完后一次性渲染发送，@ 标记不会被切在两个 chunk 里。
 */
export class MentionRenderer extends Renderer {
  schema = Schema.const(RENDER_TYPE).i18n({
    'zh-CN': '文本渲染，并把 @昵称 / <at id> 渲染成真正的 @',
    'en-US': 'Render as text, and turn @name / <at id> into real mentions',
  }) as unknown as Schema<string, string>

  private logger: Logger

  constructor(
    ctx: Context,
    private resolver: MentionResolver,
    logger?: Logger,
  ) {
    super(ctx)
    this.logger = logger ?? ctx.logger('chatluna-mention')
  }

  async render(message: Message, options: RenderOptions): Promise<RenderMessage> {
    try {
      const elements: h[] = []
      const budget: MentionBudget = { count: 0 }

      for (const part of transformMessageContentToElements(message.content)) {
        if (part.type !== 'text') {
          // 图片 / 文件 / 音频等非文本段原样透传，绝不丢弃
          elements.push(part)
          continue
        }

        const markdown = transformToMarkdown(
          String(part.attrs.content ?? ''),
          options.session?.platform ?? 'sandbox',
        )
        elements.push(...(await this.resolver.rewrite(markdown, options.session, budget)))
      }

      return { element: elements }
    } catch (e) {
      // 纹理失败不能吞掉整条回复：降级为原始文本（不加 markdown、不解析 @）
      this.logger.warn('渲染 @ 失败，已降级为原始文本：', e)
      try {
        return { element: transformMessageContentToElements(message.content) }
      } catch {
        return { element: [h.text(String(message.content ?? ''))] }
      }
    }
  }
}