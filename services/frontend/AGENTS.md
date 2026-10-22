<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Frontend design defaults

Use the composer-inspired neutral surface system defined in `app/globals.css` and
`components/ui`. Build page hierarchy with background, card, muted, and popover
surfaces, spacing, and rounded corners. Cards, navigation panels, normal inputs,
and secondary buttons have no decorative outlines. Reserve borders/rings for
focus, validation, selected controls, upload progress, drag targets, and subtle
data-table separators. Use semantic theme colors; primary blue identifies actions
and active states. Keep toolbar controls compact (32px, 14px text, 16px icons).
Check both light and dark mode when introducing or changing surfaces. Preserve
readable secondary text and visible keyboard focus.

## ReUI components first

Before building any UI component, block, or layout by hand, check
[ReUI](https://reui.io) for an existing one and use it when it fits. The
`@reui` registry is configured in `components.json`:

- Browse: `https://reui.io/llms.txt`, `https://reui.io/llms-full.txt` (every
  free example and Pro block), or `npx shadcn@latest search @reui`.
- Install ReUI items with `npx shadcn@latest add @reui/<name>` (they land in
  `components/reui/`). Stock shadcn components install by bare name
  (`npx shadcn@latest add sidebar`).
- Every item page also answers as markdown at its URL plus `.md`, with
  guidance on when to use it.
- Free primitives and examples are usable directly. Pro blocks (for example
  `app-shell-*`) need a license key; without one, build the layout from the
  free parts they are made of (shadcn `Sidebar`, ReUI `Frame`, `Badge`, …)
  rather than hand-rolling a lookalike.
- Only write a custom component when ReUI and shadcn have nothing suitable,
  and keep it consistent with the surface system above.
