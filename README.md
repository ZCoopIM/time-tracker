# Time Tracker

A one-screen app for employees to check in and out of what they're working on
(QC, Fabrication, Servicing, Transport, Other). Every check-in and check-out goes to a
Google Sheet, with one tab per person.

Works on iPhone, iPad and computers. Can be added to the home screen like an app, and keeps
working with no signal: taps are saved on the device and sent once it's back online.

## How people use it

1. Open the link and tap **Sign in with Google** with your @infinitemachine.com account.
   The device stays signed in; your tab in the sheet is named from your Google account.
2. Tap what you're doing. A timer starts.
3. Tap **Check out** when done, or tap a different task to switch (this checks you out of the
   first one automatically).

**Add to home screen:** iPhone/iPad: open in Safari → Share → *Add to Home Screen*.
Computer: in Chrome or Edge, click the install icon in the address bar.

## What the sheet looks like

Each person gets a tab named after them, created the first time they check in:

| Date | Activity | Note | Check In | Check Out | Hours |
|---|---|---|---|---|---|
| Fri 9/25/2026 | QC | | 8:02 am | 10:15 am | 2.22 |
| Fri 9/25/2026 | Other | Cleaning shop | 10:15 am | | |

A row with no Check Out means they're working on it right now. (There's also a hidden
"Entry ID" column that matches check-outs to check-ins; leave it alone.)

## One-time setup

### 1. Connect the Google Sheet

1. Create a new Google Sheet.
2. In the Sheet: **Extensions → Apps Script**.
3. Delete what's there, paste in everything from `google-sheet-script.gs`, and click **Save**.
4. Click **Deploy → New deployment**. Click the gear icon, choose **Web app**, then set:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
5. Click **Deploy**, approve the permissions, and copy the **Web app URL**.
6. Open `app.js` and paste that URL into the `SHEET_URL` line at the top.

To check it worked, open the Web app URL in a browser. You should see
`"Time tracker is running"`.

> If you edit the script later, use **Deploy → Manage deployments → Edit → New version**
> so the URL stays the same.

### 2. Turn on Google sign-in

Only signed-in @infinitemachine.com accounts can add entries. This needs a Google sign-in ID:

1. In Google Cloud (project **IM Time Tracker**), **Google Auth Platform**: audience **Internal**,
   and a **Web application** client with the app's address as an authorized JavaScript origin
   and redirect URI (`https://timetracker.infinitemachine.com` and `.../`).
2. Put the client ID in `GOOGLE_CLIENT_ID` in both `app.js` and `google-sheet-script.gs`.
3. In the Apps Script editor, pick **authorize** next to Run and run it once, so Google asks
   for permission to check sign-ins ("Connect to an external service").

Sign-ins last a year per device. To sign everyone out, delete `SESSION_SECRET` under
**Project Settings → Script Properties** in the Apps Script editor.

### 3. Put the app online

The app has to be at an `https://` address for the home-screen install to work. Any static
host works: GitHub Pages, Vercel, Netlify. It's just the files in this folder, with no build step.

**Live at https://timetracker.infinitemachine.com**, served by GitHub Pages from `main`. The
`CNAME` file tells GitHub the address; the domain's DNS (managed in Hover) has a CNAME record
`timetracker` → `zcoopim.github.io`.

## Changing the task buttons

Edit the `ACTIVITIES` list at the top of `app.js`. Add, remove or rename entries.

## Files

- `index.html`, `style.css`, `app.js`: the app
- `sw.js`, `manifest.json`, `icons/`: what makes it installable and work offline
- `assets/im-wordmark.svg`: the Infinite Machine wordmark, from the IM design system
- `google-sheet-script.gs`: the code that runs inside the Google Sheet

## Look and feel

Styled after the Infinite Machine design system's Olto app kit: white page, flat light-gray
rows, black type at regular weight, small uppercase gray labels, and Electric Green only for
the "checked in" dot. Text uses the device's built-in system font, as the Olto app does. The
timer uses Michroma (a free Google font) as a stand-in for Eurostile Extended, because the
brand's Helvetica Now and Eurostile fonts are licensed and this repo is public.
