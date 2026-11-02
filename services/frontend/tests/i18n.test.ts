import assert from "node:assert/strict"
import test from "node:test"
import { de } from "../lib/i18n/de.ts"
import { isLocale, resolveLocale } from "../lib/i18n/locale.ts"
import { translate, translateMessages } from "../lib/i18n/translate.ts"

test("explicit supported language takes precedence over browser preferences", () => {
  assert.equal(resolveLocale("de", "en-US,en;q=0.9"), "de")
  assert.equal(resolveLocale("en", "de-DE"), "en")
  assert.equal(isLocale("fr"), false)
  assert.equal(isLocale(undefined), false)
})

test("browser negotiation supports regional tags, quality weights and fallback", () => {
  assert.equal(resolveLocale(null, "de-DE,de;q=0.9,en;q=0.8"), "de")
  assert.equal(resolveLocale(null, "en-US;q=0.5,de-AT;q=0.9"), "de")
  assert.equal(resolveLocale("invalid", "fr-FR,de-CH;q=0.5"), "de")
  assert.equal(resolveLocale(null, "de;q=0,en;q=0.8"), "en")
  assert.equal(resolveLocale(null, "de;q=invalid,en;q=0.5"), "en")
  assert.equal(resolveLocale(null, "de;q=2,en;q=0.5"), "en")
  assert.equal(resolveLocale(null, "EN-gb,DE;q=0.9"), "en")
  assert.equal(resolveLocale(null, "fr,ja;q=0.9"), "en")
  assert.equal(resolveLocale(), "en")
})

test("German messages translate and English source messages remain available", () => {
  assert.equal(translate("de", "New chat"), "Neuer Chat")
  assert.equal(translate("en", "New chat"), "New chat")
  assert.equal(
    translate("de", "An unknown new message"),
    "An unknown new message"
  )
  assert.equal(translate("de", "constructor"), "constructor")
  assert.equal(translate("de", "__proto__"), "__proto__")
  assert.equal(translate("de", null), "")
  assert.equal(translate("en", undefined), "")
})

test("interpolation supports reordered values without evaluating their content", () => {
  assert.equal(
    translate("de", "Continue with {name}", { name: "Company SSO" }),
    "Mit Company SSO fortfahren"
  )
  assert.equal(
    translate("en", "Continue with {name}", { name: "Company SSO" }),
    "Continue with Company SSO"
  )
  assert.equal(translate("de", "Continue with {name}"), "Mit {name} fortfahren")
  assert.equal(
    translate("de", "Continue with {name}", { name: "{other}" }),
    "Mit {other} fortfahren"
  )
  assert.equal(translate("en", "{count} items", { count: 0 }), "0 items")
})

test("every translation preserves its interpolation placeholders", () => {
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
  for (const [source, translated] of Object.entries(de)) {
    assert.ok(translated.trim(), `Empty translation: ${source}`)
    assert.deepEqual(placeholders(translated), placeholders(source), source)
  }
})

test("static UI definitions translate without mutating machine identifiers", () => {
  const definitions = [
    {
      id: "Sources",
      value: "Private",
      label: "Sources",
      description: "New chat",
      icon: () => null,
    },
  ]
  const translated = translateMessages("de", definitions)
  assert.equal(translated[0].id, "Sources")
  assert.equal(translated[0].value, "Private")
  assert.equal(translated[0].label, "Quellen")
  assert.equal(translated[0].description, "Neuer Chat")
  assert.equal(translated[0].icon, definitions[0].icon)
  assert.equal(definitions[0].label, "Sources")
})
