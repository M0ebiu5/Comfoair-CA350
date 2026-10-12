// Function-node body: the only place that touches Node-RED. build.js prepends the core.
// The container runs in Europe/Vienna, so new Date().getHours() is the local hour, like the old code.
// Pending timers are also kept in context as {key, at}. A redeploy kills the setTimeouts (finalize
// clears 'timers') but keeps context, so restorePending() re-creates them when the node starts again,
// overdue ones at once (2026-10-12: a lost timer stopped Database Storage writing tr4 for 5 days).
function schedule(list) {
    const timers = context.get('timers') || new Set();
    const pending = context.get('pending') || [];
    for (const t of list) {
        const h = setTimeout(() => {
            timers.delete(h);
            context.set('pending', (context.get('pending') || []).filter(p => !(p.key === t.key && p.at === t.at)));
            handle({ type: 'timer', key: t.key, at: Date.now(), hour: new Date().getHours() });
        }, Math.max(0, t.at - Date.now()));
        timers.add(h);
        pending.push({ key: t.key, at: t.at });
    }
    context.set('timers', timers);
    context.set('pending', pending);
}

function restorePending() {
    const pending = context.get('pending') || [];
    context.set('pending', []);
    context.set('timers', new Set());
    schedule(pending);
}

function handle(ev) {
    const res = core.decide(context.get('state') || core.initialState(), ev);
    context.set('state', res.state);
    for (const l of res.logs) node.warn(l.text);
    schedule(res.timers);
    if (res.out.length) node.send([res.out.map(o => o.msg)]);
}

// First message after a (re)start - the start-up inject or any input: restore lost timers.
if (context.get('timers') === undefined) restorePending();
if (msg.topic === '__restore_timers__') return null;

const now = Date.now(), hour = new Date(now).getHours();
if (msg.kwlInject) handle({ type: 'inject', name: msg.kwlInject, at: now, hour });
else handle({ type: 'mqtt', topic: String(msg.topic), payload: msg.payload, retain: !!msg.retain, at: now, hour });
return null;
