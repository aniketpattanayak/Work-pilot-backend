# WorkPilot live UI tests — now run automatically in CI

These are the same Playwright tests, but they now run by themselves on GitHub's
servers every time this branch is pushed, or on demand — nothing to download, no
command to type, no output to paste back.

The workflow (`.github/workflows/e2e.yml`) spins up a throwaway MongoDB and a
throwaway copy of the backend + frontend, creates the `wp-qa-test` tenant from
scratch, switches on Attendance + Leave, and runs the same login / ticket / leave /
attendance tests headless. Results (pass/fail + a full HTML report with screenshots
and video of any failure) show up directly on GitHub under the Actions tab — Claude
checks that and fixes anything that breaks, without needing anything from you.

You can still run it by hand on your own Mac (see `playwright.config.js` /
`global-setup.js`) if you want to watch it live in a visible browser, but that is
now optional, not required.
