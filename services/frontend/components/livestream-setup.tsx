"use client"

/**
 * Livestream setup: choosing the stream (relay source or own link), deciding when and
 * what to capture (now, a Bundestag sitting, or an own window) and editing a schedule.
 * The schedule is one value object so the wizard and the "add stream" dialog share it.
 */
import { useEffect, useState } from "react"
import {
  CalendarDays,
  ChevronDown,
  Clock,
  Landmark,
  Link2,
  Radio,
  Zap,
} from "lucide-react"

import {
  BundestagTopicPicker,
  type CaptureScope,
} from "@/components/bundestag-topic-picker"
import { useTranslations } from "@/components/locale-provider"
import { PlanSummary } from "@/components/plan-summary"
import { Button } from "@/components/panelui/button"
import { ChoiceCards } from "@/components/panelui/choice-cards"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/panelui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/panelui/field"
import { Frame } from "@/components/panelui/frame"
import { Input } from "@/components/panelui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import { Spinner } from "@/components/panelui/spinner"
import { Switch } from "@/components/panelui/switch"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Calendar } from "@/components/ui/calendar"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { api } from "@/lib/api"
import type { StreamPlanSession, TranscriptionSource } from "@/lib/types"
import { cn } from "@/lib/utils"

type Translate = ReturnType<typeof useTranslations>["t"]

// ---------------------------------------------------------------------------
// Local date-time values ("YYYY-MM-DDTHH:MM" in the browser's time zone)
// ---------------------------------------------------------------------------

export function localDateTimeValue(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}

export function parseLocalDateTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute] = match
  const result = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute)
  )
  return Number.isNaN(result.getTime()) ? null : result
}

export function formatScheduleDateTime(value: string, emptyLabel: string) {
  const date = parseLocalDateTime(value)
  if (!date) return emptyLabel
  return `${String(date.getDate()).padStart(2, "0")}.${String(
    date.getMonth() + 1
  ).padStart(2, "0")}.${date.getFullYear()} · ${String(
    date.getHours()
  ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function updateLocalDateTime(
  value: string,
  update: Partial<{ date: Date; hour: number; minute: number }>
) {
  const current = parseLocalDateTime(value) ?? new Date()
  const date = update.date ?? current
  return localDateTimeValue(
    new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      update.hour ?? current.getHours(),
      update.minute ?? current.getMinutes()
    )
  )
}

const pad = (value: number) => String(value).padStart(2, "0")

/** "Di., 24.11. 09:45" — always 24 hours in German, the date only when it is not today. */
function formatMoment(date: Date, locale: string) {
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
  if (date.toDateString() === new Date().toDateString()) return time
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  }).format(date)
  return `${day} ${time}`
}

// ---------------------------------------------------------------------------
// Compact date + time picker
// ---------------------------------------------------------------------------

/** HH:MM typed in 24-hour form; commits on blur or Enter. Re-key it to resync. */
function TimeInput({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (hour: number, minute: number) => void
}) {
  const [draft, setDraft] = useState(value)
  const commit = () => {
    const match = /^(\d{1,2})[:.]?(\d{2})$/.exec(draft.trim())
    if (match && Number(match[1]) < 24 && Number(match[2]) < 60) {
      setDraft(`${pad(Number(match[1]))}:${match[2]}`)
      onCommit(Number(match[1]), Number(match[2]))
    } else {
      setDraft(value)
    }
  }
  return (
    <Input
      aria-label={label}
      className="w-20 text-center tabular-nums"
      inputMode="numeric"
      maxLength={5}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          commit()
        }
      }}
      placeholder="HH:MM"
      value={draft}
    />
  )
}

export function DateTimeField({
  label,
  value,
  minimum,
  optional = false,
  onChange,
}: {
  label: string
  value: string
  minimum?: string
  optional?: boolean
  onChange: (value: string) => void
}) {
  const { t, locale } = useTranslations()
  const selected = parseLocalDateTime(value)
  const minimumDate = minimum ? parseLocalDateTime(minimum) : null
  const minimumDay = minimumDate
    ? new Date(
        minimumDate.getFullYear(),
        minimumDate.getMonth(),
        minimumDate.getDate()
      )
    : undefined
  const time = selected
    ? `${pad(selected.getHours())}:${pad(selected.getMinutes())}`
    : ""
  return (
    <Field>
      <FieldLabel>
        {label}
        {optional ? (
          <span className="font-normal text-muted-foreground">
            {" "}
            {t("(optional)")}
          </span>
        ) : null}
      </FieldLabel>
      <div className="flex gap-2">
        <Popover>
          <PopoverTrigger
            render={
              <Button
                aria-label={t("{value0}: select date", { value0: label })}
                className="min-w-0 flex-1 justify-start"
                variant="outline"
              >
                <CalendarDays data-icon="inline-start" />
                <span className="truncate">
                  {selected
                    ? new Intl.DateTimeFormat(locale, {
                        weekday: "short",
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                      }).format(selected)
                    : t("Select date")}
                </span>
              </Button>
            }
          />
          <PopoverContent align="start" className="w-auto p-0">
            <Calendar
              disabled={minimumDay ? { before: minimumDay } : undefined}
              mode="single"
              onSelect={(date) => {
                if (date) onChange(updateLocalDateTime(value, { date }))
              }}
              selected={selected ?? undefined}
            />
          </PopoverContent>
        </Popover>
        <TimeInput
          key={time}
          label={t("{value0}: time (HH:MM)", { value0: label })}
          onCommit={(hour, minute) =>
            onChange(updateLocalDateTime(value, { hour, minute }))
          }
          value={time}
        />
      </div>
    </Field>
  )
}

function TimeZoneHint() {
  const { t } = useTranslations()
  const timeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "Browser time zone"
  return (
    <p className="text-xs leading-4 text-muted-foreground">
      {t("Times in your browser time zone ({value0}), 24-hour format.", {
        value0: timeZone,
      })}
    </p>
  )
}

// ---------------------------------------------------------------------------
// The schedule value
// ---------------------------------------------------------------------------

export type StartMode = "at_time" | "when_live"
export type StreamWhen = "now" | "sitting" | "custom"

export type StreamSchedule = {
  when: StreamWhen
  start: string
  end: string
  startMode: StartMode
  /** Minutes without speech before a live capture ends; "0" = only at the end of the window. */
  silenceStop: string
  planKey: string
  planFollow: boolean
  captureScope: CaptureScope
  topicKeys: string[]
}

export const initialStreamSchedule: StreamSchedule = {
  when: "now",
  start: "",
  end: "",
  startMode: "at_time",
  silenceStop: "0",
  planKey: "",
  planFollow: true,
  captureScope: "all",
  topicKeys: [],
}

export const silenceStopOptions = ["0", "10", "20", "30", "60", "120"]

/** The sitting number of a Bundestag plan key such as "bundestag-sitzung-110". */
export function sittingNumber(planKey: string) {
  const match = /^bundestag-sitzung-(\d+)$/.exec(planKey)
  return match ? Number(match[1]) : 0
}

/** Sessions the chosen source cannot capture: their channel is not on the relay. */
export function planSessionUnavailable(session: StreamPlanSession) {
  return session.channelAvailable === false
}

export function formatPlanSession(
  session: StreamPlanSession,
  locale: string,
  t?: Translate
) {
  const start = new Date(session.startAt)
  const end = new Date(session.endAt)
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  }).format(start)
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  })
  const label = `${session.title} · ${day} ${time.format(start)}–${time.format(end)}`
  if (!t || !session.channel) return label
  return `${label} · ${t("Channel {value0}", { value0: session.channel })}`
}

/** Watch a sitting from shortly before its announced start until well after its end. */
function withSitting(
  schedule: StreamSchedule,
  session: StreamPlanSession
): StreamSchedule {
  // A sitting that has already begun is watched from now on.
  const from = Math.max(Date.now(), new Date(session.windowStartAt).getTime())
  return {
    ...schedule,
    when: "sitting",
    planKey: session.key,
    planFollow: true,
    startMode: "when_live",
    start: localDateTimeValue(new Date(from)),
    end: localDateTimeValue(new Date(session.windowEndAt)),
    silenceStop: schedule.silenceStop === "0" ? "30" : schedule.silenceStop,
    captureScope: "all",
    topicKeys: [],
  }
}

export function chooseStreamWhen(
  schedule: StreamSchedule,
  when: StreamWhen,
  plan: StreamPlanSession[]
): StreamSchedule {
  if (when === "sitting") {
    const current = plan.find((session) => session.key === schedule.planKey)
    const next =
      current ?? plan.find((session) => !planSessionUnavailable(session))
    return next ? withSitting(schedule, next) : { ...schedule, when }
  }
  if (when === "custom")
    return {
      ...schedule,
      when,
      planKey: "",
      captureScope: "all",
      topicKeys: [],
      startMode: "at_time",
      silenceStop: "0",
      start: localDateTimeValue(new Date(Date.now() + 15 * 60_000)),
      end: "",
    }
  return { ...schedule, when }
}

export function chooseSitting(
  schedule: StreamSchedule,
  key: string,
  plan: StreamPlanSession[]
) {
  const session = plan.find((item) => item.key === key)
  return session ? withSitting(schedule, session) : schedule
}

/** Recording only selected Bundestag topics: the backend derives the whole schedule. */
export function streamTopicsOnly(schedule: StreamSchedule) {
  return (
    schedule.when === "sitting" &&
    sittingNumber(schedule.planKey) > 0 &&
    schedule.captureScope === "topics"
  )
}

/** Why the schedule cannot be used yet, or "" when it is complete. */
export function streamScheduleProblem(
  schedule: StreamSchedule,
  plan: StreamPlanSession[],
  t: Translate
) {
  if (schedule.when === "now") return ""
  if (schedule.when === "sitting") {
    const session = plan.find((item) => item.key === schedule.planKey)
    if (!session) return t("Choose a sitting.")
    if (planSessionUnavailable(session))
      return t(
        "This sitting is broadcast on channel {value0}, which the stream relay does not provide. Add the relay source bundestag-hk{value0} or choose another sitting.",
        { value0: session.channel ?? 0 }
      )
    if (streamTopicsOnly(schedule))
      return schedule.topicKeys.length ? "" : t("Choose at least one topic.")
  }
  return scheduleTimesProblem(
    schedule.startMode,
    schedule.start,
    schedule.end,
    t
  )
}

function scheduleTimesProblem(
  mode: StartMode,
  start: string,
  end: string,
  t: Translate
) {
  if (!start) return t("Choose a start time.")
  if (mode === "when_live" && !end)
    return t(
      "A watch window needs an end time. Choose when JustAI should stop watching for the broadcast."
    )
  if (end && new Date(end) <= new Date(start))
    return t("The end time must be after the start time.")
  return ""
}

/** The schedule fields of the stream-source request. */
export function streamSchedulePayload(schedule: StreamSchedule) {
  if (schedule.when === "now") return {}
  const sitting = sittingNumber(schedule.planKey)
  if (streamTopicsOnly(schedule))
    return {
      captureScope: "topics",
      topicKeys: schedule.topicKeys,
      topicsSessionNo: sitting,
    }
  const silenceSeconds = Number(schedule.silenceStop) * 60
  const live = schedule.startMode === "when_live"
  const followPlan = schedule.when === "sitting" && live && schedule.planFollow
  return {
    scheduledStartAt: schedule.start
      ? new Date(schedule.start).toISOString()
      : undefined,
    scheduledEndAt: schedule.end
      ? new Date(schedule.end).toISOString()
      : undefined,
    startMode: schedule.startMode,
    silenceStopSeconds: live && silenceSeconds > 0 ? silenceSeconds : undefined,
    planFollow: followPlan ? true : undefined,
    // The chosen sitting also tells JustAI which broadcast channel to capture.
    planKey:
      schedule.when === "sitting" && schedule.planKey
        ? schedule.planKey
        : undefined,
    topicsSessionNo:
      schedule.when === "sitting" && sitting ? sitting : undefined,
  }
}

/** One or two sentences that say what JustAI is going to do. */
export function describeStreamSchedule(
  schedule: StreamSchedule,
  plan: StreamPlanSession[],
  t: Translate,
  locale: string
) {
  if (schedule.when === "now") return t("Capture starts right away.")
  if (streamTopicsOnly(schedule))
    return t(
      schedule.topicKeys.length === 1
        ? "Only the selected topic of sitting {value1}: JustAI starts shortly before it and ends after it."
        : "Only the {value0} selected topics of sitting {value1}: JustAI starts shortly before the first one, pauses in between and ends after the last.",
      {
        value0: schedule.topicKeys.length,
        value1: sittingNumber(schedule.planKey),
      }
    )
  const start = parseLocalDateTime(schedule.start)
  const end = parseLocalDateTime(schedule.end)
  if (!start) return ""
  const parts: string[] = []
  if (schedule.startMode === "when_live") {
    parts.push(
      t(
        "JustAI watches from {value0} to {value1} and starts as soon as someone speaks.",
        {
          value0: formatMoment(start, locale),
          value1: !end
            ? "…"
            : end.toDateString() === start.toDateString()
              ? new Intl.DateTimeFormat(locale, {
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(end)
              : formatMoment(end, locale),
        }
      )
    )
    if (schedule.when === "sitting") {
      if (schedule.planFollow) parts.push(t("Schedule changes are followed."))
    }
    parts.push(
      schedule.silenceStop === "0"
        ? t("Capture ends when the window closes.")
        : t("Capture ends after {value0} minutes without speech.", {
            value0: schedule.silenceStop,
          })
    )
  } else {
    parts.push(
      t("Capture starts at {value0}.", { value0: formatMoment(start, locale) })
    )
    parts.push(
      end
        ? t("It ends at {value0}.", { value0: formatMoment(end, locale) })
        : t("It ends when the stream ends.")
    )
  }
  return parts.join(" ")
}

// ---------------------------------------------------------------------------
// Which stream
// ---------------------------------------------------------------------------

export type RelaySource = {
  id: string
  name: string
  url: string
  relay: string
  status: "live" | "idle" | "offline"
}

/** Relay IDs ("bundestag") make poor names: capitalise them at least. */
export function relaySourceDisplayName(source: RelaySource) {
  return source.name === source.id
    ? source.name.charAt(0).toUpperCase() + source.name.slice(1)
    : source.name
}

/**
 * The configured relays' sources as cards, plus "Own link". Without relays only the
 * link field is shown. Relay tokens never reach the browser.
 */
export function StreamSourcePicker({
  url,
  onURLChange,
  onRelayPick,
}: {
  url: string
  onURLChange: (url: string) => void
  onRelayPick: (source: RelaySource) => void
}) {
  const { t } = useTranslations()
  const [relays, setRelays] = useState<{
    sources: RelaySource[]
    unavailable: string[]
    failed?: boolean
  } | null>(null)
  const [ownLink, setOwnLink] = useState(false)
  useEffect(() => {
    let cancelled = false
    void api
      .get<{
        enabled: boolean
        sources: RelaySource[]
        unavailable: string[]
      }>("/api/v1/transcription/stream-relay/sources")
      .then((result) => {
        if (!cancelled)
          setRelays(
            result.enabled
              ? {
                  sources: result.sources,
                  unavailable: result.unavailable ?? [],
                }
              : { sources: [], unavailable: [] }
          )
      })
      .catch(() => {
        if (!cancelled)
          setRelays({ sources: [], unavailable: [], failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const sources = relays?.sources ?? []
  const picked = sources.find((source) => source.url === url.trim())
  const showLink = sources.length === 0 || ownLink || (!picked && Boolean(url))
  const multipleRelays = new Set(sources.map((source) => source.relay)).size > 1
  const statusLabel = (status: RelaySource["status"]) =>
    status === "live"
      ? t("Live")
      : status === "idle"
        ? t("Starts on demand")
        : t("Offline")

  const linkField = (
    <Field>
      <FieldLabel>{t("Livestream link")}</FieldLabel>
      <Input
        autoFocus={sources.length > 0}
        id="stream-source-url"
        onChange={(event) => onURLChange(event.target.value)}
        placeholder="https://www.bundestag.de/mediathek/live"
        type="url"
        value={picked ? "" : url}
      />
      <FieldDescription>
        {t(
          "A livestream webpage or a direct audio/video link. It is stored encrypted."
        )}
      </FieldDescription>
    </Field>
  )

  if (!relays)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {t("Loading stream sources…")}
      </p>
    )
  if (sources.length === 0)
    return (
      <div className="flex flex-col gap-2">
        {linkField}
        {relays.failed ? (
          <p className="text-xs leading-4 text-muted-foreground">
            {t("The stream relay sources could not be loaded.")}
          </p>
        ) : null}
      </div>
    )

  return (
    <div className="flex flex-col gap-4">
      <ChoiceCards
        aria-label={t("Stream source")}
        aspect="16 / 5"
        columns={2}
        onValueChange={(value) => {
          if (value === "own-link") {
            setOwnLink(true)
            if (picked) onURLChange("")
            return
          }
          const source = sources.find(
            (item) => `${item.relay}/${item.id}` === value
          )
          if (!source) return
          setOwnLink(false)
          onRelayPick(source)
        }}
        value={
          picked ? `${picked.relay}/${picked.id}` : showLink ? "own-link" : ""
        }
      >
        {sources.map((source) => (
          <ChoiceCards.Item
            key={`${source.relay}/${source.id}`}
            value={`${source.relay}/${source.id}`}
          >
            <ChoiceCards.Media>
              <Radio aria-hidden="true" className="size-6" />
            </ChoiceCards.Media>
            <ChoiceCards.Label>
              {multipleRelays
                ? `${relaySourceDisplayName(source)} · ${source.relay}`
                : relaySourceDisplayName(source)}
            </ChoiceCards.Label>
            <ChoiceCards.Description>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    "inline-block size-2 rounded-full",
                    source.status === "live"
                      ? "bg-emerald-500"
                      : source.status === "idle"
                        ? "bg-amber-500"
                        : "bg-muted-foreground/50"
                  )}
                />
                {t("Stream relay")} · {statusLabel(source.status)}
              </span>
            </ChoiceCards.Description>
          </ChoiceCards.Item>
        ))}
        <ChoiceCards.Item value="own-link">
          <ChoiceCards.Media>
            <Link2 aria-hidden="true" className="size-6" />
          </ChoiceCards.Media>
          <ChoiceCards.Label>{t("Own link")}</ChoiceCards.Label>
          <ChoiceCards.Description>
            {t("A webpage or direct stream")}
          </ChoiceCards.Description>
        </ChoiceCards.Item>
      </ChoiceCards>
      {relays.unavailable.length > 0 ? (
        <p className="text-xs leading-4 text-destructive" role="status">
          {t("Some relays could not be reached: {value0}", {
            value0: relays.unavailable.join(", "),
          })}
        </p>
      ) : null}
      {showLink ? linkField : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// When & what
// ---------------------------------------------------------------------------

function StartModeButtons({
  mode,
  onChange,
}: {
  mode: StartMode
  onChange: (mode: StartMode) => void
}) {
  const { t } = useTranslations()
  return (
    <Field>
      <FieldLabel>{t("Start")}</FieldLabel>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => onChange("at_time")}
          size="sm"
          type="button"
          variant={mode === "at_time" ? "default" : "outline"}
        >
          {t("At the exact time")}
        </Button>
        <Button
          onClick={() => onChange("when_live")}
          size="sm"
          type="button"
          variant={mode === "when_live" ? "default" : "outline"}
        >
          {t("When the stream goes live")}
        </Button>
      </div>
      <FieldDescription>
        {mode === "when_live"
          ? t(
              "JustAI listens from the start of the window and begins capturing as soon as it hears speech. Music and silence are ignored."
            )
          : t(
              "Capture starts at exactly this time, even if the broadcaster changed its plan."
            )}
      </FieldDescription>
    </Field>
  )
}

function SilenceStopSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (minutes: string) => void
}) {
  const { t } = useTranslations()
  const options = silenceStopOptions.includes(value)
    ? silenceStopOptions
    : [...silenceStopOptions, value]
  const label = (minutes: string | null) =>
    !minutes || minutes === "0"
      ? t("Only at the end of the window")
      : t("After {value0} minutes without speech", { value0: minutes })
  return (
    <Field>
      <FieldLabel>{t("Stop after silence")}</FieldLabel>
      <Select onValueChange={(next) => onChange(next ?? "0")} value={value}>
        <SelectTrigger className="w-full sm:w-72">
          <SelectValue>
            {(current: string | null) => label(current)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((minutes) => (
              <SelectItem key={minutes} value={minutes}>
                {label(minutes)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription>
        {t(
          "Ends the capture when the programme returns to music or silence. Shorter breaks keep it running."
        )}
      </FieldDescription>
    </Field>
  )
}

function WindowFields({
  mode,
  start,
  end,
  onStartChange,
  onEndChange,
  startLocked = false,
}: {
  mode: StartMode
  start: string
  end: string
  onStartChange: (value: string) => void
  onEndChange: (value: string) => void
  startLocked?: boolean
}) {
  const { t } = useTranslations()
  const live = mode === "when_live"
  const now = localDateTimeValue(new Date())
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {startLocked ? (
        <Field>
          <FieldLabel>{t("Watching since")}</FieldLabel>
          <p className="text-sm text-muted-foreground">
            {formatScheduleDateTime(start, t("Select date and time"))}
          </p>
        </Field>
      ) : (
        <DateTimeField
          label={live ? t("Watch from") : t("Start time")}
          minimum={now}
          onChange={onStartChange}
          value={start}
        />
      )}
      <DateTimeField
        label={live ? t("Watch until") : t("End time")}
        minimum={start || now}
        onChange={onEndChange}
        optional={!live}
        value={end}
      />
    </div>
  )
}

function FollowPlanRow({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const { t } = useTranslations()
  return (
    <Frame>
      <Frame.Panel>
        <Frame.Row>
          <Frame.Content>
            <Frame.Title as="p">{t("Follow schedule changes")}</Frame.Title>
            <Frame.Description>
              {t(
                "JustAI re-checks the published plan and moves the window if the sitting is rescheduled."
              )}
            </Frame.Description>
          </Frame.Content>
          <Frame.Actions>
            <Switch
              aria-label={t("Follow schedule changes")}
              checked={checked}
              onCheckedChange={onChange}
            />
          </Frame.Actions>
        </Frame.Row>
      </Frame.Panel>
    </Frame>
  )
}

/** Now, a published Bundestag sitting, or an own window — and for a sitting, what of it. */
export function StreamWhenFields({
  schedule,
  onChange,
  plan,
  planLoading = false,
}: {
  schedule: StreamSchedule
  onChange: (schedule: StreamSchedule) => void
  plan: StreamPlanSession[]
  planLoading?: boolean
}) {
  const { t, locale } = useTranslations()
  const patch = (update: Partial<StreamSchedule>) =>
    onChange({ ...schedule, ...update })
  const hasPlan = plan.length > 0
  const sitting = sittingNumber(schedule.planKey)
  const topicsOnly = streamTopicsOnly(schedule)
  const problem = streamScheduleProblem(schedule, plan, t)
  const summary = problem
    ? ""
    : describeStreamSchedule(schedule, plan, t, locale)
  const options: Array<{
    value: StreamWhen
    icon: typeof Zap
    label: string
    description: string
  }> = [
    {
      value: "now",
      icon: Zap,
      label: t("Start now"),
      description: t("Capture begins when you start the session."),
    },
    ...(hasPlan || schedule.when === "sitting"
      ? [
          {
            value: "sitting" as const,
            icon: Landmark,
            label: t("Bundestag sitting"),
            description: t("Follows the published plan, whole or by topic."),
          },
        ]
      : []),
    {
      value: "custom",
      icon: Clock,
      label: t("Own time window"),
      description: t("A fixed time, or watch for the broadcast."),
    },
  ]

  return (
    <div className="flex flex-col gap-5">
      <ChoiceCards
        aria-label={t("When should JustAI capture?")}
        aspect="16 / 5"
        columns={options.length}
        onValueChange={(value) =>
          onChange(chooseStreamWhen(schedule, value as StreamWhen, plan))
        }
        value={schedule.when}
      >
        {options.map((option) => {
          const Icon = option.icon
          return (
            <ChoiceCards.Item key={option.value} value={option.value}>
              <ChoiceCards.Media>
                <Icon aria-hidden="true" className="size-6" />
              </ChoiceCards.Media>
              <ChoiceCards.Label>{option.label}</ChoiceCards.Label>
              <ChoiceCards.Description>
                {option.description}
              </ChoiceCards.Description>
            </ChoiceCards.Item>
          )
        })}
      </ChoiceCards>
      {!hasPlan && planLoading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner /> {t("Checking for a published session plan…")}
        </p>
      ) : null}

      {schedule.when === "sitting" ? (
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel>{t("Sitting")}</FieldLabel>
            <Select
              onValueChange={(value) =>
                onChange(chooseSitting(schedule, value ?? "", plan))
              }
              value={schedule.planKey || null}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("Choose a sitting")}>
                  {(value: string | null) => {
                    const session = plan.find((item) => item.key === value)
                    return session
                      ? formatPlanSession(session, locale, t)
                      : t("Choose a sitting")
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {plan.map((session) => (
                    <SelectItem
                      disabled={planSessionUnavailable(session)}
                      key={session.key}
                      value={session.key}
                    >
                      {formatPlanSession(session, locale, t)}
                      {planSessionUnavailable(session)
                        ? ` · ${t("not on this relay")}`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {sitting > 0 ? (
            <Field>
              <FieldLabel>{t("What should be captured?")}</FieldLabel>
              <BundestagTopicPicker
                onScopeChange={(captureScope) =>
                  patch({ captureScope, topicKeys: [] })
                }
                onSelectedChange={(topicKeys) => patch({ topicKeys })}
                scope={schedule.captureScope}
                selected={schedule.topicKeys}
                sittingNo={sitting}
              />
            </Field>
          ) : null}
          {summary && !topicsOnly ? <PlanSummary>{summary}</PlanSummary> : null}
          {topicsOnly ? null : (
            <Collapsible>
              <CollapsibleTrigger className="group/adjust flex w-fit items-center gap-1.5 rounded-lg py-1 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                {t("Adjust")}
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 transition-transform group-data-[panel-open]/adjust:rotate-180"
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="flex flex-col gap-4 pt-3">
                  <WindowFields
                    end={schedule.end}
                    mode="when_live"
                    onEndChange={(end) => patch({ end })}
                    onStartChange={(start) => patch({ start })}
                    start={schedule.start}
                  />
                  <SilenceStopSelect
                    onChange={(silenceStop) => patch({ silenceStop })}
                    value={schedule.silenceStop}
                  />
                  <FollowPlanRow
                    checked={schedule.planFollow}
                    onChange={(planFollow) => patch({ planFollow })}
                  />
                  <TimeZoneHint />
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      ) : null}

      {schedule.when === "custom" ? (
        <div className="flex flex-col gap-4">
          <StartModeButtons
            mode={schedule.startMode}
            onChange={(startMode) =>
              patch({
                startMode,
                silenceStop:
                  startMode === "when_live" && schedule.silenceStop === "0"
                    ? "30"
                    : schedule.silenceStop,
              })
            }
          />
          <WindowFields
            end={schedule.end}
            mode={schedule.startMode}
            onEndChange={(end) => patch({ end })}
            onStartChange={(start) => patch({ start })}
            start={schedule.start}
          />
          {schedule.startMode === "when_live" ? (
            <SilenceStopSelect
              onChange={(silenceStop) => patch({ silenceStop })}
              value={schedule.silenceStop}
            />
          ) : null}
          <TimeZoneHint />
          {summary ? <PlanSummary>{summary}</PlanSummary> : null}
        </div>
      ) : null}

      {problem && schedule.when !== "now" ? (
        <p className="text-sm leading-5 text-destructive" role="alert">
          {problem}
        </p>
      ) : null}
      {schedule.when !== "now" ? (
        <p className="text-xs leading-4 text-muted-foreground">
          {t(
            "If nothing is heard you get a warning on the session. Disconnects are retried for 15 minutes; the eight-hour session limit is the final safeguard."
          )}
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Editing a schedule that has not started yet
// ---------------------------------------------------------------------------

export function StreamScheduleEditDialog({
  source,
  onClose,
  onSaved,
}: {
  source: TranscriptionSource | null
  onClose: () => void
  onSaved: (id: string, patch: Partial<TranscriptionSource>) => void
}) {
  return (
    <Dialog
      open={Boolean(source)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {source ? (
        <StreamScheduleEditForm
          key={source.id}
          onClose={onClose}
          onSaved={onSaved}
          source={source}
        />
      ) : null}
    </Dialog>
  )
}

function StreamScheduleEditForm({
  source,
  onClose,
  onSaved,
}: {
  source: TranscriptionSource
  onClose: () => void
  onSaved: (id: string, patch: Partial<TranscriptionSource>) => void
}) {
  const { t } = useTranslations()
  const [start, setStart] = useState(() =>
    source.scheduledStartAt
      ? localDateTimeValue(new Date(source.scheduledStartAt))
      : ""
  )
  const [end, setEnd] = useState(() =>
    source.scheduledEndAt
      ? localDateTimeValue(new Date(source.scheduledEndAt))
      : ""
  )
  const [mode, setMode] = useState<StartMode>(
    source.startMode === "when_live" ? "when_live" : "at_time"
  )
  const [silenceStop, setSilenceStop] = useState(
    String(Math.round((source.silenceStopSeconds ?? 0) / 60))
  )
  const [follow, setFollow] = useState(Boolean(source.planFollow))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const watching = source.transportStatus === "watching"
  const live = mode === "when_live"
  const problem = scheduleTimesProblem(mode, start, end, t)

  const save = async () => {
    if (problem || saving) return
    setSaving(true)
    setError("")
    try {
      const silenceSeconds = live ? Number(silenceStop) * 60 : 0
      const keepPlan = live && follow && source.planKey
      await api.patch(
        `/api/v1/transcription/stream-sources/${source.id}/schedule`,
        {
          scheduledStartAt: new Date(start).toISOString(),
          scheduledEndAt: end ? new Date(end).toISOString() : undefined,
          startMode: mode,
          silenceStopSeconds: silenceSeconds > 0 ? silenceSeconds : undefined,
          planFollow: keepPlan ? true : undefined,
          planKey: keepPlan ? source.planKey : undefined,
        }
      )
      onSaved(source.id, {
        scheduledStartAt: new Date(start).toISOString(),
        scheduledEndAt: end ? new Date(end).toISOString() : null,
        startMode: mode,
        silenceStopSeconds: silenceSeconds,
        planFollow: Boolean(keepPlan),
        planKey: keepPlan ? source.planKey : "",
        alert: "",
      })
      onClose()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The schedule could not be changed."
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t("Edit schedule")}</DialogTitle>
        <DialogDescription>
          {watching
            ? t(
                "JustAI is already watching for the broadcast. You can still change when it stops looking."
              )
            : t(
                "Use this when the broadcaster changed its plan. Nothing is lost; the capture simply follows the new times."
              )}
        </DialogDescription>
      </DialogHeader>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{t("Live transcription needs attention")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <DialogBody>
        <div className="flex flex-col gap-5">
          {watching ? null : (
            <StartModeButtons mode={mode} onChange={setMode} />
          )}
          <WindowFields
            end={end}
            mode={mode}
            onEndChange={setEnd}
            onStartChange={setStart}
            start={start}
            startLocked={watching}
          />
          {live ? (
            <SilenceStopSelect onChange={setSilenceStop} value={silenceStop} />
          ) : null}
          {live && source.planKey ? (
            <FollowPlanRow checked={follow} onChange={setFollow} />
          ) : null}
          <TimeZoneHint />
          {problem ? (
            <p className="text-sm leading-5 text-destructive" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose} variant="outline">
          {t("Cancel")}
        </Button>
        <Button
          disabled={Boolean(problem) || saving}
          onClick={() => void save()}
        >
          {saving ? <Spinner /> : null}
          {t("Save schedule")}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
