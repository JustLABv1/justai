import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { createElement, type ComponentType } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ts from "typescript"
import type { Locale } from "../lib/i18n/locale.ts"

// The project's Node test runner strips TypeScript but cannot load JSX directly.
// Transpile this client boundary in memory, using the real React server renderer.
const require = createRequire(import.meta.url)
const providerSource = readFileSync(
  new URL("../components/locale-provider.tsx", import.meta.url),
  "utf8"
)
const compiled = ts.transpileModule(providerSource, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const providerModule = { exports: {} }
const localRequire = (specifier: string) => {
  if (specifier === "@/lib/i18n/locale") return require("../lib/i18n/locale.ts")
  if (specifier === "@/lib/i18n/translate")
    return require("../lib/i18n/translate.ts")
  return require(specifier)
}
new Function("require", "module", "exports", compiled)(
  localRequire,
  providerModule,
  providerModule.exports
)
const { LocaleProvider, useTranslations, useTranslatedConfig } =
  providerModule.exports as {
    LocaleProvider: ComponentType<{
      initialLocale: Locale
      children?: React.ReactNode
    }>
    useTranslations: () => { locale: Locale; t: (message: string) => string }
    useTranslatedConfig: <T>(messages: T) => T
  }

const navigation = [{ id: "sources", label: "Sources" }]
function Surface() {
  const { locale, t } = useTranslations()
  const items = useTranslatedConfig(navigation)
  return createElement(
    "section",
    { lang: locale },
    createElement(
      "button",
      { "aria-label": t("Choose language") },
      t("New chat")
    ),
    createElement("nav", null, items[0].label)
  )
}

for (const locale of ["de", "en"] as const) {
  test(`server rendering starts in ${locale} with matching text and accessible labels`, () => {
    const markup = renderToStaticMarkup(
      createElement(LocaleProvider, { initialLocale: locale }, createElement(Surface))
    )
    assert.equal(
      markup,
      locale === "de"
        ? '<section lang="de"><button aria-label="Sprache wählen">Neuer Chat</button><nav>Quellen</nav></section>'
        : '<section lang="en"><button aria-label="Choose language">New chat</button><nav>Sources</nav></section>'
    )
  })
}
