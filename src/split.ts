import { h } from 'koishi'
import type { RenderOptions } from 'koishi-plugin-chatluna'

export type SplitMode = NonNullable<RenderOptions['split']>

const PARAGRAPH_BREAK = /\n\n+/

/**
 * 句末标点。与 ChatLuna 内置 TextRenderer 的 splitText 保持同样的语义：
 * 段落永远切；句读模式在句末标点处切，并避开括号 / 引号内部。
 */
const END_PUNCT = new Set(['。', '！', '？', '!', '?', '…', '；', ';'])

/** 可以跟随在句末标点后的收尾字符 */
const CLOSERS = new Set([
  '”',
  '’',
  '"',
  '』',
  '」',
  '】',
  '）',
  ')',
  '》',
  '〉',
  '〕',
  '}',
  ']',
])

const OPENERS = new Map<string, string>([
  ['“', '”'],
  ['‘', '’'],
  ['（', '）'],
  ['(', ')'],
  ['【', '】'],
  ['[', ']'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['〈', '〉'],
  ['〔', '〕'],
  ['{', '}'],
])

/** 这些缩写里的英文句点不算句末 */
const DOT_WORDS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'fig',
  'no',
  'vol',
  'inc',
  'ltd',
  'co',
  'corp',
  'e.g',
  'i.e',
])

export function splitText(text: string, mode: SplitMode): string[] {
  if (!text) return []
  if (mode === 'none') return [text]
  if (mode === 'paragraph') {
    return text
      .split(PARAGRAPH_BREAK)
      .map((part) => part.trim())
      .filter(Boolean)
  }
  return splitSentences(text)
}

function splitSentences(text: string): string[] {
  const result: string[] = []
  const stack: string[] = []
  let start = 0
  let asciiQuote = false

  const push = (end: number) => {
    const chunk = text.slice(start, end).trim()
    if (chunk) result.push(chunk)
    start = end
  }

  const endsSentenceBefore = (index: number) => {
    for (let i = index - 1; i >= 0; i--) {
      const char = text[i]
      if (char === ' ' || char === '\t' || char === '\n') continue
      return END_PUNCT.has(char) || char === '.'
    }
    return false
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    // 段落边界始终视为切点（即使句读模式）
    if (char === '\n' && text[i + 1] === '\n') {
      if (stack.length === 0 && !asciiQuote) {
        push(i)
        let next = i
        while (next < text.length && text[next] === '\n') next++
        start = next
        i = next - 1
      }
      continue
    }

    if (char === '"') {
      asciiQuote = !asciiQuote
      continue
    }

    const closer = stack[stack.length - 1]
    if (closer != null && char === closer) {
      stack.pop()
      if (stack.length === 0 && !asciiQuote && endsSentenceBefore(i)) {
        let end = i + 1
        while (end < text.length && CLOSERS.has(text[end])) end++
        push(end)
        i = end - 1
      }
      continue
    }

    if (OPENERS.has(char)) {
      stack.push(OPENERS.get(char)!)
      continue
    }

    if (asciiQuote) continue

    if (END_PUNCT.has(char) && stack.length === 0) {
      let end = i + 1
      while (end < text.length && (END_PUNCT.has(text[end]) || CLOSERS.has(text[end]))) {
        end++
      }
      push(end)
      i = end - 1
      continue
    }

    // 英文句点：只有后面是空白 / 结尾时才考虑，且跳过常见缩写
    if (char === '.' && stack.length === 0) {
      const next = text[i + 1]
      if (next != null && !/\s/.test(next)) continue
      const word =
        text
          .slice(0, i)
          .match(/[A-Za-z.]+$/)?.[0]
          .toLowerCase() ?? ''
      if (
        DOT_WORDS.has(word) ||
        /^(?:[a-z]\.)+[a-z]$/i.test(word) ||
        /^[a-z]$/i.test(word)
      ) {
        continue
      }
      push(i + 1)
    }
  }

  push(text.length)
  return result
}

/**
 * 把渲染后的元素按分段模式分组：一个分组 = 一条对外消息。
 *
 * - paragraph：块级元素（`p`）各成一组，组内保留 strong / em 等行内结构；
 * - punctuation：文本节点按句读切分，每句一组；
 * - none：原样返回一整组（保持旧的单条行为）。
 */
export function groupElements(
  elements: h[],
  mode: SplitMode,
): h[][] {
  if (mode === 'none') return [elements]

  const groups: h[][] = []
  let current: h[] = []

  const flush = () => {
    if (!current.length) return
    groups.push(current)
    current = []
  }

  const visit = (element: h) => {
    if (element.type === 'text') {
      const content = String(element.attrs?.content ?? '')
      if (!content) return

      if (mode === 'paragraph') {
        const pieces = content
          .split(PARAGRAPH_BREAK)
          .map((part) => part.trim())
          .filter(Boolean)
        for (let i = 0; i < pieces.length; i++) {
          current.push(h.text(pieces[i]))
          if (i < pieces.length - 1) flush()
        }
        return
      }

      for (const sentence of splitSentences(content)) {
        current.push(h.text(sentence))
        flush()
      }
      return
    }

    if (element.type === 'br') {
      flush()
      return
    }

    if (element.type === 'p') {
      flush()
      for (const child of element.children ?? []) visit(child)
      flush()
      return
    }

    // 图片 / 代码块 / 行内样式等保持原子性，不拆
    current.push(element)
  }

  for (const element of elements) visit(element)
  flush()

  return groups.length ? groups : [elements]
}