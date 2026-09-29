---
name: Mobile Layout
description: Ensures new pages and significant UI changes are responsive on mobile
intelligence: low
---

Review new or significantly restructured page-level UI for mobile responsiveness.

## When to Check

Only when the PR adds a new page/route, or substantially reworks the layout of
an existing page (new top-level container, new multi-column grid, a new
persistent side panel or toolbar). Skip minor UI tweaks (copy, spacing, one
component's internals) entirely. If neither applies, PASS immediately.

## What to Check

1. **Fixed-width layouts** — a container or grid using a fixed pixel width
   instead of `w-full`/percentage/`max-w-*` with a responsive fallback.
2. **Missing responsive breakpoints** — a multi-column desktop layout
   (`grid-cols-3`, side-by-side flex row) with no `sm:`/`md:`/`lg:` variant
   that collapses it to a single column on narrow viewports.
3. **Horizontal overflow** — content (tables, wide toolbars, long unwrapped
   text) with no `overflow-x-auto` or wrapping strategy, causing the page
   itself to scroll horizontally on a phone-width viewport.
4. **Touch targets** — new interactive elements (buttons, icon-only actions)
   sized well below a comfortable tap target on a touchscreen.

## Severity

- **Error**: A new page's primary layout has no responsive behavior at all
  (fixed desktop-only width, horizontal overflow on the page body)
- **Warning**: A reworked section lacks a narrow-viewport breakpoint but the
  rest of the page remains usable; undersized touch targets
