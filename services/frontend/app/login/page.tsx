import { LoginForm } from "@/components/login-form"

export default function LoginPage() {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-background">
      <div className="flex min-h-0 w-full flex-1">
        <LoginForm />
      </div>
    </div>
  )
}
