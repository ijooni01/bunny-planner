// Scripted fallback brain. Works with no AI key and no network.
// parseIntent() is pure; runScripted() calls the planner tools and writes the reply in the bunny's voice.

export const MOODS = ['idle', 'listening', 'thinking', 'happy', 'excited', 'confused', 'concerned', 'encouraging', 'celebrating', 'sleepy'];

const MAX_ITEMS = 5;

function extractMinutes(text) {
  let out = text;
  let minutes = null;
  const hr = out.match(/\b(?:for\s+|about\s+|around\s+)?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i);
  if (hr) {
    minutes = Math.round(parseFloat(hr[1]) * 60);
    out = out.replace(hr[0], ' ');
  }
  const mn = out.match(/\b(?:for\s+|about\s+|around\s+)?(\d+)\s*(?:minutes?|mins?|m)\b/i);
  if (mn) {
    minutes = (minutes || 0) + parseInt(mn[1], 10);
    out = out.replace(mn[0], ' ');
  }
  if (minutes === null) {
    const half = out.match(/\b(?:for\s+)?half an hour\b/i);
    const one = out.match(/\b(?:for\s+)?an hour\b/i);
    if (half) {
      minutes = 30;
      out = out.replace(half[0], ' ');
    } else if (one) {
      minutes = 60;
      out = out.replace(one[0], ' ');
    }
  }
  return { minutes, text: out.replace(/\s+/g, ' ').trim() };
}

function cleanTitle(s) {
  s = s.replace(/^["'\u201c\u2018\s]+|["'\u201d\u2019\s.!?]+$/g, '');
  s = s.replace(/\s+(?:to|on|in|for)\s+(?:my\s+)?(?:list|plan|todo|to-do|day|today|schedule)$/i, '');
  s = s.replace(/^(?:a\s+)?(?:new\s+)?task[:\s]+/i, '');
  s = s.trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function parseStart(l) {
  const m = l.match(/\b(?:start(?:ing)?(?:\s+at)?|from|at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return undefined;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

export function parseIntent(raw) {
  const s = String(raw).trim().replace(/\s+/g, ' ');
  const l = s.toLowerCase();
  let m;

  if (/^(help|commands?)\b/.test(l) || /\bwhat can you do\b/.test(l) || /\bhow (do|does) (this|it|you) work\b/.test(l)) return { intent: 'help' };
  if (/\bstreak\b|\bhow many days\b|\bin a row\b/.test(l)) return { intent: 'streak' };

  // complete: by id ("done #3"), "mark X as done", "finished X", or bare "done"
  if ((m = l.match(/(?:#|\btask\s+)(\d+)/)) && /\b(done|finish(?:ed)?|complete(?:d)?|did|check(?:ed)? off|mark)\b/.test(l)) {
    return { intent: 'complete', id: parseInt(m[1], 10) };
  }
  if ((m = s.match(/^mark\s+(?:the\s+|my\s+)?(.+?)\s+(?:as\s+)?(?:done|complete(?:d)?)[.!]*$/i))) {
    return { intent: 'complete', title: cleanTitle(m[1]) };
  }
  if (/^(done|finished|completed)[.!]*$/.test(l)) return { intent: 'complete', ask: true };
  if ((m = s.match(/^(?:i(?:'ve| have)?\s+)?(?:just\s+)?(?:finished|finish|completed|complete|done with|done|did|checked off|check off|ticked off|tick off)\s+(?!you\b|we\b|i\b)(?:with\s+)?(?:the\s+|my\s+)?(.+?)(?:\s+as done)?[.!]*$/i))) {
    return { intent: 'complete', title: cleanTitle(m[1]) };
  }

  // add
  if ((m = s.match(/^(?:(?:can|could) you\s+)?(?:please\s+|pls\s+)?(?:add|put|remind me to|i need to|i have to|i must|i should|i want to|todo|task)(?::|\s)\s*(.+)$/i))) {
    const rest = m[1].trim();
    if (/^(?:my\s+|the\s+)?(?:day|today|schedule|plan)$/i.test(rest)) return { intent: 'plan', start: parseStart(l) };
    const parts = rest.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
    const items = [];
    for (const part of parts) {
      const { minutes, text } = extractMinutes(part);
      const title = cleanTitle(text);
      if (!title || /^(?:a\s+|some\s+|\d+\s+)?tasks?$/i.test(title)) continue;
      items.push(minutes === null ? { title } : { title, minutes });
    }
    if (!items.length) return { intent: 'add_ask' };
    return { intent: 'add', items: items.slice(0, MAX_ITEMS), truncated: items.length > MAX_ITEMS };
  }

  if (/\b(plan|agenda|schedule|my day|today'?s list|to-?do list|what(?:'s| is)(?: on)?(?: my)? (?:plan|list|today|agenda)|what do i have|what should i do)\b/.test(l)) {
    return { intent: 'plan', start: parseStart(l) };
  }
  if (/\b(tired|sleepy|exhausted|good ?night|going to (?:bed|sleep)|bedtime)\b/.test(l)) return { intent: 'tired' };
  if (/^(hi|hello|hey|hiya|yo|good (?:morning|afternoon|evening))\b/.test(l)) return { intent: 'greeting' };
  if (/\b(thanks|thank you|thx)\b/.test(l)) return { intent: 'thanks' };
  return { intent: 'unknown' };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const EXAMPLES = 'Try "add read chapter 3 for 45 min", "plan my day", "finished read chapter" or "how is my streak?"';

const toolFailure = (res) => ({ reply: `Hmm, ${lowerFirst(res.structuredContent?.error || 'something went wrong')}`, mood: 'confused' });
const lowerFirst = (t) => (t ? t[0].toLowerCase() + t.slice(1) : t);

// callTool(name, args) -> MCP tool result ({content, structuredContent, isError})
export async function runScripted(message, callTool) {
  const p = parseIntent(message);
  switch (p.intent) {
    case 'help':
      return { reply: `I'm your planner bunny. I can add tasks, build your day, mark things done and track your streak. ${EXAMPLES}.`, mood: 'encouraging' };
    case 'greeting':
      return { reply: 'Hi there! Ready to plan your day? Tell me what you would like to get done.', mood: 'happy' };
    case 'thanks':
      return { reply: 'Any time! I am happy to help.', mood: 'happy' };
    case 'tired':
      return { reply: 'Rest well. Your list is safe with me, and we can pick it up tomorrow.', mood: 'sleepy' };
    case 'add_ask':
      return { reply: 'What would you like to add? For example: "add study math for 45 min".', mood: 'listening' };
    case 'unknown':
      return { reply: `I'm in offline mode right now, so I only know planning. ${EXAMPLES}.`, mood: 'confused' };

    case 'add': {
      const done = [];
      let last = null;
      for (const it of p.items) {
        const r = await callTool('add_task', it);
        if (r.isError) {
          if (!done.length) return toolFailure(r);
          return { reply: `Added ${done.join(', ')}, but "${it.title}" didn't work: ${lowerFirst(r.structuredContent.error)}`, mood: 'confused' };
        }
        done.push(`"${r.structuredContent.task.title}"`);
        last = r.structuredContent;
      }
      const head = done.length === 1 ? `Got it! ${done[0]} is on your list (${last.task.minutes} min).` : `Got it! Added ${done.join(', ')}.`;
      const tail = last.overbooked
        ? ` That is ${plural(last.openCount, 'open task')} (${last.totalMinutes} min), which is a lot for one day. Want me to plan it and suggest what to move?`
        : ` ${plural(last.openCount, 'open task')} today.`;
      return { reply: head + (p.truncated ? ` (I took the first ${MAX_ITEMS}.)` : '') + tail, mood: last.mood, data: last };
    }

    case 'complete': {
      if (p.ask) return { reply: 'Which task did you finish? Tell me its name or its #id.', mood: 'listening' };
      const r = await callTool('complete_task', p.id !== undefined ? { id: p.id } : { title: p.title });
      if (r.isError) return toolFailure(r);
      const d = r.structuredContent;
      const tail = d.dayCleared ? ' Your day is clear!' : ` ${d.openCount} to go.`;
      return { reply: `Nice work! "${d.task.title}" is done.${tail} Streak: ${plural(d.streak, 'day')}.`, mood: d.mood, data: d };
    }

    case 'plan': {
      const r = await callTool('plan_day', p.start ? { start: p.start } : {});
      if (r.isError) return toolFailure(r);
      const d = r.structuredContent;
      if (!d.schedule.length) return { reply: 'Your plan is empty. Tell me something to add, like "add study math for 45 min".', mood: d.mood, data: d };
      const lines = d.schedule.map((x) => `${x.start}-${x.end}  ${x.title}`).join('\n');
      let reply = `Here is your day:\n${lines}`;
      if (d.overbooked) {
        const titles = d.moveIds.map((id) => d.schedule.find((x) => x.id === id)?.title).filter(Boolean);
        reply += `\n\nThis looks overbooked. I would move ${titles.length ? titles.map((t) => `"${t}"`).join(' and ') : 'a task'} to tomorrow.`;
      }
      return { reply, mood: d.mood, data: d };
    }

    case 'streak': {
      const r = await callTool('get_streak', {});
      if (r.isError) return toolFailure(r);
      return { reply: r.content[0].text, mood: r.structuredContent.mood, data: r.structuredContent };
    }
  }
  return { reply: `I'm in offline mode right now, so I only know planning. ${EXAMPLES}.`, mood: 'confused' };
}
