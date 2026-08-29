"use client"

import { useEffect, useMemo, useState } from "react"
import { Bot, CalendarClock, Clock3, Play, Plus, ShieldCheck, Trash2 } from "lucide-react"

import { api } from "@/lib/api"
import type { Automation, AutomationRun, MCPServer, SavedAssistant } from "@/lib/types"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

type Props = { automations: Automation[]; assistants: SavedAssistant[]; servers: MCPServer[]; onChange: (items: Automation[]) => void }
type Form = { name: string; prompt: string; assistantId: string; schedule: string; approvalMode: "review" | "read_only_auto"; timezone: string; mcpServerIds: string[] }
const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
const timezoneSuggestions = [detectedTimezone, "UTC", "Europe/Berlin", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"]

const emptyForm: Form = { name: "", prompt: "", assistantId: "", schedule: "Every Monday at 09:00", approvalMode: "review", timezone: detectedTimezone, mcpServerIds: [] }

export function AutomationsView({ automations, assistants, servers, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Form>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [runs, setRuns] = useState<Record<string, AutomationRun[]>>({})
  const timezoneSelectValue = timezoneSuggestions.includes(form.timezone) ? form.timezone : "__custom__"
  const availableServers = useMemo(() => servers.filter((server) => server.enabled && server.credentialConfigured), [servers])

  async function save() {
    setSaving(true); setError("")
    try {
      const result = await api.post<{ automation: Automation }>("/api/v1/automations", form)
      onChange([result.automation, ...automations]); setOpen(false); setForm(emptyForm)
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Automation could not be saved.") } finally { setSaving(false) }
  }
  async function toggle(item: Automation, enabled: boolean) {
    const result = await api.patch<{ automation: Automation }>(`/api/v1/automations/${item.id}`, { enabled })
    onChange(automations.map((automation) => automation.id === item.id ? result.automation : automation))
  }
  async function remove(item: Automation) { await api.delete(`/api/v1/automations/${item.id}`); onChange(automations.filter((automation) => automation.id !== item.id)) }
  async function run(item: Automation) {
    const result = await api.post<{ run: AutomationRun }>(`/api/v1/automations/${item.id}/runs`)
    setRuns((current) => ({ ...current, [item.id]: [result.run, ...(current[item.id] ?? [])] }))
  }
  async function loadRuns(item: Automation) {
    if (runs[item.id]) return
    const result = await api.get<{ runs: AutomationRun[] }>(`/api/v1/automations/${item.id}/runs`)
    setRuns((current) => ({ ...current, [item.id]: result.runs }))
  }
  function toggleServer(id: string) { setForm((current) => ({ ...current, mcpServerIds: current.mcpServerIds.includes(id) ? current.mcpServerIds.filter((value) => value !== id) : [...current.mcpServerIds, id] })) }

  return <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
    <header className="flex flex-wrap items-end justify-between gap-4"><div><div className="mb-2 flex items-center gap-2 text-primary"><CalendarClock className="size-4" /><span className="text-sm font-medium">Automations</span></div><h1 className="text-2xl font-semibold tracking-tight">Give assistants recurring work.</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Schedule a focused task, choose the assistant and restrict exactly which integrations it may use.</p></div><Button onClick={() => { setError(""); setOpen(true) }}><Plus className="mr-2 size-4" />New automation</Button></header>
    <Alert className="border-primary/20 bg-primary/[0.03]"><ShieldCheck className="size-4" /><AlertDescription>Integration writes always require review. Only explicitly trusted read-only connections can run without a confirmation.</AlertDescription></Alert>
    {automations.length === 0 ? <Card className="border-dashed"><CardContent className="flex min-h-64 flex-col items-center justify-center text-center"><div className="rounded-full bg-muted p-3"><CalendarClock className="size-5 text-muted-foreground" /></div><h2 className="mt-4 font-medium">Nothing scheduled yet</h2><p className="mt-1 max-w-sm text-sm text-muted-foreground">Create a recurring research brief, issue triage or follow-up – with a small, intentional MCP scope.</p><Button className="mt-5" variant="outline" onClick={() => setOpen(true)}>Create your first automation</Button></CardContent></Card> : <div className="grid gap-4 md:grid-cols-2">{automations.map((item) => { const assistant = assistants.find((entry) => entry.id === item.assistantId); const selectedServers = servers.filter((server) => item.mcpServerIds.includes(server.id)); const itemRuns = runs[item.id]; return <Card key={item.id} className="flex min-h-72 flex-col"><CardHeader className="pb-3"><div className="flex items-start justify-between gap-3"><div><CardTitle className="text-base">{item.name}</CardTitle><CardDescription className="mt-1 line-clamp-2">{item.prompt}</CardDescription></div><Switch checked={item.enabled} onCheckedChange={(checked) => void toggle(item, checked)} aria-label={`Enable ${item.name}`} /></div></CardHeader><CardContent className="flex flex-1 flex-col gap-4 text-sm"><div className="flex items-center gap-2 text-muted-foreground"><Clock3 className="size-4" />{item.schedule}</div><div className="flex items-center gap-2 text-muted-foreground"><Bot className="size-4" />{assistant?.name ?? "Default assistant"}</div><div className="flex flex-wrap gap-1.5">{selectedServers.length ? selectedServers.map((server) => <Badge key={server.id} variant="secondary">{server.name}</Badge>) : <span className="text-xs text-muted-foreground">No integrations selected</span>}</div>{itemRuns && <div className="border-t pt-3">{itemRuns.slice(0, 2).map((entry) => <p className="mb-1 text-xs text-muted-foreground" key={entry.id}><span className="font-medium text-foreground">{entry.status === "needs_review" ? "Review needed" : entry.status === "queued" ? "Queued" : entry.status}</span> · {entry.summary}</p>)}</div>}</CardContent><CardFooter className="justify-between border-t pt-4"><button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => void loadRuns(item)}>Run history</button><div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => void remove(item)} aria-label={`Delete ${item.name}`}><Trash2 className="size-4" /></Button><Button size="sm" onClick={() => void run(item)}><Play className="mr-1.5 size-3.5" />Run now</Button></div></CardFooter></Card> })}</div>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>New automation</DialogTitle><DialogDescription>Keep the task narrow. Scheduled work only sees the integrations you select here.</DialogDescription></DialogHeader><FieldGroup><Field><FieldLabel htmlFor="automation-name">Name</FieldLabel><Input id="automation-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Weekly issue triage" /></Field><Field><FieldLabel htmlFor="automation-task">Task</FieldLabel><Textarea id="automation-task" value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} placeholder="Review new issues, identify duplicates and prepare a concise summary." rows={4} /></Field><div className="grid gap-4 sm:grid-cols-2"><ScheduleBuilder value={form.schedule} onChange={(schedule) => setForm({ ...form, schedule })} /><Field><FieldLabel>Assistant</FieldLabel><Select value={form.assistantId || "default"} onValueChange={(value) => setForm({ ...form, assistantId: value === "default" ? "" : value ?? "" })}><SelectTrigger><SelectValue placeholder="Default assistant" /></SelectTrigger><SelectContent><SelectItem value="default">Default assistant</SelectItem>{assistants.map((assistant) => <SelectItem key={assistant.id} value={assistant.id}>{assistant.name}</SelectItem>)}</SelectContent></Select></Field><Field><FieldLabel>Timezone</FieldLabel><Select value={timezoneSelectValue} onValueChange={(value) => setForm({ ...form, timezone: value === "__custom__" ? "" : value ?? detectedTimezone })}><SelectTrigger className="w-full"><SelectValue>{timezoneSelectValue === "__custom__" ? "Custom timezone" : form.timezone}</SelectValue></SelectTrigger><SelectContent>{[...new Set(timezoneSuggestions)].map((timezone) => <SelectItem key={timezone} value={timezone}>{timezone}{timezone === detectedTimezone ? " (local)" : ""}</SelectItem>)}<SelectItem value="__custom__">Custom timezone…</SelectItem></SelectContent></Select>{timezoneSelectValue === "__custom__" && <Input className="mt-2" value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} placeholder="e.g. Australia/Sydney" aria-label="Custom timezone" />}<FieldDescription>All scheduled runs use this timezone.</FieldDescription></Field></div><Field><FieldLabel>Connected integrations</FieldLabel><FieldDescription>Only connected servers are available. Select the minimum access this task needs.</FieldDescription><div className="mt-2 grid gap-2 sm:grid-cols-2">{availableServers.length ? availableServers.map((server) => <label className="flex cursor-pointer items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2.5 text-sm transition-colors hover:bg-muted/45 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/[0.06]" key={server.id}><input className="size-4 accent-primary" type="checkbox" checked={form.mcpServerIds.includes(server.id)} onChange={() => toggleServer(server.id)} /><span>{server.name}</span><span className="ml-auto text-xs text-muted-foreground">{server.trustedReadOnly ? "Read-only" : "Review required"}</span></label>) : <p className="text-sm text-muted-foreground">Connect GitHub, GitLab or another MCP server first.</p>}</div></Field><Field><FieldLabel>Execution safeguard</FieldLabel><Select value={form.approvalMode} onValueChange={(value) => setForm({ ...form, approvalMode: value as Form["approvalMode"] })}><SelectTrigger><SelectValue>{form.approvalMode === "review" ? "Review before integration actions" : "Auto-run read-only integrations"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="review">Review before integration actions</SelectItem><SelectItem value="read_only_auto">Auto-run read-only integrations</SelectItem></SelectContent></Select></Field>{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}</FieldGroup><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={saving || !form.name.trim() || !form.prompt.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Create automation"}</Button></DialogFooter></DialogContent></Dialog>
  </div>
}

type ScheduleBuilderProps = {
  value: string
  onChange: (schedule: string) => void
}

function ScheduleBuilder({ value, onChange }: ScheduleBuilderProps) {
  const [unit, setUnit] = useState<"days" | "weeks" | "months">("weeks")
  const [interval, setInterval] = useState("1")
  const [weekday, setWeekday] = useState("Monday")
  const [time, setTime] = useState("09:00")

  const schedule =
    unit === "weeks"
      ? `Every ${interval} ${unit} on ${weekday} at ${time}`
      : `Every ${interval} ${unit} at ${time}`

  useEffect(() => {
    if (value !== schedule) onChange(schedule)
  }, [onChange, schedule, value])

  return (
    <Field className="sm:col-span-2 rounded-lg border bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <FieldLabel>Schedule</FieldLabel>
        <span className="text-xs text-muted-foreground">{schedule}</span>
      </div>
      <div className="grid grid-cols-[auto_80px_minmax(0,1fr)] gap-2">
        <span className="flex h-7 items-center text-xs font-medium text-muted-foreground">
          Repeat every
        </span>
        <Input
          aria-label="Repeat interval"
          min="1"
          max="365"
          onChange={(event) =>
            setInterval(event.target.value.replace(/[^0-9]/g, "") || "1")
          }
          type="number"
          value={interval}
        />
        <Select
          value={unit}
          onValueChange={(next) =>
            setUnit((next ?? "weeks") as "days" | "weeks" | "months")
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue>{unit}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="days">days</SelectItem>
            <SelectItem value="weeks">weeks</SelectItem>
            <SelectItem value="months">months</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {unit === "weeks" ? (
          <Select value={weekday} onValueChange={(next) => setWeekday(next ?? "Monday")}>
            <SelectTrigger className="w-full"><SelectValue>{weekday}</SelectValue></SelectTrigger>
            <SelectContent>
              {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => (
                <SelectItem key={day} value={day}>{day}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex h-7 items-center text-xs text-muted-foreground">
            {unit === "months" ? "on the first day" : "starting today"}
          </div>
        )}
        <Input aria-label="Run time" onChange={(event) => setTime(event.target.value)} type="time" value={time} />
      </div>
    </Field>
  )
}
