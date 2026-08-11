README quickstart, replayed end to end on branch docs/positioning-cross-harness
===============================================================================
'npx -y stepstone@latest' is served here by the packed tarball of this branch,
installed into an empty temp project (npm install stepstone-0.2.0.tgz) whose
node_modules contains no Pi package at all. The working directory is a freshly
'git init'ed repository with no .worklist/ in it.

$ npx -y stepstone@latest project add Replace legacy authentication --description Migrate every supported client first
Added project goal replace-legacy-authentication: Replace legacy authentication

$ npx -y stepstone@latest project add Retire the legacy auth service --depends-on replace-legacy-authentication
Added project goal retire-the-legacy-auth-service: Retire the legacy auth service

$ npx -y stepstone@latest project waves
Wave 1 (1 goal):
  [open] replace-legacy-authentication: Replace legacy authentication
Wave 2 (1 goal):
  [open] retire-the-legacy-auth-service: Retire the legacy auth service

$ npx -y stepstone@latest project next
[open] replace-legacy-authentication: Replace legacy authentication

$ npx -y stepstone@latest project set_active replace-legacy-authentication
Activated project goal replace-legacy-authentication

$ npx -y stepstone@latest project list
[active] replace-legacy-authentication: Replace legacy authentication
[open] retire-the-legacy-auth-service: Retire the legacy auth service

$ npx -y stepstone@latest project next --json
{
  "ok": true,
  "scope": "project",
  "action": "next",
  "result": {
    "scope": "project",
    "action": "next"
  },
  "meta": {
    "changed": false,
    "semanticNoOp": false,
    "changedFields": [],
    "revisions": {
      "project": "3"
    },
    "cliVersion": "0.2.0"
  }
}

$ cat .worklist/worklist.json
{
  "version": 1,
  "revision": 3,
  "goals": [
    {
      "id": "replace-legacy-authentication",
      "title": "Replace legacy authentication",
      "description": "Migrate every supported client first",
      "status": "active",
      "createdAt": "2026-08-11T08:57:30.408Z",
      "updatedAt": "2026-08-11T08:57:30.716Z"
    },
    {
      "id": "retire-the-legacy-auth-service",
      "title": "Retire the legacy auth service",
      "dependsOn": [
        "replace-legacy-authentication"
      ],
      "status": "open",
      "createdAt": "2026-08-11T08:57:30.495Z",
      "updatedAt": "2026-08-11T08:57:30.495Z"
    }
  ]
}

$ node --version    # the only thing installed on this machine's PATH for the run
v24.18.1

$ ls /tmp/stepstone-e2e/app/node_modules    # what the install pulled in
graceful-fs
proper-lockfile
retry
signal-exit
stepstone

$ du -sh /tmp/stepstone-e2e/app/node_modules/stepstone    # README: 'installs under a megabyte'
904K	/tmp/stepstone-e2e/app/node_modules/stepstone
