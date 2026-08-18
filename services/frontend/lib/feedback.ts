import { toast } from "@/components/ui/toast"

export function feedbackMessage(caught: unknown, fallback: string) {
  return caught instanceof Error && caught.message ? caught.message : fallback
}

export function notifySuccess(title: string, description?: string) {
  toast.add({
    title,
    description,
    type: "success",
  })
}

export function notifyError(title: string, caught: unknown, fallback: string) {
  const description = feedbackMessage(caught, fallback)
  toast.add({
    title,
    description,
    type: "error",
  })
  return description
}
