// POST /api/add
//
// Body: {
//   "text":  "Visual literacy essay due Thursday at 3pm",
//   "now":   "2026-09-26T19:30:00+09:00",   // preferred: phone's local time + UTC offset
//   "today": "2026-09-26"                    // older Shortcuts: phone's local date only
// }
// Header: x-shortcut-key: <SHARED_SECRET>
//
// Parses natural language into an Assignments entry and writes it to Notion.
//
// `now` (or, failing that, `today`) is the *client's* local clock, which is the
// only source that stays correct while travelling. Both are validated and
// clamped before use; anything suspect falls back to the server-side TIMEZONE.
// Only `now` carries a UTC offset, so spoken times ("at 3pm") are only placed
// in the right timezone when the Shortcut sends `now`.
//
// Required env vars:
//   ANTHROPIC_API_KEY   sk-ant-...
//   NOTION_TOKEN        ntn_...
//   NOTION_DATABASE_ID  eed5b704-7148-462b-aa77-41ce33d16c3a
//   SHARED_SECRET       any long random string; must match the Shortcut
// Optional:
//   TIMEZONE            IANA zone used when the client sends no usable `now`.
//                       Defaults to America/New_York.

// The one category axis for an entry: course codes and non-course categories
// share it. Edit this each semester — Notion auto-creates any select option it
// hasn't seen, so a new code here needs no change on the Notion side.
const LABELS = [
  "STA1001", "CAS2201", "IEE1176", "Yonsei", "KLI",
  "Clubs", "Misc", "Career"
];

// Spoken names the model should map onto each course label. Keep in step with
// LABELS when the semester changes.
const LABEL_HINTS = [
  "STA1001 = Introduction to Statistics (stats, statistics)",
  "CAS2201 = Introduction to Human-Computer Interaction (HCI)",
  "IEE1176 = Visual Literacy",
  "KLI = KLI1003 Intensive Korean Language (Korean class, KLI)",
  "Yonsei = anything else about Yonsei University that isn't one of the courses"
];

const NOTION_VERSION = "2022-06-28";
const MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_ZONE = "America/New_York";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// --- date helpers ----------------------------------------------------------

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

// "15:00", "9:05" -> "15:00", "09:05"; anything else -> null.
function normalizeTime(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function daysBetween(isoA, isoB) {
  const toUtc = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(isoA) - toUtc(isoB)) / 86400000);
}

function weekdayOf(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// Local date, time and UTC offset ("+09:00") for an IANA zone, right now.
function clockInZone(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset"
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  // timeZoneName is "GMT+09:00", "GMT-04:00", or plain "GMT" for UTC.
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName.replace("GMT", "");
  return {
    today: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    offset
  };
}

// "2026-09-26T19:30:00+09:00" (seconds optional, "Z" or "+0900" accepted).
// Returns the phone's own local date/time/offset, or null if unusable.
function parseClientNow(value) {
  if (typeof value !== "string") return null;
  const match = value
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/);
  if (!match) return null;
  const [, date, hh, mm, rawOffset] = match;
  if (!isIsoDate(date) || !normalizeTime(`${hh}:${mm}`)) return null;

  let offset = "+00:00";
  if (rawOffset !== "Z") {
    const sign = rawOffset[0];
    const digits = rawOffset.slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2));
    const minutes = (sign === "-" ? -1 : 1) * (oh * 60 + om);
    // Real zones run UTC-12..UTC+14.
    if (om > 59 || minutes < -12 * 60 || minutes > 14 * 60) return null;
    offset = `${sign}${digits.slice(0, 2)}:${digits.slice(2)}`;
  }

  const instant = Date.parse(`${date}T${hh}:${mm}:00${offset}`);
  if (Number.isNaN(instant)) return null;
  return { today: date, time: `${hh}:${mm}`, offset, instant };
}

// Where "now" comes from, best source first:
//   1. `now`   — phone's local time with offset. Correct date, time and zone.
//   2. `today` — phone's local date only (older Shortcuts). Time and offset
//                come from TIMEZONE, so spoken times may be off while travelling.
//   3. TIMEZONE env var, then America/New_York.
// Client values are trusted only as far as physics allows: a genuine phone
// clock is never more than a day off the server's.
function resolveClock(body) {
  const zone = process.env.TIMEZONE || DEFAULT_ZONE;
  const zoneSource = process.env.TIMEZONE ? "env" : "default";

  if (body.now !== undefined && body.now !== null && body.now !== "") {
    const client = parseClientNow(body.now);
    if (!client) {
      console.warn(`ignoring client now=${JSON.stringify(body.now)}: not a valid ISO date-time with offset`);
    } else if (Math.abs(client.instant - Date.now()) > 86400000) {
      console.warn(`ignoring client now=${body.now}: more than a day from server time`);
    } else {
      const { today, time, offset } = client;
      return { today, time, offset, dateSource: "client-now" };
    }
  }

  const fallback = clockInZone(zone);

  if (body.today !== undefined && body.today !== null && body.today !== "") {
    const candidate = typeof body.today === "string" ? body.today.trim() : body.today;
    if (!isIsoDate(candidate)) {
      console.warn(`ignoring client today=${JSON.stringify(body.today)}: not a valid ISO date`);
    } else {
      const skew = daysBetween(candidate, new Date().toISOString().slice(0, 10));
      if (Math.abs(skew) > 1) {
        console.warn(`ignoring client today=${candidate}: ${skew} day(s) from server UTC date`);
      } else {
        return { ...fallback, today: candidate, dateSource: "client" };
      }
    }
  }

  return { ...fallback, dateSource: zoneSource };
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

function systemPrompt(clock) {
  return [
    `Right now it is ${weekdayOf(clock.today)} ${clock.today}, ${clock.time} (24-hour, local time).`,
    "The user describes an assignment, task, event, or reminder by voice.",
    "Reply with raw JSON only — no markdown fences, no commentary.",
    "",
    "Keys (omit any you cannot determine):",
    "  Name     — short title for the entry. Keep dates and times out of it.",
    `  Label    — exactly one of: ${LABELS.join(", ")}. Default to "Misc".`,
    `             Spoken course names: ${LABEL_HINTS.join("; ")}.`,
    "  Date     — YYYY-MM-DD the item is due or starts. Resolve relative dates like",
    "             \"tomorrow\" or \"next Friday\" against today's date. If only a",
    "             time is given, use today, or tomorrow if that time has already",
    "             passed today.",
    "  Time     — HH:MM (24-hour) ONLY if the user states a time (\"at 3pm\",",
    "             \"by 11:59\", \"from 2\"). Otherwise omit it. Never guess one.",
    "  EndDate  — YYYY-MM-DD ONLY if the user states or implies an end or a",
    "             multi-day span (\"Friday to Sunday\", \"through Monday\").",
    "  EndTime  — HH:MM (24-hour) ONLY if the user states or implies an end time",
    "             (\"2 to 4pm\", \"until 5\", \"ends at 5pm\").",
    "  Notes    — extra details worth keeping, such as a place or instructions.",
    "             Never put dates or times in Notes; they belong in the fields above.",
    "",
    "If nothing about an end is said, omit EndDate and EndTime. If no time is",
    "said, omit Time and EndTime.",
    "Do not set a priority. Do not invent a deadline that was not implied.",
    "",
    "Examples (dates illustrative):",
    '  "stats homework due Monday" -> {"Name":"Stats homework","Label":"STA1001","Date":"2026-09-28"}',
    '  "visual literacy essay due Thursday at 3pm" -> {"Name":"Visual literacy essay","Label":"IEE1176","Date":"2026-10-01","Time":"15:00"}',
    '  "Busan trip Friday to Sunday" -> {"Name":"Busan trip","Label":"Misc","Date":"2026-10-02","EndDate":"2026-10-04"}',
    '  "HCI team meeting tomorrow 2 to 4pm in the library" -> {"Name":"HCI team meeting","Label":"CAS2201","Date":"2026-09-27","Time":"14:00","EndTime":"16:00","Notes":"Library"}'
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

async function parseText(text, clock) {
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
      system: systemPrompt(clock),
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

// Turns the model's Date/Time/EndDate/EndTime into a Notion date value.
//   - No time spoken  -> date-only start (and end, if a span was spoken).
//   - Any time spoken -> "Include time" on, with the phone's UTC offset.
//   - End only when the model reported one; dropped if it isn't after start.
// Returns null when there is no usable date.
function buildDeadline(parsed, clock) {
  const time = normalizeTime(parsed.Time);
  const endTime = normalizeTime(parsed.EndTime);
  let date = isIsoDate(parsed.Date) ? parsed.Date : isIsoDate(parsed.Deadline) ? parsed.Deadline : null;
  let endDate = isIsoDate(parsed.EndDate) ? parsed.EndDate : null;

  // A spoken time with no date means the next occurrence of that time.
  if (!date && (time || endTime)) {
    const t = time || endTime;
    date = t > clock.time ? clock.today : addDays(clock.today, 1);
  }
  if (!date) return null;

  const hasTime = Boolean(time || endTime);
  const hasEnd = Boolean(endDate || endTime);

  // Notion needs start and end in the same form, so a range that mentions a
  // time on only one side gets a start-of-day start or an end-of-day end.
  const startTime = time || "00:00";
  const start = hasTime ? `${date}T${startTime}:00${clock.offset}` : date;

  let end = null;
  if (hasEnd) {
    if (hasTime) {
      const et = endTime || "23:59";
      // "10pm to 2am" with no end date crosses midnight.
      if (!endDate) endDate = et <= startTime ? addDays(date, 1) : date;
      end = `${endDate}T${et}:00${clock.offset}`;
    } else {
      end = endDate;
    }
    // Same format and offset on both sides, so string order is time order.
    if (end <= start) {
      console.warn(`dropping end ${end}: not after start ${start}`);
      end = null;
    }
  }

  return { date, start, end, hasTime };
}

function describeDeadline(deadline) {
  if (!deadline) return "";
  const show = (value) => value.replace("T", " ").slice(0, 16);
  const { start, end } = deadline;
  return end ? ` — ${show(start)} → ${show(end)}` : ` — due ${show(start)}`;
}

function buildProperties(parsed, clock) {
  const properties = {};

  const name = (parsed.Name || "").toString().trim() || "Untitled";
  properties.Name = { title: [{ text: { content: name.slice(0, 2000) } }] };

  const label = LABELS.includes(parsed.Label) ? parsed.Label : "Misc";
  properties.Label = { select: { name: label } };

  const deadline = buildDeadline(parsed, clock);
  if (deadline) {
    properties.Deadline = { date: deadline.end ? { start: deadline.start, end: deadline.end } : { start: deadline.start } };
    // Relative Deadline always mirrors Deadline's start date: no time, no end.
    properties["Relative Deadline"] = { date: { start: deadline.date } };
  }

  const priority = priorityFor(deadline && deadline.date, clock.today);
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

  const clock = resolveClock(body);

  try {
    const parsed = await parseText(text, clock);
    const { properties, name, deadline, priority, label } = buildProperties(parsed, clock);
    const page = await createPage(properties);

    // The Shortcut shows `message` and opens `url` (or `appUrl`, which forces
    // the Notion app) when you tap through.
    return res.status(200).json({
      ok: true,
      message: `${name}${describeDeadline(deadline)}`,
      name,
      label,
      deadline: deadline ? deadline.start : null,
      deadlineEnd: deadline ? deadline.end : null,
      priority,
      today: clock.today,
      dateSource: clock.dateSource,
      url: page.url,
      appUrl: page.id ? `notion://www.notion.so/${page.id.replace(/-/g, "")}` : null
    });
  } catch (err) {
    console.error("add failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
