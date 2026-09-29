---
name: User Prompt Privacy
description: Flags captured user prompts and conversation excerpts in versioned files
intelligence: low
---

Review added artifact content, fixtures, reports and documentation for copied user
requests or conversation evidence. If the change contains only application logic,
schema declarations or prompt templates with no captured content, PASS immediately.

## Flag

- Real user prompt text, conversation transcripts, request previews or verbatim
  excerpts copied into a versioned fixture, report, notebook, HTML export or log.
- Production-derived examples described as sanitized when only names or identifiers
  were replaced and the original user request is still present.
- A generated report writer that embeds user text into a Git-tracked report.

Confirm provenance from the change and its producer or test before flagging.
For a finding, identify the path and field without repeating the private content
in the review comment or replacement. Recommend an authored fixture or a
content-free summary, and keep captured files ignored.

## Do Not Flag

- Authored synthetic test messages, application system prompts and prompt templates.
- Documented public benchmark task statements or public issue descriptions.
- Aggregate measurements and high-level summaries without copied user content.
- Prompt field names, hashes and schema definitions alone.
- Ignored local datasets merely referenced by source code; this check concerns
  Git publication, not application storage or training authorization.

## Severity

- **Error**: Captured user content in a versioned file or a writer that puts it there.
