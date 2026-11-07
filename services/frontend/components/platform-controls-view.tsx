"use client"
import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { Field } from "@/components/panelui/field"
import { Frame } from "@/components/panelui/frame"
import { Switch } from "@/components/panelui/switch"
import { Textarea } from "@/components/panelui/textarea"
import type { PlatformSettings } from "@/lib/types"
export type PlatformControlKey = Exclude<
  keyof PlatformSettings,
  "maintenanceMessage" | "updatedAt"
>
export function PlatformControlsView({
  settings,
  savingMaintenance,
  savingControl,
  onChange,
  onToggle,
  onSave,
}: {
  settings: PlatformSettings
  savingMaintenance: boolean
  savingControl: PlatformControlKey | null
  onChange: (settings: PlatformSettings) => void
  onToggle: (key: PlatformControlKey, value: boolean) => void
  onSave: () => void
}) {
  const { t } = useTranslations()

  const controls: Array<[PlatformControlKey, string, string]> = [
    ["loginEnabled", "Login", "Allow existing users to sign in."],
    [
      "localAuthEnabled",
      "Local password auth",
      "Allow password login and password account creation.",
    ],
    ["signupEnabled", "Signup", "Allow new password and OIDC provisioning."],
    ["aiEnabled", "AI chat", "Allow model requests and text chat."],
    [
      "agentsEnabled",
      "Agents",
      "Allow agent runs, delegation, and workflow scheduling.",
    ],
    ["voiceEnabled", "Voice", "Allow realtime voice and speech synthesis."],
    [
      "transcriptionEnabled",
      "Transcription",
      "Allow rooms, capture, and processing.",
    ],
    ["mcpEnabled", "MCP", "Allow MCP discovery, attachment, and execution."],
    [
      "knowledgeEnabled",
      "Knowledge",
      "Allow source upload, indexing, and retrieval.",
    ],
    [
      "attachmentsEnabled",
      "Attachments",
      "Allow file, URL, and text attachments.",
    ],
  ]
  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-muted-foreground">
        {t(
          "Feature changes are saved automatically and apply across the platform."
        )}
      </p>
      {[
        {
          title: "Access & registration",
          description: "Control how people sign in and create accounts.",
          keys: ["loginEnabled", "localAuthEnabled", "signupEnabled"],
        },
        {
          title: "AI & processing",
          description: "Choose which AI and processing features are available.",
          keys: [
            "aiEnabled",
            "agentsEnabled",
            "voiceEnabled",
            "transcriptionEnabled",
          ],
        },
        {
          title: "Tools & content",
          description:
            "Control access to integrations, knowledge, and attachments.",
          keys: ["mcpEnabled", "knowledgeEnabled", "attachmentsEnabled"],
        },
      ].map((group) => (
        <Frame key={group.title}>
          <Frame.Header>
            <Frame.Title>{t(group.title)}</Frame.Title>
            <Frame.Description>{t(group.description)}</Frame.Description>
          </Frame.Header>
          <Frame.Panel>
            {controls
              .filter(([key]) => group.keys.includes(key))
              .map(([key, label, description]) => (
                <Frame.Row key={key} className="gap-5 py-4">
                  <Frame.Content>
                    <Frame.Title as="p">
                      <label
                        className="cursor-pointer"
                        htmlFor={`platform-control-${key}`}
                      >
                        {t(label)}
                      </label>
                    </Frame.Title>
                    <Frame.Description
                      id={`platform-control-${key}-description`}
                      className="overflow-visible! text-clip! whitespace-normal!"
                    >
                      {t(description)}
                    </Frame.Description>
                  </Frame.Content>
                  <Frame.Actions>
                    <Switch
                      size="sm"
                      checked={Boolean(settings[key])}
                      disabled={savingControl !== null || savingMaintenance}
                      pending={savingControl === key}
                      id={`platform-control-${key}`}
                      aria-describedby={`platform-control-${key}-description`}
                      onCheckedChange={(checked) => onToggle(key, checked)}
                    />
                  </Frame.Actions>
                </Frame.Row>
              ))}
          </Frame.Panel>
        </Frame>
      ))}
      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Maintenance message")}</Frame.Title>
          <Frame.Description>
            {t("Shown when a feature is unavailable.")}
          </Frame.Description>
        </Frame.Header>
        <Frame.Panel className="p-4">
          <Field disabled={savingMaintenance}>
            <Field.Label>{t("Message")}</Field.Label>
            <Textarea
              minRows={3}
              maxRows={8}
              disabled={savingMaintenance}
              onChange={(event) =>
                onChange({
                  ...settings,
                  maintenanceMessage: event.target.value,
                })
              }
              placeholder={t("We’re performing maintenance…")}
              value={settings.maintenanceMessage}
            />
            <Field.Description>
              {t("Visible to anyone who hits a disabled capability.")}
            </Field.Description>
          </Field>
        </Frame.Panel>
        <Frame.Footer className="flex justify-end">
          <Button
            disabled={savingMaintenance || savingControl !== null}
            loading={savingMaintenance}
            onClick={onSave}
          >
            {t(savingMaintenance ? "Saving…" : "Save maintenance message")}
          </Button>
        </Frame.Footer>
      </Frame>
    </div>
  )
}
