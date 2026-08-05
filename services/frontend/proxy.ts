import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  const isPublicTranscriptionJoin =
    pathname === "/transcription/join" || pathname.startsWith("/transcription/join/")

  if (isPublicTranscriptionJoin) {
    return NextResponse.next()
  }

  if (request.cookies.has("justai_session")) {
    return NextResponse.next()
  }

  const loginURL = new URL("/login", request.url)
  loginURL.searchParams.set(
    "next",
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  )
  return NextResponse.redirect(loginURL)
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
    "/prototypes/:path*",
  ],
}
