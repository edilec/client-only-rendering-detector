import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRendering, TOOL_ID, LIMITS } from '../src/index.mjs';

const good = () => ({
  serverHtml: '<main><h1>Welcome</h1><p>Read the guide.</p><a href="/start">Get started</a></main>',
  render: { schemaVersion: '1', complete: true, headings: ['Welcome'], text: ['Read the guide.'], links: [{ href: '/start', text: 'Get started' }] },
  config: { schemaVersion: '1', essentials: [
    { id: 'heading', kind: 'heading', text: 'Welcome' },
    { id: 'summary', kind: 'text', text: 'Read the guide.' },
    { id: 'link', kind: 'link', text: 'Get started', href: '/start' }
  ], exclusions: [] }
});

test('essential heading, text and link present in server and render evidence pass', () => {
  const result = compareRendering(good());
  assert.equal(TOOL_ID, 'client-only-rendering-detector');
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.summary, { checked: 3, excluded: 0, errors: 0, warnings: 0 });
  assert.deepEqual(result.findings, []);
});

const rules = report => report.findings.map(f => f.ruleId);

test('essential heading found only after local render fails with ordinal provenance', () => {
  const input = good(); input.serverHtml = '<main><p>Read the guide.</p><a href="/start">Get started</a></main>';
  const result = compareRendering(input);
  assert.equal(result.status, 'fail');
  assert.deepEqual(rules(result), ['client-only-essential']);
  assert.equal(result.findings[0].essentialId, 'essential-1');
  assert.equal(result.findings[0].location.pointer, '/essentials/0');
  assert.ok(!JSON.stringify(result).includes('Welcome'));
});

test('explicit consent and deferred exclusions allow a clean report without hiding other essentials', () => {
  const input = good();
  input.config.essentials.push({ id: 'consent', kind: 'text', text: 'Consent copy' }, { id: 'deferred', kind: 'link', text: 'Later', href: '/later' });
  input.render.text.push('Consent copy'); input.render.links.push({ href: '/later', text: 'Later' });
  input.config.exclusions = [{ id: 'consent', reason: 'consent-controlled' }, { id: 'deferred', reason: 'intentionally-deferred' }];
  const result = compareRendering(input);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.summary, { checked: 3, excluded: 2, errors: 0, warnings: 0 });
  assert.deepEqual(result.findings, []);
  input.config.exclusions[0].reason = 'unknown';
  assert.deepEqual(rules(compareRendering(input)), ['exclusion-invalid']);
});

test('all excluded or absent from both snapshots is incomplete, never a vacuous pass', () => {
  const allExcluded = good(); allExcluded.config.essentials = [allExcluded.config.essentials[0]];
  allExcluded.config.exclusions = [{ id: 'heading', reason: 'consent-controlled' }];
  assert.deepEqual(rules(compareRendering(allExcluded)), ['no-evaluable-essential']);
  const missing = good(); missing.config.essentials[0].text = 'Not in either snapshot';
  assert.equal(compareRendering(missing).status, 'incomplete');
  assert.ok(rules(compareRendering(missing)).includes('essential-unobserved'));
});

test('content lost after rendering fails and script/comment text cannot count as server content', () => {
  const lost = good(); lost.render.headings = [];
  assert.equal(compareRendering(lost).status, 'fail');
  assert.deepEqual(rules(compareRendering(lost)), ['render-missing-essential']);
  const script = good(); script.serverHtml = '<main><script>private-marker</script><!-- private-marker --></main>';
  script.config.essentials = [{ id: 'text', kind: 'text', text: 'private-marker' }];
  script.render = { schemaVersion: '1', complete: true, headings: [], text: ['private-marker'], links: [] };
  const result = compareRendering(script);
  assert.equal(result.status, 'fail');
  assert.deepEqual(rules(result), ['client-only-essential']);
  assert.ok(!JSON.stringify(result).includes('private-marker'));
});

test('link targets compare exactly and common HTML entities decode in visible headings', () => {
  const link = good(); link.serverHtml = '<h1>Welcome</h1><p>Read the guide.</p><a href="/other">Get started</a>';
  assert.deepEqual(rules(compareRendering(link)), ['client-only-essential']);
  const entity = good(); entity.serverHtml = '<h1>A &amp; B</h1><p>Read the guide.</p><a href="/start">Get started</a>';
  entity.render.headings[0] = 'A & B'; entity.config.essentials[0].text = 'A & B';
  assert.equal(compareRendering(entity).status, 'pass');
});

test('partial render or malformed HTML produces incomplete evidence, not guessed delay', () => {
  const partial = good(); partial.render.complete = false;
  assert.deepEqual(rules(compareRendering(partial)), ['render-incomplete']);
  assert.equal(compareRendering(partial).summary.checked, 0);
  const malformed = good(); malformed.serverHtml = '<h1>Welcome';
  assert.deepEqual(rules(compareRendering(malformed)), ['html-unparseable']);
});

test('essential 10 sorts before essential 2 by code unit', () => {
  const input = good(); input.config.essentials = Array.from({ length: 11 }, (_, i) => ({ id: `e-${i}`, kind: 'heading', text: i === 2 || i === 10 ? 'Delayed' : 'Welcome' }));
  input.render.headings.push('Delayed');
  const result = compareRendering(input);
  assert.deepEqual(result.findings.map(f => f.location.pointer), ['/essentials/10', '/essentials/2']);
});

test('record, depth, and injected time bounds accept N and refuse N+1', () => {
  const input = good(); input.config.essentials = Array.from({ length: LIMITS.essentials }, (_, i) => ({ id: `e-${i}`, kind: 'heading', text: 'Welcome' }));
  assert.equal(compareRendering(input).status, 'pass');
  input.config.essentials.push({ id: 'extra', kind: 'heading', text: 'Welcome' });
  assert.deepEqual(rules(compareRendering(input)), ['record-limit']);
  input.config.essentials.pop(); input.config.exclusions = input.config.essentials.slice(0, LIMITS.exclusions).map(x => ({ id: x.id, reason: 'consent-controlled' }));
  assert.equal(compareRendering(input).status, 'pass');
  input.config.exclusions.push({ id: 'e-20', reason: 'consent-controlled' });
  assert.deepEqual(rules(compareRendering(input)), ['record-limit']);
  const render = good(); render.render.headings = Array(LIMITS.renderItems).fill('Welcome');
  render.render.text = Array(LIMITS.renderItems).fill('Read the guide.');
  render.render.links = Array.from({ length: LIMITS.renderItems }, () => ({ href: '/start', text: 'Get started' }));
  assert.equal(compareRendering(render).status, 'pass');
  render.render.links.push({ href: '/start', text: 'Get started' });
  assert.deepEqual(rules(compareRendering(render)), ['record-limit']);
  const nested = good(); assert.equal(compareRendering(nested).status, 'pass');
  nested.render.links[0].extra = { tooDeep: true };
  assert.deepEqual(rules(compareRendering(nested)), ['depth-limit']);
  const exact = [0, LIMITS.milliseconds];
  assert.equal(compareRendering(good(), { now: () => exact.shift() ?? LIMITS.milliseconds }).status, 'pass');
  const late = [0, LIMITS.milliseconds + 1];
  assert.deepEqual(rules(compareRendering(good(), { now: () => late.shift() ?? LIMITS.milliseconds + 1 })), ['time-limit']);
});

test('declared 1000-code-unit value bound accepts N and refuses N+1', () => {
  const input = good();
  input.config.essentials[0].id = 'x'.repeat(1000);
  assert.equal(compareRendering(input).status, 'pass');
  input.config.essentials[0].id += 'x';
  assert.deepEqual(rules(compareRendering(input)), ['essential-invalid']);
  const render = good(); render.render.headings[0] = 'x'.repeat(1001);
  assert.deepEqual(rules(compareRendering(render)), ['render-invalid']);
});

test('unsupported HTML entities and mismatched essential tags are incomplete', () => {
  const entity = good(); entity.serverHtml = '<h1>A &copy; B</h1>';
  assert.deepEqual(rules(compareRendering(entity)), ['html-unparseable']);
  const tags = good(); tags.serverHtml = '<h1>Welcome</h2>';
  assert.deepEqual(rules(compareRendering(tags)), ['html-unparseable']);
});

test('head metadata never counts as visible server content', () => {
  const input = good();
  input.serverHtml = '<html><head><title>Account balance</title></head><body></body></html>';
  input.config.essentials = [{ id: 'balance', kind: 'text', text: 'Account balance' }];
  input.render = { schemaVersion: '1', complete: true, headings: [], text: ['Account balance'], links: [] };
  assert.deepEqual(rules(compareRendering(input)), ['client-only-essential']);
});

test('invisible controls cannot become passing essentials or render evidence', () => {
  const input = good();
  input.serverHtml = '<h1>&#8206;</h1>';
  input.config.essentials = [{ id: 'heading', kind: 'heading', text: '\u200e' }];
  input.render = { schemaVersion: '1', complete: true, headings: ['\u200e'], text: [], links: [] };
  assert.deepEqual(rules(compareRendering(input)), ['essential-invalid']);
  input.config.essentials[0].text = 'Visible';
  assert.deepEqual(rules(compareRendering(input)), ['render-invalid']);
  input.render.headings[0] = 'Visible';
  assert.deepEqual(rules(compareRendering(input)), ['html-unparseable']);
});
