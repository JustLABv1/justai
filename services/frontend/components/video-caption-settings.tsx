"use client"

import { useEffect } from "react"
import type { Endpoint } from "@/lib/types"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

export type VideoCaptionOptions = {
  endpointId: string
  model: string
  frameBudget: number
  autoApply: boolean
}
function storageKey() {
  return `justai.video.caption-settings:${localStorage.getItem("justai.organizationId") || "default"}`
}

export function VideoCaptionSettings({
  endpoints,
  enabled,
  value,
  onChange,
}: {
  endpoints: Endpoint[]
  enabled: boolean
  value: VideoCaptionOptions | null
  onChange: (value: VideoCaptionOptions | null) => void
}) {
  const choices = endpoints.filter(
    (endpoint) =>
      endpoint.enabled &&
      (endpoint.capabilities.vision || endpoint.capabilities.multimodal)
  )
  useEffect(() => {
    let cancelled = false
    // Settings are browser preferences; endpoint access is revalidated by the API.
    Promise.resolve().then(() => {
      if (cancelled) return
      try {
        const saved = JSON.parse(
          localStorage.getItem(storageKey()) || "null"
        ) as VideoCaptionOptions | null
        if (
          saved &&
          typeof saved.endpointId === "string" &&
          typeof saved.model === "string" &&
          [12, 24, 48].includes(saved.frameBudget) &&
          typeof saved.autoApply === "boolean"
        )
          onChange(saved)
      } catch {
        /* Storage can be unavailable. */
      }
    })
    return () => {
      cancelled = true
    }
  }, [onChange])
  const update = (next: VideoCaptionOptions | null) => {
    onChange(next)
    try {
      localStorage.setItem(storageKey(), JSON.stringify(next))
    } catch {
      /* Optional preference persistence. */
    }
  }
  const endpoint = choices.find((endpoint) => endpoint.id === value?.endpointId)
  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <div className="flex flex-1 flex-col gap-1">
          <FieldLabel htmlFor="video-caption-enabled">
            Names from video captions
          </FieldLabel>
          <FieldDescription>
            Read printed names after speaker separation. This selection is
            remembered for future uploads.
          </FieldDescription>
        </div>
        <Switch
          id="video-caption-enabled"
          checked={enabled && Boolean(value)}
          disabled={!enabled || !choices.length}
          onCheckedChange={(checked) =>
            update(
              checked
                ? {
                    endpointId: choices[0]?.id ?? "",
                    model: "",
                    frameBudget: 24,
                    autoApply: true,
                  }
                : null
            )
          }
        />
      </Field>
      {!enabled && (
        <FieldDescription>
          Enable speaker separation to match names to voices.
        </FieldDescription>
      )}
      {enabled && !choices.length && (
        <FieldDescription>
          Configure an enabled vision endpoint to use this step.
        </FieldDescription>
      )}
      {enabled && value && (
        <>
          <Field>
            <FieldLabel htmlFor="video-caption-endpoint">
              Name caption endpoint
            </FieldLabel>
            <Select
              value={value.endpointId}
              onValueChange={(id) =>
                update({ ...value, endpointId: id ?? "", model: "" })
              }
              items={choices.map((item) => ({
                value: item.id,
                label: item.name,
              }))}
            >
              <SelectTrigger id="video-caption-endpoint" className="w-full">
                <SelectValue placeholder="Select a vision endpoint" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {choices.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="video-caption-model">
              Name caption model
            </FieldLabel>
            <Input
              id="video-caption-model"
              value={value.model}
              onChange={(event) =>
                update({ ...value, model: event.target.value })
              }
              maxLength={200}
              placeholder={
                endpoint?.visionModel ||
                endpoint?.chatModel ||
                "Enter a vision model"
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="video-caption-budget">
              Maximum caption images
            </FieldLabel>
            <Select
              value={String(value.frameBudget)}
              onValueChange={(budget) =>
                update({ ...value, frameBudget: Number(budget ?? 24) })
              }
              items={[12, 24, 48].map((n) => ({
                value: String(n),
                label: `${n} images`,
              }))}
            >
              <SelectTrigger id="video-caption-budget" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {[12, 24, 48].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} images
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              A fixed budget, including for long videos. Selected lower-third
              images are sent to this endpoint.
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-1">
              <FieldLabel htmlFor="video-caption-apply">
                Apply consistent names automatically
              </FieldLabel>
              <FieldDescription>
                Requires three matching images across two speech turns. Other
                matches remain suggestions.
              </FieldDescription>
            </div>
            <Switch
              id="video-caption-apply"
              checked={value.autoApply}
              onCheckedChange={(autoApply) => update({ ...value, autoApply })}
            />
          </Field>
        </>
      )}
    </FieldGroup>
  )
}
