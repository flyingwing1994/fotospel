// Puntberekening, gedeeld door server (require) en browser (window.Scoring).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // activeMs: effectieve tijd (openen tot upload, zonder tijd in beoordeling)
  // a: { base_points, decay_per_min, floor_points }
  // freeMinutes: vaste vrije tijd met volle punten
  function calcPoints(activeMs, a, freeMinutes) {
    const base = Number(a.base_points) || 0;
    const floor = Math.min(base, Number(a.floor_points) || 0);
    const decay = Math.max(0, Number(a.decay_per_min) || 0);
    const overMin = Math.max(0, activeMs / 60000 - freeMinutes);
    const raw = base - decay * overMin;
    return Math.max(floor, Math.floor(raw + 1e-9));
  }

  // Hoeveel ms nog volle punten (0 als voorbij)
  function fullPointsLeftMs(activeMs, freeMinutes) {
    return Math.max(0, freeMinutes * 60000 - activeMs);
  }

  // Na hoeveel ms effectieve tijd de bodem bereikt is
  function floorReachedAtMs(a, freeMinutes) {
    const base = Number(a.base_points) || 0;
    const floor = Math.min(base, Number(a.floor_points) || 0);
    const decay = Number(a.decay_per_min) || 0;
    if (decay <= 0) return Infinity;
    return (freeMinutes + (base - floor) / decay) * 60000;
  }

  return { calcPoints, fullPointsLeftMs, floorReachedAtMs };
});
