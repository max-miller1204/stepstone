/** A small browser client for the collaboration protocol proof. */
export const COLLABORATION_PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stepstone collaboration proof</title>
<style>
body{font:16px system-ui,sans-serif;background:#f4f5f7;color:#17212b;margin:0}main{max-width:880px;margin:48px auto;padding:0 24px}h1{font-size:32px;margin-bottom:8px}p{line-height:1.5;color:#526170}section{background:white;border:1px solid #dce2e7;border-radius:12px;padding:24px;margin:20px 0}label{display:block;margin-bottom:8px}input{padding:10px;border:1px solid #9eaab5;border-radius:5px;font:inherit;max-width:100%;box-sizing:border-box}button{padding:10px 15px;border:0;border-radius:5px;background:#18594e;color:white;font:inherit;cursor:pointer;margin:4px}button:disabled{opacity:.5;cursor:default}li{display:flex;gap:12px;align-items:center;border-top:1px solid #e1e6ea;padding:12px 0}li span{flex:1}ul{padding:0;list-style:none}small{display:block;color:#526170;margin-top:5px}#notice{white-space:pre-wrap;color:#973117}#connection{font-weight:600}#identity{overflow-wrap:anywhere}
</style>
<main><h1>Stepstone collaboration proof</h1><p>One project, shared by the browser and command line.</p>
<section id="login"><form id="connect"><label for="token">Server credential</label><input id="token" type="password" autocomplete="off" required><button>Connect</button></form></section>
<p id="connection" role="status">Disconnected</p><p id="notice" role="alert"></p>
<section id="project" hidden><h2 id="title"></h2><p id="identity"></p><button id="refresh">Refresh snapshot</button><button id="pause">Disconnect events</button><button id="resume" disabled>Resume events</button>
<form id="add"><label for="task-title">New task</label><input id="task-title" required maxlength="200"><button>Add task</button></form><ul id="tasks"></ul></section></main>
<script type="module">
import { CollaborationClient } from '/client.js';
const el = id => document.getElementById(id);
let client, snapshot, stream, cursor = 0;
const fail = error => { el('notice').textContent = error.message; };
function render() {
 el('project').hidden = false;
 el('title').textContent = snapshot.project.title;
 el('identity').textContent = 'Project ' + snapshot.projectId + ' · Revision ' + snapshot.revision + ' · Event ' + cursor;
 el('tasks').replaceChildren();
 for (const task of snapshot.tasks) {
  const row = document.createElement('li'), text = document.createElement('span'), id = document.createElement('small');
  text.textContent = task.goal.title + ' (' + task.goal.status + ')'; id.textContent = task.goal.id; text.append(id); row.append(text);
  const rename = document.createElement('button'); rename.textContent = 'Rename';
  rename.onclick = () => { const title = prompt('Task title', task.goal.title); if (title !== null) send({action:'update',taskId:task.taskId,title}).catch(fail); }; row.append(rename);
  if (task.goal.status === 'open' || task.goal.status === 'active') {
   const complete = document.createElement('button'); complete.textContent = 'Complete';
   complete.onclick = () => { if (confirm('Complete ' + task.goal.title + '?')) send({action:'complete',taskId:task.taskId,confirm:true}).catch(fail); }; row.append(complete);
  }
  el('tasks').append(row);
 }
}
async function refresh() {
 const next = await client.snapshot();
 if (snapshot && (next.revision < snapshot.revision || next.cursor < cursor)) return;
 snapshot = next; cursor = next.cursor; render();
}
async function send(operation) {
 el('notice').textContent = '';
 await client.command({version:1,commandId:crypto.randomUUID(),projectId:snapshot.projectId,expectedRevision:snapshot.revision,...operation});
 await refresh();
}
async function subscribe() {
 stream?.abort(); const controller = new AbortController(); stream = controller;
 el('pause').disabled = false; el('resume').disabled = true; el('connection').textContent = 'Connected';
 try {
  for await (const event of client.events(cursor, controller.signal)) {
   if (event.cursor <= cursor) continue;
   await refresh();
  }
 } catch(error) { if (!controller.signal.aborted) fail(error); }
 finally { if (stream === controller) { el('connection').textContent = 'Events disconnected'; el('pause').disabled = true; el('resume').disabled = false; } }
}
el('connect').onsubmit = async event => { event.preventDefault(); try { client = new CollaborationClient(location.origin, el('token').value); await refresh(); el('login').hidden = true; el('token').value = ''; subscribe(); } catch(error) { fail(error); } };
el('add').onsubmit = async event => { event.preventDefault(); try { await send({action:'add',title:el('task-title').value}); el('task-title').value = ''; } catch(error) { fail(error); } };
el('refresh').onclick = () => refresh().catch(fail);
el('pause').onclick = () => stream?.abort();
el('resume').onclick = () => { el('notice').textContent = ''; subscribe(); };
</script></html>`;
