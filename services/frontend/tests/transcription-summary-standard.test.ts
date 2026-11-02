import assert from "node:assert/strict"
import test from "node:test"
import { summaryParagraphs } from "../lib/transcription-summary-standard.ts"

test("summary contributions use the same boundaries as server exports", () => {
  assert.deepEqual(
    summaryParagraphs(
      "\r\n Anna speaks.\r\n Continues her point.\r\n \r\nBen replies.\r\n\r\n"
    ),
    ["Anna speaks. Continues her point.", "Ben replies."]
  )
  assert.deepEqual(summaryParagraphs(" \n\n "), [])
})

test("time range filters accept the timestamps users see in the transcript", async () => {
  const { summaryTimeOffset } =
    await import("../lib/transcription-summary-standard.ts")
  assert.equal(summaryTimeOffset("2:30"), 150000)
  assert.equal(summaryTimeOffset("1:02:03"), 3723000)
  assert.equal(summaryTimeOffset(""), undefined)
  assert.equal(summaryTimeOffset("2:90"), null)
  assert.equal(summaryTimeOffset("invalid"), null)
})

test("team rules update independently from personal download preferences and session overrides", async () => {
  const { resolveSummaryTemplateDefaults, defaultSummaryStandard } =
    await import("../lib/transcription-summary-standard.ts")
  const template = {
    ...defaultSummaryStandard,
    id: "team-template",
    name: "Plenary",
    instructions: "Focus on political arguments",
    exclusionRules: "Updated shared rule",
    updatedAt: "2026-11-02T00:00:00Z",
    canEdit: true,
  }
  const personal = {
    ...defaultSummaryStandard,
    format: "docx",
    chapters: false,
  }
  assert.equal(
    resolveSummaryTemplateDefaults([template], template.id, personal).template
      ?.id,
    template.id
  )
  const defaults = resolveSummaryTemplateDefaults(
    [template],
    template.id,
    personal,
    {
      templateId: template.id,
      instructions: "Old shared instructions",
      exclusionRules: "Old shared rule",
    }
  )
  assert.equal(defaults.exclusionRules, template.exclusionRules)
  assert.equal(defaults.instructions, template.instructions)
  assert.equal(defaults.exportPreferences.format, "docx")
  assert.equal(defaults.exportPreferences.chapters, false)
  const overridden = resolveSummaryTemplateDefaults(
    [template],
    template.id,
    personal,
    {
      templateId: template.id,
      instructions: "Only this session",
      exclusionRules: "Only this rule",
      instructionsOverridden: true,
      rulesOverridden: true,
    }
  )
  assert.equal(overridden.instructions, "Only this session")
  assert.equal(overridden.exclusionRules, "Only this rule")
  const without = resolveSummaryTemplateDefaults(
    [template],
    template.id,
    personal,
    {
      templateId: "",
      instructions: "Custom session",
      exclusionRules: "Custom rule",
    }
  )
  assert.equal(without.template, undefined)
  assert.equal(without.exclusionRules, "Custom rule")
  assert.equal(template.exclusionRules, "Updated shared rule")
})
