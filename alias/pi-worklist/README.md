<!-- markdownlint-disable MD013 -->

# pi-worklist (deprecated)

This package was renamed to [`stepstone`](https://www.npmjs.com/package/stepstone).

`pi-worklist` now contains no implementation.
It depends on `stepstone` and forwards both the `pi-worklist` bin and the Pi extension entry point to it, so existing installs keep working unchanged.
It is frozen at parity with the release that renamed it and will not receive further development.

## Moving over

```sh
pi install npm:stepstone
```

Anything invoking the CLI by name changes from `npx -y pi-worklist@latest` to `npx -y stepstone@latest`.
Reinstall the agent skill afterwards, since the copy already on disk still names the old package.

Nothing about the stored data changes.
The roadmap stays at `<git-root>/.pi/worklist.json` and is read and written exactly as before, so a repository survives the rename untouched.

The full documentation lives in the [stepstone README](https://github.com/max-miller1204/stepstone#readme).
