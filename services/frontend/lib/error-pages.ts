import { APIError } from "./api.ts"

export type ErrorPageKind = "not-found" | "client" | "server" | "unreachable"

/** Maps an HTTP status (0 means "no response at all") to the page that explains it. */
export function errorPageKind(status: number): ErrorPageKind {
  if (status === 404 || status === 410) return "not-found"
  if (status === 0 || status === 502 || status === 503 || status === 504)
    return "unreachable"
  if (status >= 500) return "server"
  return "client"
}

/** Classifies anything a component might catch. Unknown errors count as server faults. */
export function errorPageKindFor(error: unknown): ErrorPageKind {
  if (error instanceof APIError) return errorPageKind(error.status)
  if (
    error instanceof TypeError &&
    /fetch|network|load failed/i.test(error.message)
  )
    return "unreachable"
  return "server"
}

export function errorStatusFor(error: unknown): number | null {
  return error instanceof APIError ? error.status : null
}
