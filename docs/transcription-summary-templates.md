# Team templates for transcription summaries

In **Create summary**, choose **Team template → New template**. Start with the
plenary debate, customer conversation, project meeting, or interview example,
or write a template in ordinary language. Save it for the team. The last chosen
template is remembered for the current user and organization when starting new
summaries. Each organization has a separate catalog.

A template contains the summary focus, content exclusion rules, and download
defaults. Changing the fields below the picker changes only this transcription;
editing the shared template requires an explicit **Save for team**. Any member
can create templates. Creators and organization owners/admins can edit or delete
them; other members can make a copy. Shared edits use a revision check to avoid
silently overwriting concurrent changes.

For plenary debates, the provided rules exclude purely organizational openings,
closing remarks, greetings, speaking-time announcements, and floor handovers.
They preserve substantive statements, including those of the chair. They do not
exclude a speaker or a fixed duration at the beginning or end.

Before generating the summary, the configured grammar/chat model classifies
source passages against the rules. Only validated source IDs can be omitted.
Uncertain and mixed passages should be kept. All summary sections are generated
from the same filtered source. The original transcript is preserved. Invalid
classification responses fail the generation instead of silently skipping the
rules. This is model-based classification; the omission review is available in
the summary and download views for human checking.

The review records source text, IDs, timestamps, and reasons. Restoring a passage
opens the creation dialog; creating the summary again applies the restoration.
Explicitly restored passages are protected against automatic exclusion and are
marked for inclusion during generation. Template snapshots and session overrides
are stored in the existing insights customization metadata. Later template edits
do not rewrite existing summaries. Regenerating adopts current shared rules
unless the session explicitly overrides them; restoration starts with the rules
used for that summary.

Removing a paragraph during export does not update a shared template. The separate
**Leave out similar contributions in future** action proposes a reusable rule,
opens an editable template draft, and requires explicit saving. No shared change
is made while proposing a rule. Personal export preferences remain separate from
team content rules and can override template download defaults.

Migrations `062` and `063` add the required persistence. Focused checks:

- Backend: `go test ./server -run 'TestTranscript|TestSummary' -count=1`
- Frontend: `pnpm typecheck`, targeted ESLint, and `pnpm test`

The backend tests include a simulated AI endpoint for the full classify → filter
→ summarize flow, restorations, tenant isolation, edit permissions, and audited
source text. They do not measure the semantic accuracy of a production model.
