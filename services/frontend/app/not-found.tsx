import { ErrorScreen } from "@/components/error-screen"

export default function NotFound() {
  return <ErrorScreen kind="not-found" status={404} fullScreen />
}
