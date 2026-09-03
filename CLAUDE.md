# lbk-deploy-translation

A published GitHub Action (`Vadko/lbk-deploy-translation@v1`) that uploads translation archives to the LBK Launcher public API. Five TypeScript files in `src/` (502 lines total) bundled by `@vercel/ncc` into a **committed** `dist/` that the Actions runtime executes; versioned by release-please with a force-moved `v1` tag. Runtime flow: `src/index.ts` → `run()` in `src/main.ts` → `POST /api/submit-via-token/uploads` → N parallel tus resumable uploads straight to Supabase Storage → `PUT /api/submit-via-token/games/{gameId}`.

## Commands

```bash
pnpm install --frozen-lockfile   # as CI does
pnpm all                         # typecheck → biome:check → test → build (exactly CI, in CI order)
pnpm typecheck                   # tsc --noEmit
pnpm biome:check                 # read-only; pnpm biome:fix writes
pnpm test                        # vitest run — src/**/*.test.ts
pnpm build                       # ncc build src/index.ts --out dist --source-map --license licenses.txt
pnpm build && git diff --exit-code dist   # the dist-freshness gate CI does NOT have
cp .env.example .env && pnpm test:local   # real end-to-end run against the real API
```

- `pnpm test:local` is `local-action . src/main.ts .env` — `@github/local-action` runs `src/main.ts` (never `dist/`), needs a **real** `lbk_` token and game UUID in `.env`, and **will really upload and submit**. `core.getInput` only uppercases the name (and maps spaces to `_`), so dashes survive: `INPUT_API-TOKEN`, `INPUT_GAME-ID`, `INPUT_STEAM-LINUX`.
- Find a game UUID (the Action never calls this endpoint itself): `curl -s https://admin.lbklauncher.com/api/submit-via-token/games -H "Authorization: Bearer $TOKEN" | jq '.games[] | {id, name}'`.

## dist/ and releases

- `dist/` is five committed generated files; `dist/index.js` alone is 2.2 MB and starts with `import './sourcemap-register.cjs';`. Runtime-required: `index.js`, `sourcemap-register.cjs`, and `package.json` (`{"type":"module"}`). `index.js.map` only feeds sourcemap-register's stack traces; `licenses.txt` is attribution. Never gitignore the first three.
- **Every commit touching `src/` must commit the regenerated `dist/` in the same commit.** `pnpm all` builds it but does not stage it; run `git add dist` yourself. All three historical dist commits (`f3886c7`, `45268b1`, `1759094`) were hand-made this way.
- CI (`.github/workflows/ci.yml`) runs `pnpm build` but **never diffs the result** — a stale bundle passes green. The only net is the `auto-build` job in `.github/workflows/release.yml`, which self-commits `chore: auto-build dist [skip ci]` on push to main; no such commit exists in history, so it has never fired, and it does nothing for PR branches or forks.
- Conventional Commits drive releases: `feat:` → minor, `fix:` → patch. Anything else (history has `format`, `update workspace file`) produces no release and no CHANGELOG line. Write plain commit messages — no AI co-author or attribution trailers.
- `.release-please-manifest.json` and `package.json` `version` are both written by release-please (both `1.2.0`); never hand-edit one without the other. `release-please-config.json` has no `extra-files`, so version strings elsewhere are not auto-updated.
- `bump-major-tag` force-moves `v1` to each new tag. `v1` and the newest `vX.Y.Z` must resolve to the same commit — today both are `7044c43`: `git for-each-ref --format='%(refname:short) %(objectname:short)' refs/tags`.
- Node 20 is declared in four places that must move together: `action.yml` `runs.using: node20`, `package.json` `engines` (`>=20`), and `node-version: 20` in both workflows. Only `action.yml` affects consumers' runners.

## Inputs and upload kinds

- `src/inputs.ts` declares `UPLOAD_KINDS` (8 kinds) and `KIND_INPUT: Record<UploadKind, string>`. `KIND_INPUT` is an identity map that exists purely so TypeScript fails when you extend `UPLOAD_KINDS` without updating it — do not "simplify" it away.
- Adding a kind touches five places, only two of which are type-checked: `action.yml` `inputs`, `UPLOAD_KINDS`, `KIND_INPUT`, the README inputs table, `.env.example` — then `pnpm build` + `git add dist`. Only `UPLOAD_KINDS`/`KIND_INPUT` are enforced by the compiler; the rest fail silently or as runner warnings.
- The server accepts 10 kinds — this Action's 8 plus `uplay` and `ea` (`KINDS` in `src/app/api/submit-via-token/uploads/route.ts` and `UPLOAD_KINDS` in `buildSubmitBody.ts` of lbk-admin). Treat the server's enum as authoritative when extending, and re-check it rather than trusting the `// 8 max in parallel` comment in `src/main.ts`.
- `status` deliberately excludes `planned` (this flow always ships a file; the server's `gameStatus` enum rejects it too). The reason is documented in Ukrainian at `src/inputs.ts:56` and locked by a test.
- `api-token`/`game-id`/`version` use `core.getInput(..., { required: true })`; `archive` does not — its enforcement is the Zod refine `m.has('archive')`, which produces the "Main `archive` input is required" message. Other kinds that trim to empty are dropped silently.
- Token regex `/^lbk_[A-Za-z0-9_-]{43}$/` is stricter than the server's `bearer.startsWith('lbk_')` — it is a fail-fast convenience and will reject valid tokens if `generateToken()` (32 random bytes, base64url) ever changes length.
- Use Zod v4 top-level validators (`z.uuid('…')`, `z.url()`), not the v3 chained `z.string().uuid()` forms, and pass custom messages as the validator argument so they land in the aggregated `Invalid action inputs:` block.

## API client rules (`src/api.ts`)

- The axios instance sets `validateStatus: () => true` on purpose; all status handling lives in `ensureOk`, which requires **both** 2xx and `data.success === true` and throws `"<status> <url> → <server message>"`. Server messages are Ukrainian and must be surfaced verbatim, never replaced or translated.
- tus chunk size is exactly 6 MiB (Supabase requirement) and the source **must** stay `createReadStream(filePath)` — tus-js-client's node FileReader picks the seekable `FileSource` only for `input instanceof fs.ReadStream && input.path != null`; any other Readable falls to `StreamSource` and silently loses resume. Consequently the file must not be moved or rewritten mid-upload.
- `submitMetadata` sends `version` and `kinds` always, and `status` / `translation_progress` / `editing_progress` only when defined — a missing field means "don't touch" server-side, `null` would wipe the column. The camelCase→snake_case rename happens only here. The server supports `delete*Archive` flags, but this Action never sends them, so it cannot delete a kind.
- The submit `PUT` keeps its 5-minute timeout (it triggers the full server pipeline); the JSON client keeps 30 s. Neither JSON call retries; the tus path has its own retry ladder and no timeout.
- `signedUrl` on `SignedUpload` is the legacy single-shot flow the server still returns for old clients — dead code here; tus is the only path used.

## Conventions

- Pure ESM: `"type": "module"`, extensionless relative imports (`./main`), `node:` protocol for builtins (Biome error). Type-only imports use `import type` / `{ type X }` (Biome error, and `isolatedModules` requires it).
- Biome: single quotes, semicolons always, ES5 trailing commas, 2-space indent, 100 columns. `noExplicitAny` is a warn, not an error.
- `api.ts` exposes a factory returning an object literal typed by an exported interface. There are no classes anywhere; keep it that way.
- `noUncheckedIndexedAccess` is on — index/`Map.get` results need an explicit guard, as in `src/main.ts`.
- Ukrainian user-facing copy (README, comments, surfaced server errors) calls a translation entry «переклад» and the Steam Workshop area «Майстерня»; never write «айтем».
- Before hand-rolling a helper, check `package.json` — `p-map`, `pretty-bytes`, `zod`, `axios`, `tus-js-client` and `@actions/core` are already here and already do most of what you'd reach for.
- Secrets never land on disk: real tokens live only in the gitignored `.env`, with `.env.example` as the tracked template.

## Comments

Everyone here reads TS faster than prose about TS. **Default to no comment** — write one only for what the code can't say: a workaround and what breaks without it, a business or regulatory rule, a non-obvious ordering or idempotency constraint.

Never narrate a function body — no step-by-step, no `// Step 1:`, no `// loop over users` above a loop. No JSDoc restating the signature; types carry it. No divider or changelog comments, no commented-out code. TODOs need an issue number.

Keep any comment that does exist to a single line; no multi-line comment blocks. Existing comments are written in whichever language the author was thinking in — English for mechanics, Ukrainian for product/policy reasoning — match that and never strip or translate them.

## Verification

- `pnpm all` before every push. Nothing enforces it: there are no git hooks (no husky/lefthook, no `prepare` script).
- Then `git diff --exit-code dist` — or, without `node_modules`, compare the sources embedded in the bundle: `dist/index.js.map` carries verbatim `sourcesContent` for all four src files reachable from the entry (`.././src/api.ts`, `inputs.ts`, `main.ts`, `index.ts`), so diffing those against the working tree is an exact staleness test (it will not notice a brand-new file nothing imports yet).
- Tests are 10 cases in `src/inputs.test.ts`, all against `parseInputs`, mocking `@actions/core` down to a `getInput` stub (deliberately — env vars would test GitHub's name-mangling instead of the schema). `src/api.ts` and `src/main.ts` have **zero** coverage and there is no HTTP mock set up; new logic there needs one added.

## Gotchas / Do not

- **Never run bare `tsc` / `npx tsc`.** `tsconfig.json` sets `outDir: "dist"` with `rootDir: "src"`, so it emits unbundled `.js` over the committed ncc bundle and breaks the Action at runtime. Always `pnpm typecheck`.
- **Never hand-edit `dist/`**, including merge conflicts. `.gitattributes` `dist/** linguist-generated=true` only collapses the diff on github.com — no merge driver exists, so conflicts inside the 2.2 MB `dist/index.js` are real. Resolve with `git checkout --theirs -- dist` (either side works), then `pnpm build` and re-commit.
- Biome's `files.includes` is `["src/**", "*.json", "*.yml"]` — root globs don't recurse, so `.github/workflows/*.yml` and `vitest.config.ts` are **not** checked, and `*.yml` currently matches nothing (`pnpm-workspace.yaml`/`pnpm-lock.yaml` are `.yaml`). Format those by hand to match.
- `pnpm-workspace.yaml`: `minimumReleaseAge: 4320` (3 days) makes `pnpm add`/`pnpm update` refuse to resolve freshly published versions — expected, not a bug. With `dangerouslyAllowAllBuilds: false`, `allowBuilds: { esbuild: true }` is the one approved postinstall (esbuild arrives via vitest). `packages: ['.']` is required even for a single package — commit `1367337` added it as a fix; do not delete it.
- CI pins pnpm 9 (`pnpm/action-setup@v4`) and there is no `packageManager` field, while local pnpm is 11 (lockfile is `lockfileVersion: '9.0'`, last regenerated 2026-06-23). Regenerating `pnpm-lock.yaml` locally risks CI's `--frozen-lockfile`; changing the pin means editing both workflow files together.
- Re-running a workflow with the same `version` **silently overwrites** the previous archives: the server derives the path `_api/{gameId}/v{encodeURIComponent(version)}/{kind}.zip` and the tus headers set `x-upsert: 'true'`. That is why the README example uses `${{ github.run_number }}.0`. The server also caps `version` at 64 chars while this Action only checks non-empty.
- A token is rate-limited to 10 requests / 60 s server-side (`RATE_LIMIT_MAX_REQUESTS`/`RATE_LIMIT_WINDOW_SECONDS`) and each run logs 2 usage rows, so roughly 5 concurrent matrix jobs per token per minute; the JSON calls have no retry and ignore `Retry-After`. A 429 or a transient 502 on the final submit fails the run and a re-run re-uploads everything.
- tus does retry — `TUS_RETRY_DELAYS` is 10 attempts backing off to 60 s — but only for non-4xx (plus 409/423). All signed upload tokens are minted up front by the single `POST /uploads` and created without an explicit expiry, so a very long queue can outlive Supabase's default TTL; with no upload timeout, a stalled connection hangs until the job timeout.
- `stopOnError: true` does not abort the other in-flight uploads, so a partial failure can leave half-written objects in Storage. The pre-flight `statSync` loop in `src/main.ts` exists to minimise that; keep it before any signed-URL request.
- `{ concurrency: uploads.length }` would throw a p-map `TypeError` if the server ever returned `uploads: []` — the guard only rejects a missing `uploads` field.
- `core.getInput` trims by default, but its `required: true` check runs on the *untrimmed* value: `version: '   '` passes `@actions/core` and is caught only by the schema's `.trim().min(1)`. Keep that trim.
- The `game-id` output is echoed from the input, never from the server response.
- Known-stale docs, do not trust them: `README.md`'s dev section claims `pnpm lint # tsc --noEmit` (it is typecheck **and** biome); `.env.example` says archive paths are "at least one required" (`archive` specifically is required); `CHANGELOG.md` links a `v1.0.0` tag that never existed (tags are `v1`, `v1.1.0`, `v1.1.1`, `v1.2.0`).
