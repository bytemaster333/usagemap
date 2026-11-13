// SPDX-License-Identifier: Apache-2.0
// How the tracker would start the solver: worker from a Blob URL, one solve per page load.
// __SOLVER__ is replaced at build time by the minified solver.js source as a string literal.
function scfSolve(t, pow) {
  return new Promise(function (ok, no) {
    var u = URL.createObjectURL(new Blob([__SOLVER__])), w = new Worker(u);
    w.onmessage = function (e) { w.terminate(); URL.revokeObjectURL(u); ok(e.data); };
    w.onerror = no;
    w.postMessage([t, pow.cost, pow.max, pow.pfx, 4]);
  });
}
