const conversationalGreetings = [
  "Welcome back, {name}",
  "What shall we work on, {name}?",
  "What’s on your mind, {name}?",
  "Ready for your next idea, {name}?",
] as const

let pageGreeting: string | undefined

/** Keep one greeting for this page load, including when a new chat mounts. */
export function getWelcomeGreeting() {
  if (pageGreeting) return pageGreeting
  const hour = new Date().getHours()
  const timedGreeting =
    hour >= 5 && hour < 12
      ? "Good morning, {name}"
      : hour >= 12 && hour < 18
        ? "Good afternoon, {name}"
        : "Good evening, {name}"
  const choices: string[] = [...conversationalGreetings, timedGreeting]
  let previous: string | null = null
  try {
    previous = sessionStorage.getItem("justai.welcome-greeting")
  } catch {
    /* Storage may be unavailable. */
  }
  const available = choices.filter((choice) => choice !== previous)
  pageGreeting = available[Math.floor(Math.random() * available.length)]
  try {
    sessionStorage.setItem("justai.welcome-greeting", pageGreeting)
  } catch {
    /* The greeting still works without storage. */
  }
  return pageGreeting
}

export const subscribeToWelcomeGreeting = () => () => {}
export const getServerWelcomeGreeting = () => "Hello, {name}"
