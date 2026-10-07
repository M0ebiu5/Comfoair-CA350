// Function-node body: the only place that touches Node-RED. build.js prepends the core.
// The container runs in Europe/Vienna, so new Date().getHours() is the local hour, like the old code.
function handle(ev) {
    const res = core.decide(context.get('state') || core.initialState(), ev);
    context.set('state', res.state);
    for (const l of res.logs) node.warn(l.text);
    const timers = context.get('timers') || new Set();
    for (const t of res.timers) {
        const h = setTimeout(() => { timers.delete(h); handle({ type: 'timer', key: t.key, at: Date.now(), hour: new Date().getHours() }); },
                             Math.max(0, t.at - Date.now()));
        timers.add(h);
    }
    context.set('timers', timers);
    if (res.out.length) node.send([res.out.map(o => o.msg)]);
}

const now = Date.now(), hour = new Date(now).getHours();
if (msg.kwlInject) handle({ type: 'inject', name: msg.kwlInject, at: now, hour });
else handle({ type: 'mqtt', topic: String(msg.topic), payload: msg.payload, retain: !!msg.retain, at: now, hour });
return null;
