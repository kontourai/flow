# Vendored brand faces

These woff2 files back the `--k-font-display`, `--k-font-ui` and `--k-font-mono` tokens.
They are self-hosted so a consumer with `default-src 'self'` — the right posture for a tool
that handles someone's documents — still renders the brand typography, and so no Kontour
surface makes a third-party request at render time.

`tokens/fonts.css` is generated from these files by `scripts/vendor-fonts.mjs`. Run that
script to refresh a family, weight, or upstream release; do not hand-edit `fonts.css`.

## What ships, and why

| Family | Token | Files | License |
| --- | --- | --- | --- |
| Fraunces | `--k-font-display` | `fraunces-{latin,latin-ext}.woff2` | [OFL 1.1](./OFL-Fraunces.txt) |
| Hanken Grotesk | `--k-font-ui` | `hanken-grotesk-{latin,latin-ext}.woff2` | [OFL 1.1](./OFL-HankenGrotesk.txt) |
| IBM Plex Mono | `--k-font-mono` | `ibm-plex-mono-{400,500,600}-{latin1,latin2}.woff2` | [OFL 1.1](./OFL-IBMPlexMono.txt) |

Fraunces and Hanken Grotesk are variable fonts, shipped as one file per unicode subset
covering the full `100 900` weight axis. Google serves the identical file for every weight
of a variable family, so vendoring the individual weights the tokens use would have shipped
the same bytes four and five times over — 496 KB instead of 124 KB for Fraunces alone.
Fraunces keeps its `opsz` axis variable so optical sizing still works at display sizes.

IBM Plex Mono has no variable release, so it ships as three static weights — 400, 500 and
600, the weights `tokens.css` and `react/styles.css` ask for.

Coverage is latin + latin-ext for every family (IBM's `Latin1` + `Latin2` subsets are the
equivalent split). Characters outside those ranges fall through to the fallback stacks
declared in `tokens.css`.

## Provenance

- **Fraunces**, **Hanken Grotesk** — the woff2 subsets Google Fonts serves, fetched from
  `fonts.gstatic.com` with their `unicode-range` declarations taken verbatim from the
  Google Fonts CSS. Neither family declares a Reserved Font Name, so the subsetting Google
  applies carries no naming restriction.
- **IBM Plex Mono** — IBM's own published `@ibm/plex-mono` woff2 artifacts, unmodified.
  IBM Plex reserves the font name "Plex", and OFL clause 5 restricts that name on modified
  versions; taking IBM's own build rather than a re-subset copy keeps the family name
  unambiguously licensed.
