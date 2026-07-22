# Altagether Digital Style Guide

> **Purpose:** Reusable design instructions for Altagether dashboards, directories, forms, reports, lightweight web apps, and internal tools.
>
> Treat this file as the visual source of truth. Preserve the system rather than improvising a new aesthetic for each project.

---

## 1. Brand Character

Altagether interfaces should feel:

- **Neighborly and civic-minded** — welcoming, trustworthy, and built for real community work.
- **Warm but operational** — more human than a typical administrative dashboard, but still easy to scan and use.
- **Editorial plus utilitarian** — clear sans-serif structure paired with a restrained serif for genuine reading passages.
- **Grounded and tactile** — paper-like backgrounds, visible borders, modest corner radii, and occasional hard-edged shadows.
- **Confident, not corporate** — avoid generic SaaS styling, excessive polish, and ornamental visual effects.

A useful shorthand is: **a contemporary community field guide crossed with a well-designed civic dashboard.**

### Avoid

- Glassmorphism, translucent panels, neon colors, or glossy gradients
- Excessively rounded “bubble” interfaces
- Huge empty hero areas in functional tools
- Dense blocks of mixed font treatments
- Unnecessary icons, animations, or decorative UI
- Color used without labels, icons, or text
- Generic blue-on-white enterprise software aesthetics

---

## 2. Color System

### Core brand colors

```css
:root {
  --deep-space-blue: #304059;
  --golden-orange: #f59e09;
  --porcelain: #fdfbf8;
  --floral-white: #fffdf5;
  --rosy-copper: #bc5839;
}
```

| Token | Hex | Primary use |
|---|---:|---|
| Deep Space Blue | `#304059` | Main brand color, app headers, table headers, primary buttons, strong headings |
| Golden Orange | `#F59E09` | Active states, calls to action, selected controls, highlights, milestones |
| Porcelain | `#FDFBF8` | Default page background |
| Floral White | `#FFFDF5` | Warm alternate background, gentle callouts, quiet sections |
| Rosy Copper | `#BC5839` | Brand accent, warnings, errors, important emphasis |

### Supporting data and status colors

```css
:root {
  --muted-olive: #afc892;
  --dusty-mauve: #bc455a;
  --light-caramel: #fdba77;
  --apricot-cream: #f6cf98;
  --sky-blue-light: #81bdc3;
  --floral-white-warm: #fdf8ec;
  --soft-blush: #f9d6d3;
  --alabaster-grey: #e5e5e5;
}
```

`--floral-white-warm` is the renamed version of the second supplied “floral white” value. Do not create two variables with the same name.

### Essential neutral colors

```css
:root {
  --surface-white: #ffffff;
  --text-primary: #1f2937;
  --text-secondary: #4b5563;
  --border-color: #e5e5e5;
  --overlay: rgba(0, 0, 0, 0.40);
}
```

### Semantic status mapping

Use a light fill with dark text for most statuses. Reserve saturated fills for urgent or strongly selected states.

| Meaning | Background | Text | Notes |
|---|---|---|---|
| Complete / positive | Muted Olive | Deep Space Blue | Calm success; do not use bright green |
| In progress / informational | Sky Blue Light | Deep Space Blue | Good for active work and neutral information |
| Needs attention | Golden Orange or Apricot Cream | Deep Space Blue | Golden Orange is stronger; Apricot Cream is quieter |
| Pending / scheduled | Light Caramel | Deep Space Blue | Useful for intermediate states |
| Blocked / urgent | Dusty Mauve | White | Best high-contrast urgent status |
| Error / destructive | Rosy Copper | White | Also use for error text on pale backgrounds |
| Not started / neutral | Alabaster Grey | Deep Space Blue | Default inactive status |
| Community / human highlight | Soft Blush | Deep Space Blue | Use sparingly for people-centered notes |

### Color usage rules

1. **Deep Space Blue is the anchor.** It should appear in every major interface.
2. **Golden Orange is an accent, not a page background.** Use it to guide attention.
3. **Warm whites should dominate large surfaces.** Porcelain is the standard canvas; pure white is for cards and controls.
4. **Rainbow colors are functional.** Use them for categories, statuses, chart series, badges, and small callouts rather than broad decoration.
5. **Never rely on color alone.** Pair status color with a label, icon, pattern, or numeric value.
6. **Do not use white text on Golden Orange, Sky Blue, Olive, Caramel, Apricot, Blush, or Grey.** Use Deep Space Blue or `--text-primary` instead.
7. **Avoid placing similar warm colors next to one another in charts** without direct labels. Golden Orange, Light Caramel, and Apricot Cream can be difficult to distinguish at a glance.

### Suggested chart order

For categorical data, use this sequence before introducing additional shades:

1. Deep Space Blue
2. Golden Orange
3. Rosy Copper
4. Sky Blue Light
5. Muted Olive
6. Dusty Mauve
7. Light Caramel
8. Apricot Cream

Use direct labels whenever possible. Legends should be close to the visualization, not separated at the bottom of a long card.

---

## 3. Typography

### Font families

```css
--font-ui: "Chivo", Arial, sans-serif;
--font-reading: "Lora", Georgia, serif;
```

Load these weights:

- **Chivo:** 400, 700, 900
- **Lora:** 400, 700

Google Fonts import:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Chivo:wght@400;700;900&family=Lora:wght@400;700&display=swap" rel="stylesheet">
```

### Division of labor

**Chivo is the default interface font.** Use it for:

- Page titles and section headings
- Navigation
- Buttons, tabs, chips, badges, and filters
- Form labels and inputs
- Tables, metrics, dates, statuses, and operational data
- Short instructional text that needs fast scanning

**Lora is reserved for genuine reading.** Use it for:

- Introductory messages
- Explanatory paragraphs
- Bios, stories, notes, quotations, and resident-facing copy
- Longer callouts where warmth and reading rhythm matter

Do not alternate fonts line by line within one compact component. A component should have one clear typographic mode.

### Type scale

| Role | Font | Size | Weight | Line height |
|---|---|---:|---:|---:|
| App-header title | Chivo | 24px | 700 | 1.2 |
| Page H1 outside app bar | Chivo | 28–32px | 700 or 900 | 1.15 |
| H2 / major section | Chivo | 22–24px | 700 | 1.25 |
| H3 / card title | Chivo | 18px | 700 | 1.3 |
| Group label / eyebrow | Chivo | 12–14px | 700 | 1.3 |
| UI body | Chivo | 15–16px | 400 | 1.45 |
| Reading body | Lora | 15–17px | 400 | 1.6 |
| Small metadata | Chivo | 14px | 400 | 1.4 |
| Tags / badges | Chivo | 12–13px | 400 or 700 | 1.2 |
| Large metric | Chivo | 30–44px | 900 | 1.0 |

### Typography rules

- Use **900 weight only for compact emphasis**, such as metrics, compact group titles, or major campaign labels.
- Use sentence case for almost all headings and controls.
- Uppercase is acceptable only for very small category labels, with letter spacing around `0.05em`.
- Keep paragraphs to approximately `48rem` maximum width.
- Avoid italics in UI. Italics may be used sparingly for personal notes or quoted narrative text.
- Never shrink critical text below 14px.

---

## 4. Page Structure and Header Placement

### Standard application header

The default app header is a **full-width Deep Space Blue bar at the top of the page**.

```css
.app-header {
  background: var(--deep-space-blue);
  color: white;
  padding: 16px 24px;
  display: flex;
  align-items: center;
  gap: 16px;
  border-bottom: 3px solid var(--text-primary);
}

.app-header img {
  height: 50px;
  width: auto;
}

.app-header h1 {
  margin: 0;
  font: 700 24px/1.2 var(--font-ui);
}
```

Placement rules:

- Logo sits at the far left.
- Product or page title sits immediately to the right of the logo.
- Do not center the title in functional tools.
- Header actions, when needed, sit on the far right.
- Keep the header height compact; it should frame the tool rather than dominate it.
- Sticky headers are optional for long data tools, but not required by default.

### Main content container

```css
.page-container {
  width: min(1200px, 100%);
  margin: 0 auto;
  padding: 24px;
}
```

- Use a maximum width of **1200px** for most tools.
- Keep introductory reading content narrower, around **48rem**.
- Use left alignment for content, forms, filters, and text.
- Use centered alignment only for empty states, loading indicators, or small confirmation moments.

### Recommended page order

1. App header
2. Optional introductory callout or short explanation
3. Primary task controls or filters
4. Result summary / progress / view controls
5. Main content cards, table, form, or workflow
6. Secondary information and help

The most important user action should appear above the fold without requiring a large hero section.

---

## 5. Spacing and Sizing

Use a 4px-based spacing system:

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 24px;
--space-6: 32px;
--space-7: 48px;
--space-8: 64px;
```

Common applications:

- Inline icon/text gap: 4–8px
- Compact control gap: 8px
- Related fields or chips: 8–12px
- Card padding: 16–24px
- Grid gap: 16px
- Section separation: 24–32px
- Major page separation: 48px

Avoid arbitrary values when a system value will work.

---

## 6. Shape, Borders, and Shadows

### Corner radii

```css
--radius-small: 4px;
--radius-medium: 8px;
--radius-large: 10px;
```

- Inputs, buttons, chips, and compact controls: **4px**
- Cards, callouts, tables, and modals: **8px**
- Nested group panels: up to **10px**
- Avoid pill shapes except for a truly compact status badge or binary toggle.

### Borders

- Default border: `1px solid var(--border-color)`
- Prominent cards and controls: `2px solid var(--border-color)`
- Active controls may use Deep Space Blue as the border.
- Strong callouts may use a 2px border in the associated accent color.

### Shadows

The characteristic card shadow is a subtle, hard-edged offset:

```css
box-shadow: 4px 4px 0 var(--border-color);
```

Use this for primary content cards when a slightly tactile feel is helpful. Do not apply it to every element.

**Do not use Golden Orange, Rosy Copper, or another bright accent as a large offset shadow.** Accent colors should appear as fills, borders, labels, icons, progress indicators, or small highlights—not as a bold block beneath a card. Featured cards should keep the standard neutral shadow and gain emphasis through border color, layout, or a compact accent treatment.

Soft blurred shadows are reserved for floating layers such as modals:

```css
box-shadow: 0 4px 20px rgba(0, 0, 0, 0.20);
```

---

## 7. Core Components

### Cards

```css
.card {
  background: var(--surface-white);
  border: 2px solid var(--border-color);
  border-radius: var(--radius-medium);
  padding: 20px;
  box-shadow: 4px 4px 0 var(--border-color);
}
```

Card hierarchy:

1. Chivo card title in Deep Space Blue
2. Secondary metadata in muted text
3. Main data or action
4. Optional Lora narrative block
5. Tags, statuses, or secondary controls

Do not place five equally prominent text treatments in one card. Each card needs a clear first, second, and third level.

### Introductory callouts

Use Lora for the body. Keep callouts to a short paragraph whenever possible.

```css
.callout {
  max-width: 48rem;
  padding: 20px 24px;
  background: var(--floral-white-warm);
  border: 2px solid var(--golden-orange);
  border-radius: var(--radius-medium);
  color: var(--text-primary);
  font: 400 15px/1.6 var(--font-reading);
}
```

A light warm gradient may be used for a single important welcome or campaign callout, but do not use gradients throughout the interface.

### Buttons

#### Primary

```css
.button-primary {
  background: var(--deep-space-blue);
  color: white;
  border: 2px solid var(--deep-space-blue);
}
```

#### Highlight / campaign

```css
.button-highlight {
  background: var(--golden-orange);
  color: var(--deep-space-blue);
  border: 2px solid var(--deep-space-blue);
}
```

#### Secondary

```css
.button-secondary {
  background: white;
  color: var(--deep-space-blue);
  border: 2px solid var(--deep-space-blue);
}
```

#### Destructive

```css
.button-destructive {
  background: var(--rosy-copper);
  color: white;
  border: 2px solid var(--rosy-copper);
}
```

All buttons should:

- Use Chivo 700
- Have at least a 44px touch target on mobile
- Use 4px corners
- State the action directly
- Show a visible keyboard focus state
- Avoid vague labels such as “Continue” when a more specific label is possible

### Links

- Default to Deep Space Blue with an underline.
- Use 700 weight when the link is a call to action inside prose.
- Do not use Muted Olive or Sky Blue as link text on a light background.
- Hover may reduce opacity slightly or thicken the underline; do not change layout.

### Inputs and selects

```css
.input,
.select {
  width: 100%;
  min-height: 44px;
  padding: 10px 16px;
  background: white;
  color: var(--text-primary);
  border: 2px solid var(--border-color);
  border-radius: var(--radius-small);
  font: 400 16px/1.3 var(--font-ui);
}
```

- Labels appear above controls in most forms.
- Horizontal label/control pairs are acceptable for compact toolbars.
- Focus state: Deep Space Blue border plus a visible Golden Orange outer ring.
- Error state: Rosy Copper border and a plain-language message below the field.
- Do not use placeholder text as the only label.

Suggested focus style:

```css
:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--golden-orange) 65%, white);
  outline-offset: 2px;
}
```

### Chips and filter pills

Chips should be compact rectangles, not oversized pills.

```css
.chip {
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  background: white;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-small);
  font: 400 14px/1.2 var(--font-ui);
}

.chip[aria-pressed="true"] {
  background: var(--golden-orange);
  border-color: var(--deep-space-blue);
  color: var(--text-primary);
}
```

### Tags and badges

- Tags describe categories; badges signal achievement, role, or status.
- Standard tags use a pale supporting color with Deep Space Blue text.
- Achievement badges may use a small symbol, but symbols must not carry meaning alone.
- Keep badge type at 12–13px and avoid more than 2–3 high-emphasis badges in one card.

### Tables

- Header row: Deep Space Blue background with white Chivo text.
- Body: white with subtle alternating rows.
- Hover: very light grey or porcelain.
- Keep cell padding around 10px 16px.
- Align text left; align numeric measures right when comparison benefits.
- On small screens, use horizontal scrolling or convert rows to cards. Do not compress tables until they become unreadable.

### Accordions

- White surface, 2px border, 4px radius.
- Header uses Chivo 700 and a simple chevron.
- Put explanation beneath the group title, not inside every option.
- Use accordions for secondary filters or details, not for the primary task.

### Modals

- Centered over a 40% black overlay.
- Maximum width around 480–560px for simple tasks.
- 8px corners, 2px border, soft shadow.
- Clear title, concise explanation, action group, and obvious close behavior.
- Avoid nesting a modal inside another modal.

### Empty, loading, and error states

- Center them within the available content region.
- Keep the message direct and specific.
- Error text uses Rosy Copper.
- Offer the next useful action whenever one exists.
- Do not use playful illustrations for serious or privacy-sensitive workflows.

---

## 8. Data Displays and Metrics

- Use Chivo 900 for large numbers and Chivo 400–700 for labels.
- Put the label close to the value.
- Include units and time windows: “42 addresses contacted this month,” not simply “42.”
- Use compact cards rather than one giant analytics panel when measures have different meanings.
- Keep community-wide metrics separate from an individual user’s immediate task unless the broader number directly motivates that task.
- Use progress bars only when the denominator is stable and meaningful.
- Celebrate meaningful milestones with Golden Orange, Muted Olive, or a restrained badge. Avoid confetti for routine saves.

### Progress bar example

```css
.progress-track {
  height: 10px;
  background: var(--alabaster-grey);
  border-radius: 4px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--golden-orange);
}
```

Always show a text value alongside the bar.

---

## 9. Responsive Behavior

Primary breakpoint:

```css
@media (max-width: 640px) { /* mobile rules */ }
```

On mobile:

- Page padding reduces from 24px to 16px.
- Toolbars stack vertically.
- Inputs and selects become full width.
- Card grids become one column.
- Reading callouts use 16px padding.
- Two-column option grids become one column.
- Button groups may stack.
- Hover-only actions must become permanently visible.
- Preserve 44px touch targets.

For card grids:

```css
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}
```

Do not create a separate mobile aesthetic. The same hierarchy, colors, and typography should carry through.

---

## 10. Accessibility and Usability

- Meet WCAG AA contrast for normal text.
- White text is appropriate on Deep Space Blue, Dusty Mauve, and Rosy Copper.
- Use Deep Space Blue or `--text-primary` on all pale supporting colors.
- Preserve visible keyboard focus on every interactive element.
- Use semantic HTML before custom ARIA.
- Provide proper labels for forms and accessible names for icon-only buttons.
- Never communicate status through color alone.
- Respect reduced-motion preferences.
- Keep transition durations around 150–250ms and use motion only to clarify state change.
- Error messages should explain what happened and how to fix it.
- Privacy-sensitive data should be visually calm and treated with direct, non-playful language.

Reduced motion:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
```

---

## 11. Voice Within the Interface

Visual and verbal style should support each other.

- Write like a capable neighbor, not a bureaucracy.
- Use plain, concrete verbs: “Save contact,” “View zone,” “Export addresses.”
- Explain why information matters when the reason is not obvious.
- Keep instructions close to the task they describe.
- Avoid over-explaining routine actions.
- Use warmth in introductions and milestone messages; use precision in forms and data states.
- Prefer “No addresses match these filters” over “No results found.”

---

## 12. Implementation Starter

Use this base in new projects:

```css
:root {
  /* Brand */
  --deep-space-blue: #304059;
  --golden-orange: #f59e09;
  --porcelain: #fdfbf8;
  --floral-white: #fffdf5;
  --rosy-copper: #bc5839;

  /* Supporting palette */
  --muted-olive: #afc892;
  --dusty-mauve: #bc455a;
  --light-caramel: #fdba77;
  --apricot-cream: #f6cf98;
  --sky-blue-light: #81bdc3;
  --floral-white-warm: #fdf8ec;
  --soft-blush: #f9d6d3;
  --alabaster-grey: #e5e5e5;

  /* Neutrals */
  --surface-white: #ffffff;
  --text-primary: #1f2937;
  --text-secondary: #4b5563;
  --border-color: #e5e5e5;
  --overlay: rgba(0, 0, 0, 0.40);

  /* Typography */
  --font-ui: "Chivo", Arial, sans-serif;
  --font-reading: "Lora", Georgia, serif;

  /* Shape */
  --radius-small: 4px;
  --radius-medium: 8px;
  --radius-large: 10px;

  /* Spacing */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;
}

* {
  box-sizing: border-box;
}

html,
body {
  min-height: 100%;
  margin: 0;
  background: var(--porcelain);
  color: var(--text-primary);
  font-family: var(--font-ui);
}

h1,
h2,
h3,
h4,
button,
input,
select,
textarea {
  font-family: var(--font-ui);
}

.reading-copy {
  max-width: 48rem;
  font-family: var(--font-reading);
  line-height: 1.6;
}

a {
  color: var(--deep-space-blue);
  text-decoration: underline;
  text-underline-offset: 2px;
}

button,
input,
select,
textarea {
  font-size: 1rem;
}

button {
  min-height: 44px;
  border-radius: var(--radius-small);
  font-weight: 700;
  cursor: pointer;
}

:focus-visible {
  outline: 3px solid var(--golden-orange);
  outline-offset: 2px;
}
```

---

## 13. Final Design Checklist

Before shipping an Altagether interface, confirm:

- [ ] Deep Space Blue visibly anchors the interface.
- [ ] The page uses Porcelain or a warm white as its main background.
- [ ] Chivo handles structure and data; Lora is limited to real reading passages.
- [ ] The page title is left-aligned in a compact top header or clear content hierarchy.
- [ ] There is one obvious primary action.
- [ ] Cards have restrained radii, visible borders, and no unnecessary floating effects.
- [ ] Golden Orange is used selectively for emphasis and active states.
- [ ] Supporting rainbow colors convey categories or status rather than decoration.
- [ ] Every color-coded state also has a text label or icon.
- [ ] Text hierarchy is clear without mixing many font treatments.
- [ ] Mobile controls stack cleanly and retain 44px touch targets.
- [ ] Keyboard focus, contrast, error messaging, and empty states are handled.
- [ ] The result feels warm, capable, community-centered, and easy to act on.
