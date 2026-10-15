# Hadamard project tools for DeepSeek Harness

An independent, read-only DSH bundle over Hadamard's existing project metadata and issue stores. The published JavaScript bundles the shared project reader from this repository. It does not load the GUI, MCP server, agent runtime, or a CLI.

## Compatibility

This first version is pinned to the official DeepSeek Harness **0.2.1-alpha.3**, Cordis **4.0.5-alpha.2**, and Schemastery **3.18.5-alpha.2**. The upstream is a rapidly changing developer preview; other versions have not been verified.

Verified source: [deepseek-ai/deepseek-harness at 5719020](https://github.com/deepseek-ai/deepseek-harness/tree/571902028a75c64c1d767f4ae5fd099485f0ddf0).

- [Tool contracts](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/docs/cookbook/adding-a-tool.md): `ctx.tools.register(defineTool(...))`, canonical JSON output schema, separate renderer, cancellation, and effect-owned removal
- [Configuration](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/docs/user/develop/basic/config.md): exported Schemastery `Config` and `inject`
- [Bundle packaging](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/docs/user/develop/basic/publish.md): `dsh.bundle.patch`, package-name entry, shared host peers
- [Commands](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/docs/subsystems/commands.md): optional `commands` service and `/project status`

## Build and install

From the Hadamard repository root:

```sh
npm ci --prefix plugins/dsh-project
npm --prefix plugins/dsh-project test
npm --prefix plugins/dsh-project run typecheck
cd plugins/dsh-project
npm pack
```

`prepack` builds `dist/index.js` and `dist/index.d.ts`. The tarball contains these artifacts, the manifest, license, README, and `cordis.patch.yml`; it has no dependency on Hadamard source paths or its GUI/runtime dependencies. Use the built tarball, not a GitHub subdirectory install: rebuilding from source requires this repository's shared core.

Install the tarball into an existing DSH Web profile (shown here as `web`). A newly initialized base-only profile may have no interactive surface:

```sh
dsh plugin --profile web add /absolute/path/dsh-hadamard-project-0.1.0.tgz
```

Before booting, configure the inserted row in that profile's `cordis.patch.yml`:

```yaml
- id: hadamard-project
  config:
    workDir: /absolute/path/to/workspace
    homeDir: /absolute/path/to/user-home
    maxOutputBytes: 65536
```

Check the composed layer and then launch the existing Web profile:

```sh
dsh --profile web --dump-config
dsh --profile web
```

Both paths are required and must be absolute. `homeDir` uses the existing Hadamard semantics: an OS home usually resolves to its `.hadamard` directory; recognized Hadamard data roots are used directly. Supply the same home/data-root input as the existing Hadamard GUI. Custom roots should have their existing Hadamard markers (such as `projects/`) or established Hadamard configuration. This plugin never creates a root or migrates data to guess the right location.

For a source-linked plugin, build first and use the same explicit config. DSH's runtime peer resolution uses its own Cordis and DSH service instances. No login, model call, or external network access is needed for this plugin's tests.

## Tools and command

- `hadamard_project_get({})`: existing project identity, workspace path, display name, lifecycle status, issue-storage selection, and counts. `open` includes `in_review`; `review` is a subset, not an additional bucket.
- `hadamard_issue_list({ limit?, offset? })`: compact issue summaries (`id`, `number`, `title`, `status`, `priority`, complete `acceptanceCriteria`). Default limit 20, maximum 100; offset is zero-based. Returns `issues`, `total`, `offset`, `limit`, `nextOffset`, and `truncated`. Follow a non-null `nextOffset`. `truncated` means the page is not the entire collection; individual criteria are never silently shortened.
- `hadamard_issue_get({ idOrNumber })`: full existing issue, including description, acceptance criteria, comments, metadata, and session references, or `null` if absent. Accepts an existing ID, positive integer, numeric string, or `ISS-n` label.
- `/project` or `/project status`: direct read-only status summary when DSH's optional `commands` service is available. Other subcommands are rejected. DSH may record its own command lifecycle in its session log.

There are no tool path parameters. The workspace and home are captured when the plugin loads; model-provided extra path fields and session working-directory changes cannot change that configured scope. Reload with an operator-edited configuration to select another project. Filesystem symlinks and the operator's chosen storage root retain the existing Hadamard filesystem semantics; this is not an OS sandbox.

## Privacy and read-only boundaries

**Calling these tools returns project data to the selected DSH model and may make it part of the DSH conversation.** Configure only a project whose data you intend to expose. `issue_get` includes issue descriptions, comments, metadata, and session IDs. The plugin itself makes no model/provider requests, does not read or return provider credentials, and creates no separate server.

This version only reads existing stores. It does not create, edit, delete, repair, or migrate Hadamard data; update project/issue status; start an issue, agent, job, workflow, or session; run a shell/CLI; or provide write tools. Disabling/unloading it removes both tools and commands through Cordis effects. Unloading also cancels waiting plugin reads.

`maxOutputBytes` caps the actual rendered UTF-8 JSON for each successful tool result (default 64 KiB; configurable integer 1024–262144). Oversized results fail with an explicit error instead of returning partial issue content, silently truncating acceptance criteria, or spilling content to another file. Try a smaller page or inspect large issue details in Hadamard. This bounds returned content, not store-file size: the shared legacy reader still reads the whole JSON store into memory.

Cancellation is checked before reading and after completion, and waiting calls reject promptly on cancellation. The existing filesystem read may finish in the background; it has no writes or follow-on work.

The core preserves existing Hadamard normalization: absent stores yield empty/default state; malformed issue JSON throws; malformed individual records may be dropped or missing IDs/timestamps synthesized in memory; malformed metadata follows existing fallback behavior. None of this persists repairs. Reads reload metadata's `home`/`workspace` selection each time, but separate JSON files do not provide a transactional snapshot. Pagination reflects each fresh read, so concurrent Hadamard edits can change page membership.

## Verification

`npm test` builds and tests the compiled plugin using the published, pinned Cordis context and real DSH tool/command registries. Coverage includes schema validation, full issue detail, compact pagination, home/workspace selection, missing/corrupt stores, explicit scope, UTF-8 bounds, cancellation, unload/reload, and byte/mtime checks proving Hadamard fixture data is unchanged. Packaging checks load the packed entry without source files. No live API credentials or model requests are used.
