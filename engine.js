// Anchor Word - core engine (grid, anchor-area, placement validation)
// Coordinate system: col 0..W-1 (A..), row 0..H-1, row 0 = TOP internally (we'll map to bottom-origin only in UI labels if needed)

const DIRS = [
  { dx: 1, dy: 0 },   // E
  { dx: 1, dy: 1 },   // SE
  { dx: 0, dy: 1 },   // S
  { dx: -1, dy: 1 },  // SW
  { dx: -1, dy: 0 },  // W
  { dx: -1, dy: -1 }, // NW
  { dx: 0, dy: -1 },  // N
  { dx: 1, dy: -1 },  // NE
];

function key(x, y) { return x + ',' + y; }

class Board {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.cells = new Map(); // key -> letter
    this.anchor = new Set(); // key -> true, cells that are part of anchor area
  }

  inBounds(x, y) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  getLetter(x, y) {
    return this.cells.get(key(x, y)) || null;
  }

  isAnchor(x, y) {
    return this.anchor.has(key(x, y));
  }

  // Compute cells for placing `word` starting at (x0,y0) in direction dir (index into DIRS), optionally reversed
  computeCells(word, x0, y0, dirIdx, reversed) {
    const w = reversed ? [...word].reverse().join('') : word;
    const { dx, dy } = DIRS[dirIdx];
    const cells = [];
    for (let i = 0; i < w.length; i++) {
      cells.push({ x: x0 + dx * i, y: y0 + dy * i, letter: w[i] });
    }
    return cells;
  }

  // Validate a placement. Returns { valid, reason, score, cells, newAnchorCells }
  validatePlacement(word, x0, y0, dirIdx, reversed) {
    const cells = this.computeCells(word, x0, y0, dirIdx, reversed);

    // Bounds check
    for (const c of cells) {
      if (!this.inBounds(c.x, c.y)) {
        return { valid: false, reason: 'Word falls outside the grid.' };
      }
    }

    let touchesAnchor = false;
    let matchCount = 0;
    let allCellsMatchExisting = true; // for method 1 overlay detection
    let anyExistingLetterInPath = false;

    for (const c of cells) {
      const existing = this.getLetter(c.x, c.y);
      if (existing !== null) {
        if (existing !== c.letter) {
          return { valid: false, reason: `Letter clash at (${c.x},${c.y}): board has "${existing}", word needs "${c.letter}".` };
        }
        matchCount++;
        anyExistingLetterInPath = true;
        if (this.isAnchor(c.x, c.y)) touchesAnchor = true;
      } else {
        allCellsMatchExisting = false;
      }
    }

    if (!touchesAnchor) {
      return { valid: false, reason: 'Word must connect to the anchor area.' };
    }

    // Determine if this is an "overlay" (method 1): every cell already had a matching letter
    const isOverlay = allCellsMatchExisting && anyExistingLetterInPath;

    const score = isOverlay ? 0 : matchCount;

    return {
      valid: true,
      isOverlay,
      score,
      cells,
    };
  }

  // Apply a validated placement: write letters, extend anchor if overlay, then run method-2 auto-expansion
  applyPlacement(result) {
    // Snapshot the anchor exactly as it stood before this move (overlay cells included) - this is
    // what the single-cell "closes a notch" test checks against, so a cell added by THIS move's own
    // overlay can't itself count as a qualifying side for auto-absorbing the next cell along an edge.
    this._anchorSnapshotForCascade = new Set(this.anchor);

    for (const c of result.cells) {
      this.cells.set(key(c.x, c.y), c.letter);
      if (result.isOverlay) {
        this.anchor.add(key(c.x, c.y));
      }
    }
    this.runAutoExpansion();
    this._anchorSnapshotForCascade = null;
  }

  // Method 2: repeatedly find complete straight perimeter edges bordered fully by letters, absorb rectangles.
  // See applyPlacement for how _anchorSnapshotForCascade is set - the single-cell "closes a notch" test
  // (see tryExpandDirection) only counts anchor neighbours that existed in that snapshot (i.e. before
  // this move, including its own overlay cells), so a cell absorbed earlier in the SAME cascade can't
  // itself count as one of the 2 qualifying sides for the next cell along an edge - otherwise a single
  // new cell can "creep" along an entire edge one step at a time, each step seeing the previous step as
  // one of its two sides. Genuine corner-closing (like the M3-between-two-existing-arms case) still
  // works, since both sides there already existed before this move started.
  runAutoExpansion() {
    if (!this._anchorSnapshotForCascade) this._anchorSnapshotForCascade = new Set(this.anchor);
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 50) {
      changed = this.tryOneExpansion();
      iterations++;
    }
  }

  // Try a single auto-expansion pass in all 4 axis directions (up/down/left/right)
  // For each cell on the anchor's boundary, look for maximal straight runs of boundary edge
  // that are fully bordered by letters, and absorb the deepest common full rectangle.
  // Two sub-rules:
  //  (a) runs of length >= 2: absorbed whenever the bordering line is fully lettered (as before).
  //  (b) runs of length == 1 (an isolated boundary-facing cell): only absorbed if the candidate
  //      cell is orthogonally adjacent to anchor (as it stood BEFORE this cascade - see
  //      runAutoExpansion) on 2 or more sides (closes a notch/corner between pre-existing anchor
  //      arms), not just a single-side "outcrop tip", and not by chaining off a cell this same
  //      cascade only just added.
  tryOneExpansion() {
    if (this.anchor.size === 0) return false;

    const dirs = [
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 0, dy: -1 },
    ];

    for (const { dx, dy } of dirs) {
      if (this.tryExpandDirection(dx, dy)) return true;
    }
    return false;
  }

  // Count how many of the 4 orthogonal neighbours of (x,y) were anchor cells at the start of the
  // current cascade (falls back to the live anchor set if called outside a cascade, e.g. from tests).
  orthogonalAnchorNeighbourCount(x, y) {
    const ref = this._anchorSnapshotForCascade || this.anchor;
    let n = 0;
    if (ref.has(key(x + 1, y))) n++;
    if (ref.has(key(x - 1, y))) n++;
    if (ref.has(key(x, y + 1))) n++;
    if (ref.has(key(x, y - 1))) n++;
    return n;
  }

  tryExpandDirection(dx, dy) {
    // Find all anchor cells whose neighbour in (dx,dy) is NOT anchor (i.e. boundary-facing cells in this direction)
    const boundaryCells = [];
    for (const k of this.anchor) {
      const [x, y] = k.split(',').map(Number);
      const nx = x + dx, ny = y + dy;
      if (!this.isAnchor(nx, ny)) {
        boundaryCells.push({ x, y });
      }
    }
    if (boundaryCells.length === 0) return false;

    // Group boundary cells into contiguous straight runs perpendicular to (dx,dy)
    const runs = [];
    if (dx !== 0) {
      const byX = new Map();
      for (const c of boundaryCells) {
        if (!byX.has(c.x)) byX.set(c.x, []);
        byX.get(c.x).push(c.y);
      }
      for (const [x, ys] of byX) {
        ys.sort((a, b) => a - b);
        let run = [ys[0]];
        for (let i = 1; i < ys.length; i++) {
          if (ys[i] === ys[i - 1] + 1) {
            run.push(ys[i]);
          } else {
            runs.push({ x, ys: run });
            run = [ys[i]];
          }
        }
        runs.push({ x, ys: run });
      }
    } else {
      const byY = new Map();
      for (const c of boundaryCells) {
        if (!byY.has(c.y)) byY.set(c.y, []);
        byY.get(c.y).push(c.x);
      }
      for (const [y, xs] of byY) {
        xs.sort((a, b) => a - b);
        let run = [xs[0]];
        for (let i = 1; i < xs.length; i++) {
          if (xs[i] === xs[i - 1] + 1) {
            run.push(xs[i]);
          } else {
            runs.push({ y, xs: run });
            run = [xs[i]];
          }
        }
        runs.push({ y, xs: run });
      }
    }

    for (const run of runs) {
      let coords;
      if (dx !== 0) {
        coords = run.ys.map(y => ({ x: run.x, y }));
      } else {
        coords = run.xs.map(x => ({ x, y: run.y }));
      }

      const runLength = coords.length;

      // Check first neighbour line is fully lettered
      const firstLine = coords.map(c => ({ x: c.x + dx, y: c.y + dy }));
      if (!this.lineFullyLettered(firstLine)) continue;

      if (runLength === 1) {
        // Sub-rule (b): isolated single-cell boundary run.
        // Only eligible if the candidate cell (depth 1) touches anchor on 2+ orthogonal sides.
        const cand = firstLine[0];
        if (this.orthogonalAnchorNeighbourCount(cand.x, cand.y) < 2) {
          continue; // plain outcrop tip - do not auto-absorb
        }
        // Absorb just this single cell (do not blindly extend depth for isolated cells -
        // depth extension re-checked next pass once this cell is anchor, so multi-step
        // corner-filling still works iteratively).
        const k = key(cand.x, cand.y);
        if (!this.anchor.has(k)) {
          this.anchor.add(k);
          return true;
        }
        continue;
      }

      // Sub-rule (a): run length >= 2, absorb full depth as before.
      let depth = 1;
      while (true) {
        const nextLine = coords.map(c => ({ x: c.x + dx * (depth + 1), y: c.y + dy * (depth + 1) }));
        if (!this.lineFullyLettered(nextLine)) break;
        depth++;
        if (depth > Math.max(this.width, this.height)) break; // safety
      }

      let absorbedAny = false;
      for (let d = 1; d <= depth; d++) {
        for (const c of coords) {
          const ax = c.x + dx * d, ay = c.y + dy * d;
          const k = key(ax, ay);
          if (!this.anchor.has(k)) {
            this.anchor.add(k);
            absorbedAny = true;
          }
        }
      }
      if (absorbedAny) return true;
    }

    return false;
  }

  lineFullyLettered(coords) {
    for (const c of coords) {
      if (!this.inBounds(c.x, c.y)) return false;
      if (this.getLetter(c.x, c.y) === null) return false;
    }
    return true;
  }
}

// Browser-safe export (no module.exports; engine.js is loaded as a plain script)
