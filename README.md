# agentic-harness — public showcase site

A pure static site (plain HTML / CSS / vanilla JS, **no build step, no npm,
no backend**) showcasing the `agentic-harness` / `cluster_ops` agent and the
**Tool · Agent · Repo · Portal** pattern.

## Files

```
site/
├── DESIGN.md          # the technical design doc (architecture, component specs, MVP/v2)
├── index.html         # landing — what it is, the pattern, the 3 lanes, integrations
├── architecture.html  # the architecture + integration story, visualized
├── calculator.html    # directional GPU-cluster sizing/cost calculator (UI)
├── README.md          # this file
└── assets/
    ├── style.css      # shared dark-theme styling
    └── calculator.js  # pure, deterministic sizing functions + DOM glue
```

## Preview locally

No tooling required. From the repo root:

```bash
cd site
python3 -m http.server 8000
# then open http://localhost:8000/  in a browser
```

(Per the host security rules, if previewing on a remote box, tunnel it —
don't open a port to the internet:
`ssh -L 8000:localhost:8000 user@host`, then browse `localhost:8000`.)

## Deploy to GitHub Pages

This is already Pages-ready (relative links, no build). Two common options:

1. **`/docs` or project-subdir publish** — in the repo's
   *Settings → Pages*, set the source branch and a folder. If you point
   Pages at this `site/` directory (e.g. by copying/symlinking it to
   `/docs` on the publish branch, or configuring a Pages workflow with
   `path: site`), the pages serve as-is.

2. **GitHub Actions (recommended, no file moves):** add a workflow that
   uploads `site/` as the Pages artifact:

   ```yaml
   # .github/workflows/pages.yml
   name: Deploy site to Pages
   on: { push: { branches: [main], paths: ['site/**'] } }
   permissions: { pages: write, id-token: write }
   jobs:
     deploy:
       runs-on: ubuntu-latest
       environment: { name: github-pages }
       steps:
         - uses: actions/checkout@v4
         - uses: actions/upload-pages-artifact@v3
           with: { path: site }
         - uses: actions/deploy-pages@v4
   ```

   The landing page resolves at the Pages URL root; `architecture.html`,
   `calculator.html`, and `DESIGN.md` are linked relatively.

## Hard constraints this site obeys

- **No sensitive data.** No customer names, no negotiated/discount pricing,
  no account ids, no internal hostnames/IPs, no internal/Midway URLs, no
  secrets, no real benchmark numbers.
- **Directional only.** Every figure in the calculator is a clearly-labeled
  *directional, public-spec estimate* — not a benchmark or a quote. The
  formulas are public heuristics, written out on `calculator.html` and
  implemented as pure functions in `assets/calculator.js`.
- **Pure static.** No backend, no API keys, no network calls from any page.
  The calculator runs entirely in the browser.
- **Restricted tier is described, not built.** The auth + RBAC + audit
  portal is documented in `DESIGN.md` as the private tier; nothing here
  exposes it.

## Notes for reviewers

- `DESIGN.md` is the substantive document; the HTML pages render its core
  visually. Where a capability isn't implemented yet it's marked
  **planned (v2)** in both.
- The deterministic-tool half of the design is **shipped** in
  `cluster_ops/` (capacity discovery, the `error_patterns.py` classifier,
  the synthesizer, the read-only MCP server). The benchmark-entry repo and
  the portal UI are the new build.
