export const TOOL_ID = 'client-only-rendering-detector';
export const LIMITS = Object.freeze({ bytes: 1_048_576, essentials: 100, exclusions: 20, renderItems: 100, depth: 3, milliseconds: 5000 });

const UNKNOWN = new Set(['input-unreadable', 'config-invalid', 'config-incomplete', 'render-invalid', 'render-incomplete', 'html-unparseable', 'byte-limit', 'depth-limit', 'record-limit', 'time-limit', 'essential-invalid', 'essential-duplicate', 'exclusion-invalid', 'no-evaluable-essential', 'essential-unobserved']);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const safeText = v => !/[\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(v);
const nonempty = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 1000 && safeText(v);
const norm = v => v.replace(/\s+/gu, ' ').trim();
const finding = (ruleId, pointer = '', essentialId) => ({
  ruleId, severity: 'error',
  message: { 'client-only-essential': 'Essential content appears only in rendered evidence.', 'render-missing-essential': 'Essential content is missing from rendered evidence.', 'essential-unobserved': 'Essential content appears in neither evidence source.' }[ruleId] ?? 'Evidence cannot be evaluated safely.',
  location: { file: '@config', pointer },
  ...(essentialId ? { essentialId } : {})
});
function report(findings, checked = 0, excluded = 0) {
  findings.sort((a, b) => order(a.location.file, b.location.file) || order(a.location.pointer, b.location.pointer) || order(a.ruleId, b.ruleId));
  return { schemaVersion: '1', tool: TOOL_ID, status: findings.some(f => UNKNOWN.has(f.ruleId)) ? 'incomplete' : findings.length ? 'fail' : 'pass', summary: { checked, excluded, errors: findings.length, warnings: 0 }, findings };
}
export function incomplete(ruleId, file) {
  const result = report([finding(ruleId)]);
  result.findings[0].location.file = file;
  return result;
}
function tooDeep(v, depth = 0) {
  if (depth > LIMITS.depth) return true;
  if (v === null || typeof v !== 'object') return false;
  return Object.values(v).some(x => tooDeep(x, depth + 1));
}
function decode(v) {
  return v.replace(/&([^;\s&]+);/gu, (_, entity) => {
    const e = entity.toLowerCase();
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (e in named) return named[e];
    if (!/^#(?:x[\da-f]+|\d+)$/iu.test(e)) throw new Error('unsupported entity');
    const n = e.startsWith('#x') ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    if (!(n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff))) throw new Error('invalid entity');
    return String.fromCodePoint(n);
  });
}
function parseHtml(html, expired) {
  const headings = [], links = [], visible = [];
  let heading = null, anchor = null, i = 0;
  const append = raw => {
    const value = decode(raw);
    if (!safeText(value)) throw new Error('invisible or control content');
    visible.push(value);
    if (heading) heading.parts.push(value);
    if (anchor) anchor.parts.push(value);
  };
  while (i < html.length) {
    if (expired()) return null;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end < 0) return null;
      i = end + 3; continue;
    }
    if (html[i] !== '<') {
      let end = html.indexOf('<', i);
      if (end < 0) end = html.length;
      append(html.slice(i, end)); i = end; continue;
    }
    let end = i + 1, quote = null;
    while (end < html.length) {
      const c = html[end];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      end++;
    }
    if (end >= html.length) return null;
    const raw = html.slice(i + 1, end).trim(); i = end + 1;
    if (/^!doctype\b/i.test(raw)) continue;
    if (raw.startsWith('!') || raw.startsWith('?')) return null;
    const m = raw.match(/^(\/)?([a-z][\w:-]*)([\s\S]*)$/i);
    if (!m) return null;
    const closing = Boolean(m[1]), tag = m[2].toLowerCase();
    if (!closing && ['head', 'script', 'style', 'template'].includes(tag)) {
      const re = new RegExp(`</${tag}\\s*>`, 'ig'); re.lastIndex = i;
      const found = re.exec(html);
      if (!found) return null;
      i = re.lastIndex; continue;
    }
    if (closing) {
      if (/^h[1-6]$/.test(tag) && heading) { if (tag !== heading.tag) return null; headings.push(norm(heading.parts.join(''))); heading = null; }
      if (tag === 'a' && anchor) { links.push({ href: anchor.href, text: norm(anchor.parts.join('')) }); anchor = null; }
      continue;
    }
    if (/^h[1-6]$/.test(tag)) heading = { tag, parts: [] };
    if (tag === 'a') {
      const href = m[3].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      anchor = { href: href ? decode(href[1] ?? href[2]) : '', parts: [] };
    }
  }
  return heading || anchor ? null : { headings, links, text: norm(visible.join(' ')) };
}
export function compareRendering(input, { now = Date.now } = {}) {
  const start = now(), expired = () => now() - start > LIMITS.milliseconds;
  const stop = (ruleId, pointer = '') => report([finding(ruleId, pointer)]);
  if (!plain(input) || typeof input.serverHtml !== 'string' || !plain(input.config) || !plain(input.render)) return stop('config-invalid');
  if (expired()) return stop('time-limit');
  if ([input.serverHtml, JSON.stringify(input.config), JSON.stringify(input.render)].some(v => Buffer.byteLength(v, 'utf8') > LIMITS.bytes)) return stop('byte-limit');
  if (tooDeep(input.config) || tooDeep(input.render)) return stop('depth-limit');
  const { config, render } = input;
  if (config.schemaVersion !== '1' || !Array.isArray(config.essentials) || !Array.isArray(config.exclusions)) return stop('config-invalid');
  if (config.complete === false) return stop('config-incomplete');
  if (render.schemaVersion !== '1' || !Array.isArray(render.headings) || !Array.isArray(render.text) || !Array.isArray(render.links)) return stop('render-invalid');
  if (render.complete !== true) return stop('render-incomplete');
  if (config.essentials.length > LIMITS.essentials || config.exclusions.length > LIMITS.exclusions || [render.headings, render.text, render.links].some(v => v.length > LIMITS.renderItems)) return stop('record-limit');
  const ids = new Set(), exclusions = new Set();
  for (const [i, item] of config.essentials.entries()) {
    if (expired()) return stop('time-limit');
    if (!plain(item) || !nonempty(item.id) || !nonempty(item.text) || !['heading', 'text', 'link'].includes(item.kind) || (item.kind === 'link' && !nonempty(item.href))) return stop('essential-invalid', `/essentials/${i}`);
    if (ids.has(item.id)) return stop('essential-duplicate', `/essentials/${i}`);
    ids.add(item.id);
  }
  for (const [i, item] of config.exclusions.entries()) {
    if (expired()) return stop('time-limit');
    if (!plain(item) || !ids.has(item.id) || exclusions.has(item.id) || !['consent-controlled', 'intentionally-deferred'].includes(item.reason)) return stop('exclusion-invalid', `/exclusions/${i}`);
    exclusions.add(item.id);
  }
  if (!render.headings.every(nonempty) || !render.text.every(nonempty) || !render.links.every(v => plain(v) && nonempty(v.href) && nonempty(v.text))) return stop('render-invalid');
  let server;
  try { server = parseHtml(input.serverHtml, expired); } catch { return stop('html-unparseable'); }
  if (expired()) return stop('time-limit');
  if (!server) return stop('html-unparseable');
  const findings = []; let checked = 0;
  for (const [i, item] of config.essentials.entries()) {
    if (expired()) return stop('time-limit');
    if (exclusions.has(item.id)) continue;
    checked++;
    const target = norm(item.text);
    const onServer = item.kind === 'heading' ? server.headings.includes(target) : item.kind === 'text' ? server.text.includes(target) : server.links.some(v => v.href === item.href && v.text === target);
    const onRender = item.kind === 'heading' ? render.headings.some(v => norm(v) === target) : item.kind === 'text' ? norm(render.text.join(' ')).includes(target) : render.links.some(v => v.href === item.href && norm(v.text) === target);
    const rule = onServer && onRender ? null : onRender ? 'client-only-essential' : onServer ? 'render-missing-essential' : 'essential-unobserved';
    if (rule) findings.push(finding(rule, `/essentials/${i}`, `essential-${i + 1}`));
  }
  if (expired()) return stop('time-limit');
  if (!checked) findings.push(finding('no-evaluable-essential'));
  return report(findings, checked, exclusions.size);
}
