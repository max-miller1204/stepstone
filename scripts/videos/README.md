# Reproducible PR videos

Use named VHS scenarios to record actual Stepstone commands and output. Do not add release-specific copies of the runner.

## Commands

Run from the repository root after `npm ci`:

```sh
npm run videos:list
npm run videos:test
npm run videos:check -- tracker-retirement
npm run videos:render -- tracker-retirement
```

Omit the scenario name, or pass `all`, to run every scenario. Unknown names fail before a build or fixture change.

- `videos:test` tests the tape parser and scenario-selection rules.
- `videos:check` builds the CLI and replays the tape's exact shell commands without typing delays. It requires Node 22.18 or newer, Bash, Git, and jq. It does not require VHS or FFmpeg.
- `videos:render` builds the CLI, records the same tape, checks its results, and encodes an MP4. Run it locally. It requires VHS **0.12.0**, ttyd, FFmpeg with libx264, and FFprobe. The runner refuses another VHS version.

Manage workstation tools through `dots`. The runner does not install global tools. It resolves mise-managed executables before creating an isolated HOME. CI runs `videos:test` and `videos:check`. CI does not install recording tools or render videos.

## Outputs

Each run replaces `artifacts/videos/<scenario>/`. Do not store work there. A single lock protects the shared build and all video fixtures. A concurrent run fails instead of deleting another run's work. If the process is killed, inspect the running processes before removing `artifacts/videos/.lock`.

Successful renders contain:

- `<scenario>.mp4`: H.264 video with terminal margins.
- `preview.png`: a frame at the video midpoint or 10 seconds, whichever comes first.
- `commands.jsonl`: actual CLI arguments, output, diagnostics, and exit status.
- `process.log`: setup, replay or recording, verification, and encoder output.
- `metadata.json`: commit, dirty-tree flag, CLI version, tape hash, tool versions, media properties, and video hash.

Successful runs remove their disposable repositories and frames. Failed runs retain their fixtures and `failure.txt` for local investigation. The CI artifact excludes fixtures and frames.

A check run replaces the same scenario's prior render. Run `videos:check` before `videos:render` if you want to keep the final MP4.

## Add or change a scenario

Create a directory under `scripts/videos/scenarios/<name>/`. Use lowercase letters, digits, and hyphens. Include these three files:

1. `setup.sh`: create disposable repositories and local remotes under `$VIDEO_WORKSPACE`. Use `$VIDEO_REPOSITORY/dist/cli.js` for setup. Do not mutate the source checkout or publish remote changes.
2. `demo.tape`: type real commands. The runner supplies a `stepstone` wrapper that executes the compiled CLI, logs its complete result, and forwards its output unchanged.
3. `verify.mjs`: assert the expected command order, exit status, output, and final state. Read `$VIDEO_COMMAND_LOG` and `$VIDEO_WORKSPACE`. Throw on a mismatch.

The tape uses this deliberately bounded subset:

- One `Output frames/` line.
- `Set`, `Require`, `Hide`, `Show`, and `Sleep` directives.
- Shell input only as `Type` with a backtick-delimited string followed by `Enter` on the same line.
- `Set Shell "bash"`, even `Width` and `Height`, and a `Framerate` of 1 through 60.
- First typed command: `set -euo pipefail`.
- Last typed command: `touch "$VIDEO_WORKSPACE/complete"`.

Use shell continuations for long commands. Do not add standalone key presses or sourced tapes. The parser rejects commands it cannot replay instead of silently omitting them. Expected command failures must have an explicit shell assertion of their expected exit code. Do not use `|| true` to hide failures.

Use visible `jq` expressions when you need shorter JSON output. Do not replace product output with printed summary panels. Keep critical file-preservation checks in the tape immediately after the operation, before any fixture cleanup.

The `tracker-retirement` scenario records rejected workspace commands, preserved Git worktrees and files, an existing tracker claim, explicit completion, and dependency readiness. Setup creates a disposable legacy journal and ownership marker to verify byte preservation.

## Reproducibility limits

The fixture, commands, layout, and behavioral assertions are repeatable. Live timestamps, run IDs, absolute paths, and browser/font versions can differ. MP4 bytes are not promised to match across machines.

The local capture environment supplies VHS, ttyd, FFmpeg, the browser, and fonts. Metadata records the encoder and runtime versions. No provider credentials or GitHub authentication reach the fixture environment. VHS may download its headless browser on first use. CI verifies the same commands without browser rendering.

Do not run videos in parallel with another build or `npm run verify`, because each can replace `dist/`.

## Use in a pull request

1. Add or update a scenario that demonstrates the change.
2. Run `videos:check`, then `videos:render` for that scenario.
3. Watch the MP4. Inspect full-size and half-size frames for legibility. An exit code does not prove visual quality.
4. Add the reproduction command to the PR's Testing section.
5. Attach the MP4 to the PR's Evidence section using GitHub's upload control, or link the CI artifact.

The `PR video verification` workflow runs on pull requests that change a scenario or shared video tooling. It verifies all scenarios because shared setup changes can affect each one. It never renders videos.

For a product-code PR that uses an unchanged scenario, run the workflow manually on that branch:

```sh
gh workflow run videos.yml --ref <branch> -f scenario=tracker-retirement
```

The check summary links verification logs. Artifacts expire after 14 days and may require a GitHub login. Attach the locally reviewed MP4 to the PR for inline playback. The workflow has read-only repository permissions and does not post comments or change PR bodies.

Example PR evidence:

```md
## Testing
- `npm run videos:check -- tracker-retirement`

## Evidence
- Tracker retirement recording: <uploaded-video-or-artifact-link>
- Recorded revision and tools: metadata.json in the video artifact.
```
