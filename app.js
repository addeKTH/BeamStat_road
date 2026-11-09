/* app.js --------------------------------------------------------------------
   Road bridge static load effects, web version of Main_gui.m in BeamStat_road (2026-11-07):
   input, sketch and analysis of the ticked load models on every change (Web Workers from
   three new models), Section / Critical / Envelope, Run (Cancel after 1 s), Reset, Export
   (xlsx), Print (report by browser print to PDF).

   Andreas Andersson, 2026-11-05 (assisted by Claude)
---------------------------------------------------------------------------*/
(function () {
'use strict';
const $ = id => document.getElementById(id);
const VER = '2026-11-09e';

// ---------------------------------------------------------- default input
const def = { L: '20 20', EI: '35E9', dL: '0.1', BK: 'BK1', dx: '0.2', w: '3', gap: '45', v: '80', shw: 'Section', EIopt: 'L/delta = 400' };   // EIopt '' = EI typed
// EI from the deflection limit, TRVINFRA-00331 10.3.2.2.1: the options and the menu text
const EIopts = ['L/delta = 400', 'L/delta = 300'];
const EIlabel = o => `<i>L</i>/<i>δ</i><sub>V</sub> = ${o.slice(10)}   (${o.endsWith('400') ? '1975 rules and later' : '1960 rules and earlier'})`;
// input limits, as Main_gui: element size, elements, total length (m), carriageway (m), LM length (m)
const dLmin = 0.01, nElMax = 5000, Lmin = 1, Lmax = 2000, wMin = 3, wMax = 40, Llm = 200;
const nLaneMax = 6;   // most lanes in the menu of w; a wider carriageway is typed
const shwList = ['Section', 'Critical', 'Envelope'], bkList = ['BK1', 'BK2', 'BK3', 'BK4'], gapList = ['45', '25'];
const typList = 'abcdefghijklmno'.split('');                          // TRVINFRA-00331 Bilaga 1
const lmList = ['LM1', 'LM2'];                                        // EN 1991-2:2024
const grpList = [['EN 1991-2', lmList], ['TRVINFRA-00331', typList]];
const loadList = [...lmList, ...typList];                             // the order of the results
const groupOf = n => (n.startsWith('LM') ? 'EN 1991-2:2024' : 'TRVINFRA-00331');
const co = ['#0072BD', '#D95319'], nMax = 2e6, snapTol = 0.05;        // axles moved more are reported (m)

// shared state (as Main_gui)
let inp = {}, mdl = {}, ILa = null, IL = null, LE = null, sup = [], jx = 0, xp = 0, sig = '';
let xpAuto = true, L0 = '', inputOK = true, sel = ['LM1'], allS = new Map(), allN = [], allR = [], modelMap = null, tProg = 0;
const ui = { busy: false, stopReq: false, stopOn: false, stopTimer: null, abort: null };

// ============================================================ helpers
// numbers as MATLAB str2num would read them: '20 20', '[10 15 10]', '15E3', simple expressions
function evalExpr(s) {
    let i = 0;
    const peek = () => s[i], ws = () => { while (s[i] === ' ') i++; };
    function num() {
        ws();
        const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
        if (m) { i += m[0].length; return parseFloat(m[0]); }
        if (peek() === '(') { i++; const v = add(); ws(); if (s[i++] !== ')') throw 0; return v; }
        if (peek() === '-') { i++; return -pow(); }
        if (peek() === '+') { i++; return pow(); }
        throw 0;
    }
    function pow() { let v = num(); ws(); while (peek() === '^') { i++; v = Math.pow(v, num()); ws(); } return v; }
    function mul() { let v = pow(); ws(); while (peek() === '*' || peek() === '/') { const o = s[i++]; const w = pow(); v = o === '*' ? v * w : v / w; ws(); } return v; }
    function add() { let v = mul(); ws(); while (peek() === '+' || peek() === '-') { const o = s[i++]; const w = mul(); v = o === '+' ? v + w : v - w; ws(); } return v; }
    const v = add(); ws();
    if (i !== s.length || !isFinite(v)) throw 0;
    return v;
}
// the input boxes: at most this many characters; a box with an error is light red; a comma is
// a decimal point, also in the box
const maxIn = 200;
document.querySelectorAll('#fig input:not([type=checkbox])').forEach(e => { e.maxLength = maxIn; });
function markBad(bad) { for (const id in bad) $(id).classList.toggle('bad', !!bad[id]); }
function fixComma(ids) { for (const id of ids) if ($(id).value.includes(',')) $(id).value = $(id).value.replace(/,/g, '.'); }
function parseVec(str) {
    if (String(str).length > maxIn) return null;
    try {
        let s = String(str).trim().replace(/^\[|\]$/g, '').replace(/,/g, '.').replace(/;/g, ' ').trim();
        if (!s) return null;
        s = s.replace(/\s*:\s*/g, ':').replace(/([*/^+(-])\s+/g, '$1').replace(/\s+([*/^)])/g, '$1');
        const out = [];
        for (const tok of s.split(/\s+/)) {
            const p = tok.split(':').map(evalExpr);
            if (p.length === 1) { out.push(p[0]); continue; }
            if (p.length > 3) return null;
            const [a, st, b] = p.length === 2 ? [p[0], 1, p[1]] : p;
            if (!st) return null;
            const n = Math.floor((b - a) / st + 1e-10) + 1;      // a:b, a:s:b
            if (out.length + n > 1000) return null;
            for (let k = 0; k < n; k++) out.push(Number((a + k * st).toPrecision(12)));
        }
        return out.length ? out : null;
    } catch (e) { return null; }
}
// The span lengths from the box L.  L1:dL:Ltot is a first span L1, then spans of dL up to the
// total length Ltot, which comes back in .s rounded down to whole spans (10:10:59 is 10:10:50);
// otherwise as parseVec.  .v null if they cannot be read; at most 1000 spans.
function readSpans(str) {
    const s = String(str).replace(/,/g, '.').trim();
    if (!s.includes(':')) return { v: parseVec(s), s: null };
    const p = s.split(':').map(t => { const x = parseVec(t); return x && x.length === 1 ? x[0] : null; });
    if (s.length > maxIn || p.length !== 3 || p.includes(null)) return { v: null, s: null };
    const [a, d, T] = p;
    if (!(a > 0 && d > 0 && T >= a)) return { v: null, s: null };
    const n = Math.floor((T - a) / d + 1e-9);
    if (n + 1 > 1000) return { v: null, s: null };
    return { v: [a, ...new Array(n).fill(d)], s: `${gfmt(a)}:${gfmt(d)}:${gfmt(Number((a + n * d).toFixed(10)))}` };
}
const scalar = s => { const v = parseVec(s); return v && v.length === 1 ? v[0] : null; };
const gfmt = x => String(Number(x.toPrecision(6)));              // %g
const rnd = x => (x < 0 ? -Math.round(-x) : Math.round(x));
const nextFrame = () => new Promise(r => setTimeout(r, 0));
const RED = '#b30000';

// ============================================================ symbols
const C = { green: '#21963f', red: '#cc2626', grey: '#737373' };
const ICON = {
    run: `<circle cx="12" cy="12" r="11" fill="${C.green}"/><polygon points="9.5,7 9.5,17 17.5,12" fill="#fff"/>`,
    stop: `<circle cx="12" cy="12" r="11" fill="${C.red}"/><rect x="8" y="8" width="8" height="8" rx="1" fill="#fff"/>`,
    reset: `<path d="M18.06 8.5 A7 7 0 1 1 12 5" fill="none" stroke="${C.red}" stroke-width="3"/><polygon points="12,0.8 12,9.2 17.5,5" fill="${C.red}"/>`,
    print: `<rect x="7.5" y="3" width="9" height="6.5" fill="#fff" stroke="${C.grey}"/><rect x="2" y="8" width="20" height="10" rx="2" fill="#666b73"/>` +
           `<rect x="6" y="14" width="12" height="1.5" fill="#333338"/><rect x="7.5" y="15" width="9" height="6" fill="#fff" stroke="${C.grey}"/>` +
           `<path d="M9 17.5H15M9 19.5H15" stroke="${C.grey}"/><circle cx="18.5" cy="11" r="1" fill="#4dbf59"/>`,
    export: `<rect x="7" y="2" width="15" height="20" rx="1.5" fill="#219e59"/><path d="M14 7H22M14 12H22M14 17H22M18 2V22" stroke="#d9f2e0" stroke-width="1"/>` +
            `<rect x="2" y="6" width="13" height="13" rx="1.5" fill="#0f6636"/><path d="M5.56 8.3L11.44 16.7M11.44 8.3L5.56 16.7" stroke="#fff" stroke-width="2.1"/>`
};
const TIP = { run: 'Run: analysis of the ticked load models', stop: 'Cancel: ends the run' };
const SYMS = {
    sRun: ['run', TIP.run, () => (ui.stopOn ? onCancel() : onRun())],
    sRst: ['reset', 'Reset: default input, clears the results', () => onReset()],
    sExp: ['export', 'Export: results to *.xlsx', () => onExport()],
    sRep: ['print', 'Print: pdf report of the results', () => onReport()]
};
function setIcon(id, name) { $(id).innerHTML = `<svg viewBox="0 0 24 24">${ICON[name]}</svg>`; }
for (const id in SYMS) {
    const [ic, tip, fcn] = SYMS[id], el = $(id);
    setIcon(id, ic);
    el.dataset.tip = tip;
    el.addEventListener('click', ev => {
        ev.stopPropagation();
        if (el.classList.contains('off') || (ui.busy && !(id === 'sRun' && ui.stopOn))) return;   // off; during a run: Cancel only
        hideTip(); fcn();
    });
    el.addEventListener('mouseenter', () => showTip(el));
    el.addEventListener('mouseleave', hideTip);
}
function showTip(el) {
    const t = $('tip');
    t.textContent = el.dataset.tip; t.style.display = 'block';
    t.style.left = Math.min(el.offsetLeft, 550 - t.offsetWidth) + 'px';
    t.style.top = (el.offsetTop + el.offsetHeight + 4) + 'px';
}
function hideTip() { $('tip').style.display = 'none'; }
function setMsg(s, col) { const m = $('msg'); m.textContent = s || ''; m.style.color = col || '#4d4d4d'; }
function setProg(fr) {
    if (fr === null) { $('pfill').style.width = '0'; $('pct').textContent = ''; return; }
    $('pfill').style.width = (100 * fr) + '%'; $('pct').textContent = Math.round(100 * fr) + ' %';
}
// a run or a report: the Run symbol becomes Cancel after 1 s
function progStart() {
    ui.stopReq = false; ui.busy = true; $('fig').classList.add('busy'); tProg = performance.now();
    clearTimeout(ui.stopTimer);
    ui.stopTimer = setTimeout(() => { ui.stopOn = true; setIcon('sRun', 'stop'); $('sRun').dataset.tip = TIP.stop; }, 1000);
}
function progEnd() {
    clearTimeout(ui.stopTimer);
    ui.stopOn = false; setIcon('sRun', 'run'); $('sRun').dataset.tip = TIP.run;
    ui.busy = false; $('fig').classList.remove('busy');
}
function onCancel() {
    ui.stopReq = true; setMsg('cancelling ...');
    if (ui.abort) ui.abort();
}
const msgDone = (stopped, t0) => {
    if (stopped) { setProg(null); setMsg('cancelled'); }
    else {
        setProg(1);
        const t = ((performance.now() - t0) / 1000).toFixed(1);
        if (LE && LE.snap > snapTol) setMsg(`done in ${t} sec, axles moved up to ${LE.snap.toFixed(2)} m`, '#b35900');   // dL too large for the axle spacings
        else setMsg(`done in ${t} sec`);
    }
};

// ============================================================ input fields
for (const s of shwList) { const o = document.createElement('option'); o.textContent = s; $('iShw').appendChild(o); }
for (const s of bkList) { const o = document.createElement('option'); o.textContent = s; $('iBK').appendChild(o); }
for (const s of gapList) { const o = document.createElement('option'); o.textContent = s; $('iGap').appendChild(o); }
function setDefaults() {
    $('iL').value = def.L; $('iEI').value = def.EI; ui.dLset = def.dL;
    $('iBK').value = def.BK; $('iDx').value = def.dx; $('iW').value = def.w; $('iGap').value = def.gap;
    $('iV').value = def.v; $('iShw').value = def.shw;
    $('tPhi').checked = true; $('tD').checked = true; $('tR').checked = false; $('tF').checked = false;
    sel = ['LM1']; xpAuto = true; L0 = ''; sup = []; sig = '';
    ui.EIopt = def.EIopt; ui.EIkey = '';
}
for (const id of ['iL', 'iBK', 'iDx', 'iW', 'iGap', 'iV']) $(id).addEventListener('change', () => updateModel());
// a typed EI ends the computed one
$('iEI').addEventListener('change', () => {
    ui.EIopt = ''; ui.EIkey = ''; $('iEI').classList.remove('auto');
    $('iEI').title = 'Flexural rigidity, one value or one per span; or from a deflection limit with the button';
    updateModel();
});
// the EI menu below its button: a limit picked computes EI
$('bEI').addEventListener('click', ev => {
    ev.stopPropagation();
    const m = $('mEI'); m.innerHTML = '';
    EIopts.forEach(o => {
        const d = document.createElement('div');
        d.innerHTML = EIlabel(o);
        if (ui.EIopt === o) d.className = 'chk';
        d.addEventListener('click', e => { e.stopPropagation(); m.style.display = 'none'; ui.EIopt = o; ui.EIkey = ''; updateModel(); });
        m.appendChild(d);
    });
    m.style.left = $('bEI').offsetLeft + 'px'; m.style.top = ($('bEI').offsetTop + 22) + 'px'; m.style.display = 'block';
    $('mLoad').style.display = 'none'; $('mW').style.display = 'none';
});
// the lanes menu of w: the width of that many lanes 3 m wide
$('bW').addEventListener('click', ev => {
    ev.stopPropagation();
    const m = $('mW'); m.innerHTML = '';
    const wNow = Number($('iW').value.trim() || NaN);
    for (let k = 1; k <= nLaneMax; k++) {
        const d = document.createElement('div');
        d.textContent = `${k} lane${k > 1 ? 's' : ''}   (w = ${3 * k} m)`;
        if (wNow === 3 * k) d.className = 'chk';
        d.addEventListener('click', e => { e.stopPropagation(); m.style.display = 'none'; $('iW').value = String(3 * k); updateModel(); });
        m.appendChild(d);
    }
    m.style.left = $('iW').offsetLeft + 'px'; m.style.top = ($('iW').offsetTop + 23) + 'px'; m.style.display = 'block';
    $('mLoad').style.display = 'none'; $('mEI').style.display = 'none';
});
$('idL').addEventListener('change', e => { ui.dLset = e.target.value.trim(); updateModel(); });
$('iXp').addEventListener('change', () => { xpAuto = false; updateModel(); });
$('iShw').addEventListener('change', () => { if (!ui.busy && ILa) updatePlots(); });
$('tPhi').addEventListener('change', () => updateModel());
for (const id of ['tD', 'tR', 'tF']) $(id).addEventListener('change', () => {
    for (const j of ['tD', 'tR', 'tF']) $(j).checked = j === id;
    if (!ui.busy && ILa) updatePlots();
});

// the load model menu: tick boxes in groups, with a box for all models of the group.  A tick
// applies at once; what is calculated is kept.
const mT = $('mLoad'), tks = new Map();
function addTick(text, x, row, fn, bold) {
    const l = document.createElement('label'), c = document.createElement('input');
    c.type = 'checkbox'; c.dataset.model = text;
    l.style.left = x + 'px'; l.style.top = (4 + row * 17) + 'px';
    if (bold) l.className = 'b';
    l.appendChild(c); l.appendChild(document.createTextNode(text));
    c.addEventListener('change', () => fn(c));
    mT.appendChild(l);
    return c;
}
const onTick = c => setSel(c.checked ? [...sel, c.dataset.model] : sel.filter(s => s !== c.dataset.model));
const tkG = [];                                  // [box, its models]
const addGroup = (title, names, x, r0) => {
    let r = r0;
    tkG.push([addTick(title, x, r++, c => setSel(c.checked ? [...sel, ...names] : sel.filter(s => !names.includes(s))), true), names]);
    names.forEach(n => tks.set(n, addTick(n, x + 14, r++, onTick)));
    return r;
};
grpList.reduce((r, g) => addGroup(g[0], g[1], 6, r), 0);
mT.addEventListener('click', ev => ev.stopPropagation());
const toggleLoad = ev => {
    ev.stopPropagation();
    if (ui.busy) return;
    $('mEI').style.display = 'none'; $('mW').style.display = 'none';
    if (mT.style.display === 'block') { mT.style.display = 'none'; return; }
    mT.style.left = $('iLoad').offsetLeft + 'px'; mT.style.top = ($('iLoad').offsetTop + 23) + 'px'; mT.style.display = 'block';
};
$('iLoad').addEventListener('click', toggleLoad);
$('bLoad').addEventListener('click', toggleLoad);
document.addEventListener('click', () => {
    mT.style.display = 'none'; $('mEI').style.display = 'none'; $('mW').style.display = 'none';
    if (ui.supJust) { ui.supJust = false; return; }              // the click that opened the support menu
    removeSupSel();
});

function setSel(names) {
    if (!ui.busy) sel = loadList.filter(n => names.includes(n));
    syncTicks();
    if (!ui.busy) updateModel();
}
function syncTicks() {
    tks.forEach((c, n) => { c.checked = sel.includes(n); });
    tkG.forEach(([c, names]) => { c.checked = names.some(n => sel.includes(n)); });
    const st = !sel.length ? 'none' : sel.length === loadList.length ? 'all' : sel.join() === typList.join() ? 'a to o' : sel.length <= 4 ? sel.join(', ') : `${sel.length} models`;
    $('iLoad').value = st;
    $('iLoad').title = sel.length ? sel.join(', ') : 'No load model ticked: the influence lines alone';
}

// ============================================================ input / model
function readInput() {
    fixComma(['iL', 'iEI', 'iXp', 'iW', 'iV', 'iDx']);
    ui.dLset = String(ui.dLset).replace(/,/g, '.');
    const LS = readSpans($('iL').value);
    if (LS.s) $('iL').value = LS.s;                              // L1:dL:Ltot, Ltot on whole spans
    const L = LS.v, EI = parseVec($('iEI').value);
    let dL = scalar(ui.dLset);
    const okL = goodVec(L);
    if (okL && L.join() !== L0) { xpAuto = true; L0 = L.join(); }     // new spans: x_p back at the first midspan
    // dL: a negative value counts as positive, at least dLmin, and these replace what was typed
    if (dL !== null && (dL < 0 || Math.abs(dL) < dLmin)) { dL = Math.max(Math.abs(dL), dLmin); ui.dLset = gfmt(dL); }
    // the field: as typed, or (grey) the length in use where a span needs a shorter element,
    // at most a tenth of the shortest span, or a long bridge fewer elements (at most nElMax,
    // in whole cm), or a short bridge more elements; the typed value returns when it fits again
    let dLshow = ui.dLset, dLgrey = false;
    ui.nCap = false;
    if (okL && dL !== null) {
        const s0 = sum(L), dMax = Math.max(Math.min(...L) / 10, dLmin);
        if (dL > dMax) { dL = dMax; dLshow = gfmt(dL); dLgrey = true; }
        // dL in whole cm; the spans are then rounded to whole elements, which may add one per
        // span, so that is allowed: the rounded spans give the same dL on the next update
        let dN = Math.max(Math.floor(s0 / nElMax * 100) / 100, dLmin);
        while (sum(L.map(l => rnd(l / dN))) > nElMax + L.length) dN = Number((dN + 0.01).toFixed(2));
        if (dL < dN) { dL = dN; ui.nCap = true; dLshow = gfmt(dL); dLgrey = true; }
        if (s0 < 10 && rnd(s0 / dL) < 100) { dLshow = gfmt(s0 / 100); dLgrey = true; }
    }
    $('idL').value = dLshow; $('idL').classList.toggle('auto', dLgrey);
    if (xpAuto && okL) $('iXp').value = gfmt(L[0] / 2);          // midspan of the first span, until moved by hand
    let xv = scalar($('iXp').value);
    inp.L = L; inp.EI = EI; inp.dL = dL;
    syncTicks();
    inp.load = sel;
    inp.dyn = $('tPhi').checked;
    inp.BK = $('iBK').value;
    const T0 = BS.vehicleModel('a', inp.BK);
    $('iBK').title = `Bearing class: A/B = ${T0.A / 1e3}/${T0.B / 1e3} kN`;
    // each box only where it applies; a bad value in a hidden box does not count
    const onT = sel.some(n => typList.includes(n)), onV = inp.dyn && onT;
    const onW = sel.includes('LM1') || onT || !!ui.EIopt, onG = sel.some(n => ['j', 'k', 'l'].includes(n));   // the lanes matter; the gap
    const show = (ids, on) => ids.forEach(id => { $(id).style.display = on ? '' : 'none'; });
    show(['iBK', 'lBK', 'iDx', 'lDx'], onT); show(['iV', 'lV'], onV); show(['iW', 'bW', 'lW', 'nW'], onW); show(['iGap', 'lGap'], onG);
    const yW = (onT ? 164 : 112) + 'px';                         // no type vehicle: w under the load model
    $('iW').style.top = yW; $('bW').style.top = yW; $('lW').style.top = yW;
    // the lanes: to the left of w on the lowest row, else below the box
    const nW = $('nW');
    if (onT) { nW.style.left = ''; nW.style.right = '356px'; nW.style.top = yW; nW.style.textAlign = 'right'; }
    else { nW.style.right = ''; nW.style.left = '252px'; nW.style.top = '138px'; nW.style.textAlign = 'left'; }
    inp.gapL = Number($('iGap').value);
    const goodW = v => v !== null && v >= wMin && v <= wMax;
    inp.w = scalar($('iW').value);
    if (inp.w !== null) {                                        // to 0.1 m, within the limits
        const wRnd = Math.min(Math.max(Math.round(10 * inp.w) / 10, wMin), wMax);
        if (wRnd !== inp.w) $('iW').value = String(wRnd);
        inp.w = wRnd;
    }
    if (!onW && !goodW(inp.w)) inp.w = Number(def.w);
    if (goodW(inp.w)) {
        const [nLM, wlLM, wrLM] = BS.lanes(inp.w), nTV = Math.min(Math.max(Math.floor(inp.w / 3 + 1e-9), 1), 4);
        nW.textContent = laneText(nLM, wlLM, wrLM, nTV, sel.includes('LM1') || !!ui.EIopt, onT); nW.style.color = '';
        $('iW').title = `Carriageway width, ${wMin} to ${wMax} m: LM1 ${nLM} notional lane${nLM > 1 ? 's' : ''} and a remaining area of ${Number(wrLM.toPrecision(3))} m ` +
            `(EN 1991-2:2024 Table 6.1); type vehicles ${nTV} lane${nTV > 1 ? 's' : ''}, vehicles in ${Math.min(nTV, 2)} (times 1.0${nTV >= 2 ? ' and 0.8' : ''}), ` +
            `q = 5 kN/m in ${Math.max(nTV - 2, 0)} (TRVINFRA-00331 K264958)`;
    } else {
        $('iW').title = `Carriageway width, ${wMin} to ${wMax} m`;
        nW.innerHTML = `<i>w</i> = ${wMin} to ${wMax} m`; nW.style.color = '#b30000';
    }
    inp.v = scalar($('iV').value);
    if (!onV && !(inp.v !== null && inp.v > 0)) inp.v = Number(def.v);
    inp.dx = $('iDx').value.trim() === '' ? 0 : scalar($('iDx').value);
    if (inp.dx !== null && inp.dx > 0 && inp.dx < 0.1) { inp.dx = 0.1; $('iDx').value = '0.1'; }   // 0 = the shortest spacing only
    if (!onT && !(inp.dx !== null && inp.dx >= 0)) inp.dx = Number(def.dx);
    // the total length may exceed Lmax by the rounding of the spans, half an element per span
    const Ltol = okL && dL !== null ? L.length * Math.abs(dL) / 2 + 1e-9 : 0;
    let ok = okL && sum(L) >= Lmin && sum(L) <= Lmax + Ltol && goodVec(EI) && (EI.length === 1 || EI.length === L.length)
        && dL !== null && dL > 0 && xv !== null
        && inp.v !== null && inp.v > 0 && inp.dx !== null && inp.dx >= 0 && goodW(inp.w);
    let spansOK = true;
    if (ok) { ok = realSpans(); spansOK = ok; }
    // the boxes with an error; Export and Print only from a valid input
    markBad({ iL: !okL || sum(L) < Lmin || sum(L) > Lmax + Ltol || !spansOK,
              iEI: !(goodVec(EI) && (!okL || EI.length === 1 || EI.length === L.length)),
              idL: !(dL !== null && dL > 0), iXp: xv === null, iW: !goodW(inp.w),
              iV: !(inp.v !== null && inp.v > 0), iDx: !(inp.dx !== null && inp.dx >= 0) });
    for (const id of ['sExp', 'sRep']) $(id).classList.toggle('off', !ok);
    if (ok) {
        if (xpAuto) { xv = inp.L[0] / 2; $('iXp').value = gfmt(xv); }
        xp = Math.min(Math.max(xv, 0), sum(inp.L));
        $('tPhi').disabled = !onT;                               // Phi: only for the type vehicles
    } else setMsg('input error', RED);
    inputOK = !!ok;
    return inputOK;
}
const sum = a => a.reduce((p, c) => p + c, 0);
// the lanes of w in words: LM1 where LM1 counts, with its remaining area or its narrower
// lanes; the type vehicles where they count and have another number of lanes
function laneText(n1, wl, wr, nT, onL, onT) {
    const lanes = n => `${n} lane${n > 1 ? 's' : ''}`, g3 = v => Number(v.toPrecision(4));
    if (!onL) return lanes(nT);
    let s = lanes(n1);
    if (wl < 3) s += ` ${g3(wl)} m`;
    if (wr > 1e-6) s += ` + ${g3(wr)} m`;
    if (onT && nT !== n1) s += `, type veh. ${nT}`;
    return s;
}
// finite positive numbers, at least one (parseVec gives finite numbers or null)
const goodVec = v => Array.isArray(v) && v.length > 0 && v.every(x => isFinite(x) && x > 0);
// The supports stand on nodes: each span is rounded to a whole number of elements, and
// replaces what was typed where it differs, so dL stays as it is.  A short bridge has its
// 100 elements: there the total length stays and the grid follows from it.  False if a span
// would vanish.  (As BeamStat_rail.)
function realSpans() {
    const Lt = sum(inp.L);
    let LA, dA;
    if (Lt < 10 && rnd(Lt / inp.dL) < 100) {
        dA = Lt / 100; let c = 0;
        const n = [0, ...inp.L.map(l => rnd((c += l) / dA))];
        LA = inp.L.map((_, i) => (n[i + 1] - n[i]) * dA);
    } else {
        dA = inp.dL;
        LA = inp.L.map(l => Number((rnd(l / dA) * dA).toFixed(10)));
    }
    if (!LA.every(v => v > 0)) { ui.Lmoved = false; return false; }
    ui.Lmoved = LA.some((v, i) => Math.abs(v - inp.L[i]) > 1e-3 * dA);
    if (ui.Lmoved) { inp.L = LA; L0 = LA.join(); $('iL').value = LA.map(gfmt).join(' '); }   // L0: not new spans for the marker
    return true;
}
// no model: after an input error, or a cancelled or failed EI from the limit
function clearResults() {
    ILa = null; IL = null; LE = null; allN = []; allR = []; allS = new Map(); sig = ''; sendKey = null;
    clearPlots(); $('dynT').innerHTML = ''; setProg(null);
}
// the number of elements in the status text, before a run; above 1000 in red
function showElements() {
    const nE = rnd(mdl.Ltot / mdl.dL);
    if (nE > 1000) setMsg(`${nE} elements: long run time`, RED); else setMsg(`${nE} elements`);
}
// the status after a model change: length limit, dL raised, L rounded
function afterMsg() {
    if (mdl.Ltot > Llm && (sel.some(n => lmList.includes(n)) || ui.EIopt)) setMsg(`length > ${Llm} m: LM1, LM2 not calibrated (EN 1991-2 6.1)`, RED);
    else if (ui.nCap) setMsg(`dL raised: at most ${nElMax} elements`);
    else if (ui.Lmoved) setMsg('L rounded to whole elements of dL');
}

async function updateModel() {
    if (ui.busy) return false;
    if (!readInput()) { clearResults(); return false; }
    let s0 = 0; const xs = [0, ...inp.L.map(l => (s0 += l))];
    if (sup.length !== xs.length) sup = xs.map(() => false);
    inp.bc = [];
    xs.forEach((x, i) => { inp.bc.push([x, 1, 0]); if (sup[i]) inp.bc.push([x, 2, 0]); });
    mdl.xs = xs; mdl.Ltot = s0; mdl.dL = s0 / BS.nElements(s0, inp.dL);
    if (ui.EIopt) {                                              // EI from the deflection limit
        const heavy = eiKey() !== ui.EIkey && BS.nElements(s0, inp.dL) >= nElWorker;
        if (heavy) { progStart(); showElements(); setProg(0); }
        let ok = false;
        try { ok = await limitEI(); }
        catch (e) { clearResults(); setMsg(e && e.message ? e.message : 'error', RED); console.error(e); if (heavy) progEnd(); return false; }
        if (heavy) progEnd();
        if (!ok) { clearResults(); setMsg('cancelled'); return false; }
    }

    // a new model: new analysis; otherwise only the section has changed
    const s = [inp.dL, inp.BK, inp.dx, inp.w, inp.gapL, inp.dyn, inp.v, inp.L.join(' '), inp.EI.join(' '), sup.join('')].join('|');
    const isNew = s !== sig;
    if (isNew) { sig = s; sectionGrid(); allS = new Map(); ILa = null; sendKey = null; setProg(null); }
    setSection(null);
    plotBeam();
    if ($('msg').style.color === 'rgb(179, 0, 0)') setMsg('');
    if (isNew || sel.join() !== allN.join()) return analyse(isNew).then(r => { afterMsg(); return r; });
    updatePlots();
    afterMsg();
    return true;
}

// EI from the deflection limit L/delta_V (TRVINFRA-00331 10.3.2.2.1, K230747 400, K164672 300;
// for 400 also TRVINFRA-00227 K135526, frequent traffic load): LM1 at its frequent value with
// the adjustment factors of TSFS 2018:57 and the lanes of w, Phi = 1; the largest downward
// deflection in each span against L/delta_V of that span.  The deflection goes as 1/EI, so one
// run at a reference EI scales to the EI that just meets the limit, rounded up to 3 digits; one
// EI for all spans.  As Main_gui at every node: on a thinned grid the nodes either side of each
// span's largest deflection are solved again.  Resolved with false when cancelled.
const eiKey = () => [ui.EIopt, inp.L.join(' '), inp.dL, inp.w, sup.join('')].join('|');
async function limitEI() {
    const key = eiKey();
    if (key !== ui.EIkey) {
        const EI0 = 1e10, nEL = BS.nElements(mdl.Ltot, inp.dL), dl = mdl.Ltot / nEL, xs = mdl.xs;
        const lim = parseFloat(ui.EIopt.slice(10));
        const stp = Math.max(1, Math.ceil((nEL + 1) / Math.max(rnd(nMax / (nEL + 1)), 120)));   // as sectionGrid
        let lanes = 1;
        const delAt = async (idx, p0, p1) => {                   // downward deflection at the nodes idx (m); null: cancelled
            const I0 = await calcIL({ L: inp.L, EI: EI0, dL: inp.dL, bc: inp.bc, xp: idx.map(i => i * dl) }, p0, p1);
            if (!I0) return null;
            const L0e = BS.loadEffect(I0, 'LM1', { w: inp.w, freq: true });
            lanes = L0e.T.lanes;
            return { x: idx.map(i => i * dl), d: Array.from(L0e.d[0], v => -v) };
        };
        const all = []; for (let i = 0; i <= nEL; i += stp) all.push(i);
        if (all[all.length - 1] !== nEL) all.push(nEL);
        const R = await delAt(all, 0, stp > 1 ? 0.5 : 1);
        if (!R) return false;
        const best = xs.slice(1).map((x1, i) => {               // per span: index into R of the largest
            let b = -1, v = -Infinity;
            R.x.forEach((x, j) => { if (x >= xs[i] - 1e-9 && x <= x1 + 1e-9 && R.d[j] > v) { v = R.d[j]; b = j; } });
            return [v, all[b]];
        });
        if (stp > 1) {                                           // every node near each span's largest
            const near = new Set();
            best.forEach(([, i0]) => { for (let i = Math.max(0, i0 - stp); i <= Math.min(nEL, i0 + stp); i++) near.add(i); });
            const R2 = await delAt([...near].sort((a, b) => a - b), 0.5, 1);
            if (!R2) return false;
            R2.x.forEach((x, j) => xs.slice(1).forEach((x1, i) => { if (x >= xs[i] - 1e-9 && x <= x1 + 1e-9 && R2.d[j] > best[i][0]) best[i][0] = R2.d[j]; }));
        }
        let need = 0, gov = 0;
        best.forEach(([del], i) => { const r = del * lim / inp.L[i]; if (r > need) { need = r; gov = i; } });
        let EI = EI0 * need;
        const e = Math.floor(Math.log10(EI)) - 2;
        EI = Math.ceil(Number((EI / 10 ** e).toPrecision(12))) * 10 ** e;   // 3 digits, on the safe side
        EI = Number(EI.toPrecision(3));
        ui.EIinfo = { opt: ui.EIopt, lim, gov: gov + 1, lanes, w: inp.w, EI };
        ui.EIkey = key;
    }
    const I = ui.EIinfo;
    inp.EI = [I.EI];
    $('iEI').value = `${gfmt(I.EI / 1e9)}E9`; $('iEI').classList.add('auto');
    $('iEI').title = `EI from L/delta = ${I.lim.toFixed(0)} (TRVINFRA-00331 10.3.2.2.1): frequent LM1 (psi_1 0.75/0.40), alpha of TSFS 2018:57, ${I.lanes} lane${I.lanes > 1 ? 's' : ''} (w = ${gfmt(I.w)} m); governs in span ${I.gov}; type a value to set EI by hand`;
    return true;
}

// the sections the influence lines are solved at: every node while that fits in nMax
// entries per matrix, always with the supports, the element either side, the mid-spans
function sectionGrid() {
    const nEL = rnd(mdl.Ltot / mdl.dL), stp = Math.max(1, Math.ceil((nEL + 1) / Math.max(rnd(nMax / (nEL + 1)), 120)));
    const sx = mdl.xs, spc = [...sx, ...sx.map(x => Math.max(x - mdl.dL, 0)), ...sx.map(x => Math.min(x + mdl.dL, mdl.Ltot))];
    for (let i = 1; i < sx.length; i++) spc.push((sx[i] + sx[i - 1]) / 2);
    const set = new Set();
    for (let i = 0; i <= nEL; i += stp) set.add(i);
    for (const v of spc) set.add(rnd(v / mdl.dL));
    mdl.xa = [...set].sort((a, b) => a - b).map(i => i * mdl.dL);
    mdl.spc = spc;
}
function setSection(j) {
    if (j === null) { let b = Infinity; mdl.xa.forEach((x, i) => { const d = Math.abs(x - xp); if (d < b) { b = d; j = i; } }); }
    jx = Math.min(Math.max(Math.round(j), 0), mdl.xa.length - 1);
    xp = mdl.xa[jx];
    $('iXp').value = String(Number(xp.toPrecision(4)));
    if (modelMap && modelMap.mk) moveMarker();
}
const showMode = () => $('iShw').value;

// ============================================================ analysis
// influence lines in a worker of their own, so that the page stays live, with the progress
// bar from p0 to p1 and Cancel (as BeamStat_rail); in the page below nElWorker elements, or
// when no worker can be made (a page opened from file://).  Resolved with null when cancelled.
const nElWorker = 400;
let ilW = null;
function calcIL(args, p0 = 0, p1 = 1) {
    const inPage = () => BS.influenceLines(args);
    if (BS.nElements(sum(args.L), args.dL) < nElWorker || window.__noWorkers === true) return Promise.resolve().then(inPage);
    return new Promise((resolve, reject) => {
        let over = false;
        const end = () => { over = true; ui.abort = null; };
        const fallback = () => { end(); if (ilW) ilW.terminate(); ilW = null; try { resolve(inPage()); } catch (e) { reject(e); } };
        try { if (!ilW) ilW = new Worker(`solver.worker.js?v=${VER}`); } catch (e) { fallback(); return; }
        ui.abort = () => { if (!over) { end(); ilW.terminate(); ilW = null; resolve(null); } };
        ilW.onmessage = ev => {
            if (over) return;
            const r = ev.data;
            if (r.prog !== undefined) { setProg(p0 + (p1 - p0) * r.prog); return; }
            end();
            if (r.ok) resolve(r.IL); else reject(new Error(r.message));
        };
        ilW.onerror = e => { if (!over) { e.preventDefault(); fallback(); } };
        ilW.postMessage({ ilJob: args });
    });
}
// the influence lines of the model; false when cancelled
async function buildIL() {
    const R = await calcIL({ L: inp.L, EI: inp.EI.length === 1 ? inp.EI[0] : inp.EI, dL: inp.dL, bc: inp.bc, xp: mdl.xa });
    if (!R) return false;
    ILa = R;
    const Ir = ILa, iv = ILa.bc.map((b, i) => (b[1] === 1 ? i : -1)).filter(i => i >= 0);
    const rng = A => { let a = Infinity, b = -Infinity; for (const c of A) for (let i = 0; i < c.length; i++) { if (c[i] < a) a = c[i]; if (c[i] > b) b = c[i]; } return [a, b]; };
    mdl.rng = { M: rng(Ir.M), V: rng(Ir.V), d: rng(Ir.d), r: rng(Ir.r), RF: rng(iv.map(i => Ir.RF[i])) };
    const n2 = mdl.xa.length, st2 = Math.max(1, rnd(n2 / 120)), e = new Set([n2 - 1]);
    for (let i = 0; i < n2; i += st2) e.add(i);
    const ix = mdl.xa.map(x => rnd(x / mdl.dL));
    for (const v of mdl.spc) { const k = ix.indexOf(rnd(v / mdl.dL)); if (k >= 0) e.add(k); }
    mdl.env = [...e].sort((a, b) => a - b);
    return true;
}
function ilAt(j) {
    const pick = (A, B) => { A.xp = j.map(i => ILa.xp[i]); for (const q of ['M', 'V', 'd', 'r']) A[q] = j.map(i => B[q][i]); return A; };
    const o = pick(Object.assign({}, ILa), ILa);
    return o;
}
const leOpt = () => ({ dyn: inp.dyn, v: inp.v, BK: inp.BK, dx: inp.dx, w: inp.w, gapL: inp.gapL });

// ---- the worker pool: one load model per job; the influence lines once per bridge
const nWorkers = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));   // more gain little, and each gets a copy of the lines
let pool = null, sendKey = null;
function makePool() {
    try { pool = Array.from({ length: nWorkers }, () => new Worker(`solver.worker.js?v=${VER}`)); }
    catch (e) { pool = null; }
}
// warm up after the start, so that the first analysis of many models does not pay for the
// compiling of the code: one small job per worker, the reply (id -1) is ignored
function warmPool() {
    if (pool || window.__noWorkers === true) return;
    makePool();
    if (!pool) return;
    const il = BS.influenceLines({ L: [10, 10], EI: 35e9, dL: 0.5 });
    pool.forEach(w => { w.postMessage({ il }); w.postMessage({ id: -1, name: 'g', opt: { BK: 'BK1', dx: 0.5 } }); });
}
function killPool() { if (pool) pool.forEach(w => w.terminate()); pool = null; sendKey = null; }
// several load models: resolved with true when cancelled
function runPool(names, ILe, show) {
    return new Promise((resolve, reject) => {
        if (sendKey !== sig) { pool.forEach(w => w.postMessage({ il: ILe })); sendKey = sig; }
        let next = 0, done = 0, over = false;
        ui.abort = () => { if (!over) { over = true; ui.abort = null; killPool(); resolve(true); } };
        const feed = w => {
            if (over || next >= names.length) return;
            const k = next++, name = names[k];
            w.onmessage = ev => {
                if (over) return;
                const r = ev.data;
                if (r.id !== k) return;                          // a reply from the warm-up
                if (!r.ok) { over = true; killPool(); reject(new Error(r.message)); return; }
                allS.set(name, r.LE); done++;
                if (show) { setProg(done / names.length); setMsg(`${name}: ${done}/${names.length}`); }
                if (done === names.length) { over = true; ui.abort = null; resolve(false); } else feed(w);
            };
            w.onerror = e => { if (!over) { over = true; killPool(); reject(new Error(e.message || 'worker error')); } };
            w.postMessage({ id: k, name, opt: leOpt() });
        };
        pool.forEach(feed);
    });
}
// the same in the page: few load models, or no workers (a page opened from file://)
async function runSerial(names, ILe, show) {
    for (let k = 0; k < names.length; k++) {
        if (show) { setProg(k / names.length); setMsg(`${names[k]}: ${k + 1}/${names.length}`); await nextFrame(); }
        if (ui.stopReq) return true;
        allS.set(names[k], BS.loadEffect(ILe, names[k], leOpt()));
    }
    return false;
}
// envelope over the beam per ticked load model, once per bridge and model, and over the ticked
// models (LE).  Cancelled: the models not calculated are unticked.
async function calcEnv(prog) {
    const nw = sel.filter(n => !allS.has(n)), show = prog || nw.length > 2;
    let stopped = false;
    if (nw.length) {
        const ILe = ilAt(mdl.env);
        const par = nw.length >= 3 && window.__noWorkers !== true;
        if (par && !pool && ui.started) makePool();              // the start-up analysis runs in the page: the workers are not warm yet
        if (par && pool) stopped = await runPool(nw, ILe, show);
        else stopped = await runSerial(nw, ILe, show);
    }
    if (stopped) { sel = sel.filter(n => allS.has(n)); syncTicks(); }
    allN = sel.slice(); allR = sel.map(n => allS.get(n));
    LE = mergeSel(allN, allR);
    return stopped;
}
// the load effects of the load models as one: the envelopes over them, and each peak with the
// arrangement of the model that governs it
function mergeSel(N, R) {
    if (!R.length) return null;
    if (R.length === 1) return R[0];
    const M = Object.assign({}, R[0], { xpeak: {}, pos: {} });
    for (const q of ['M', 'V', 'd', 'r', 'RF']) {
        const m = R[0][q][0].length, lo = new Float64Array(m), hi = new Float64Array(m);
        for (let j = 0; j < m; j++) {
            let a = Infinity, b = -Infinity;
            for (const L of R) { if (L[q][0][j] < a) a = L[q][0][j]; if (L[q][1][j] > b) b = L[q][1][j]; }
            lo[j] = a; hi[j] = b;
        }
        M[q] = [lo, hi];
    }
    for (const [n, c] of [['Mmax', 1], ['Mmin', -1], ['Vmax', 0], ['dmax', 0], ['rmax', 0], ['RFmax', 1], ['RFmin', -1]]) {
        let k = 0, b = c < 0 ? Infinity : -Infinity;
        R.forEach((L, i) => {
            const v = c === 0 ? Math.abs(L[n]) : L[n];
            if (c < 0 ? v < b : v > b) { b = v; k = i; }
        });
        M[n] = R[k][n]; M.xpeak[n] = R[k].xpeak[n];
        M.pos[n] = Object.assign({}, R[k].pos[n], { model: N[k] });
    }
    M.snap = Math.max(...R.map(L => L.snap));
    return M;
}

async function analyse(isNew) {
    progStart();
    const t0 = performance.now();
    showElements();
    try {
        if (isNew) {
            await nextFrame();
            if (!(await buildIL())) {                            // cancelled: no model, a new update starts again
                ILa = null; LE = null; allN = []; allR = []; sig = ''; sendKey = null;
                clearPlots(); $('dynT').innerHTML = ''; msgDone(true, t0); progEnd();
                return true;
            }
            setSection(null);
        }
        const stopped = await calcEnv(false);
        if (stopped) { ui.busy = false; readInput(); ui.busy = true; }
        updatePlots();
        setHead();
        msgDone(stopped, t0);
    } catch (e) {
        ILa = null; LE = null; allN = []; allR = [];
        clearPlots(); $('dynT').innerHTML = '';
        setMsg(e && e.message ? e.message : 'error', RED);
        console.error(e);
    }
    progEnd();
    return true;
}
function setHead() {
    $('dynT').innerHTML = PL.texHTML(dynText());
    let tip = 'Element length; axles stand on nodes, so spacings it does not divide are rounded';
    if (LE && LE.snap > 1e-9) tip += `; now by up to ${gfmt(Number(LE.snap.toPrecision(2)))} m`;
    $('idL').title = tip;
}
async function onRun() {
    if ((await updateModel()) === false) return;
    while (ui.busy) await new Promise(r => setTimeout(r, 20));
    if (!ILa) return;
    progStart();
    const t0 = performance.now();
    showElements();
    try {
        const sel0 = sel.slice(), S0 = allS;
        allS = new Map();
        setProg(0);
        const stopped = await calcEnv(true);
        if (stopped) {                                           // as before the Run
            sel = sel0; allS = S0;
            syncTicks();
            await calcEnv(false);
        }
        updatePlots();
        setHead();
        msgDone(stopped, t0);
    } catch (e) { setProg(null); setMsg(e && e.message ? e.message : 'error', RED); console.error(e); }
    progEnd();
}
function onReset() { mT.style.display = 'none'; $('mEI').style.display = 'none'; $('mW').style.display = 'none'; setDefaults(); updateModel(); }

// the dynamic allowance and the determining length, above the model; one value for all
// type vehicles
function dynText() {
    if (!LE || !inp.dyn) return '';
    const nL = allN.filter(n => lmList.includes(n));             // LM1, LM2 ticked
    if (nL.length === allN.length) return `${nL.join(', ')}: dynamic amplification included in the load values, $\\Phi$ = 1`;
    const s = dynOne(allR[allN.findIndex(n => !lmList.includes(n))]);
    return nL.length ? `${s}, ${nL.join(', ')}: 1` : s;
}
const dynOne = L => `$\\Phi$ = ${L.phi.toFixed(2)}, $D = (180 + 8(v - 10))/(20 + L)$ = ${L.D.toFixed(1)} %, $L$ = ${L.Lphi.toFixed(1)} m`;

// units: symbol, unit and scale of a peak, the same of the envelope plots, influence line
const UNIT = {
    M: { sy: 'M', uv: 'kNm', sc: 1e3, uE: 'MNm', sE: 1e6, kI: 1, uI: 'm' },
    V: { sy: 'V', uv: 'kN', sc: 1e3, uE: 'MN', sE: 1e6, kI: 1, uI: '-' },
    d: { sy: 'd', uv: 'mm', sc: 1e-3, uE: 'mm', sE: 1e-3, kI: 1e9, uI: 'mm/MN' },
    r: { sy: '\\phi', uv: 'mrad', sc: 1e-3, uE: 'mrad', sE: 1e-3, kI: 1e9, uI: 'mrad/MN' },
    RF: { sy: 'R', uv: 'kN', sc: 1e3, uE: 'MN', sE: 1e6, kI: 1, uI: '-' }
};
const fmtVal = (q, v) => { const U = UNIT[q], w = v / U.sc, s = ['M', 'V', 'RF'].includes(q) ? w.toFixed(0) : w.toFixed(1); return `${s} ${U.uv}`.replace(/^-0 /, '0 '); };
const qtyName = () => ($('tD').checked ? 'd' : $('tR').checked ? 'r' : 'RF');

// ============================================================ model plot
function drawModel(svg, box, opt) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const L = mdl.Ltot, yd = -0.075 * L, yr = [yd - 0.035 * L, 0.12 * L], xl = [-0.02 * L, 1.02 * L];
    const ysp = Math.max((xl[1] - xl[0]) * box.h / box.w, yr[1] - yr[0]), ym = (yr[0] + yr[1]) / 2, yl = [ym - ysp / 2, ym + ysp / 2];
    const X = x => box.x + (x - xl[0]) / (xl[1] - xl[0]) * box.w, Y = y => box.y + box.h - (y - yl[0]) / (yl[1] - yl[0]) * box.h;
    const sc = box.w / (xl[1] - xl[0]), line = (x1, y1, x2, y2, c, w) => PL.el('line', { x1: X(x1), y1: Y(y1), x2: X(x2), y2: Y(y2), stroke: c, 'stroke-width': w }, svg);
    line(0, 0, L, 0, '#8c8c8c', 4);
    mdl.xs.forEach((x, i) => {
        if (sup[i]) line(x, -0.03 * L, x, 0.03 * L, '#000', 1);
        else {
            const a = 0.02 * L * sc, b = 0.03 * L * sc;
            PL.el('polygon', { points: `${X(x) - a},${Y(0) + b} ${X(x) + a},${Y(0) + b} ${X(x)},${Y(0)}`, fill: '#fff', stroke: '#000', 'stroke-width': 0.7 }, svg);
            PL.el('circle', { cx: X(x), cy: Y(0), r: 2, fill: '#000' }, svg);
        }
    });
    line(0, yd, L, yd, '#000', 0.4);
    mdl.xs.forEach(x => {
        line(x, yd - 0.016 * L, x, yd + 0.024 * L, '#000', 0.4);
        line(x - 0.012 * L, yd - 0.012 * L, x + 0.012 * L, yd + 0.012 * L, '#000', 0.4);
    });
    for (let i = 0; i + 1 < mdl.xs.length; i++)
        PL.text(svg, (mdl.xs[i + 1] - mdl.xs[i]).toFixed(1), X((mdl.xs[i] + mdl.xs[i + 1]) / 2), Y(yd + 0.004 * L) - 2, { size: opt.size, anchor: 'middle', baseline: 'text-after-edge' });
    return { X, Y, L, xl, yl, box };
}
function plotBeam() {
    const m = drawModel($('model'), { x: 48, y: 0, w: 410, h: 95 }, { size: 14.7 });
    m.mk = PL.el('g', {}, $('model'));
    modelMap = m;
    drawMarker(m);
    moveMarker();
}
function drawMarker(m) {
    const b = 0.045 * m.L * m.box.w / (m.xl[1] - m.xl[0]);
    PL.el('line', { x1: 0, y1: 0, x2: 0, y2: -b, stroke: co[0], 'stroke-width': 0.8 }, m.mk);
    PL.el('polygon', { points: `0,${-b} -4,${-b - 7} 4,${-b - 7}`, fill: co[0] }, m.mk);
}
function moveMarker() { modelMap.mk.setAttribute('transform', `translate(${modelMap.X(xp)} ${modelMap.Y(0)})`); }
// the critical sections on the sketch; they replace the marker
function markPeaks(on, m, svg) {
    m = m || modelMap; svg = svg || $('model');
    svg.querySelectorAll('.xpk').forEach(e => e.remove());
    if (m.mk) m.mk.style.display = on ? 'none' : '';
    if (!on || !LE) return;
    peakNames().forEach((n, i) => {
        const U = UNIT[n.replace(/(max|min)$/, '')], xq = LE.xpeak[n], L = m.L, sc = m.box.w / (m.xl[1] - m.xl[0]);
        const yl = (0.014 + 0.03 * (i % 2)) * L * sc, px = m.X(xq), py = m.Y(0), g = PL.el('g', { class: 'xpk' }, svg);
        PL.el('line', { x1: px, y1: py, x2: px, y2: py - yl, stroke: co[1], 'stroke-width': 0.8 }, g);
        PL.el('polygon', { points: `${px},${py} ${px - 3},${py - 5} ${px + 3},${py - 5}`, fill: co[1] }, g);
        PL.text(g, `$${U.sy}_\\mathrm{${n.slice(-3)}}$`, px, py - yl - 1, { size: 12, anchor: 'middle', fill: co[1], baseline: 'text-after-edge' });
    });
}
// on or below the beam line and near a support: the pull-down for that support; a right
// click near a support at any height; anywhere else grab the marker
const mdlPoint = ev => {
    const r = $('model').getBoundingClientRect(), m = modelMap;
    const x = m.xl[0] + (ev.clientX - r.left - m.box.x) / m.box.w * (m.xl[1] - m.xl[0]);
    const y = m.yl[0] + (m.box.y + m.box.h - (ev.clientY - r.top)) / m.box.h * (m.yl[1] - m.yl[0]);
    return { x, y };
};
$('model').addEventListener('contextmenu', ev => ev.preventDefault());
$('model').addEventListener('click', ev => ev.stopPropagation());
// pointer events: mouse and touch
$('model').addEventListener('pointerdown', ev => {
    ev.stopPropagation(); ev.preventDefault();
    if (ui.busy || !ILa || !inputOK) return;
    removeSupSel(); mT.style.display = 'none';
    const P = mdlPoint(ev), alt = ev.button === 2;
    let bi = 0, bd = Infinity;
    mdl.xs.forEach((x, i) => { const d = Math.abs(x - P.x); if (d < bd) { bd = d; bi = i; } });
    if (bd < 0.03 * mdl.Ltot && (alt || P.y <= 0)) { supMenu(bi); return; }
    if (alt) return;
    const move = e => {
        const Q = mdlPoint(e);
        let b = Infinity, j = jx;
        mdl.xa.forEach((x, i) => { const d = Math.abs(x - Q.x); if (d < b) { b = d; j = i; } });
        if (j === jx) return;
        xpAuto = false;
        setSection(j);
        if (showMode() === 'Section') requestPlots();
    };
    const up = () => { for (const [n, f] of [['pointermove', move], ['pointerup', up], ['pointercancel', up]]) window.removeEventListener(n, f); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    move(ev);
});
function supMenu(bi) {
    const s = document.createElement('select');
    s.id = 'supsel';
    for (const t of ['pinned', 'clamped']) { const o = document.createElement('option'); o.textContent = t; s.appendChild(o); }
    s.value = sup[bi] ? 'clamped' : 'pinned';
    s.style.left = (10 + modelMap.X(mdl.xs[bi]) - 32) + 'px';
    s.style.top = (240 + modelMap.Y(0) + 8) + 'px';
    s.addEventListener('click', e => e.stopPropagation());
    s.addEventListener('mousedown', e => e.stopPropagation());
    s.addEventListener('change', () => { sup[bi] = s.value === 'clamped'; removeSupSel(); updateModel(); });
    $('fig').appendChild(s);
    ui.supJust = true;                                           // the mouse button is still down
    s.focus();
}
function removeSupSel() { const s = $('supsel'); if (s) s.remove(); }
// arrow keys step the section one grid point, ten with shift; not while typing
document.addEventListener('keydown', ev => {
    const a = document.activeElement;
    if (ui.busy || !ILa || !inputOK || (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT'))) return;
    const s = ev.shiftKey ? 10 : 1;
    if (ev.key === 'ArrowLeft') setSection(jx - s);
    else if (ev.key === 'ArrowRight') setSection(jx + s);
    else return;
    xpAuto = false;
    if (showMode() === 'Section') requestPlots();
});
let plotReq = false;
function requestPlots() {
    if (plotReq) return;
    plotReq = true;
    requestAnimationFrame(() => { plotReq = false; updatePlots(); });
}

// ============================================================ result plots
// a set of n axes on a shared x axis: GUI (in #res) or report
function guiSet(n) {
    const svg = $('res');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const gp = 6, ytop = 10, h = (510 - 52 - (n - 1) * gp) / n;
    return Array.from({ length: n }, (_, k) => {
        const ax = new PL.Axes(svg, { x: 48, y: ytop + k * (h + gp), w: 410, h }, { xTickLabels: k === n - 1 });
        ax.xlim = [-0.02 * mdl.Ltot, 1.02 * mdl.Ltot];
        if (k === n - 1) ax.xlabel = '$x$ (m)';
        return ax;
    });
}
function clearPlots() {
    const A = guiSet(4);
    A.forEach(ax => { ax.ylim = [0, 1]; ax.draw(); });
}
const peakNames = () => ['Mmax', 'Mmin', 'Vmax', qtyName() + 'max'];
function topText(ax, str) {
    ax.top = g => PL.text(g, str, ax.box.x + 3, ax.box.y + 11, { size: 13.3 });
}
const triangle = (g, ax, x, y, dr, fc, ec) => {
    const px = ax.X(x), py = ax.Y(y);
    PL.el('polygon', { points: `${px},${py} ${px - 3.5},${py - dr * 6} ${px + 3.5},${py - dr * 6}`, fill: fc, stroke: ec, 'stroke-width': 0.5 }, g);
};
function supports(g, ax, LEp, xc, yc) {
    LEp.supX.forEach((xs, i) => {
        if (LEp.supDir[i] !== 1) return;
        let y0 = 0;
        if (xc) {                                                // the tip on the curve
            const k = Math.round((xs - xc[0]) / (xc[1] - xc[0]));
            if (k >= 0 && k < xc.length) y0 = yc[k];
        }
        triangle(g, ax, xs, y0, -1, '#fff', '#000');
    });
}
function drawLoad(ax, LEp, C, q, bare, nm) {
    const U = UNIT[q], x = Array.from(LEp.x), h = Array.from(C.h, v => v * U.kI), rr = mdl.rng[q].map(v => v * U.kI);
    let rg = Math.max(Math.abs(rr[0]), Math.abs(rr[1])); if (rg === 0) rg = 1;
    const aH = 0.30 * rg, qH = 0.10 * rg, lo = Math.min(rr[0], 0) - 0.08 * rg;
    const hi = (bare ? Math.max(rr[1], 0) : Math.max(rr[1], aH)) + 0.05 * rg;
    ax.ylim = [lo, hi + 0.22 * (hi - lo)];
    ax.ylabel = `$\\xi_{${U.sy}}$ (${U.uI})`;
    const Lt = mdl.Ltot;
    ax.under = g => {
        PL.el('line', { x1: ax.X(-0.02 * Lt), y1: ax.Y(0), x2: ax.X(1.02 * Lt), y2: ax.Y(0), stroke: '#808080', 'stroke-width': 0.5 }, g);
        // the distributed load q: one polygon per stretch that carries load
        let wm = 0; for (let i = 0; i < C.w.length; i++) if (C.w[i] > wm) wm = C.w[i];
        for (let i = 0; i < C.w.length; i++) {
            if (!(C.w[i] > 0)) continue;
            let j = i; while (j + 1 < C.w.length && C.w[j + 1] > 0) j++;
            let pts = '';
            for (let k = i; k <= j; k++) pts += `${ax.X(x[k]).toFixed(2)},${ax.Y(C.w[k] * qH / wm).toFixed(2)} `;
            pts += `${ax.X(x[j]).toFixed(2)},${ax.Y(0).toFixed(2)} ${ax.X(x[i]).toFixed(2)},${ax.Y(0).toFixed(2)}`;
            PL.el('polygon', { points: pts, fill: co[1], 'fill-opacity': 0.25, stroke: co[1], 'stroke-width': 0.5 }, g);
            i = j;
        }
        // the section
        const sx = ax.X(C.x);
        PL.el('line', { x1: sx, y1: ax.box.y, x2: sx, y2: ax.box.y + ax.box.h, stroke: '#999', 'stroke-width': 0.5 }, g);
        // axle loads, the tip of the head on the zero line
        if (C.xa.length) {
            const Pm = Math.max(...C.Pa);
            C.xa.forEach((v, i) => {
                const px = ax.X(v), y0 = ax.Y(0);
                PL.el('line', { x1: px, y1: y0, x2: px, y2: ax.Y(aH * C.Pa[i] / Pm), stroke: co[1], 'stroke-width': 0.8 }, g);
                PL.el('polygon', { points: `${px},${y0} ${px - 2},${y0 - 4} ${px + 2},${y0 - 4}`, fill: co[1] }, g);
            });
        }
    };
    ax.plot(x, h, { color: co[0], width: 1 });
    ax.over = g => supports(g, ax, LEp, x, h);
    ax.onTipText = (xv, yv) => [`x = ${Number(xv.toPrecision(4))} m`, `${Number(yv.toPrecision(4))} ${U.uI}`];
    if (bare) topText(ax, `Influence line at $x$ = ${C.x.toFixed(1)} m`);
    else {
        let v = C.val;
        if (nm !== 'Mmin' && q !== 'RF') v = Math.abs(v);
        topText(ax, `$${U.sy}_\\mathrm{${nm.slice(-3)}}$ = ${fmtVal(q, v)} at $x$ = ${C.x.toFixed(1)} m${C.model ? ' (' + C.model + ')' : ''}`);
    }
}
function drawPos(LEp, bare, set) {
    let nms = peakNames();
    if (bare) nms = [nms[0], nms[2], nms[3]];
    const A = set(nms.length);
    nms.forEach((n, k) => {
        const q = n.replace(/(max|min)$/, '');
        drawLoad(A[k], LEp, LEp.pos[n], q, bare, n);
        A[k].draw();
    });
}
function ilLE() {
    const x = IL.x, LEx = { x, supX: IL.supX, supDir: IL.supDir, pos: {} };
    for (const f of ['M', 'V', qtyName()]) {
        let h = f === 'RF' ? null : IL[f][0], xc = xp;
        if (f === 'RF') {
            let b = Infinity, k = 0;
            IL.bc.forEach((c, i) => { if (c[1] === 1) { const d = Math.abs(IL.supX[i] - xp); if (d < b) { b = d; k = i; } } });
            h = IL.RF[k]; xc = IL.supX[k];
        }
        const C = { quant: f, h, x: xc, val: 0, q: 1, xa: [], Pa: [], w: new Float64Array(x.length) };
        LEx.pos[f + 'max'] = C; LEx.pos[f + 'min'] = C;
    }
    return LEx;
}
// the envelopes along the beam: one load model; several: over them, with the governing one
function envAxis(ax, q, xe, hi, lo, Lr, txt) {
    const U = UNIT[q];
    let vx = -Infinity, ix = 0, vn = Infinity, inn = 0;
    hi.forEach((v, i) => { if (v > vx) { vx = v; ix = i; } });
    lo.forEach((v, i) => { if (v < vn) { vn = v; inn = i; } });
    const rg = Math.max(vx - vn, Number.EPSILON);
    ax.ylim = [vn - 0.10 * rg, vx + 0.28 * rg];
    ax.ylabel = `$${U.sy}$ (${U.uE})`;
    const Lt = mdl.Ltot;
    ax.under = g => {
        PL.el('line', { x1: ax.X(-0.02 * Lt), y1: ax.Y(0), x2: ax.X(1.02 * Lt), y2: ax.Y(0), stroke: '#808080', 'stroke-width': 0.5 }, g);
        if (q !== 'RF') {
            let pts = '';
            xe.forEach((v, i) => { pts += `${ax.X(v).toFixed(2)},${ax.Y(hi[i]).toFixed(2)} `; });
            for (let i = xe.length - 1; i >= 0; i--) pts += `${ax.X(xe[i]).toFixed(2)},${ax.Y(lo[i]).toFixed(2)} `;
            PL.el('polygon', { points: pts, fill: co[0], 'fill-opacity': 0.12 }, g);
        }
    };
    if (q === 'RF') {
        ax.over = g => {
            xe.forEach((v, i) => {
                PL.el('line', { x1: ax.X(v), y1: ax.Y(lo[i]), x2: ax.X(v), y2: ax.Y(hi[i]), stroke: co[0], 'stroke-width': 1 }, g);
                PL.el('circle', { cx: ax.X(v), cy: ax.Y(hi[i]), r: 2.5, fill: co[0] }, g);
                PL.el('circle', { cx: ax.X(v), cy: ax.Y(lo[i]), r: 2.5, fill: '#fff', stroke: co[0], 'stroke-width': 0.7 }, g);
            });
            triangle(g, ax, xe[ix], vx, 1, co[1], co[1]);
            triangle(g, ax, xe[inn], vn, -1, co[1], co[1]);
            supports(g, ax, Lr);
        };
    } else {
        ax.plot(xe, hi, { color: co[0] }); ax.plot(xe, lo, { color: co[0] });
        ax.over = g => {
            triangle(g, ax, xe[ix], vx, 1, co[1], co[1]);
            triangle(g, ax, xe[inn], vn, -1, co[1], co[1]);
            supports(g, ax, Lr);
        };
    }
    ax.onTipText = (xv, yv) => [`x = ${Number(xv.toPrecision(4))} m`, `${Number(yv.toPrecision(4))} ${U.uE}`];
    topText(ax, txt(vx * U.sE, xe[ix], vn * U.sE, xe[inn], ix, inn));
}
function drawEnv(LEp, set) {
    const qs = ['M', 'V', qtyName()], A = set(3);
    qs.forEach((q, k) => {
        const U = UNIT[q];
        let xe = Array.from(LEp.xp), hi = Array.from(LEp[q][1], v => v / U.sE), lo = Array.from(LEp[q][0], v => v / U.sE);
        if (q === 'RF') {
            const iv = LEp.supDir.map((d, i) => (d === 1 ? i : -1)).filter(i => i >= 0);
            xe = iv.map(i => LEp.supX[i]); hi = iv.map(i => LEp[q][1][i] / U.sE); lo = iv.map(i => LEp[q][0][i] / U.sE);
        }
        envAxis(A[k], q, xe, hi, lo, LEp, (vx, xx, vn, xn) =>
            `$${U.sy}_\\mathrm{max}$ = ${fmtVal(q, vx)} at $x$ = ${xx.toFixed(1)} m, $${U.sy}_\\mathrm{min}$ = ${fmtVal(q, vn)} at $x$ = ${xn.toFixed(1)} m`);
        A[k].draw();
    });
}
function drawAll(set) {
    const qs = ['M', 'V', qtyName()], A = set(3), Lr = allR[0];
    qs.forEach((q, k) => {
        const U = UNIT[q];
        let iv = Lr[q][0].map ? Array.from(Lr[q][0], (_, i) => i) : [], xe = Array.from(Lr.xp);
        if (q === 'RF') { iv = Lr.supDir.map((d, i) => (d === 1 ? i : -1)).filter(i => i >= 0); xe = iv.map(i => Lr.supX[i]); }
        const hi = iv.map(i => Math.max(...allR.map(L => L[q][1][i])) / U.sE), lo = iv.map(i => Math.min(...allR.map(L => L[q][0][i])) / U.sE);
        const tr = (i, side, val) => allN[allR.findIndex(L => L[q][side][iv[i]] / U.sE === val)];
        envAxis(A[k], q, xe, hi, lo, Lr, (vx, xx, vn, xn, ix, inn) =>
            `$${U.sy}_\\mathrm{max}$ = ${fmtVal(q, vx)} (${tr(ix, 1, hi[ix])}), $${U.sy}_\\mathrm{min}$ = ${fmtVal(q, vn)} (${tr(inn, 0, lo[inn])})`);
        A[k].draw();
    });
}
function render(md, set) {
    if (md !== 'Section' && !LE) md = 'Section';
    if (md === 'Section') {
        if (!sel.length) drawPos(ilLE(), true, set);
        else drawPos(mergeSel(sel, sel.map(n => BS.loadEffect(IL, n, leOpt()))), false, set);
    } else if (md === 'Critical') drawPos(LE, false, set);
    else if (allR.length > 1) drawAll(set);
    else drawEnv(LE, set);
}
function updatePlots() {
    if (!ILa) return;
    IL = ilAt([jx]);
    let md = showMode();
    if (md !== 'Section' && !LE) md = 'Section';
    markPeaks(md !== 'Section');
    render(md, guiSet);
}

// ============================================================ export
// Chrome, Edge: a Save-as dialog, opened first (it needs the click); embedded browsers
// (Electron apps) open the dialog but write an empty file, so they get a plain download.
// null = cancelled.  A write that fails downloads the file, without a second dialog.
const TYPES = { xlsx: ['Excel workbook', { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] }]
};
async function pickFile(name, kind) {
    if (window.__saveHook) return { name };
    const embedded = /Electron|Claude\//.test(navigator.userAgent);
    if (window.showSaveFilePicker && !embedded) {
        try {
            const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: TYPES[kind][0], accept: TYPES[kind][1] }] });
            return { name: h.name, h };
        } catch (e) { if (e && e.name === 'AbortError') return null; }
    }
    return { name };
}
function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
// true: written, or downloaded as asked; false: downloaded after a failed write
async function writeFile(f, blob) {
    if (window.__saveHook) { await window.__saveHook(blob, f.name); return true; }
    if (!f.h) { download(blob, f.name); return true; }
    try {
        const w = await f.h.createWritable();
        await w.write(await blob.arrayBuffer());
        await w.close();
        if ((await f.h.getFile()).size === blob.size) return true;
    } catch (e) { console.error(e); }
    download(blob, f.name);
    return false;
}
const round = (v, d) => Number(v.toFixed(d));
// with an exponent in steps of three: 35E9
const expFmt = x => { const p = 3 * Math.floor(Math.log10(Math.abs(x)) / 3); return `${gfmt(x / 10 ** p)}E${p}`; };
async function onExport() {
    if (!ILa || !readInput()) return;                            // not with an invalid input
    const f = await pickFile('BeamStat_road.xlsx', 'xlsx');
    if (!f) return;
    try {
        const I0 = [['Quantity', 'Value', 'Unit'],
            ['Span lengths L', inp.L.map(gfmt).join(' '), 'm'],
            ['Flexural rigidity EI', inp.EI.map(expFmt).join(' '), 'Nm^2'],
            ['EI from', eiSource(false), '-'],
            ['Element size dL', mdl.dL, 'm'],
            ['Clamped supports', sup.map((c, i) => (c ? i + 1 : 0)).filter(Boolean).join(' '), '-']];
        const anyT = allN.some(n => typList.includes(n));
        if (anyT || allN.includes('LM1') || ui.EIopt) I0.push(['Carriageway width w', inp.w, 'm']);
        if (anyT) {
            const T0 = BS.vehicleModel('a', inp.BK, null, inp.w);
            I0.push(['Bearing class', inp.BK, '-'], ['Type vehicle value A', T0.A / 1e3, 'kN'], ['Type vehicle value B', T0.B / 1e3, 'kN'],
                ['Lanes of the type vehicles (K264958)', T0.lanes, '-'], ['Type vehicles times (1.0 and 0.8 in two lanes)', T0.fv, '-'],
                ['Lanes with q only, 5 kN/m each', Math.max(T0.lanes - 2, 0), '-'],
                ['Increment of the free axle spacings, 0 = the shortest only', inp.dx, 'm'],
                ['Distributed load q of a vehicle lane, where unfavourable', 5, 'kN/m'], ['Free distance in j, k, l, at least', inp.gapL, 'm'],
                ['Dynamic allowance applied, on the axle loads, also on d and rotation', inp.dyn ? 'on' : 'off', '-'], ['Speed v in formula (8-1)', inp.v, 'km/h']);
        }
        if (allN.includes('LM1')) {
            const [n1, , wr] = BS.lanes(inp.w);
            I0.push(['Notional lanes, LM1', n1, '-'], ['Remaining area, LM1', wr, 'm'],
                ['Adjustment factors aQ1 aQ2 aQ3 aq1 aqi aqr (TSFS 2018:57)', '0.9 0.9 0 0.8 1 1', '-']);
        }
        if (allN.includes('LM2')) I0.push(['Axle load LM2, beta_Q x 400 (beta_Q = aQ1)', 360, 'kN']);
        const hd = ['Load model', 'Phi (-)', 'D (%)', 'L (m)', 'v (km/h)', 'M_max (kNm)', 'x (m)', 'M_min (kNm)', 'x (m)',
                    'V_max (kN)', 'x (m)', 'd_max (mm)', 'x (m)', 'phi_max (mrad)', 'x (m)', 'R_max (kN)', 'x (m)'];
        const T = allR.map((L, k) => [allN[k], round(L.phi, 3), round(L.D, 1), round(L.Lphi, 2), allN[k].startsWith('LM') ? '-' : L.v,
            round(L.Mmax / 1e3, 0), L.xpeak.Mmax, round(L.Mmin / 1e3, 0), L.xpeak.Mmin,
            round(Math.abs(L.Vmax) / 1e3, 0), L.xpeak.Vmax, round(Math.abs(L.dmax) * 1e3, 1), L.xpeak.dmax,
            round(Math.abs(L.rmax) * 1e3, 1), L.xpeak.rmax, round(L.RFmax / 1e3, 0), L.xpeak.RFmax]);
        const res = [...I0, [], hd, ...T];

        const ILc = IL;
        const iv = ILc.bc.map((b, i) => (b[1] === 1 ? i : -1)).filter(i => i >= 0);
        const il = [['Section x_p (m)', xp], [], ['x (m)', 'xi_M (m)', 'xi_V (-)', 'xi_d (mm/MN)', 'xi_phi (mrad/MN)', ...iv.map(i => `xi_R at x = ${gfmt(ILc.supX[i])} m (-)`)]];
        ILc.x.forEach((x, i) => il.push([x, ILc.M[0][i], ILc.V[0][i], ILc.d[0][i] * 1e9, ILc.r[0][i] * 1e9, ...iv.map(b => ILc.RF[b][i])]));

        const ff = [['M', 'kNm', 1e3, 0], ['V', 'kN', 1e3, 0], ['d', 'mm', 1e-3, 1], ['r', 'mrad', 1e-3, 1]];   // quantity, unit, scale, decimals
        const env = [];
        if (allR.length) {
            const he = ['x (m)'], Lr = allR[0];
            allN.forEach(n => ff.forEach(f => { he.push(`${n} ${f[0]}_min (${f[1]})`, `${n} ${f[0]}_max (${f[1]})`); }));
            env.push(he);
            Array.from(Lr.xp).forEach((x, j) => {
                const r = [x];
                allR.forEach(L => ff.forEach(f => r.push(round(L[f[0]][0][j] / f[2], f[3]), round(L[f[0]][1][j] / f[2], f[3]))));
                env.push(r);
            });
            env.push([]);
            const ivs = Lr.supDir.map((d, i) => (d === 1 ? i : -1)).filter(i => i >= 0);
            const hr = ['Support x (m)']; allN.forEach(n => hr.push(`${n} R_min (kN)`, `${n} R_max (kN)`));
            env.push(hr);
            ivs.forEach(i => { const r = [Lr.supX[i]]; allR.forEach(L => r.push(round(L.RF[0][i] / 1e3, 0), round(L.RF[1][i] / 1e3, 0))); env.push(r); });
        }
        const blob = XLSX.write([{ name: 'Results', rows: res }, { name: 'InfluenceLines', rows: il }, { name: 'Envelopes', rows: env }]);
        setMsg(await writeFile(f, blob) ? 'saved' : `could not write ${f.name}, downloaded instead`);
    } catch (e) { setMsg('export failed', RED); console.error(e); }
}

// where EI comes from: typed, or the deflection limit; for Export (tex = false) and the report
function eiSource(tex) {
    if (!ui.EIopt || !ui.EIinfo) return 'input';
    const I = ui.EIinfo, pl = I.lanes > 1 ? 's' : '';
    const rule = I.lim === 300 ? 'TRVINFRA-00331 K164672, bridges to the 1960 rules and earlier' : 'TRVINFRA-00331 K230747, bridges to the 1975 road traffic load rules and later';
    if (!tex) return `L/delta = ${I.lim.toFixed(0)} under frequent LM1, ${I.lanes} lane${pl} (${rule})`;
    return `$EI$ from the deflection limit $L/\\delta_\\mathrm{V}$ = ${I.lim.toFixed(0)} (${rule}), governing in span ${I.gov}: deflection from LM1 at its frequent value ($\\psi_1$ = 0.75 on the tandems, 0.40 on the UDL), adjustment factors of TSFS 2018:57, ${I.lanes} notional lane${pl}, one $EI$ for all spans, rounded up.`;
}

// ============================================================ print
// an A4 page in a hidden frame, printed with the browser (Save as PDF); page margin boxes
// for the date (top right) and the page number "N (M)"
function printHTML(title, body) {
    const today = new Date().toISOString().slice(0, 10);
    const css = `@page { size: A4; margin: 25mm 25mm 25mm 25mm;
        @top-right { content: "${today}"; font: 11pt "Times New Roman", Times, serif; }
        @bottom-center { content: counter(page) " (" counter(pages) ")"; font: 11pt "Times New Roman", Times, serif; } }
      body { margin: 0; font: 11pt/1.2 "Times New Roman", Times, serif; color: #000; }
      h1 { font-size: 16pt; font-weight: normal; margin: 0 0 6pt; }
      h2 { font-size: 14pt; margin: 11pt 0 3pt; break-after: avoid; }
      p { margin: 0 0 6pt; text-align: justify; hyphens: auto; }
      ul { margin: 0 0 6pt; padding-left: 1.2em; }
      li { margin: 0 0 4pt; text-align: justify; hyphens: auto; }
      table { border-collapse: collapse; margin: 3pt auto 6pt; break-inside: avoid; }
      caption { caption-side: top; padding-bottom: 4pt; }
      th, td { padding: 1pt 7pt; text-align: left; font-weight: normal; }
      td.r, th.r { text-align: right; } td.c, th.c { text-align: center; }
      tr.gr { border-top: 0.8pt solid #000; } tr.gr td { padding-top: 3pt; font-weight: bold; }
      table.long td { padding-top: 0.5pt; padding-bottom: 0.5pt; line-height: 1.2; }
      thead tr { border-top: 0.8pt solid #000; border-bottom: 0.8pt solid #000; }
      tbody tr:last-child { border-bottom: 0.8pt solid #000; }
      figure { margin: 4pt 0 6pt; text-align: center; break-inside: avoid; }
      figcaption { margin-top: 4pt; }
      .np { break-before: page; }
      svg { display: block; margin: 0 auto; }`;
    const fr = document.createElement('iframe');
    fr.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0';
    document.body.appendChild(fr);
    const doc = fr.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body>${body}</body></html>`);
    doc.close();
    if (window.__printHook) { window.__printHook(fr, title); return; }
    const t0 = document.title;
    document.title = title;
    setTimeout(() => {
        fr.contentWindow.focus(); fr.contentWindow.print();
        document.title = t0;
        setTimeout(() => fr.remove(), 1000);
    }, 300);
}
// the report as HTML: headings, paragraphs and table cells in the LaTeX subset of plot.js
class ReportDoc {
    constructor() { this.b = ''; this.nt = 0; this.nf = 0; }
    h1(s) { this.b += `<h1>${PL.texHTML(s)}</h1>`; }
    h2(s, opt) { this.b += `<h2${opt && opt.newPage ? ' class="np"' : ''}>${PL.texHTML(s)}</h2>`; }
    p(s) { this.b += `<p>${PL.texHTML(s)}</p>`; }
    ul(items) { this.b += `<ul>${items.map(s => `<li>${PL.texHTML(s)}</li>`).join('')}</ul>`; }
    // a row given as a string: the title of a group, across the table
    table(cap, head, rows, al) {
        const cell = (t, c, i) => `<${t} class="${al[i]}">${PL.texHTML(String(c))}</${t}>`;
        this.b += `<table${rows.length > 25 ? ' class="long"' : ''}><caption>Table ${++this.nt}:&ensp;${PL.texHTML(cap)}</caption>` +
                  `<thead><tr>${head.map((c, i) => cell('th', c, i)).join('')}</tr></thead>` +
                  `<tbody>${rows.map(r => (typeof r === 'string' ? `<tr class="gr"><td colspan="${head.length}">${PL.texHTML(r)}</td></tr>` : `<tr>${r.map((c, i) => cell('td', c, i)).join('')}</tr>`)).join('')}</tbody></table>`;
    }
    figure(svg, cap) {
        const vb = svg.getAttribute('viewBox').split(/\s+/).map(Number);
        svg.setAttribute('width', '160mm'); svg.setAttribute('height', (160 * vb[3] / vb[2]).toFixed(1) + 'mm');
        this.b += `<figure>${svg.outerHTML}<figcaption>Figure ${++this.nf}:&ensp;${PL.texHTML(cap)}</figcaption></figure>`;
    }
}
// several load models: with a page each, or only the model and the results table
function askReport() {
    return new Promise(resolve => {
        const d = $('dlg');
        d.innerHTML = '<p>Report with the plots of each load model, or only the model and the results table?</p><div></div>';
        for (const t of ['Full report', 'Results table', 'Cancel']) {
            const b = document.createElement('button');
            b.textContent = t;
            b.addEventListener('click', ev => { ev.stopPropagation(); d.style.display = 'none'; resolve(t); });
            d.lastChild.appendChild(b);
        }
        d.addEventListener('click', ev => ev.stopPropagation());
        d.style.display = 'block';
    });
}
const newSvg = (w, h) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return svg;
};
// the results of a load model at its critical sections, with the reaction as a plot of its own
function critSvg(L1) {
    let q4 = qtyName(); if (q4 === 'RF') q4 = 'd';
    const nms = ['Mmax', 'Mmin', 'Vmax', q4 + 'max', 'RFmax'], np = nms.length, gp = 10, y0 = 52, hp = 106, H = y0 + np * hp + (np - 1) * gp + 6;
    const svg = newSvg(700, H);
    nms.forEach((n, i) => {
        const ax = new PL.Axes(svg, { x: 80, y: 6 + i * (hp + gp), w: 590, h: hp }, { xTickLabels: i === np - 1, pick: false });
        ax.xlim = [-0.02 * mdl.Ltot, 1.02 * mdl.Ltot];
        if (i === np - 1) ax.xlabel = '$x$ (m)';
        drawLoad(ax, L1, L1.pos[n], n.replace(/(max|min)$/, ''), false, n);
        ax.draw();
    });
    return svg;
}
// the load model: axle loads as arrows with their value (kN), q as bands, a chain of dimensions
// below (m), the free distance marked >=.  A long free distance (j, k, l) is drawn shorter, so
// that the axles have room.
function vehicleSvg(name) {
    const hr = 150, svg = newSvg(700, hr), b = { x: 20, y: 2, w: 660, h: hr - 4 };
    const T = BS.vehicleModel(name, inp.BK, inp.gapL, inp.w);
    const xa = T.x.slice(), Pa = T.P.map(v => v / 1e3), sg = T.qseg.map(s => s.slice());
    let ge = null;
    if (T.g.length === 2) {
        const i1 = T.grp.lastIndexOf(1), e1 = xa[i1];
        ge = [e1, xa[i1 + 1]];
        const sh = Math.max(T.dmin - 12, 0);                     // drawn shorter by this
        if (sh > 0) {
            T.grp.forEach((g, i) => { if (g === 2) xa[i] -= sh; });
            ge[1] -= sh;
            sg.forEach(s => s.forEach((v, j) => { if (isFinite(v) && v > e1 + T.dmin / 2) s[j] = v - sh; }));
        }
    }
    const fin = sg.flat().filter(isFinite), pts = [...xa, ...fin];
    let a = Math.min(...pts), c = Math.max(...pts);
    if (!sg.length) { a -= 1; c += 1; }
    a = Math.min(a, c - 10);                                     // a single axle not over the whole width
    const ext = 2.5, xl = [a - (sg.some(s => !isFinite(s[0])) ? ext : 0), c + (sg.some(s => !isFinite(s[1])) ? ext : 0)];
    const wd = xl[1] - xl[0], X0 = xl[0] - 0.01 * wd, X1 = xl[1] + 0.01 * wd, dx = (X1 - X0) / b.w, Ylo = -1.15, Yhi = 1.75, dy = (Yhi - Ylo) / b.h;
    const X = x => b.x + (x - X0) / (X1 - X0) * b.w, Y = y => b.y + b.h - (y - Ylo) / (Yhi - Ylo) * b.h;
    const line = (x1, y1, x2, y2, col, w) => PL.el('line', { x1: X(x1), y1: Y(y1), x2: X(x2), y2: Y(y2), stroke: col, 'stroke-width': w }, svg);
    const txt = (s, x, y, base) => PL.text(svg, s, X(x), Y(y), { size: 12, anchor: 'middle', baseline: base || 'text-after-edge' });
    line(xl[0], 0, xl[1], 0, '#808080', 0.5);
    const hq = 0.3;
    sg.forEach(s => {
        const x1 = Math.max(s[0], xl[0]), x2 = Math.min(s[1], xl[1]);
        if (x2 <= x1) return;
        PL.el('polygon', { points: `${X(x1)},${Y(0)} ${X(x1)},${Y(hq)} ${X(x2)},${Y(hq)} ${X(x2)},${Y(0)}`, fill: co[1], 'fill-opacity': 0.25 }, svg);
        line(x1, hq, x2, hq, co[1], 0.5);
        if (isFinite(s[0])) line(x1, 0, x1, hq, co[1], 0.5);
        if (isFinite(s[1])) line(x2, 0, x2, hq, co[1], 0.5);
        txt(`$q$ = ${gfmt(T.q / 1e3)} kN/m`, (x1 + x2) / 2, hq + 3 * dy);
    });
    const Pm = Math.max(...Pa);
    xa.forEach((v, i) => {
        const aL = Pa[i] / Pm;
        line(v, aL, v, 0, co[1], 0.8);
        PL.el('polygon', { points: `${X(v)},${Y(0)} ${X(v) - 2},${Y(0) - 5} ${X(v) + 2},${Y(0) - 5}`, fill: co[1] }, svg);
        txt(Pa[i].toFixed(0), v, aL + 2 * dy);
    });
    // dimension lines; the free distance with its value in the code; q in it: the part between
    // the two 2.5 m; of two short stretches in a row the second has its number below the line
    let gv = T.dmin;
    if (ge && T.qf === 2 && T.dmin > 2 * T.qm) { ge = [ge[0] + T.qm, ge[1] - T.qm]; gv = T.dmin - 2 * T.qm; }
    const pos = [...new Set(pts.map(v => Number(v.toFixed(3))))].sort((p, r) => p - r), y = -0.42;
    if (pos.length >= 2) {
        line(pos[0], y, pos[pos.length - 1], y, '#000', 0.4);
        pos.forEach(p => {
            PL.el('line', { x1: X(p), y1: Y(y) + 5, x2: X(p), y2: Y(y) - 7, stroke: '#000', 'stroke-width': 0.4 }, svg);
            PL.el('line', { x1: X(p) - 3, y1: Y(y) + 3, x2: X(p) + 3, y2: Y(y) - 3, stroke: '#000', 'stroke-width': 0.4 }, svg);
        });
        let low = false;
        for (let i = 0; i + 1 < pos.length; i++) {
            let st = gfmt(Number((pos[i + 1] - pos[i]).toFixed(2)));
            if (ge && Math.abs(pos[i] - ge[0]) < 2e-3 && Math.abs(pos[i + 1] - ge[1]) < 2e-3) st = `≥${gfmt(gv)}`;
            low = (pos[i + 1] - pos[i]) / dx < 20 && !low;
            if (low) txt(st, (pos[i] + pos[i + 1]) / 2, y - 7 * dy, 'hanging');
            else txt(st, (pos[i] + pos[i + 1]) / 2, y + dy);
        }
    }
    return svg;
}
async function onReport() {
    if (!ILa || !readInput()) return;                            // not with an invalid input
    let full = true;
    if (allN.length > 1) {
        const a = window.__reportChoice || await askReport();
        if (a === 'Cancel') return;
        full = a === 'Full report';
    }
    const title = allN.length === 1 ? `${allN[0]}_load_effect` : 'load_effect';
    progStart();
    setProg(null); setMsg('printing ...');
    await nextFrame();
    let msg = 'print dialog: Save as PDF', col;
    try {
        const D = await buildReport(full);
        if (D === null) { setProg(null); msg = 'cancelled'; }
        else printHTML(title, D.b);
    } catch (e) { msg = 'report failed'; col = RED; console.error(e); }
    progEnd();
    setMsg(msg, col);
}
// the report as HTML for the print preview.  null: cancelled
async function buildReport(full) {
    const multi = allR.length > 1, clamped = sup.map((c, i) => (c ? i + 1 : 0)).filter(Boolean);
    const num = x => gfmt(Number(x.toPrecision(3)));
    const sci = x => { const p = Math.floor(Math.log10(Math.abs(x))); return p >= -2 && p <= 3 ? num(x) : `$${gfmt(Number((x / 10 ** p).toFixed(4)))} \\cdot 10^{${p}}$`; };
    const D = new ReportDoc();
    D.h1('Road Bridge Static Load Effects, 2D');
    D.h2('Basis');
    const anyT = allN.some(n => typList.includes(n));
    const T0 = BS.vehicleModel('a', inp.BK, null, inp.w);
    let lt = 'in one load lane';
    if (T0.lanes > 1) {
        lt = `in two of ${T0.lanes} load lanes 3 m wide on the carriageway of ${num(inp.w)} m (K264958), the one times 1.0, the other times 0.8, at the same place on the beam, so 1.8 times one vehicle with its $q$`;
        if (T0.lanes === 3) lt += '; $q$ = 5 kN/m in the third lane, where unfavourable';
        if (T0.lanes === 4) lt += '; $q$ = 5 kN/m in each of the other two lanes, where unfavourable';
    }
    const [n1, wl, wr] = BS.lanes(inp.w);
    D.ul(['Static load effects from influence lines: bending moment, shear force, displacement, end rotation and support reaction, over all positions of the load models and both directions.',
          ...(anyT ? [`Type vehicles a–o of TRVINFRA-00331, Bilaga 1, ${lt}, without transverse distribution. ${inp.dx > 0 ? `Free spacings (≥) in steps of ${num(inp.dx)} m, the most unfavourable at each section.` : 'Free spacings (≥) at their shortest value only.'}`,
                      `Distributed load $q$ = 5 kN/m (K224830) on the stretches of Bilaga 1, 2.5 m or more from the axles, where it is unfavourable. Free distance in j, k and l at least ${gfmt(inp.gapL)} m (K224831).`,
                      inp.dyn ? 'Dynamic allowance $D$, formula (8-1), on the axle loads only, not on $q$ (K163750), also on displacement and rotation (load combination B:c, K164471). Determining length $L$ from Bilaga 2, row 1a, 1b. No reduction for covering and fill (K223619).' : 'No dynamic allowance.'] : []),
          ...(allN.includes('LM1') ? [`Load Model 1 of EN 1991-2:2024 (6.3.2), for the beam as a whole: tandem systems and UDL of Table 6.2 on the ${n1} notional lane${n1 > 1 ? 's' : ''} (${num(wl)} m wide) and the remaining area (${num(wr)} m) of a carriageway ${num(inp.w)} m wide (Table 6.1), all tandems at the same place, no axle left out, but one may stand beyond a bridge end; UDL on the unfavourable parts of the bridge. Dynamic amplification included, $\\Phi$ = 1. Adjustment factors of TSFS 2018:57 Table 11.1: $\\alpha_{Q1} = \\alpha_{Q2}$ = 0.9, $\\alpha_{Q3}$ = 0, $\\alpha_{q1}$ = 0.8, $\\alpha_{qi} = \\alpha_{qr}$ = 1.`] : []),
          ...(allN.includes('LM2') ? ['Load Model 2 of EN 1991-2:2024 (6.3.3): one axle $\\beta_Q$ × 400 kN, $\\beta_Q = \\alpha_{Q1}$ = 0.9, so 360 kN, at any place. Dynamic amplification included, $\\Phi$ = 1; no additional factor near expansion joints.'] : []),
          ...(ui.EIopt ? [eiSource(true)] : [])]);

    const stx = clamped.length ? `support${clamped.length > 1 ? 's' : ''} ${clamped.join(', ')} clamped, the others pinned` : 'all supports pinned';
    D.h2('Structural model');
    D.p(`2D Bernoulli-Euler beam, ${rnd(mdl.Ltot / mdl.dL)} elements of ${num(mdl.dL)} m, ${stx}. The influence lines are exact at the nodes, and the axles stand on nodes, so that axle spacings the element length does not divide are rounded. Axle loads as point loads.${LE && LE.snap > snapTol ? ` Here axles are moved by up to ${LE.snap.toFixed(2)} m.` : ''} Model in figure 1.`);
    D.p('Sign convention, with $x$ from the left end: bending moment $M$ positive when sagging (tension at the underside), negative when hogging (tension at the top); shear force $V = \\mathrm{d}M/\\mathrm{d}x$, so positive at the left end of a span under downward load; displacement $d$ positive upward; rotation $\\phi = \\mathrm{d}d/\\mathrm{d}x$, so anticlockwise positive; support reaction $R$ positive upward. In the tables $M_\\mathrm{max}$ is the largest sagging moment and $M_\\mathrm{min}$ the largest hogging moment; $V_\\mathrm{max}$, $d_\\mathrm{max}$ and $\\phi_\\mathrm{max}$ are the largest absolute values.');
    const sm = newSvg(700, 170), mm = drawModel(sm, { x: 20, y: 5, w: 660, h: 160 }, { size: 14.7 });
    markPeaks(showMode() !== 'Section', mm, sm);
    D.figure(sm, 'Model, dimensions in m.');

    const rows = [['Spans, $L$', inp.L.map(gfmt).join(' + '), 'm'], [`Flexural rigidity, $EI$${ui.EIopt ? ', from the deflection limit' : ''}`, inp.EI.map(sci).join(', '), 'Nm$^2$'],
                  ['Element length, d$L$', num(mdl.dL), 'm']];
    if (anyT || allN.includes('LM1') || ui.EIopt) rows.push(['Carriageway width, $w$', num(inp.w), 'm']);
    if (anyT) {
        rows.push(['Bearing class', inp.BK, '–'], ['Type vehicle values, $A/B$', `${T0.A / 1e3}/${T0.B / 1e3}`, 'kN'], ['Increment of free axle spacings, $\\Delta x$', num(inp.dx), 'm']);
    }
    if (allN.includes('LM1')) rows.push(['Notional lanes, LM1', String(n1), '–']);
    if (inp.dyn && anyT) rows.push(['Speed in formula (8-1), $v$', gfmt(inp.v), 'km/h']);
    D.h2('Input');
    D.table('Bridge and traffic load.', ['', 'Value', 'Unit'], rows, ['', 'r', '']);

    D.h2(anyT ? `Results, ${inp.BK}` : 'Results', { newPage: true });   // LM1 alone has no bearing class
    const vt = (() => {
        if (!sel.length) return `influence lines at $x$ = ${num(xp)} m`;
        const tr = sel[0];
        if (showMode() === 'Envelope') return `envelopes of load model ${tr}`;
        if (showMode() === 'Critical') return `influence lines and governing arrangement of load model ${tr} at the critical sections`;
        return `influence lines and governing arrangement of load model ${tr} at $x$ = ${num(xp)} m`;
    })();
    if (multi) D.p(`Peak values over the bridge per load model in table ${D.nt + 1}, ${full ? 'each load model on the following pages' : 'influence lines at the critical sections on the next page'}.`);
    else if (!allR.length) D.p(`No load model is ticked: ${vt} in figure ${D.nf + 1}.`);
    else D.p(`Peak values over the bridge per load model in table ${D.nt + 1}, ${vt} in figure ${D.nf + 1}.`);
    if (allR.length) {
        const neg = v => (v < 0 ? '−' + (-v).toFixed(0) : v.toFixed(0));
        D.table('Peak values.', ['Load model', '$\\Phi$', '$M_\\mathrm{max}$ (kNm)', '$M_\\mathrm{min}$ (kNm)', '$V_\\mathrm{max}$ (kN)', '$d_\\mathrm{max}$ (mm)', '$\\phi_\\mathrm{max}$ (mrad)', '$R_\\mathrm{max}$ (kN)'],
            allR.map((L, k) => [allN[k], L.phi.toFixed(2), (L.Mmax / 1e3).toFixed(0), neg(L.Mmin / 1e3), (Math.abs(L.Vmax) / 1e3).toFixed(0), (Math.abs(L.dmax) * 1e3).toFixed(1), (Math.abs(L.rmax) * 1e3).toFixed(1), (L.RFmax / 1e3).toFixed(0)]),
            ['', 'r', 'r', 'r', 'r', 'r', 'r', 'r']);
    }
    if (multi && !full) {
        D.h2('Critical sections', { newPage: true });
        D.figure(critSvg(LE), 'Influence lines and governing load model at the critical sections.');
    } else if (multi) {
        for (let k = 0; k < allR.length; k++) {
            setProg(k / allR.length); setMsg(`printing ${allN[k]}: ${k + 1}/${allR.length}`);
            await nextFrame();
            if (ui.stopReq) return null;
            const L1 = allR[k], t = `Load model ${allN[k]} (${groupOf(allN[k])})`;
            D.h2(t, { newPage: true });
            D.figure(vehicleSvg(allN[k]), `Load model, axle loads in kN${allN[k].startsWith('LM') ? '' : ' without $D$'}, dimensions in m.`);
            let fx;
            if (allN[k] === 'LM1') fx = `Dynamic amplification included in the load values, $\\Phi$ = 1. ${L1.T.lanes} notional lane${L1.T.lanes > 1 ? 's' : ''} and the remaining area, all lanes together in the figure.`;
            else if (allN[k] === 'LM2') fx = 'Dynamic amplification included in the load value, $\\Phi$ = 1.';
            else fx = inp.dyn ? (dynOne(L1) + '.') : `No dynamic allowance applied, $L$ = ${L1.Lphi.toFixed(1)} m.`;
            if (!allN[k].startsWith('LM') && L1.T.fv > 1) fx += ` Axle loads and $q$ of the two vehicle lanes together (1.0 + 0.8) in the figure${L1.T.qAll > 0 ? `, $q$ = ${gfmt(L1.T.qAll / 1e3)} kN/m of the other lanes not drawn` : ''}.`;
            D.p(fx);
            D.figure(critSvg(L1), 'Influence lines and governing arrangement at the critical sections.');
        }
        setProg(1);
    } else {
        // the plots as shown, stacked
        let md = showMode(); if (md !== 'Section' && !LE) md = 'Section';
        const set = n => {
            const hp = Math.round((130 * 4 + 12 * 3 - 12 * (n - 1)) / n), H0 = 8 + n * hp + (n - 1) * 12 + 52, svg = newSvg(700, H0);
            set.svg = svg;
            return Array.from({ length: n }, (_, k) => {
                const ax = new PL.Axes(svg, { x: 80, y: 8 + k * (hp + 12), w: 590, h: hp }, { xTickLabels: k === n - 1, pick: false });
                ax.xlim = [-0.02 * mdl.Ltot, 1.02 * mdl.Ltot];
                if (k === n - 1) ax.xlabel = '$x$ (m)';
                return ax;
            });
        };
        render(md, set);
        D.figure(set.svg, vt[0].toUpperCase() + vt.slice(1) + '.');
    }
    return D;
}

// ============================================================ start
window.__beamstat = { get state() { return { inp, mdl, sel, allN, allR, LE, IL, ILa, xp, jx, busy: ui.busy, stopOn: ui.stopOn, nWorkers, inputOK, poolOn: !!pool }; }, onCancel };
setDefaults();
readInput();

(async () => {
    await updateModel();
    setProg(null); setMsg('');                                   // the start-up run is not one the user asked for
    ui.started = true;
    setTimeout(warmPool, 300);
})();
})();
