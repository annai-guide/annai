# Shiori's art tools

Dev-time tools that turn the user's art kit into Shiori's avatar art. Nothing here ships, and nothing at runtime depends on it.

- `build.mjs` writes `assets/shiori.svg`, the parts `src/ui/avatar.js` moves.
- `measure.mjs` prints the numbers for the shapes `avatar.js` draws live: the eyes and the streamer.

## What you need

- **The art kit.** It is the user's, private, and git-ignored. Locally it lives at `.superpowers/art/shiori-rig-kit/` in the main checkout. Its README is the source of truth for every part, pose and colour. Without the kit, these tools can't run. The committed `assets/shiori.svg` is their output.
- **Docker.** `build.mjs` traces with potrace, in an `alpine:3.20` container. Nothing is installed on the machine.
- **Node 24 or later.** The PNG decoding, the colour split and the masks are plain JavaScript (`png.mjs`, `raster.mjs`).

## Running them

```sh
node scripts/shiori-art/build.mjs <kit folder> [--debug <folder>]
node scripts/shiori-art/measure.mjs <kit folder>
npm run stamp && npm run check
```

- `build.mjs` takes about a minute and a half, and gives the same file every time.
  - `--debug` writes a small picture of each part's colour classes to the folder, for checking a cut.
  - It prints the pivots that `src/ui/shiori.css` and `avatar.js` move the parts about, and records them in the art as `<!-- pivots … -->`. If they change, update the CSS and `avatar.js`: `test/unit/shiori-art.test.js` fails until they agree.
- `measure.mjs` only prints. Copy what it prints into `avatar.js` by hand, and look at her afterwards. The front open eye in `avatar.js` is hand-tuned and differs from its output on purpose, as the comment there explains.
- After a build, run `npm run stamp`, since the art is in the service worker's shell.

## How `build.mjs` works

1. **Registers** each kit picture to the front master's pixels. Parts are placed by scale, turn and a point (`AT` in the script); the turned and asleep masters are registered at the scarf's knot.
2. **Splits** each picture into the README's palette. Anti-aliased edges go to the nearer colour of their blend. The asleep masters have browns of their own (`ASLEEP`), but every part is drawn in the master's palette.
3. **Cuts** the parts that move on their own. It fills what each part hid with what was around it, so a part can move without opening a gap.
4. **Cleans** each layer. Islands and holes under 600 pixels are grain in the generated pictures, and a 2-pixel blur keeps pixel wobble from turning into dozens of tiny curves.
5. **Traces** each colour layer with potrace. Paths are rounded to whole units of the SVG, relative to rounded points so rounding never drifts.
6. **Writes** the parts as named groups in `assets/shiori.svg`, which `avatar.js` draws with `<use href="/assets/shiori.svg#…">`.

`scripts/render-icons.mjs` is separate: it makes Android's maskable icon from the user's icon head, and optimises it losslessly with oxipng in Docker.
