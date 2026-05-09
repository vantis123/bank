# Install Bank

You don't need to know what npm or Node.js is. Just follow these steps once.

---

## Step 1 — Install Node.js (one-time, ~3 min)

Bank runs on Node. If you've never installed it, grab the LTS version from:

→ **https://nodejs.org/en/download**

Download, install with all defaults, restart your Terminal afterward.

(If you've installed Node before, skip this step.)

---

## Step 2 — Open the Bank folder in Terminal

After unzipping the Bank zip:

**Mac:**
1. Open Terminal (Spotlight: Cmd-Space → "Terminal")
2. Type `cd ` (with a space at the end)
3. Drag the Bank folder from Finder into the Terminal window
4. Hit Enter

**Windows:**
1. Right-click the Bank folder → "Open in Terminal"

> **PowerShell quirk:** if you see `npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running scripts is disabled on this system`, that's Windows blocking npm scripts by default. Two fixes — pick one:
>
> **Easiest:** type `cmd` and hit Enter — that drops you into the older command-prompt shell where npm just works. Then continue with the steps below.
>
> **Permanent fix:** in PowerShell, run `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`, hit Y to confirm. Restart the terminal, npm now works in PowerShell forever.

---

## Step 3 — One-time setup (~3 min)

In Terminal, type:

```
npm install
```

Hit Enter. This installs Bank's dependencies and downloads a private browser binary it uses to log into FSN/IIQ. Coffee break.

---

## Step 4 — Run Bank

```
npm start
```

Hit Enter. Your default browser opens to **http://localhost:7878** with the Bank dashboard.

Drop in a client's MyFreeScoreNow or IdentityIQ creds, give the client's name, hit **Run Bank**.

A separate browser window will pop up — that's Bank logging into the client's account. **Don't close it.** It'll capture the report, parse it, score it, and render the PDF. The PDF appears in the dashboard with a Download button.

---

## Subsequent runs

You only do Step 3 once. After that, just:

1. Open Terminal → cd into the Bank folder
2. `npm start`
3. Browser opens, run the report

---

## Where reports + sandbox files live

Bank saves rendered PDFs and intermediate captures to:

- **Mac:** `~/.bank/reports/` and `~/.bank/sandbox/`
- **Windows:** `C:\Users\<you>\.bank\reports\` and `\sandbox\`

Delete that folder anytime to wipe all client data.

---

## Troubleshooting

**"command not found: npm"** — Node.js wasn't installed correctly, or your Terminal isn't using the right path. Restart your Terminal. If still broken, reinstall Node from nodejs.org.

**Browser doesn't auto-open** — Open it manually and go to http://localhost:7878

**Capture says login failed** — The credentials may be wrong, or the client's MFSN account isn't fully verified. Bank tries the new + legacy MFSN sites; if both fail, your client may need to verify their email first.

**Anything else** — DM Phillip with the Terminal output.
