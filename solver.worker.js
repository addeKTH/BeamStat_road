/* solver.worker.js ----------------------------------------------------------
   One load model per job.  The influence lines are sent once per bridge.

   {il}                   the influence lines of the sections of the envelope
   {id, name, opt}        reply {id, ok, LE} or {id, ok: false, message}

   Andreas Andersson, 2026-11-05 (assisted by Claude)
---------------------------------------------------------------------------*/
importScripts('beamstat2d.js?v=2026-11-05b');

let IL = null;

self.onmessage = function (ev) {
    const job = ev.data;
    if (job.il) { IL = job.il; return; }
    try {
        self.postMessage({ id: job.id, ok: true, LE: BS.loadEffect(IL, job.name, job.opt) });
    } catch (e) {
        self.postMessage({ id: job.id, ok: false, message: e && e.message ? e.message : String(e) });
    }
};
