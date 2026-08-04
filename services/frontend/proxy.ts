import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export function proxy(request: NextRequest) {
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
  matcher: ["/", "/prototypes/:path*"],
}
