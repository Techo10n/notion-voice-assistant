# notion-voice-assistant

One Vercel serverless function. Dictate a task into an iOS Shortcut, and it lands in the
Notion Assignments database with a Name, Label, Deadline, Relative Deadline, and Priority.

## How it works

`POST /api/add`

```
Header: x-shortcut-key: <SHARED_SECRET>
Body:   { "text": "Visual literacy essay due Thursday at 3pm", "now": "2026-09-26T19:30:00+09:00" }
```

1. Shared-secret header check, then `text` is required.
2. The clock comes from the phone. `now` (local time with UTC offset) is preferred; older
   Shortcuts send `today` (local date only). Either is validated and must be within a day of
   the server's clock. Otherwise the server falls back to `TIMEZONE`, then
   `America/New_York`. The response reports which won as `dateSource`
   (`client-now` / `client` / `env` / `default`).
3. Claude Haiku parses the text into `Name` / `Label` / `Date` / `Time` / `EndDate` /
   `EndTime` / `Notes`. Time and end fields are only filled when spoken or implied.
4. The model output is validated in code:
   - `Label` must be in the hardcoded list or becomes `Misc`.
   - `Deadline` is date-only unless a time was spoken; then it includes the time, using the
     phone's UTC offset. It gets an end only when an end or range was spoken, and the end is
     dropped if it isn't after the start. A range with a time on only one side gets a 00:00
     start or a 23:59 end.
   - `Relative Deadline` is always the start date only.
   - Priority (`Past` / `Urgent` / `Due Soon`) is pure date math — never the model.
5. A Notion page is created. The response carries `message` for the Shortcut to show, plus
   `url` and `appUrl` (a `notion://` link that forces the Notion app) to open the new page.

## Labels

`LABELS` and `LABEL_HINTS` at the top of `api/add.js` are the only place course codes live.
Update both each semester.

## Environment variables

Required: `ANTHROPIC_API_KEY`, `NOTION_TOKEN`, `NOTION_DATABASE_ID`, `SHARED_SECRET`.
Optional: `TIMEZONE` (IANA zone, used only when the client sends no usable `now`).

See `.env.example`.

## Deploy

Push to GitHub, import the repo at vercel.com, add the four env vars, deploy. No build step —
Vercel picks up `api/add.js` as a function automatically. After that, every push to `main`
redeploys.

## Test

```sh
curl -sS -X POST https://<your-project>.vercel.app/api/add \
  -H "x-shortcut-key: $SHARED_SECRET" \
  -H 'content-type: application/json' \
  -d "{\"text\":\"HCI team meeting tomorrow 2 to 4pm\",\"now\":\"$(date +%Y-%m-%dT%H:%M:%S%z | sed 's/\(..\)$/:\1/')\"}"
```

Expect `"dateSource":"client-now"`, a `deadline` and `deadlineEnd` with times, and
`"priority":"Due Soon"`.
