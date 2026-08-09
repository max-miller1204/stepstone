<!-- markdownlint-disable MD013 -->

# pi-worklist (deprecated)

This package was renamed to [`stepstone`](https://www.npmjs.com/package/stepstone).

`pi-worklist` now contains no implementation.
It forwards exactly two surfaces to `stepstone`: the `pi-worklist` bin and the Pi extension entry point.
Deep subpath imports are not forwarded: `pi-worklist/src/types.ts`, and anything else under `pi-worklist/src/`, no longer resolves and has to move to `stepstone`.

This is the last version of this package. It is published once and never republished, so it will not receive further development, but it depends on `stepstone` by range rather than by pin, so it keeps resolving the current release rather than pinning you to an old one.

## Moving over

```sh
pi install npm:stepstone
```

Anything invoking the CLI by name changes from `npx -y pi-worklist@latest` to `npx -y stepstone@latest`.
Reinstall the agent skill afterwards, since the copy already on disk still names the old package.

Nothing about the stored data changes.
The roadmap stays at `<git-root>/.pi/worklist.json` and is read and written exactly as before, so a repository survives the rename untouched.

The full documentation lives in the [stepstone README](https://github.com/max-miller1204/stepstone#readme).
