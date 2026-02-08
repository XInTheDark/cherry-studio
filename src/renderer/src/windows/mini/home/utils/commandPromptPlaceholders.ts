const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g

type PlaceholderToken = 'selected' | 'clipboard'

interface PlaceholderResolvers {
  selected: () => Promise<string>
  clipboard: () => Promise<string>
}

const isPlaceholderToken = (value: string): value is PlaceholderToken => value === 'selected' || value === 'clipboard'

export const resolveCommandPromptPlaceholders = async (
  template: string,
  resolvers: PlaceholderResolvers
): Promise<string> => {
  if (!template.includes('{')) return template

  const valueCache: Partial<Record<PlaceholderToken, string>> = {}
  const getValue = async (token: PlaceholderToken) => {
    if (valueCache[token] !== undefined) return valueCache[token] as string
    const value = (await resolvers[token]())?.trim() || ''
    valueCache[token] = value
    return value
  }

  const matches = Array.from(template.matchAll(PLACEHOLDER_PATTERN))
  if (matches.length === 0) return template

  let output = ''
  let cursor = 0

  for (const match of matches) {
    const start = match.index ?? 0
    output += template.slice(cursor, start)

    const expression = match[1]?.trim() || ''
    const tokens = expression.split('|').map((part) => part.trim())
    const validTokens = tokens.length > 0 && tokens.every(isPlaceholderToken)

    if (!validTokens) {
      output += match[0]
      cursor = start + match[0].length
      continue
    }

    let replacement = ''
    for (const token of tokens) {
      const value = await getValue(token)
      if (value) {
        replacement = value
        break
      }
    }

    output += replacement
    cursor = start + match[0].length
  }

  output += template.slice(cursor)
  return output
}
