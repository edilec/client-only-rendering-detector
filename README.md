# Client-Only Rendering Detector

An offline, read-only comparison of exported server HTML and a **separately captured local render snapshot** for configured essential headings, text and links. The tool never opens a browser, fetches a page, runs scripts, or changes a site. Its result is limited by the completeness and trustworthiness of the supplied capture.

Requires Node.js 22 or later. No dependencies or network access.

## Run

```sh
node bin/client-only-rendering-detector.mjs --root examples/passing --server server.html --render render.json --config config.json
node bin/client-only-rendering-detector.mjs --root examples/failing --server server.html --render render.json --config config.json
npm run check
```

The passing command exits 0; the failing command exits 1 with `client-only-essential` for the first configured item. Use `--out report.json` to save the same JSON report in the evidence root, or `--human` for a short stderr summary. The JSON report is always sent to stdout unless output destination validation fails. Bad CLI configuration and refused output destinations exit 2 with empty stdout.

## Evidence

All file arguments are relative to `--root`; resolved files must remain inside its real path. Files are strict UTF-8. The server file is exported HTML, never a URL. The render JSON must have `schemaVersion:"1"`, `complete:true`, `headings:[string]`, `text:[string]`, and `links:[{href,text}]`. The config JSON must have `schemaVersion:"1"`, `essentials:[{id,kind,text,href?}]`, and `exclusions:[{id,reason}]`. Kinds are `heading`, `text`, and `link`; links require an exact `href`. Exclusion reasons are exactly `consent-controlled` or `intentionally-deferred`, and must name a configured essential ID. Only those explicit exclusions are skipped.

The HTML reader extracts body text, headings and anchor labels/targets; head metadata, comments, and script/style/template bodies do not count. It is a deliberately limited static scanner, not a full browser DOM. Unsupported or malformed HTML can produce incomplete evidence; it cannot establish actual user-visible rendering or timing. If a capture is partial, declare `complete:false`; it will never pass.

## Rules and exits

| Exit | Rule | Meaning |
| --- | --- | --- |
| 0 | none | Every evaluated essential appears in both evidence sources. |
| 1 | `client-only-essential` | Present only in captured render evidence. |
| 1 | `render-missing-essential` | Present only in server HTML. |
| 2 | `essential-unobserved`, `no-evaluable-essential` | No defensible conclusion for one or all essentials. |
| 2 | `config-invalid`, `config-incomplete`, `render-invalid`, `render-incomplete`, `essential-invalid`, `essential-duplicate`, `exclusion-invalid`, `html-unparseable` | Evidence schema or parsing is uncertain. |
| 2 | `input-unreadable`, `byte-limit`, `depth-limit`, `record-limit`, `time-limit` | Read, containment, or resource guard refused evaluation. |

Incomplete takes precedence over fail when both arise. Findings have fixed rule/messages and logical provenance (`@config` plus source ordinal pointer); raw configured text, links, paths, and HTML are never emitted. Ordering uses code-unit comparison.

## Limits and safety

Each input file and each library document is at most 1,048,576 UTF-8 bytes. At most 100 essentials, 20 exclusions, and 100 entries in each render array. JSON nesting depth is at most 3 (root = 0), with exact N accepted and N+1 refused. Evaluation uses a 5,000 ms injected-clock bound; exceeding it returns incomplete. Strings for IDs and essential/render text/links must contain visible content, reject bidi controls and disallowed control characters, and are at most 1,000 code units. Joiners or variation selectors within otherwise visible emoji or Indic text remain valid. Decoded HTML entities for bidi/disallowed controls make the server scan incomplete. Output writes are limited to a normal in-root destination; input aliases, symlink destinations, symlinked parent escapes, and input hard links are refused. Reports use fixed messages and bounded source ordinals rather than source values.

This does not test search indexing, accessibility trees, client behavior, browser timing, consent widgets, or network delivery. It is not a crawler or a substitute for a live browser audit.

## License

MIT. See [LICENSE](./LICENSE).
