"use client"

import { LogOut, ShieldCheck, UserRound } from "lucide-react"
import { useRouter } from "next/navigation"

import { api } from "@/lib/api"
import type { User } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Page,
  PageDescription,
  PageEyebrow,
  PageHeader,
  PageHeading,
  PageTitle,
} from "@/components/ui/page"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

type ProfileViewProps = {
  user: User
}

export function ProfileView({ user }: ProfileViewProps) {
  const router = useRouter()
  async function logout() {
    try {
      await api.post("/api/v1/auth/logout")
    } finally {
      api.setOrganizationId(null)
      router.push("/login")
    }
  }

  return (
    <Page className="max-w-4xl">
      <PageHeader>
        <PageHeading>
          <PageEyebrow>Account</PageEyebrow>
          <PageTitle>Profile</PageTitle>
          <PageDescription>
            Manage your JustAI identity and session.
          </PageDescription>
        </PageHeading>
      </PageHeader>

      <Card size="sm">
        <CardHeader className="flex-row items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
            <UserRound aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-base">Your account</CardTitle>
            <CardDescription className="mt-1">
              Authenticated JustAI identity.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 border-t pt-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">Display name</p>
            <p className="mt-1 font-medium">{user.displayName}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Email</p>
            <p className="mt-1 truncate font-medium">{user.email}</p>
          </div>
          <div className="flex items-center gap-2 sm:col-span-2">
            <ShieldCheck className="size-4 text-muted-foreground" />
            <Badge variant="outline">
              {user.platformAdmin
                ? "Platform administrator"
                : "Workspace member"}
            </Badge>
          </div>
          <div className="sm:col-span-2">
            <Button onClick={() => void logout()} size="sm" variant="outline">
              <LogOut data-icon="inline-start" aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </CardContent>
      </Card>
    </Page>
  )
}
