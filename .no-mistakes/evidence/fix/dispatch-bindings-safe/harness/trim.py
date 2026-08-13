import json, sys

def summarize(env):
    out = {"ok": env.get("ok"), "action": env.get("action")}
    goal = (env.get("result") or {}).get("goal")
    if goal:
        out["result.goal"] = {k: goal[k] for k in ("id", "status", "branch", "updatedAt") if k in goal}
    err = env.get("error")
    if err:
        out["error"] = {k: err[k] for k in ("code", "message") if k in err}
        if "conflict" in err:
            c = err["conflict"]
            out["error"]["conflict"] = {k: c[k] for k in ("expectedUpdatedAt", "actualUpdatedAt", "resolution") if k in c}
    return out

lines = sys.stdin.read().splitlines()
i = 0
while i < len(lines):
    line = lines[i]
    if line.strip() == "{":
        depth, buf, j = 0, [], i
        while j < len(lines):
            depth += lines[j].count("{") - lines[j].count("}")
            buf.append(lines[j])
            j += 1
            if depth == 0:
                break
        try:
            env = json.loads("\n".join(buf))
        except json.JSONDecodeError:
            print(line); i += 1; continue
        if isinstance(env, dict) and "ok" in env:
            print(json.dumps(summarize(env)) + "   <- stepstone envelope, trimmed here to result.goal and error")
            i = j; continue
    print(line); i += 1
