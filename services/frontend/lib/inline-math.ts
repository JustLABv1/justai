const symbols: Record<string, string> = {
  rightarrow: "→",
  leftarrow: "←",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  to: "→",
  gets: "←",
  mapsto: "↦",
  uparrow: "↑",
  downarrow: "↓",
  times: "×",
  cdot: "·",
  div: "÷",
  pm: "±",
  approx: "≈",
  neq: "≠",
  ne: "≠",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  infty: "∞",
  degree: "°",
  checkmark: "✓",
  ldots: "…",
  dots: "…",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  mu: "µ",
  pi: "π",
  Delta: "Δ",
  Omega: "Ω",
}

const symbolPattern = Object.keys(symbols).join("|")
// A `$...$` span made only of known commands and whitespace, e.g. `$\rightarrow$`.
const symbolSpan = new RegExp(
  `\\$\\s*((?:\\\\(?:${symbolPattern})(?![A-Za-z])\\s*)+)\\$`,
  "g"
)
const symbolCommand = new RegExp(`\\\\(${symbolPattern})(?![A-Za-z])`, "g")

/**
 * Chat models often emit simple LaTeX such as `$\rightarrow$`, which the
 * markdown renderer has no math support for. Convert those to Unicode, leaving
 * fenced and inline code untouched.
 */
export function replaceInlineMathSymbols(text: string): string {
  if (!text.includes("$")) return text
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(symbolSpan, (_match, body: string) =>
            body
              .replace(symbolCommand, (_m, name: string) => symbols[name])
              .replace(/\s+/g, " ")
              .trim()
          )
    )
    .join("")
}
