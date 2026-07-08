import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutputRenderer, distillStreamJson } from '../src/render.mjs';

// A fake terminal: collects every write so a test can inspect the painted output.
function fakeTerm() {
  const chunks = [];
  return { term: { write: (s) => chunks.push(s) }, out: () => chunks.join('') };
}

// Real-shaped claude stream-json events (the shape verified live 2026-07-08).
const SYS = '{"type":"system","subtype":"init","model":"claude-opus"}';
const DELTA = (t) => `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":${JSON.stringify(t)}}}}`;
const TOOL = (n) => `{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":${JSON.stringify(n)}}}}`;
const RESULT = (o) => JSON.stringify({ type: 'result', subtype: 'success', ...o });

test('createOutputRenderer: paints a stream-json transcript, not raw JSON', () => {
  const { term, out } = fakeTerm();
  const r = createOutputRenderer(term);
  r.feed(`${SYS}\n${DELTA('Hello ')}\n${DELTA('world')}\n${TOOL('Bash')}\n${RESULT({ result: 'ignored', num_turns: 3, total_cost_usd: 0.0123 })}\n`);
  const text = out();
  assert.match(text, /Hello world/); // streamed assistant text
  assert.match(text, /⚙ Bash/); // tool-use marker
  assert.match(text, /\[session · claude-opus\]/); // system init
  assert.match(text, /\[done · 3 turns · \$0\.0123\]/); // final cost line
  assert.doesNotMatch(text, /"type":"stream_event"/, 'raw JSON must not leak through');
});

test('createOutputRenderer: command/plain output sniffs to raw and passes through unchanged', () => {
  const { term, out } = fakeTerm();
  const r = createOutputRenderer(term);
  r.feed('$ ls -la\r\ntotal 8\r\n');
  assert.equal(out(), '$ ls -la\r\ntotal 8\r\n'); // byte-for-byte, no rendering
});

test('createOutputRenderer: a command that merely prints JSON is NOT swallowed', () => {
  const { term, out } = fakeTerm();
  const r = createOutputRenderer(term);
  r.feed('{"foo":1}\n{"bar":2}\n'); // valid JSON but no stream-json `type`
  assert.equal(out(), '{"foo":1}\n{"bar":2}\n'); // rendered raw, nothing lost
});

test('createOutputRenderer: falls back to full assistant text blocks when no deltas', () => {
  const { term, out } = fakeTerm();
  const r = createOutputRenderer(term);
  const asst = '{"type":"assistant","message":{"content":[{"type":"text","text":"Full answer"}]}}';
  r.feed(`${SYS}\n${asst}\n${RESULT({ num_turns: 1 })}\n`);
  assert.match(out(), /Full answer/);
});

test('createOutputRenderer: result text is painted when no assistant text was seen', () => {
  const { term, out } = fakeTerm();
  const r = createOutputRenderer(term);
  r.feed(`${SYS}\n${RESULT({ result: 'The final answer', num_turns: 1 })}\n`);
  assert.match(out(), /The final answer/);
});

test('createOutputRenderer: a trailing event split across feeds with no final newline is painted on flush', () => {
  const { term, out } = fakeTerm();
  const r = createOutputRenderer(term);
  r.feed(`${SYS}\n`); // a complete first line classifies the stream as json
  assert.match(out(), /\[session/);
  // The final event streams in WITHOUT a trailing newline, split across frames.
  r.feed('{"type":"result","subtype":"success","result":"hi",');
  r.feed('"num_turns":1}');
  assert.doesNotMatch(out(), /hi/); // buffered until flush — no newline yet
  r.flush();
  assert.match(out(), /hi/);
  assert.match(out(), /\[done/);
});

test('distillStreamJson: pulls the result text out of a JSONL tail', () => {
  const raw = `${SYS}\n${DELTA('partial…')}\n${RESULT({ result: 'You have reached your usage limit', num_turns: 2 })}\n`;
  assert.equal(distillStreamJson(raw), 'You have reached your usage limit');
});

test('distillStreamJson: annotates an error subtype', () => {
  const raw = `${RESULT({ subtype: 'error_max_turns', result: 'stopped early' })}\n`;
  assert.equal(distillStreamJson(raw), '[error_max_turns] stopped early');
});

test('distillStreamJson: uses assistant text when there is no result', () => {
  const raw = `${DELTA('the answer so far')}\n`;
  assert.equal(distillStreamJson(raw), 'the answer so far');
});

test('distillStreamJson: robust to a truncated leading partial line (tail cut at a KB boundary)', () => {
  // The tail is only the last few KB, so its first line is usually a fragment.
  const raw = `_delta","text":"x"}}}\n${RESULT({ result: 'The real error is here' })}\n`;
  assert.equal(distillStreamJson(raw), 'The real error is here');
});

test('distillStreamJson: returns null for plain command output (caller falls back to raw distill)', () => {
  assert.equal(distillStreamJson('make: *** [build] Error 2\nnpm ERR! exit 1\n'), null);
  assert.equal(distillStreamJson('{"foo":1}\n'), null); // JSON but not a stream-json type
  assert.equal(distillStreamJson(''), null);
  assert.equal(distillStreamJson(null), null);
});
