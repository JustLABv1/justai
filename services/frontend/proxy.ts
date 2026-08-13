import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  const isPublicTranscriptionJoin =
    pathname === "/transcription/join" ||
    pathname.startsWith("/transcription/join/")

  if (isPublicTranscriptionJoin) {
    return NextResponse.next()
  }

  // The backend is the authentication source of truth. The frontend cannot
  // safely infer validity from the presence of a cookie, especially when the
  // API is deployed on another origin. Workspace performs `/auth/me` and
  // redirects only after the backend confirms an unauthenticated session.
  return NextResponse.next()
}

export const config = {
  matcher: [
    "/",
    "/conversation/:path*",
    "/chat/:path*",
    "/transcription/:path*",
    "/endpoints/:path*",
    "/knowledge/:path*",
    "/mcp/:path*",
    "/settings/:path*",
    "/admin/:path*",
  ],
}
