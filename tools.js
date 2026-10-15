// Bunny Planner tools. Pure logic: no network, no framework, no storage code.
// Every result carries a `mood` so the bunny can react to REAL state.

const MAX_TASKS = 40;
const WORKDAY_MINUTES = 480; // more than 8h of work = overbooked
const MAX_PENDING = 6; // more than 6 open tasks = overbooked
const BREAK_MINUTES = 10;
const LATEST_END = 22 * 60; // plan should end before 22:00

export const emptyState = () => ({ tasks: [], doneDates: [], nextId: 1 });

// ---------- helpers ----------
const localDate = (ctx) =>
  new Date(ctx.now() + (ctx.tzOffsetMinutes || 0) * 60000).toISOString().slice(0, 10);

const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function streakOf(doneDates, today) {
  const set = new Set(doneDates);
  let day = set.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (set.has(day)) {
    n++;
    day = addDays(day, -1);
  }
  return n;
}

const pendingOf = (s) => s.tasks.filter((t) => t.status === 'pending');
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

const ok = (text, data) => ({
  content: [{ type: 'text', text }],
  structuredContent: data,
});
const fail = (text) => ({
  content: [{ type: 'text', text }],
  structuredContent: { error: text, mood: 'confused' },
  isError: true,
});

// Builds a sequential schedule and trims it until it fits the day.
function buildPlan(pending, startMin) {
  const sorted = [...pending].sort((a, b) => a.minutes - b.minutes || a.id - b.id); // quick wins first
  const schedule = [];
  let t = startMin;
  for (const task of sorted) {
    schedule.push({ id: task.id, title: task.title, minutes: task.minutes, start: hhmm(t), end: hhmm(t + task.minutes) });
    t += task.minutes + BREAK_MINUTES;
  }
  const totalMinutes = sorted.reduce((a, x) => a + x.minutes, 0);
  const endMin = schedule.length ? t - BREAK_MINUTES : startMin;
  const overbooked = totalMinutes > WORKDAY_MINUTES || endMin > LATEST_END || sorted.length > MAX_PENDING;

  // Suggest moving the longest tasks to tomorrow until the day fits.
  const moveIds = [];
  if (overbooked) {
    const byLength = [...sorted].sort((a, b) => b.minutes - a.minutes);
    let keep = [...sorted];
    for (const cand of byLength) {
      const total = keep.reduce((a, x) => a + x.minutes, 0);
      const end = startMin + total + BREAK_MINUTES * Math.max(0, keep.length - 1);
      if (total <= WORKDAY_MINUTES && end <= LATEST_END && keep.length <= MAX_PENDING) break;
      moveIds.push(cand.id);
      keep = keep.filter((x) => x.id !== cand.id);
    }
  }
  return { schedule, totalMinutes, overbooked, moveIds };
}

// ---------- tool definitions ----------
export const TOOLS = [
  {
    name: 'add_task',
    title: 'Add a task',
    description: 'Add a task to the user\'s plan for today. Use when the user wants to remember or schedule something.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task name, max 120 characters' },
        minutes: { type: 'integer', minimum: 5, maximum: 480, description: 'Estimated minutes (default 30)' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run(args, s) {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) return fail('A task needs a title.');
      if (title.length > 120) return fail('Task title is too long (max 120 characters).');
      let minutes = args.minutes === undefined ? 30 : args.minutes;
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) return fail('Minutes must be a whole number from 5 to 480.');
      if (s.tasks.length >= MAX_TASKS) s.tasks = pendingOf(s); // drop finished tasks to make room
      if (s.tasks.length >= MAX_TASKS) return fail('Too many open tasks. Finish or clear some first.');
      const task = { id: s.nextId++, title, minutes, status: 'pending' };
      s.tasks.push(task);
      const pending = pendingOf(s);
      const totalMinutes = pending.reduce((a, x) => a + x.minutes, 0);
      const overbooked = totalMinutes > WORKDAY_MINUTES || pending.length > MAX_PENDING;
      const mood = overbooked ? 'concerned' : 'happy';
      const text = overbooked
        ? `Added "${title}". That makes ${pending.length} open tasks (${totalMinutes} min), which is a lot for one day.`
        : `Added "${title}" (${minutes} min). ${pending.length} open task${pending.length === 1 ? '' : 's'} today.`;
      return ok(text, { task, openCount: pending.length, totalMinutes, overbooked, mood });
    },
  },
  {
    name: 'plan_day',
    title: 'Plan the day',
    description: 'Build a time-ordered schedule from open tasks and flag whether the day is overbooked.',
    inputSchema: {
      type: 'object',
      properties: { start: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'Start time HH:MM (default 09:00)' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run(args, s) {
      const start = args.start === undefined ? '09:00' : args.start;
      if (typeof start !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) return fail('Start must look like 09:00.');
      const startMin = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
      const pending = pendingOf(s);
      if (!pending.length) {
        return ok('Your plan is empty. Add a task to begin.', { schedule: [], totalMinutes: 0, overbooked: false, moveIds: [], mood: 'encouraging' });
      }
      const p = buildPlan(pending, startMin);
      const mood = p.overbooked ? 'concerned' : 'encouraging';
      const lines = p.schedule.map((x) => `${x.start}-${x.end} ${x.title}`).join('; ');
      const text = p.overbooked
        ? `This day is overbooked. Consider moving ${p.moveIds.length} task${p.moveIds.length === 1 ? '' : 's'} to tomorrow. Schedule: ${lines}`
        : `Here is a plan that fits: ${lines}`;
      return ok(text, { ...p, mood });
    },
  },
  {
    name: 'complete_task',
    title: 'Complete a task',
    description: 'Mark an open task as done, by id or by words in its title. Updates the daily streak.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Task id' },
        title: { type: 'string', description: 'Part of the task title' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run(args, s, ctx) {
      const pending = pendingOf(s);
      let match;
      if (Number.isInteger(args.id)) {
        match = pending.filter((t) => t.id === args.id);
      } else if (typeof args.title === 'string' && args.title.trim()) {
        const q = args.title.trim().toLowerCase();
        match = pending.filter((t) => t.title.toLowerCase().includes(q));
      } else {
        return fail('Tell me which task: give an id or part of its title.');
      }
      if (match.length === 0) return fail('I could not find an open task like that.');
      if (match.length > 1) return fail('More than one task matches: ' + match.map((t) => `#${t.id} ${t.title}`).join(', ') + '. Please use the id.');
      const task = match[0];
      task.status = 'done';
      const today = localDate(ctx);
      if (!s.doneDates.includes(today)) s.doneDates.push(today);
      s.doneDates = s.doneDates.slice(-60);
      const streak = streakOf(s.doneDates, today);
      const openCount = pendingOf(s).length;
      const text = openCount
        ? `Done: "${task.title}". ${openCount} to go. Streak: ${streak} day${streak === 1 ? '' : 's'}.`
        : `Done: "${task.title}". Your day is clear! Streak: ${streak} day${streak === 1 ? '' : 's'}.`;
      return ok(text, { task, openCount, dayCleared: openCount === 0, streak, mood: 'celebrating' });
    },
  },
  {
    name: 'get_streak',
    title: 'Get streak',
    description: 'Report how many days in a row the user has completed at least one task.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run(_args, s, ctx) {
      const today = localDate(ctx);
      const streak = streakOf(s.doneDates, today);
      const doneToday = s.doneDates.includes(today);
      const openCount = pendingOf(s).length;
      let mood = 'encouraging';
      if (doneToday) mood = streak >= 3 ? 'celebrating' : 'happy';
      const text = streak === 0
        ? 'No streak yet. Finish one task today to start it.'
        : doneToday
          ? `Streak: ${streak} day${streak === 1 ? '' : 's'}. Nice work today!`
          : `Streak: ${streak} day${streak === 1 ? '' : 's'}. Finish one task today to keep it going.`;
      return ok(text, { streak, doneToday, openCount, mood });
    },
  },
];

export const READ_ONLY = new Set(TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name));
