---
type: "query"
date: "2026-08-20T08:35:02.297138+00:00"
question: "Take a look at both screenshots. On one I uploaded the transcript as pdf and on the other I pasted it raw. Both have different summaries where the differenze is very high. The one where I pasted the transcript in the chat is way better than the one where I uploaded the pdf"
contributor: "graphify"
outcome: "useful"
source_nodes: ["ExtractUpload()", ".ingest()", "splitChunks()", "Citation", "citationPrompt()", ".createUploadedSource()"]
---

# Q: Take a look at both screenshots. On one I uploaded the transcript as pdf and on the other I pasted it raw. Both have different summaries where the differenze is very high. The one where I pasted the transcript in the chat is way better than the one where I uploaded the pdf

## Answer

Expanded from original query via vocab: [attachment, chunk, citation, content, context, embed, extract, ingest, knowledge, parse, search, transcript]. Diagnosis: pasted transcripts are sent to the provider as the full user message, while uploaded PDFs are extracted by ExtractUpload, split into chunks, and reduced by ordinary retrieval to a small set of compact citation snippets before citationPrompt assembles the provider context. That drops later transcript decisions and action items. Fix implemented: preserve full chunk text in an in-memory PromptText field, keep Snippet compact for the UI, broaden explicitly attached document retrieval to a 24-passage window with ordered coverage, and cap the assembled grounding prompt at a safe size. Added regression coverage for full-chunk prompt grounding.

## Outcome

- Signal: useful

## Source Nodes

- ExtractUpload()
- .ingest()
- splitChunks()
- Citation
- citationPrompt()
- .createUploadedSource()