import { h } from 'koishi'

/**
 * 把元素树压成可读字符串，供诊断命令预览。
 *
 * 例：`好的喵 [at:3691234694] 你看 [img]`
 * 只在命令回显里使用，不进入正常回复链路。
 */
export function serializeElements(elements: h[]): string {
  return elements.map(serialize).join('')
}

function serialize(el: h): string {
  if (el.type === 'text') return String(el.attrs.content ?? '')

  if (el.type === 'at') {
    if (el.attrs.type === 'all') return '[at:all]'
    const name = el.attrs.name ? `:${el.attrs.name}` : ''
    return `[at:${el.attrs.id}${name}]`
  }

  if (el.type === 'p') return el.children.map(serialize).join('')
  if (el.type === 'img' || el.type === 'image') return '[img]'
  if (el.children?.length) return el.children.map(serialize).join('')
  return `[${el.type}]`
}