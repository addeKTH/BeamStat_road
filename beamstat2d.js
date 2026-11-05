/* beamstat2d.js --------------------------------------------------------------
   Static load effects of road vehicles on a 2D beam, by influence lines: a port of
   BeamStat2D.m in BeamStat_road (2026-11-05); see its header for the method and the models.

   BS.influenceLines(inp)         inp: L [m], EI (one or per span), dL, bc [[x, dir, K]], xp
   BS.loadEffect(IL, type, opt)   type: a to o, LM1; opt: dyn, v, BK, dx, lanes, gapL, both
   BS.vehicleModel(type, BK, gapL, lanes)   load model definition

   Influence lines: arrays of columns, IL.M[section][load position], Float64Array.
   Envelopes: LE.M = [lo, hi], per section.

   Andreas Andersson, 2026-11-05 (assisted by Claude)
---------------------------------------------------------------------------*/
(function (root) {
'use strict';

const BS = {};
const rnd = x => (x < 0 ? -Math.round(-x) : Math.round(x));      // as MATLAB round
const sum = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
const clip = (v, a, b) => Math.min(Math.max(v, a), b);

// number of elements: a short bridge gets at least 100
BS.nElements = (Ltot, dL) => { const n = rnd(Ltot / dL); return Ltot < 10 ? Math.max(n, 100) : n; };

// ================================================== influence lines
BS.influenceLines = function (inp) {
    const tol = inp.tol === undefined ? 1e-9 : inp.tol;
    const L = inp.L, Ltot = sum(L);
    const nEL = BS.nElements(Ltot, inp.dL), dL = Ltot / nEL, n = nEL + 1, nDof = 2 * nEL + 2;
    const xn = new Float64Array(n); for (let i = 0; i < n; i++) xn[i] = i * dL;
    let bc = inp.bc && inp.bc.length ? inp.bc.map(b => [b[0], b[1] === undefined ? 1 : b[1], b[2] || 0]) : null;
    if (!bc) { bc = [[0, 1, 0]]; let s = 0; for (const l of L) { s += l; bc.push([s, 1, 0]); } }
    const xp = inp.xp ? Array.from(inp.xp) : Array.from(xn);

    // flexural rigidity per element
    const EI = Array.isArray(inp.EI) ? inp.EI : [inp.EI];
    const EIe = new Float64Array(nEL).fill(EI[0]);
    if (EI.length > 1) {
        let a = 0;
        L.forEach((l, i) => {
            const b = a + l;
            for (let e = 0; e < nEL; e++) { const xm = (xn[e] + xn[e + 1]) / 2; if (xm > a && xm <= b) EIe[e] = EI[i]; }
            a = b;
        });
    }

    // K as band rows, half bandwidth 3
    const hb = 3, K = new Float64Array(nDof * (2 * hb + 1));
    const ke = [12, 6 * dL, -12, 6 * dL, 6 * dL, 4 * dL * dL, -6 * dL, 2 * dL * dL,
                -12, -6 * dL, 12, -6 * dL, 6 * dL, 2 * dL * dL, -6 * dL, 4 * dL * dL];
    for (let e = 0; e < nEL; e++) {
        const f = EIe[e] / (dL * dL * dL), d0 = 2 * e;
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++)
            K[(d0 + a) * (2 * hb + 1) + (b - a) + hb] += f * ke[4 * a + b];
    }
    // boundary conditions
    for (const b of bc) if (b[0] < -1e-9 || b[0] > Ltot + 1e-9) throw new Error(`support positions must lie on the beam, 0 to ${Ltot} m`);
    const sn = bc.map(b => rnd(b[0] / dL));                      // support nodes
    const bdof = bc.map((b, i) => 2 * sn[i] + b[1] - 1);         // support dofs
    const rig = bc.map(b => !isFinite(b[2]) || b[2] <= 0);
    bc.forEach((b, i) => { if (!rig[i]) K[bdof[i] * (2 * hb + 1) + hb] += b[2]; });
    const fix = new Uint8Array(nDof);
    bc.forEach((b, i) => { if (rig[i]) fix[bdof[i]] = 1; });

    // band Cholesky of the free dofs, one factorisation for all the loads
    const fd = []; const map = new Int32Array(nDof).fill(-1);
    for (let i = 0; i < nDof; i++) if (!fix[i]) { map[i] = fd.length; fd.push(i); }
    const nf = fd.length, Lc = new Float64Array(nf * (hb + 1));   // Lc[i*(hb+1)+k]: L(i, i-k)
    for (let i = 0; i < nf; i++) {
        for (let k = hb; k >= 0; k--) {
            const j = i - k; if (j < 0) continue;
            const dd = fd[i] - fd[j];
            let v = dd <= hb ? K[fd[i] * (2 * hb + 1) - dd + hb] : 0;
            for (let m = 1; m <= hb - k; m++) {
                if (j - m < 0) break;
                v -= Lc[i * (hb + 1) + k + m] * Lc[j * (hb + 1) + m];
            }
            if (k === 0) {
                if (!(v > 1e-12 * K[fd[i] * (2 * hb + 1) + hb])) throw new Error('the beam is a mechanism: check the supports');
                Lc[i * (hb + 1)] = Math.sqrt(v);
            } else Lc[i * (hb + 1) + k] = v / Lc[j * (hb + 1)];
        }
    }

    // sections
    const ns = xp.length;
    const ie = new Int32Array(ns), ss = new Float64Array(ns);
    xp.forEach((xv, j) => {
        const t = xv / dL;
        ie[j] = Math.min(Math.max(Math.floor(t + 1e-9), 0), nEL - 1);
        ss[j] = clip(t - ie[j], 0, 1);
    });
    const col = () => Array.from({ length: ns }, () => new Float64Array(n));
    const M = col(), V = col(), d = col(), r = col();
    const RF = bc.map(() => new Float64Array(n));

    // unit downward load at every node
    const D = new Float64Array(nDof), y = new Float64Array(nf);
    for (let c = 0; c < n; c++) {
        y.fill(0);
        const k0 = map[2 * c];
        if (k0 >= 0) {
            y[k0] = -1;
            for (let i = k0; i < nf; i++) {
                let v = y[i];
                for (let k = 1; k <= hb && i - k >= 0; k++) v -= Lc[i * (hb + 1) + k] * y[i - k];
                y[i] = v / Lc[i * (hb + 1)];
            }
            for (let i = nf - 1; i >= 0; i--) {
                let v = y[i];
                for (let k = 1; k <= hb && i + k < nf; k++) v -= Lc[(i + k) * (hb + 1) + k] * y[i + k];
                y[i] = v / Lc[i * (hb + 1)];
            }
        }
        D.fill(0);
        for (let i = 0; i < nf; i++) D[fd[i]] = y[i];
        for (let j = 0; j < ns; j++) {
            const e = ie[j], s = ss[j], v1 = D[2 * e], f1 = D[2 * e + 1], v2 = D[2 * e + 2], f2 = D[2 * e + 3], EIs = EIe[e];
            M[j][c] = EIs / (dL * dL) * ((-6 + 12 * s) * v1 + dL * (-4 + 6 * s) * f1 + (6 - 12 * s) * v2 + dL * (-2 + 6 * s) * f2);
            V[j][c] = EIs / (dL * dL * dL) * (12 * (v1 - v2) + 6 * dL * (f1 + f2));
            d[j][c] = (1 - 3 * s * s + 2 * s * s * s) * v1 + dL * (s - 2 * s * s + s * s * s) * f1
                    + (3 * s * s - 2 * s * s * s) * v2 + dL * (-s * s + s * s * s) * f2;
            r[j][c] = (-6 * s + 6 * s * s) / dL * v1 + (1 - 4 * s + 3 * s * s) * f1
                    + (6 * s - 6 * s * s) / dL * v2 + (-2 * s + 3 * s * s) * f2;
        }
        bc.forEach((b, i) => {
            const g = bdof[i];
            if (rig[i]) {
                let v = 0;
                for (let k = -hb; k <= hb; k++) if (g + k >= 0 && g + k < nDof) v += K[g * (2 * hb + 1) + k + hb] * D[g + k];
                if (b[1] === 1 && sn[i] === c) v += 1;           // - F at the support dof
                RF[i][c] = v;
            } else RF[i][c] = -b[2] * D[g];
        });
    }

    // round off small values; not d and r, whose ordinates are of order 1e-9
    const out = { xp, dL, Ltot, bc, supX: sn.map(s => s * dL), supDir: bc.map(b => b[1]), sn, rig };
    const round0 = A => A.forEach(c => { for (let i = 0; i < c.length; i++) if (Math.abs(c[i]) < tol) c[i] = 0; });
    out.M = M; out.V = V; out.d = d; out.r = r; out.RF = RF; out.x = xn;
    round0(out.M); round0(out.V); round0(out.RF);
    let chk = 0;
    for (let i = 0; i < n; i++) {
        let s = 0; bc.forEach((b, q) => { if (b[1] === 1) s += out.RF[q][i]; });
        chk = Math.max(chk, Math.abs(s - 1));
    }
    out.chk = chk;
    return out;
};

// ================================================== load effect
// determining length L for the dynamic allowance, TRVINFRA-00331 Bilaga 2, 1a, 1b
BS.determiningLength = function (Ls) {
    const n = Ls.length;
    if (n === 1) return Ls[0];
    if (n <= 5) return Math.max((1 + 0.1 * n) * sum(Ls) / n, Math.max(...Ls));
    let best = Infinity;                                         // lowest mean of five adjacent spans
    for (let i = 0; i + 5 <= n; i++) best = Math.min(best, sum(Ls.slice(i, i + 5)) / 5);
    return 1.5 * best;
};
// dynamic allowance (%), TRVINFRA-00331 (8-1), at most 35 %
BS.dynAllowance = (L, v) => Math.min((180 + 8 * (v - 10)) / (20 + L), 35);

BS.loadEffect = function (IL, type, opt0) {
    const opt = Object.assign({ v: 80, dyn: true, both: true, Lphi: null, BK: 'BK1', gapL: 45, dx: 0.5, lanes: 1 }, opt0 || {});
    const T = BS.vehicleModel(type, opt.BK, opt.gapL, opt.lanes);
    const x = IL.x, dL = IL.dL, n = x.length, Gr = toGrid(T, dL, opt.dx), G0 = Gr.G;

    // determining length and dynamic allowance, one value for the bridge
    const sup = [...new Set(IL.supX.filter((_, i) => IL.supDir[i] === 1))].sort((a, b) => a - b);
    const Ls = []; for (let i = 1; i < sup.length; i++) Ls.push(sup[i] - sup[i - 1]);
    if (!Ls.length) Ls.push(x[n - 1] - x[0]);
    const Lphi = opt.Lphi === null ? BS.determiningLength(Ls) : opt.Lphi;
    let Dp = BS.dynAllowance(Lphi, opt.v), phi = 1;
    if (opt.dyn && T.name !== 'LM1') phi = 1 + Dp / 100; else Dp = 0;   // LM1: included in the loads

    // every quantity, in one or both directions; d and r without D
    const Gd = [G0]; if (opt.both) Gd.push(mirror(G0));
    const Q = ['M', 'V', 'd', 'r', 'RF'], out = {}, dr = {};
    for (const q of Q) {
        const f = (q === 'd' || q === 'r') ? 1 : phi, cols = IL[q], m = cols.length;
        const lo = new Float64Array(m), hi = new Float64Array(m), dlo = new Uint8Array(m).fill(1), dhi = new Uint8Array(m).fill(1);
        for (let j = 0; j < m; j++) {
            lo[j] = sweep(cols[j], dL, n, Gd[0], f, -1);
            hi[j] = sweep(cols[j], dL, n, Gd[0], f, +1);
            if (Gd.length > 1) {
                const a = sweep(cols[j], dL, n, Gd[1], f, -1), b = sweep(cols[j], dL, n, Gd[1], f, +1);
                if (a < lo[j]) { lo[j] = a; dlo[j] = 2; }
                if (b > hi[j]) { hi[j] = b; dhi[j] = 2; }
            }
        }
        out[q] = [lo, hi]; dr[q] = [dlo, dhi];
    }
    out.xp = IL.xp; out.x = x; out.supX = IL.supX; out.supDir = IL.supDir;
    out.phi = phi; out.D = Dp; out.Lphi = Lphi; out.Lspan = Ls; out.v = opt.v;
    out.type = T.name; out.T = T; out.snap = Gr.snap;

    // peak values, and the arrangement behind each
    out.xpeak = {}; out.pos = {}; out.chk = 0;
    const pk = [['Mmax', 'M', 1], ['Mmin', 'M', -1], ['Vmax', 'V', 0], ['dmax', 'd', 0], ['rmax', 'r', 0], ['RFmax', 'RF', 1], ['RFmin', 'RF', -1]];
    for (const [nm, qn, c] of pk) {
        const E = out[qn];
        let xq, iv;
        if (qn === 'RF') {
            xq = IL.supX;
            iv = IL.supDir.map((d, i) => (d === 1 ? i : -1)).filter(i => i >= 0);
            if (!iv.length) iv = xq.map((_, i) => i);
        } else { xq = IL.xp; iv = xq.map((_, i) => i); }
        let k = iv[0], sd = c >= 0 ? 1 : 0, v;
        if (c > 0) { v = -Infinity; for (const i of iv) if (E[1][i] > v) { v = E[1][i]; k = i; } }
        else if (c < 0) { v = Infinity; for (const i of iv) if (E[0][i] < v) { v = E[0][i]; k = i; } }
        else {
            let best = -1;
            for (const s of [0, 1]) for (const i of iv) if (Math.abs(E[s][i]) > best) { best = Math.abs(E[s][i]); k = i; sd = s; }
            v = E[sd][k];
        }
        out[nm] = v; out.xpeak[nm] = xq[k];
        const f = (qn === 'd' || qn === 'r') ? 1 : phi, dk = dr[qn][sd][k];
        const C = config(IL[qn][k], x, dL, n, Gd[dk - 1], f, 2 * sd - 1);
        C.name = nm; C.quant = qn; C.x = xq[k]; C.dir = dk;
        C.h = IL[qn][k]; C.val = v; C.q = T.q;
        out.chk = Math.max(out.chk, Math.abs(C.sum - v) / Math.max(Math.abs(v), Number.EPSILON));
        delete C.sum;
        out.pos[nm] = C;
    }
    return out;
};

// cumulative integral of the part of the influence line that q loads
function sideInt(z, dL, s) {
    const n = z.length, C = new Float64Array(n);
    let a = s * z[0] > 0 ? z[0] : 0;
    for (let i = 1; i < n; i++) {
        const b = s * z[i] > 0 ? z[i] : 0;
        C[i] = C[i - 1] + 0.5 * dL * (a + b);
        a = b;
    }
    return C;
}

// effect of one axle group with its share of q, per position (node of its first axle, from
// i0 up, 0 = the first node).  Runs from clear of the bridge on one side to clear of it on the
// other; the first group goes further back by the length of the vehicle, with the second
// group still on the bridge.
function field(z, C, g, phi, G, kg, n) {
    const k = g.k, P = g.P, na = k.length, Kg = k[na - 1], mz = G.mz;
    const i0 = -Kg - mz - (kg === 1 ? G.ext : 0), nI = n + mz - i0 + 1, F = new Float64Array(nI);
    for (let a = 0; a < na; a++) {
        const ka = k[a], pa = P[a] * phi, r0 = i0 + ka;
        const b0 = Math.max(0, -r0), b1 = Math.min(nI, n - r0);
        for (let b = b0; b < b1; b++) F[b] += pa * z[r0 + b];
    }
    if (G.qf === 3) {
        const v = G.q * C[n - 1];
        for (let b = 0; b < nI; b++) F[b] += v;
    } else if (G.q > 0 && G.qf > 0) {
        const cl = r => (r < 0 ? 0 : r > n - 1 ? n - 1 : r), two = G.g.length === 2, q = G.q, Ce = C[n - 1];
        const left = kg === 1 || G.qf === 2, end = kg === 2 || !two, gap = !end && G.qf === 2;
        for (let b = 0; b < nI; b++) {
            const i = i0 + b;
            if (left) F[b] += q * C[cl(i - mz)];
            if (end) F[b] += q * (Ce - C[cl(i + Kg + mz)]);
            else if (gap) F[b] -= q * C[cl(i + Kg + mz)];
        }
    }
    return { F, i0 };
}

// the best second group (s*F) at a row or at whole steps st beyond it; st = 0: at the row
// only.  Past the last row the group is clear of the bridge, which is the last row.
function bestAhead(F, s, st) {
    const nr = F.length, S = new Float64Array(nr);
    for (let r = 0; r < nr; r++) S[r] = s * F[r];
    if (st > 0) for (let r = nr - 2; r >= 0; r--) { const t = S[Math.min(r + st, nr - 1)]; if (t > S[r]) S[r] = t; }
    return S;
}

// the envelope of one influence line, the largest (s = 1) or smallest (s = -1) effect over
// every position of the vehicle and every free distance
function sweep(z, dL, n, G, phi, s) {
    const C = sideInt(z, dL, s), f1 = field(z, C, G.g[0], phi, G, 1, n), F1 = f1.F;
    let best = -Infinity;
    if (G.g.length === 1) {
        for (let b = 0; b < F1.length; b++) { const v = s * F1[b]; if (v > best) best = v; }
        return s * best;
    }
    const f2 = field(z, C, G.g[1], phi, G, 2, n), S = bestAhead(f2.F, s, G.step), nr = S.length, sh = G.g[0].k[G.g[0].k.length - 1] + G.gap;
    for (let b = 0; b < F1.length; b++) {
        const r = Math.min(Math.max(f1.i0 + b + sh - f2.i0, 0), nr - 1), v = s * F1[b] + S[r];
        if (v > best) best = v;
    }
    return s * best;
}

// the arrangement of the sweep at one section, so that it can be drawn: the same fields on
// the one line, with the positions kept
function config(h, x, dL, n, G, phi, s) {
    const C = sideInt(h, dL, s), f1 = field(h, C, G.g[0], phi, G, 1, n), F1 = f1.F, g1 = G.g[0];
    const K1 = g1.k[g1.k.length - 1];
    let xa = [], Pa = [], z1, z2, gz = null, gp = NaN, sumv = -Infinity;
    if (G.g.length === 1) {
        let a = 0;
        for (let b = 0; b < F1.length; b++) if (s * F1[b] > sumv) { sumv = s * F1[b]; a = b; }
        const i1 = f1.i0 + a;
        xa = g1.k.map(k => (i1 + k) * dL); Pa = g1.P.slice();
        z1 = i1 * dL; z2 = (i1 + K1) * dL;
    } else {
        const g2 = G.g[1], f2 = field(h, C, g2, phi, G, 2, n), S = bestAhead(f2.F, s, G.step), nr = S.length, sh = K1 + G.gap;
        const row = b => Math.min(Math.max(f1.i0 + b + sh - f2.i0, 0), nr - 1);
        let a = 0;
        for (let b = 0; b < F1.length; b++) { const v = s * F1[b] + S[row(b)]; if (v > sumv) { sumv = v; a = b; } }
        const r0 = row(a);
        let b2 = r0;                                             // the nearest position of the best
        while (G.step > 0 && s * f2.F[b2] < S[r0] - 1e-9 * Math.abs(S[r0]) && b2 < nr - 1) b2 = Math.min(b2 + G.step, nr - 1);
        const i1 = f1.i0 + a, i2 = f2.i0 + b2;
        xa = [...g1.k.map(k => (i1 + k) * dL), ...g2.k.map(k => (i2 + k) * dL)];
        Pa = [...g1.P, ...g2.P];
        const e1 = (i1 + K1) * dL, s2 = i2 * dL;
        gp = s2 - e1; z1 = i1 * dL; z2 = (i2 + g2.k[g2.k.length - 1]) * dL; gz = [e1, s2];
    }
    const m = G.mz * dL, w = new Float64Array(n);
    if (G.q > 0 && G.qf > 0) {
        for (let i = 0; i < n; i++) {
            let on = x[i] <= z1 - m || x[i] >= z2 + m || G.qf === 3;
            if (G.qf === 2 && gz && x[i] >= gz[0] + m && x[i] <= gz[1] - m) on = true;
            if (on && s * h[i] > 0) w[i] = G.q;
        }
    }
    const o = { sum: s * sumv, xa: [], Pa: [], gap: gp, w };
    xa.forEach((v, i) => { if (v > x[0] - 1e-9 && v < x[n - 1] + 1e-9) { o.xa.push(v); o.Pa.push(Pa[i]); } });
    return o;
}

// the vehicle on the element grid: axle offsets, free distance, its step and the q margin
// in nodes
function toGrid(T, dL, dx) {
    const G = { q: T.q, qf: T.qf, step: dx > 0 ? Math.max(rnd(Math.max(dx, 0.1) / dL), 1) : 0, g: [] };
    let snap = 0;
    for (const g of T.g) {
        const k = g.off.map(v => rnd(v / dL));
        k.forEach((v, i) => { snap = Math.max(snap, Math.abs(v * dL - g.off[i])); });
        G.g.push({ k, P: g.P.slice() });
    }
    G.gap = rnd(T.dmin / dL);
    G.mz = rnd(T.qm / dL);
    if (G.qf === 2) G.mz = Math.min(G.mz, Math.floor(G.gap / 2));   // the two margins fit in the smallest gap
    snap = Math.max(snap, Math.abs(G.gap * dL - T.dmin));
    G.ext = G.g.length === 2 ? G.gap + G.g[0].k[G.g[0].k.length - 1] + G.g[1].k[G.g[1].k.length - 1] : 0;
    return { G, snap };
}

// the same vehicle running the other way
function mirror(G) {
    const g = G.g.map(a => { const K = a.k[a.k.length - 1]; return { k: a.k.map(v => K - v).reverse(), P: a.P.slice().reverse() }; }).reverse();
    return Object.assign({}, G, { g });
}

// ================================================== load models
// Type vehicles of TRVINFRA-00331 v3.0 Bilaga 1 and LM1 of EN 1991-2:2024; see the header of
// BeamStat2D.m.  A/B fitted to the limits of Lasta lagligt 2026.
const AB = { BK1: [120, 180], BK2: [100, 160], BK3: [80, 120], BK4: [120, 180] };
BS.vehicleModel = function (type, BK, gapL, lanes) {
    BK = BK === undefined || BK === null ? 'BK1' : BK;
    gapL = gapL === undefined || gapL === null ? 45 : gapL;
    lanes = lanes === undefined || lanes === null ? 1 : lanes;
    if (String(type).toUpperCase() === 'LM1') {                  // Table 6.2, notional lanes 3 m wide
        const Qi = [300, 200, 100], Q = sum(Qi.slice(0, Math.min(lanes, 3))) * 1e3;
        return { name: 'LM1', A: NaN, B: NaN, BK: '', lanes, g: [{ off: [0, 1.2], P: [Q, Q] }], dmin: 0, qf: 3, qm: 0,
                 q: 3 * (9 + 2.5 * (lanes - 1)) * 1e3, x: [0, 1.2], P: [Q, Q], grp: [1, 1], Ltot: 1.2, qseg: [[-Infinity, Infinity]] };
    }
    const ab = Array.isArray(BK) ? BK.map(v => v / 1e3) : AB[String(BK).toUpperCase()];
    if (!ab) throw new Error(`unknown bearing class '${BK}' (BK1 to BK4)`);
    const A = ab[0] * 1e3, B = ab[1] * 1e3;
    const tr = [0, 2.4, 3.7, 5.0], pg = [.44, .44, .44, .44], tr2 = [...tr, ...tr.map(v => v + 15)], pg2 = [...pg, ...pg];
    const oh = [0, 3, 4.3, 9.3, 10.6, 11.9], ph = [.55, .5, .5, .44, .44, .44];
    const ol = [0, 3.8, 5.6, 9.6, 11.4, 15, 16], pl = [.44, .55, .55, .55, .55, .33, .33];
    //        offsets 1          loads 1 (B)              dmin   offsets 2         loads 2 (B)           qf
    const Vh = {
        a: [[0],                 [NaN],                   0,     null,             null,                 0],
        b: [[0],                 [.44],                   1.0,   [0],              [.44],                0],
        c: [[0],                 [.50],                   1.3,   [0],              [.50],                0],
        d: [[0],                 [.55],                   1.8,   [0],              [.55],                0],
        e: [[0, 1.0],            [.39, .39],              1.0,   [0],              [.39],                0],
        f: [[0, 1.3],            [.44, .44],              1.3,   [0],              [.44],                0],
        g: [tr,                  pg,                      5.0,   tr,               pg,                   2],
        h: [[0, 3, 4.3],         [.55, .5, .5],           5.0,   [0, 1.3, 2.6],    [.44, .44, .44],      1],
        i: [[0, 3.8, 5.6],       [.44, .55, .55],         4.0,   [0, 1.8, 5.4, 6.4], [.55, .55, .33, .33], 1],
        j: [tr2,                 pg2,                     gapL,  tr2,              pg2,                  2],
        k: [oh,                  ph,                      gapL,  oh,               ph,                   2],
        l: [ol,                  pl,                      gapL,  ol,               pl,                   2],
        m: [[0, 1.3, 3.1, 6.5, 8.3, 9.6], [.33, .5, .5, .44, .44, .44], 0, null, null, 0],
        n: [[0, 2, 4, 5.5, 6.6], [.55, .55, .55, .33, .12], 0, null, null, 0],
        o: [[0, 3.4, 4.7, 10.4, 11.7, 13, 17.8, 19.1, 25.6, 27.4], [.33, .445, .445, .39, .39, .39, .415, .415, .445, .445], 0, null, null, 1]
    };
    const name = String(type).toLowerCase(), V = Vh[name];
    if (!V) throw new Error(`unknown type vehicle '${type}' (a to o, LM1)`);
    const T = { name, A, B, BK: Array.isArray(BK) ? '' : String(BK).toUpperCase(), lanes: 1, dmin: V[2], qf: V[5], q: V[5] > 0 ? 5e3 : 0, qm: 2.5 };
    T.g = [{ off: V[0].slice(), P: name === 'a' ? [A] : V[1].map(v => B * v) }];
    if (V[3]) T.g.push({ off: V[3].slice(), P: V[4].map(v => B * v) });
    // all the axles at the smallest free distance, for the drawings
    const x1 = T.g[0].off, e1 = x1[x1.length - 1];
    if (T.g.length === 2) {
        T.x = [...x1, ...T.g[1].off.map(v => e1 + T.dmin + v)];
        T.P = [...T.g[0].P, ...T.g[1].P];
        T.grp = [...x1.map(() => 1), ...T.g[1].off.map(() => 2)];
    } else { T.x = x1.slice(); T.P = T.g[0].P.slice(); T.grp = x1.map(() => 1); }
    T.Ltot = T.x[T.x.length - 1];
    T.qseg = [];
    if (T.qf > 0) T.qseg = [[-Infinity, -T.qm], [T.Ltot + T.qm, Infinity]];
    if (T.qf === 2 && T.dmin > 2 * T.qm) T.qseg.splice(1, 0, [e1 + T.qm, e1 + T.dmin - T.qm]);
    return T;
};

root.BS = BS;
})(typeof self !== 'undefined' ? self : this);
