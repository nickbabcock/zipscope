# Design

This file gives the design intent of Zipscope. The values are in the code:
the tokens are in `web/src/theme/tokens.stylex.ts`, and the shared controls
are in `web/src/shell/controls.ts`. When this file and the code do not agree,
the code is correct.

## The survey sheet

Zipscope shows an archive as a map shows land. The ground is a clean sheet.
Sizes show as height: a neutral bar is next to each number. Thin brown
contour lines show the depth of the folder tree. The status bar at the bottom
is the map margin.

The survey sheet gives the type, the colors, the density and two signatures:
the contour guides and the map margin. The layout, the navigation and the
controls are standard web components. Do not add map decoration.

One URL has two surfaces. The front door at `/` must persuade the visitor.
It is a poster: the word mark at poster scale, the actions, and a level
picture of the real tool on a sample archive. The tool is for work: it is
dense, it is quiet, and the keyboard can do all of it. When the visitor
drops a file, the front door changes into the tool. The URL does not change.

- Dense but quiet: 24 px rows, 13 px body text, 11 px legend labels.
- Color shows action, selection and health. It never encodes size.
- Flat surfaces in tonal layers. Only overlays have a shadow.
- The system UI font, with tabular figures for every number.
- Light is the default. The night sheet follows the system setting.

## Color

The palette is warm stone neutrals, one sky-blue action color and three
health colors, from the Tailwind palette. Each token has a light value and a
night value.

| Role                  | Use                                                                 |
| --------------------- | ------------------------------------------------------------------- |
| Water                 | Links, the primary action, progress, native controls                |
| Focus                 | The 2 px focus ring                                                 |
| Select, Select Rest   | The selected row of the pane with the focus, and of the other pane  |
| Contour               | The tree guides, and the bytes that nothing accounts for            |
| Warn, Crit            | Health warnings, and health errors and failed extractions           |
| Ground, Panel, Raised | The tonal layers: table, then tree and bars, then headers and hover |
| Overlay               | Dialogs, menus, popovers and cards                                  |
| Rule, Rule Strong     | Dividers, and edges that must show at 3:1                           |
| Ink, Ink Muted        | Text, and secondary text, legends and placeholders                  |
| Bar                   | Size bars and the entry data of the byte map                        |

At night a shadow does not show, so an overlay is one step lighter than the
ground.

**Neutral elevation.** Size is never encoded by hue. A size bar is neutral.

**One action color.** Water is for actions, links and progress. It is never
decoration.

**Contrast.** Each text pair is at least 4.5:1, and each focus ring and size
bar fill is at least 3:1, in both themes. The contour guides are decorative
(`aria-hidden`): the indent of the row shows the level.

## Type

One plain family carries the tool: the system UI stack, and the system mono
stack for offsets, hex, archive comments and key hints. The tool downloads
no web font: it has a strict bundle budget.

The front door has one display face, Archivo Black (SIL OFL, 19 KB, in
`public/fonts/`). Only the word mark, the band headings, the figures and the
close use it. Running text stays in the system UI stack. The service worker
keeps the font, so the door looks the same offline.

- **Tabular figures.** Each number uses tabular figures. Numeric columns
  align right with their headers.
- **Legend labels.** Column headers and section labels are 11 px, upper
  case, tracked 0.04em, in ink muted, as the legend of a map.
- **Units.** A no-break space joins each number and its unit ("8.6 MiB").

## Layout

- The tool is a grid of three rows: the top bar, the work area and the map
  margin (the front door has no top bar). All panes share one header strip height and one gutter, so the
  tree label, the breadcrumb and the preview title are on one line.
- Three layouts come from a JavaScript signal, not from CSS media queries:
  - At 1200 px or more: the tree, the table and the preview side by side.
  - From 700 to 1200 px: a breadcrumb with a tree drawer.
  - Below 700 px: one pane at a time.
- Nothing grows to fill the window. Compact folder chains and inline
  expansion keep sparse archives from looking empty.
- The name is the main datum of a row, and Size is the main number. When a
  name has less than 200 px, the minor parts leave the table in a fixed
  order: the size bar, Modified, Ratio, Method, Compressed, Size.
- A path cuts its folders first, from the start, and keeps its base name
  whole: `…/lib/libdemo_store.so.2.4.0`.
- A cell with no value shows one marker: an em dash in ink muted.
- A size bar shows the share of the listed folder. A row draws a bar only
  when the bar is 3 px wide or more, so a column of equal files shows no
  bars and a large file shows the only bar of the view.

### Touch screens

A touch screen (`pointer: coarse` on the primary pointer) gets 36 px rows and
larger targets. Nothing changes for a mouse, and a touch laptop with a mouse
keeps the dense layout. The buttons of the front door are 44 px high for
each pointer: they are the main action of the page.

## Depth and shape

The surfaces are flat. Depth comes from the tonal layers. A surface at rest
has no shadow: a shadow means that the element floats above the sheet and
can close.

Corners are small: 6 px for controls, 8 px for overlays, 4 px for badges and
menu items, 1 px for size bars. Borders are 1 px rules.

## Behavior

### Buttons and dialogs

- A view has one primary button at most.
- A view that asks the user to accept a risk has no primary. Its risky
  button has crit text with no fill ("Extract anyway"), and the first focus
  is on Cancel. Else the first focus is on the primary.
- Each control shows a 2 px focus ring on `:focus-visible`.

### Health

- With no findings, the shell shows nothing.
- One strip above the table shows the most severe finding, with a link to
  the list.
- Weight follows severity. An error has the crit band and comes first. A
  zip bomb (overlapping entries, or a bomb-like ratio) is an error. A
  warning is on the ground with a warn icon. A notice is in ink muted.

### Names on the screen

A name comes from the archive, so an attacker can choose it. Zipscope says
what is in the file, so a name must not mislead. All surfaces show a name
through `web/src/label.ts`. `crates/marks` gives the classes of the
characters.

- A control, bidirectional or invisible format character shows as a lozenge
  (`◊`) in its true position: `invoice<U+202E>fdp.exe` shows as
  `invoice◊fdp.exe`. The title spells each mark.
- A label is left to right, with an isolate around each right-to-left part,
  so an Arabic or Hebrew name reads correctly and its extension stays at the
  right.
- A real name in a right-to-left script has no mark. Lookalike letters stay:
  this rule is not about them.
- Search, copy and extraction use the true name. A search for what a spoof
  shows finds nothing.

### Front door

- The whole door is in the served HTML, so the first paint is the styled
  page and a reader with no script can read all of it.
- One left axis carries the page. The word mark fills about 90% of it. The
  actions are in the first view at 1280 x 720 and larger, and the picture of
  the tool starts in the first view below them.
- The picture is a capture of the real tool on the sample archive, in the
  theme of the visitor (`mise run gen:door-shots`). It is level: no tilt, no
  browser frame. Selecting it opens the sample at the same place.
- Five bands follow: speed, local, preview, health, save. Each band has a
  datum on the left at display scale and its claim on the right. A datum is
  a measured value or a real value of the sample. The preview band shows a
  capture of the preview of a real picture in the sample instead. Do not
  add a claim that a test or a benchmark does not support.
- The page has no questions section. A fact that a visitor needs goes in
  the band that it supports, as one short line.
- The page links the sample one time: "Try a sample archive" (the picture
  of the tool opens the same sample). The bands have no links, and the page
  does not link the source code.
- The page has no cards, no icons for each band, no section numbers and no
  accordions.
- The front door has no top bar: the poster word mark is the header. The
  top bar of the tool shows when a file opens.
- Each visit to `/` gets the same page in each browser. Where the browser
  keeps file handles (Chromium), the recent archives are directly below the
  actions, on the same axis, with a small label.
- The return and reopen doors are at the top, on the axis of the poster, with
  the display face for the heading. Their buttons say what they do ("Reopen
  name.zip", "Open another file").
- The reopen door shows only when "Reopen" does more than the file picker:
  for the demo, or where the browser keeps file handles. Else the first door
  shows, and "Open a file" restores the location of the same archive.
- On each door state the map margin takes the ground and no rule. It keeps
  its height.

### Map margin

- The map margin gives the archive name, the file size, the number of
  entries and the parse progress. It shows the store memory only while it
  matters.
- It says when the device is offline and the app still works, and when an
  update is ready. It is quiet: no banner, no dialog, no motion. The page
  never reloads on its own.

## Do

- Use the tokens and the shared controls. Add a token only when a real
  screen needs it.
- Keep motion at 150–250 ms and only for a change of state. Set the duration
  to 0 s under `prefers-reduced-motion: reduce`.
- Show a number beside each size bar, with the exact byte count on hover.
- Keep each control usable with the keyboard.
- Check each new text pair at 4.5:1 and each new non-text pair at 3:1, in
  light and at night.

## Do not

- Do not encode size or health by hue alone. Health always has text and an
  icon or a badge.
- Do not add a web font to the tool. Do not add a second face to the front
  door.
- Do not add paper texture, a compass rose, map shapes, neon or glow.
- Do not add a shadow to a surface at rest.
- Do not use water for decoration.
- Do not add a load animation, or an animation that shows no change of
  state.
- Do not use emoji or Unicode symbols as icons. Use Lucide at 16 px with a
  stroke width of 1.75.
