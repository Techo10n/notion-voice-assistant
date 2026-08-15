# notion-voice-assistant

One Vercel serverless function. Dictate a task into an iOS Shortcut, and it lands in the
Notion Assignments database with a Name, Label, Deadline, Relative Deadline, and Priority.

## How it works

`POST /api/add`

```
Header: x-shortcut-key: <SHARED_SECRET>
Body:   { "text": "CS 3510 homework due next Friday", "today": "2026-08-15" }
```

1. Shared-secret header check, then `text` is required.
2. `today` (the phone's local date) is validated and sanity-clamped to ±1 day of the server's
   UTC date. If it's missing or fails either check, the server falls back to `TIMEZONE`, then
   `America/New_York`. The response reports which won as `dateSource`.
3. Claude Haiku parses the text into `Name` / `Label` / `Deadline` / `Notes`.
4. The model output is validated in code: `Label` must be in the hardcoded list or becomes
   `Misc`, `Deadline` must be a real ISO date or is dropped, `Relative Deadline` mirrors
   `Deadline`, and Priority (`Past` / `Urgent` / `Due Soon`) is pure date math — never the model.
5. A Notion page is created. The response's `message` is what the Shortcut shows.

## Environment variables

Required: `ANTHROPIC_API_KEY`, `NOTION_TOKEN`, `NOTION_DATABASE_ID`, `SHARED_SECRET`.
Optional: `TIMEZONE` (IANA zone, used only when the client sends no usable `today`).

See `.env.example`.

## Deploy

Push to GitHub, import the repo at vercel.com, add the four env vars, deploy. No build step —
Vercel picks up `api/add.js` as a function automatically.

## Test

```sh
curl -sS -X POST https://<your-project>.vercel.app/api/add \
  -H "x-shortcut-key: $SHARED_SECRET" \
  -H 'content-type: application/json' \
  -d "{\"text\":\"CS 3510 homework due tomorrow\",\"today\":\"$(date +%F)\"}"
```

Expect `"dateSource":"client"` and, for a "tomorrow" deadline, `"priority":"Due Soon"`.
