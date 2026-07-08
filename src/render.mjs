// Shared stream-json → readable-terminal renderer (DESIGN §22 monitor).
//
// AI steps run the provider in `--output-format stream-json` (providers.mjs), so
// their pty output is a stream of JSONL events, not a TUI. This module turns that
// stream into a readable live transcript. It is ENVIRONMENT-AGNOSTIC — pure
// string manipulation over a `write(str)` sink — so ONE implementation backs both
// the web console (xterm `term.write`, browser) and the CLI `taskherd attach`
// (`process.stdout.write`, a real TTY). Keeping it shared is why the two can't
// drift (DESIGN §3). No imports: node imports it from disk, serve serves it to the
// browser under the static allowlist.

// Known claude stream-json event types. The renderer sniffs the first event's
// `type` against this set — a command that merely prints `{…}` (no recognized
// type) still renders raw, so nothing is swallowed.
export const STREAM_JSON_TYPES = new Set(['system', 'stream_event', 'assistant', 'user', 'result', 'rate_limit_event']);

// Turns a step's raw output stream into terminal writes. Command / plain steps
// pass through byte-for-byte (full fidelity); an AI step's stream-json is parsed
// per event and painted as a readable LIVE transcript (assistant text as it
// streams, tool calls, retries, a final cost line) instead of raw JSON. The mode
// is sniffed once from the first event. `term` is any object with `write(str)`.
export function createOutputRenderer(term) {
  let mode = null; // null (sniffing) | 'raw' | 'json'
  let buf = '';
  let sawText = false;

  const paint = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { term.write(`${line}\r\n`); return; }
    const e = ev.event || {};
    if (ev.type === 'stream_event' && e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      sawText = true;
      term.write(e.delta.text.replace(/\n/g, '\r\n')); // assistant text, streaming in
    } else if (ev.type === 'stream_event' && e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
      term.write(`\r\n\x1b[36m⚙ ${e.content_block.name || 'tool'}\x1b[0m\r\n`);
    } else if (ev.type === 'assistant' && !sawText) {
      // Fallback if partial-message deltas aren't emitted: paint the full text blocks.
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text) { sawText = true; term.write(b.text.replace(/\n/g, '\r\n')); }
      }
    } else if (ev.type === 'system' && ev.subtype === 'init') {
      term.write(`\x1b[2m[session${ev.model ? ` · ${ev.model}` : ''}]\x1b[0m\r\n`);
    } else if (ev.type === 'rate_limit_event' || (ev.type === 'system' && ev.subtype === 'api_retry')) {
      term.write(`\r\n\x1b[33m[${ev.type === 'rate_limit_event' ? 'rate limit' : 'retry'}]\x1b[0m\r\n`);
    } else if (ev.type === 'result') {
      if (!sawText && ev.result) term.write(String(ev.result).replace(/\n/g, '\r\n'));
      const bits = [];
      if (ev.num_turns != null) bits.push(`${ev.num_turns} turns`);
      if (typeof ev.total_cost_usd === 'number') bits.push(`$${ev.total_cost_usd.toFixed(4)}`);
      term.write(`\r\n\x1b[2m[done${bits.length ? ` · ${bits.join(' · ')}` : ''}]\x1b[0m\r\n`);
    }
  };

  const drain = () => {
    let nl;
    // eslint-disable-next-line no-cond-assign
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.trim()) paint(line);
    }
  };

  return {
    feed(text) {
      if (mode === 'raw') { term.write(text); return; }
      buf += text;
      if (mode === null) {
        const lead = buf.replace(/^\s+/, '');
        if (!lead) return; // only whitespace so far — keep sniffing
        if (lead[0] !== '{') { mode = 'raw'; term.write(buf); buf = ''; return; }
        const nl = buf.indexOf('\n');
        if (nl === -1) return; // need the whole first line to classify it
        let first; try { first = JSON.parse(buf.slice(0, nl)); } catch { first = null; }
        if (!first || !STREAM_JSON_TYPES.has(first.type)) { mode = 'raw'; term.write(buf); buf = ''; return; }
        mode = 'json';
      }
      drain();
    },
    flush() { if (mode === 'json' && buf.trim()) { paint(buf); buf = ''; } },
  };
}

// Distill a PLAIN-TEXT (no ANSI) error/answer excerpt from a claude stream-json
// tail, for a parked failure's excerpt (executor extractErrorTail) shown in
// `status` and the console. Unlike the live renderer, this is static and
// ANSI-free (it is stored + HTML-rendered). Scans EVERY parseable known-type line
// (robust to a truncated leading line — the tail is only the last few KB, so its
// first line is usually a partial JSON fragment while the operative `result`
// event sits whole at the end). Returns null when the tail isn't stream-json, so
// the caller falls back to its raw ANSI-stripping distiller for command output.
export function distillStreamJson(raw) {
  if (!raw) return null;
  let found = false;
  let assistantText = '';
  let resultText = null;
  let note = null; // an error/retry subtype worth surfacing
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let ev; try { ev = JSON.parse(t); } catch { continue; }
    if (!STREAM_JSON_TYPES.has(ev.type)) continue;
    found = true;
    const e = ev.event || {};
    if (ev.type === 'stream_event' && e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      assistantText += e.delta.text;
    } else if (ev.type === 'assistant') {
      for (const b of ev.message?.content || []) if (b.type === 'text' && b.text) assistantText += b.text;
    } else if (ev.type === 'result') {
      if (ev.result != null) resultText = String(ev.result);
      if (ev.subtype && ev.subtype !== 'success') note = ev.subtype;
      else if (ev.is_error === true) note = 'error';
    } else if ((ev.type === 'system' && /error|api_/.test(ev.subtype || '')) || ev.type === 'rate_limit_event') {
      note = ev.type === 'rate_limit_event' ? 'rate limit' : ev.subtype;
    }
  }
  if (!found) return null;
  // Prefer the final result text; else the streamed assistant text.
  const body = (resultText && resultText.trim()) ? resultText.trim() : assistantText.trim();
  const parts = [];
  if (note) parts.push(`[${note}]`);
  if (body) parts.push(body);
  const out = parts.join(' ').trim();
  return out || null;
}
