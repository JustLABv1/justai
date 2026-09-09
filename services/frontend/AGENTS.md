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
