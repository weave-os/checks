---
name: No Checked-in Specs
description: Flags added specs directories and standalone Markdown specification files
intelligence: low
---

Review added files and changed lines for repository-local implementation specifications.
The repository keeps planning and specification artifacts in the issue tracker or another
approved external workspace; do not check them into Git as a `specs/` tree or as standalone
Markdown files elsewhere.

## Flag

- Any added file below a path component named `specs` (including non-Markdown files). A
  directory may not be made acceptable by calling it a draft, plan, design, proposal, or
  research directory.
- An added Markdown-based file (`.md`, `.markdown`, `.mdx`, or an equivalent Markdown file)
  whose primary purpose is to specify planned implementation or system behavior: for example,
  an implementation plan, technical/design specification, feature proposal, rollout or
  acceptance specification, or research document that prescribes work to be done.
- An added file that presents requirements, phases, acceptance criteria, migration or rollout steps,
  or a desired end state for a feature as a repository-local spec, even if it is polished,
  marked temporary, or also contains useful background.

When flagging an added file, anchor the finding to an added line in that file and identify why
the file is a checked-in specification. Recommend deleting the file and moving any material to
the issue tracker or approved external workspace; do not repeat sensitive or user-provided
content in the review comment.

## Do Not Flag

- Existing files that the diff does not add or change; this check is not a repository-wide purge
  of historical artifacts.
- Current-state product, API, contributor, or operational documentation whose primary purpose
  is to explain how the system works or how to use it, rather than prescribe a proposed change.
- `README.md`, `CLAUDE.md`, check-definition files, generated indexes, and other repository
  guidance that defines tooling or review policy. The check's own criteria are policy files,
  not feature specifications.
- Markdown embedded in source code, issue links, references to an external specification, and
  test fixtures that contain authored synthetic examples without defining a planned change.

## Severity

- **Error**: An added `specs/` tree entry or Markdown-based specification is checked into the
  repository.
