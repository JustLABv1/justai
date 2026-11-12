export type ParsedJSON = { ok: true; value: unknown } | { ok: false }

const maxJSONChars = 500_000

export function parseJSON(text: string): ParsedJSON {
  if (text.length > maxJSONChars) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

/** RFC 4180 style parser: quoted fields, escaped quotes, newlines in quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
    } else if (char === '"' && field === "") {
      quoted = true
    } else if (char === delimiter) {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += char
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.length > 1 || cells[0]?.trim() !== "")
}

/** `tsv` uses tabs; CSV falls back to `;` when the header has no comma. */
export function detectDelimiter(language: string, text: string): string {
  if (language === "tsv") return "\t"
  const header = text.split(/\r?\n/, 1)[0] ?? ""
  if (!header.includes(",") && header.includes(";")) return ";"
  return ","
}
