# Pella Render Recorder v20.6

Wispbyte-focused build with Render-optimized Playwright Chromium headless-shell installation to reduce disk usage.

## Wispbyte
Use Node.js 22.

Startup command can remain Wispbyte's default command that runs `npm install` and then `node index.js`.
`package.json` now has a `postinstall` script that runs:

`PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium`

The server also auto-installs the Chromium headless shell at first recording attempt if the browser binary is missing.

The app binds to `0.0.0.0` and prefers `SERVER_PORT`, then `PORT`, then 10896.

## Render
Build:
`npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium`

Start:
`npm start`

Health:
`/health`

## Render setup

Build command:
```text
npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
```

Start command:
```text
npm start
```

Health check:
```text
/health
```

Render uses `PORT=10000`. The application binds to `0.0.0.0`. The browser is installed at build time, not during recording.
