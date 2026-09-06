# JustAI frontend

The JustAI frontend is a Next.js 16 App Router application for chat, agents,
workflows, knowledge, integrations, and transcription. It talks to the Go
backend through `/api/v1`; browser code should use the helpers in `lib/api.ts`
instead of constructing backend URLs directly.

## Requirements

- Node.js 22 or newer
- pnpm
- A running JustAI backend (the development default is
  `http://localhost:8080`)

From this directory:

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000>. See the repository-level README for PostgreSQL,
backend, object-storage, and optional diarization setup.

## Important directories

- `app/` — App Router layouts and route entry points.
- `components/` — product views and shared UI composition.
- `components/ui/` — installed shadcn/Base UI primitives.
- `components/assistant-ui/` — assistant-ui message, attachment, tool, and voice
  adapters.
- `lib/api.ts` — authenticated JSON/blob request client and API error handling.
- `lib/types.ts` — frontend representations of backend resources.
- `tests/` — fast Node-based unit and contract tests.

Workspace routes are resolved centrally in `lib/workspace-routes.ts`. Preserve
legacy redirects there when renaming a product surface so saved URLs continue
to work.

## UI conventions

- Compose the existing components in `components/ui` before adding custom
  controls.
- Forms use `FieldGroup`, `Field`, `FieldLabel`, and `FieldDescription`.
- Expected request failures are rendered inline or as a toast with a recovery
  action. Do not turn failed loads into empty states.
- Destructive actions use `AlertDialog`; do not use `window.confirm`.
- Long-running work must expose pending, failure, retry, and cancellation states.
- Interactive components remain client components; route layouts/pages should
  stay server components unless browser APIs or state are required.

## Verification

Run the complete frontend gate:

```bash
pnpm check
```

Individual commands are also available:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Before merging a user-facing workflow, exercise its loading, empty, error,
success, keyboard, and narrow-viewport states. Changes to creation dialogs
should also verify focus trapping, Escape/Cancel behavior, validation, and
double-submit protection.

## Troubleshooting

- `401 Unauthorized`: sign in again and confirm the backend is reachable.
- Empty provider/model lists: verify an endpoint exists and test its connection
  in Settings.
- Uploads that remain in processing: inspect the corresponding backend job and
  worker health rather than retrying the browser request indefinitely.
- UI and API types disagree: update `lib/types.ts` with the backend response and
  add a contract test covering the changed payload.
