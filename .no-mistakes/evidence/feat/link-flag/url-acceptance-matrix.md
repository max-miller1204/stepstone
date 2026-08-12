# What `--link` and the MCP `links` argument accept

Every row is one real `project add --link <url> --json` run and one real MCP
`add` tool call against the same build.
`detail` is the stored array on an acceptance and the exact refusal a user sees otherwise.

| URL | why it matters | CLI | MCP | detail |
| --- | --- | --- | --- | --- |
| `https://example.com/spec` | ordinary absolute URL with a path | accepted | accepted | ["https://example.com/spec"] |
| `https://example.com/` | bare origin, written with the trailing slash | accepted | accepted | ["https://example.com/"] |
| `https://example.com` | bare origin, written the way people type it | accepted | accepted | ["https://example.com/"] |
| `http://example.com/spec` | plain http | accepted | accepted | ["http://example.com/spec"] |
| `HTTPS://example.com/spec` | uppercase scheme | accepted | accepted | ["https://example.com/spec"] |
| `https://example.com/x?y=1#z` | query and fragment | accepted | accepted | ["https://example.com/x?y=1#z"] |
| `https://example.com/spéc` | non-ASCII path | accepted | accepted | ["https://example.com/sp%C3%A9c"] |
| `github.com/example/colony` | no scheme | rejected (exit 1) | rejected (schema) | CLI: links entries must be absolute HTTP or HTTPS URLs. / MCP: Input validation error: Invalid arguments for tool add: Invalid URL at links[0] |
| `ftp://example.com/spec.pdf` | non-HTTP scheme | rejected (exit 1) | rejected (schema) | CLI: links entries must be absolute HTTP or HTTPS URLs. / MCP: Input validation error: Invalid arguments for tool add: Invalid URL at links[0] |
| `/docs/spec.md` | repository-relative path | rejected (exit 1) | rejected (schema) | CLI: links entries must be absolute HTTP or HTTPS URLs. / MCP: Input validation error: Invalid arguments for tool add: Invalid URL at links[0] |

Every absolute HTTP(S) URL is accepted however it was spelled and stored in its
canonical form, so what the field holds is always a URL a reader can follow, and
two spellings of one address deduplicate against each other.
Everything that is not an absolute HTTP(S) URL is still refused on both surfaces,
and nothing is written when it is.
