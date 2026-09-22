# Reusable document templates

Open **Templates** in the sidebar. Upload an original file once, name it and
optionally describe required inputs, cell locations and business rules. Templates
are private to their owner within the current workspace. They are available across
conversations without reuploading. Edit instructions or replace the original from
the same screen. Downloading the original never changes it.

In a chat with a tool-capable model or native agent, ask e.g.:

> Use my Travel expenses template with these receipts. Ask me for missing details.

The assistant can list templates, read one with its revision and complete target
map, read full attachment text in ordered pages, and fill a new downloadable copy.
No search snippets are used to read the template itself. Existing custom agent
instructions can refer to a template by name for reuse in later conversations.
A native workflow without a conversation can use templates and its selected source
context; conversation attachment tools are available only when a conversation is
associated with the run. Remote A2A services do not automatically gain these local
tools: use a native coordinator and explicitly pass the needed input.

## Formats and behavior

| Input | Behavior |
| --- | --- |
| DOCX / DOTX | Edit paragraph targets, including headers and table cells; replace `{{field}}` placeholders even across runs; repeat a table row with supplied values. |
| XLSX / XLTX | Edit cells, resolve shared strings, add new cell addresses, retain existing formulas and styling of existing cells. Numbers stay numeric. Formula recalculation is requested when opened in a spreadsheet app; the server does not calculate formulas. |
| PPTX / POTX | Edit slide text and table rows; retain other package assets. |
| ODT / OTT / ODS / OTS / ODP / OTP | Edit text paragraphs and table rows. Paragraph replacement can flatten inline styling. Spreadsheet cell values are synchronized for numeric edits. |
| PDF with AcroForm fields | Fill field names from the inspected field map, preserving the PDF. |
| PDF without form fields | Reference text only. The assistant can create a new PDF, but cannot claim it filled the original layout. Scan-only PDFs need readable text/OCR outside this feature. |
| TXT / MD / CSV / HTML / JSON / XML | Replace placeholders or the `document` target; validate JSON/XML output. |

Legacy binary DOC/XLS/PPT and RTF must first be converted to a modern Office format.
Encrypted PDFs, macros/ActiveX, arbitrary scripting and formula replacement are not
supported. Replacement content is treated as data. Original Office archive entries
are retained unless their document content is edited; exact rendering still depends
on the consuming Office application and installed fonts.

A table row replacement takes the inspected `tableRows` ID and an array of rows,
where every row has the same number of columns as the original. For spreadsheets,
write an explicit cell map rather than inserting rows: this avoids silently changing
formula references. For merged or repeated OpenDocument cells, prepare distinct
editable cells before use. Formatting is taken from the example row.

Missing placeholders, unknown target IDs and stale revisions produce an error
rather than an apparently complete output. Business-rule validation, receipt OCR,
tax calculations and approval processes are not provided by the template renderer.

## Runtime and limits

Migration `055_document_templates.sql` stores original bytes and the inspected
structure. Existing generated file downloads retain their user/workspace checks.
Both Docker images include Python and pinned pypdf. For a local Go server:

```sh
python3 -m venv .venv-templates
.venv-templates/bin/pip install pypdf==6.19.0
export JUSTAI_TEMPLATE_PYTHON="$PWD/.venv-templates/bin/python"
```

The processor is embedded in the Go binary and uses Python's standard library for
Office/OpenDocument ZIP/XML editing. Python runs in isolated mode and receives no
model-generated code. Limits: 8 MB original/output, 32 MB expanded archive, 2,000
archive entries, 10,000 targets, 512 KB inspection JSON, 30 seconds wall time.
Linux workers additionally have memory and CPU limits. Download links require the
original user and workspace. Replacing a template increments its revision; callers
must reread it before generating from the new version.

Tests:

```sh
python -m unittest discover -s services/backend/server/templates -v
cd services/backend && go test ./server -run 'TestTemplate|TestReadAttachment'
```
