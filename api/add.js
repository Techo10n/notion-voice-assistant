// POST /api/add
//
// Body: { "text": "CS 3510 homework due next Friday", "today": "2026-08-15" }
// Header: x-shortcut-key: <SHARED_SECRET>
//
// Parses natural language into an Assignments entry and writes it to Notion.
//
// `today` is optional and is the *client's* local date, which is the only
// source that stays correct while travelling. It is validated and clamped
// before use; anything suspect falls back to the server-side TIMEZONE.
//
// Required env vars:
//   ANTHROPIC_API_KEY   sk-ant-...
//   NOTION_TOKEN        ntn_...
//   NOTION_DATABASE_ID  eed5b704-7148-462b-aa77-41ce33d16c3a
//   SHARED_SECRET       any long random string; must match the Shortcut
// Optional:
//   TIMEZONE            IANA zone for "today" when the client sends none.
//                       Defaults to America/New_York.

const LABELS = [
  "CS 3510", "CS 3001", "KOR 3002", "PSYC 1101", "MATH 3012",
  "Clubs", "VIP", "GC", "Misc", "Career"
];

const NOTION_VERSION = "2022-06-28";
const MODEL = "claude-haiku-4-5-20251001";

// --- date helpers ----------------------------------------------------------

// "Today" has to be resolved in a real timezone, not the server's UTC clock,
// or anything dictated after 8pm ET lands on the wrong day.
function todayInZone(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function daysBetween(isoA, isoB) {
  const toUtc = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(isoA) - toUtc(isoB)) / 86400000);
}

// The Shortcut sends its own local date so travelling doesn't shift "today".
// Trust it only as far as physics allows: real zones run UTC-12..UTC+14, so a
// genuine local date is never more than one day off the server's UTC date.
// Anything else is a broken Shortcut or a spoofed body — fall back instead.
function resolveToday(clientToday) {
  if (clientToday !== undefined && clientToday !== null && clientToday !== "") {
    const candidate = typeof clientToday === "string" ? clientToday.trim() : clientToday;
    if (!isIsoDate(candidate)) {
      console.warn(`ignoring client today=${JSON.stringify(clientToday)}: not a valid ISO date`);
    } else {
      const skew = daysBetween(candidate, new Date().toISOString().slice(0, 10));
      if (Math.abs(skew) > 1) {
        console.warn(`ignoring client today=${candidate}: ${skew} day(s) from server UTC date`);
      } else {
        return { today: candidate, dateSource: "client" };
      }
    }
  }

  const timeZone = process.env.TIMEZONE;
  if (timeZone) {
    return { today: todayInZone(timeZone), dateSource: "env" };
  }
  return { today: todayInZone("America/New_York"), dateSource: "default" };
}

// Priority is pure date math, so compute it here rather than asking the model
// to do it. Deterministic, and it can't drift when the prompt changes.
function priorityFor(deadline, today) {
  if (!deadline) return null;
  if (deadline < today) return "Past";
  if (deadline === today) return "Urgent";
  if (deadline === addDays(today, 1)) return "Due Soon";
  return null;
}

// --- Claude parse ----------------------------------------------------------

function systemPrompt(today) {
  return [
    `Today is ${today}.`,
    "The user describes an assignment, task, event, or reminder by voice.",
    "Reply with raw JSON only — no markdown fences, no commentary.",
    "",
    "Keys (omit any you cannot determine):",
    `  Name    — short title for the entry`,
    `  Label   — exactly one of: ${LABELS.join(", ")}. Default to "Misc".`,
    `  Deadline — ISO date (YYYY-MM-DD). Resolve relative dates like`,
    `             "tomorrow" or "next Friday" against today's date.`,
    `  Notes   — any extra detail worth keeping`,
    "",
    "Do not set a priority. Do not invent a deadline that was not implied."
  ].join("\n");
}

function extractJson(raw) {
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("No JSON object in model output");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

async function parseText(text, today) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: systemPrompt(today),
      messages: [{ role: "user", content: text }]
    })
  });

  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text block in Anthropic response");
  return extractJson(textBlock.text);
}

// --- Notion write ----------------------------------------------------------

function buildProperties(parsed, today) {
  const properties = {};

  const name = (parsed.Name || "").toString().trim() || "Untitled";
  properties.Name = { title: [{ text: { content: name.slice(0, 2000) } }] };

  const label = LABELS.includes(parsed.Label) ? parsed.Label : "Misc";
  properties.Label = { select: { name: label } };

  const deadline = isIsoDate(parsed.Deadline) ? parsed.Deadline : null;
  if (deadline) {
    // Relative Deadline always mirrors Deadline.
    properties.Deadline = { date: { start: deadline } };
    properties["Relative Deadline"] = { date: { start: deadline } };
  }

  const priority = priorityFor(deadline, today);
  if (priority) {
    properties.Priority = { status: { name: priority } };
  }

  const notes = (parsed.Notes || parsed["Location/Notes"] || "").toString().trim();
  if (notes) {
    properties["Location/Notes"] = { rich_text: [{ text: { content: notes.slice(0, 2000) } }] };
  }

  return { properties, name, deadline, priority, label };
}

async function createPage(properties) {
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties
    })
  });

  if (!res.ok) {
    throw new Error(`Notion ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// --- handler ---------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  const secret = process.env.SHARED_SECRET;
  if (!secret || req.headers["x-shortcut-key"] !== secret) {
    return res.status(401).json({ ok: false, error: "Bad or missing key" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const text = (body.text || "").toString().trim();
  if (!text) {
    return res.status(400).json({ ok: false, error: "No text provided" });
  }

  const { today, dateSource } = resolveToday(body.today);

  try {
    const parsed = await parseText(text, today);
    const { properties, name, deadline, priority } = buildProperties(parsed, today);
    const page = await createPage(properties);

    // The Shortcut shows `message` verbatim in its notification.
    const when = deadline ? ` — due ${deadline}` : "";
    return res.status(200).json({
      ok: true,
      message: `${name}${when}`,
      name,
      deadline,
      priority,
      today,
      dateSource,
      url: page.url
    });
  } catch (err) {
    console.error("add failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
