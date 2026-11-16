# Third-Party Notices

RouterSync is distributed under the MIT licence. It depends on the packages
listed below, which keep their own licences.

The table was produced with `pnpm licenses list --prod --json` over the root
package and every workspace package, then grouped by licence.

## Summary

| giấy phép | số gói |
|---|---|
| MIT | 89 |
| ISC | 8 |
| OFL-1.1 | 2 |
| BSD-3-Clause | 2 |
| BSD-2-Clause | 1 |

Total: **102** production packages, **5** distinct licences.

**No GPL, AGPL, LGPL or unknown-licence package is in the production
dependency tree.** The two OFL-1.1 entries are the web-interface fonts
(`@fontsource/jetbrains-mono`, `@fontsource/plus-jakarta-sans`), which are
bundled into the user interface build.

## Details

### MIT (89 packages)

`@hono/node-server`, `@modelcontextprotocol/sdk`, `accepts`, `ajv`,
`ajv-formats`, `better-sqlite3`, `body-parser`, `bytes`,
`call-bind-apply-helpers`, `call-bound`, `commander`, `content-disposition`,
`content-type`, `cookie`, `cookie-signature`, `cors`, `cross-spawn`, `debug`,
`depd`, `dunder-proto`, `ee-first`, `encodeurl`, `es-define-property`,
`es-errors`, `es-object-atoms`, `escape-html`, `etag`, `eventsource`,
`eventsource-parser`, `express`, `express-rate-limit`, `fast-deep-equal`,
`finalhandler`, `forwarded`, `fresh`, `function-bind`, `get-intrinsic`,
`get-proto`, `gopd`, `has-symbols`, `hasown`, `hono`, `http-errors`,
`iconv-lite`, `ip-address`, `ipaddr.js`, `is-promise`, `jose`, `js-tokens`,
`json-schema-traverse`, `loose-envify`, `math-intrinsics`, `media-typer`,
`merge-descriptors`, `mime-db`, `mime-types`, `ms`, `negotiator`,
`node-addon-api`, `object-assign`, `object-inspect`, `on-finished`,
`parseurl`, `path-key`, `path-to-regexp`, `pkce-challenge`, `proxy-addr`,
`range-parser`, `raw-body`, `react`, `react-dom`, `require-from-string`,
`router`, `safer-buffer`, `scheduler`, `send`, `serve-static`,
`shebang-command`, `shebang-regex`, `side-channel`, `side-channel-list`,
`side-channel-map`, `side-channel-weakmap`, `statuses`, `toidentifier`,
`type-is`, `unpipe`, `vary`, `zod`

### ISC (8 packages)

`inherits`, `isexe`, `once`, `setprototypeof`, `which`, `wrappy`, `yaml`,
`zod-to-json-schema`

### OFL-1.1 (2 packages)

`@fontsource/jetbrains-mono`, `@fontsource/plus-jakarta-sans`

### BSD-3-Clause (2 packages)

`fast-uri`, `qs`

### BSD-2-Clause (1 package)

`json-schema-typed`

## Dev-only dependencies

The test and build tooling is not shipped with the published packages. It is
licensed under permissive terms as well (Apache-2.0, BSD-2-Clause,
BSD-3-Clause, ISC, MIT and CC0-1.0); run `pnpm licenses list` for the full
list including development dependencies.

## How to reproduce

```bash
pnpm licenses list --prod --json
```
