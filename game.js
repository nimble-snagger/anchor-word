// Anchor Word - game.js
// Coordinates: x = column (0..GRID_W-1), y = row (0..GRID_H-1), y=0 is the TOP row visually.

const GRID_W = 21;
const GRID_H = 27;
const CELL = 26; // px
const TOP_MARGIN_ROWS_INITIAL = 2;
const RIGHT_MARGIN_COLS = 2;
const NEG_BOX_CAPACITY = 2;
const POS_BOX_CAPACITY = 5;
const MIN_START_WORD_LEN = 4;
const MIN_WORD_LEN = 2;

const SVGNS = 'http://www.w3.org/2000/svg';

// ---------- Mode: full word list (default, public beta) or reduced test list (?list=test) ----------
// The test list is for debugging mechanics (it has lots of overlapping words, so overlays come up often),
// and it also switches the coordinate labels on so screenshots are self-describing.
const IS_TEST_MODE = new URLSearchParams(window.location.search).get('list') === 'test';
const ACTIVE_WORD_POOL = IS_TEST_MODE ? WORD_POOL_TEST : WORD_POOL_FULL;
const SHOW_COORDS = IS_TEST_MODE;
const LABEL_STRIP = SHOW_COORDS ? 16 : 0; // px reserved for coordinate labels (column letters above, row numbers left of the play grid)


// ---------- Coordinate display helpers ----------
// Internal engine coords: x=0..GRID_W-1 (left to right), y=0..GRID_H-1 (TOP to bottom).
// Display coords (matches our A1-bottom-left convention used when discussing the board):
// column letters A, B, C... left to right; row numbers 1..GRID_H, with row 1 at the BOTTOM.
function colLetter(x) {
  // Supports beyond 26 columns (AA, AB...) though we don't need it at width 21.
  let n = x, s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
function rowNumber(y) {
  return GRID_H - y; // y=0 (top) -> GRID_H, y=GRID_H-1 (bottom) -> 1
}
function displayCoord(x, y) {
  return colLetter(x) + rowNumber(y);
}

// ---------- Word pool helpers ----------
// The word list is just a big pool of words. How often each LENGTH comes up is controlled here, not by
// the list: first a length is drawn using these target shares (roughly how often words of each length
// appear in running English text), then a random word of that length is picked from the list.
// Lengths the active list doesn't have are skipped and the remaining shares are renormalised, so the
// same code works for the small test list.
const LENGTH_SHARES = { 2: 19.5, 3: 23.3, 4: 20.0, 5: 11.9, 6: 8.3, 7: 7.1, 8: 4.7, 9: 3.1, 10: 2.0 };

const wordsByLen = {};
for (const w of ACTIVE_WORD_POOL) {
  const L = w.length;
  if (!wordsByLen[L]) wordsByLen[L] = [];
  wordsByLen[L].push(w.toUpperCase());
}

function pickWeightedLength(lens, weightOf) {
  const weights = lens.map(weightOf);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < lens.length; i++) {
    if (r < weights[i]) return lens[i];
    r -= weights[i];
  }
  return lens[lens.length - 1];
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Candidate words for play: length drawn from LENGTH_SHARES (renormalised over lengths available).
function randomWordAnyLen() {
  const lens = Object.keys(wordsByLen).map(Number).filter(l => l >= MIN_WORD_LEN);
  const L = pickWeightedLength(lens, l => LENGTH_SHARES[l] || 1);
  return randomFrom(wordsByLen[L]);
}

// Starting (anchor) word: at least MIN_START_WORD_LEN letters, each available length equally likely,
// so games don't usually begin with a tiny anchor.
function randomStartWord() {
  const lens = Object.keys(wordsByLen).map(Number).filter(l => l >= MIN_START_WORD_LEN);
  const L = randomFrom(lens);
  return randomFrom(wordsByLen[L]);
}

// ---------- Game state ----------
let state = null;

function newGameState() {
  const board = new Board(GRID_W, GRID_H);
  const startWord = randomStartWord();
  // Place vertically, centred
  const x0 = Math.floor(GRID_W / 2);
  const y0 = Math.floor((GRID_H - startWord.length) / 2);
  for (let i = 0; i < startWord.length; i++) {
    const y = y0 + i;
    board.cells.set(x0 + ',' + y, startWord[i]);
    board.anchor.add(x0 + ',' + y);
  }

  return {
    board,
    posTallyRows: TOP_MARGIN_ROWS_INITIAL, // grows over time
    posScore: 0,
    negScore: 0,
    candidateWord: randomWordAnyLen(),
    // placement UI state
    selectedLetterIdx: null, // index in candidate word the user tapped
    anchorPoint: null,       // {x,y} the anchor-area cell chosen to align with selectedLetterIdx
    dirIdx: DIRS.findIndex(d => d.dx === 1 && d.dy === 0), // default East
    reversed: false,
    gameOver: false,
  };
}

// ---------- Rendering ----------
const host = document.getElementById('gridSvgHost');
const boardScroll = document.getElementById('boardScroll');
let svg = null;

function totalGridWidthPx() {
  return LABEL_STRIP + (GRID_W + RIGHT_MARGIN_COLS) * CELL + 2;
}
function totalGridHeightPx(posRows) {
  return (GRID_H + posRows) * CELL + LABEL_STRIP + 2;
}

function buildStaticSvgSkeleton() {
  host.innerHTML = '';
  svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('id', 'mainSvg');
  render();
}

function render() {
  const posRows = state.posTallyRows;
  const W = totalGridWidthPx();
  const H = totalGridHeightPx(posRows);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';

  const gridPxY0 = posRows * CELL; // play grid starts below the pos margin (within the shifted content group)
  const rightMarginPxX0 = GRID_W * CELL;

  // Everything else (margins, play grid) is drawn into this shifted group so a fixed label
  // strip can sit above/left of it without disturbing any of the existing layout maths below.
  const contentGroup = document.createElementNS(SVGNS, 'g');
  contentGroup.setAttribute('transform', `translate(${LABEL_STRIP}, ${LABEL_STRIP})`);

  // Compute placement validation up front (if a placement is in progress) so every part of
  // this render pass (corner button, ghost cells, status line) reflects the same result.
  if (state.anchorPoint && state.selectedLetterIdx !== null) {
    computeCurrentValidation();
  } else {
    state._lastValidation = null;
  }

  // --- Positive tally margin (top-left block, GRID_W wide x posRows tall) ---
  const posGroup = document.createElementNS(SVGNS, 'g');
  for (let r = 0; r < posRows; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const rect = document.createElementNS(SVGNS, 'rect');
      rect.setAttribute('x', c * CELL);
      rect.setAttribute('y', r * CELL);
      rect.setAttribute('width', CELL);
      rect.setAttribute('height', CELL);
      rect.setAttribute('class', 'tallyCellBox');
      posGroup.appendChild(rect);
    }
  }
  drawPositiveTallies(posGroup, posRows);
  contentGroup.appendChild(posGroup);

  // --- Right negative tally margin (runs alongside the play grid only, NOT the top margin) ---
  const negGroup = document.createElementNS(SVGNS, 'g');
  negGroup.setAttribute('transform', `translate(${rightMarginPxX0}, ${gridPxY0})`);
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < RIGHT_MARGIN_COLS; c++) {
      const rect = document.createElementNS(SVGNS, 'rect');
      rect.setAttribute('x', c * CELL);
      rect.setAttribute('y', r * CELL);
      rect.setAttribute('width', CELL);
      rect.setAttribute('height', CELL);
      rect.setAttribute('class', 'tallyCellBox');
      negGroup.appendChild(rect);
    }
  }
  drawNegativeTallies(negGroup);
  contentGroup.appendChild(negGroup);

  // --- The unused 2x2 corner where the top margin and right margin would cross ---
  // This is where the "Place word" action lives (drawn as a button-like cell group).
  const cornerGroup = document.createElementNS(SVGNS, 'g');
  cornerGroup.setAttribute('transform', `translate(${rightMarginPxX0}, 0)`);
  cornerGroup.setAttribute('id', 'placeButtonCorner');
  const cornerRect = document.createElementNS(SVGNS, 'rect');
  cornerRect.setAttribute('x', 0);
  cornerRect.setAttribute('y', 0);
  cornerRect.setAttribute('width', RIGHT_MARGIN_COLS * CELL);
  cornerRect.setAttribute('height', posRows * CELL);
  cornerRect.setAttribute('class', 'cornerPlaceRect' + (canPlaceNow() ? ' cornerPlaceReady' : ''));
  cornerRect.setAttribute('rx', 3);
  cornerGroup.appendChild(cornerRect);
  const cornerLabel = document.createElementNS(SVGNS, 'text');
  cornerLabel.setAttribute('x', (RIGHT_MARGIN_COLS * CELL) / 2);
  cornerLabel.setAttribute('y', (posRows * CELL) / 2 + 1);
  cornerLabel.setAttribute('class', 'cornerPlaceText' + (canPlaceNow() ? ' cornerPlaceReady' : ''));
  cornerLabel.setAttribute('text-anchor', 'middle');
  cornerLabel.setAttribute('dominant-baseline', 'central');
  cornerLabel.textContent = 'PLACE';
  cornerGroup.appendChild(cornerLabel);
  if (canPlaceNow()) {
    cornerGroup.classList.add('pickTarget');
    cornerGroup.addEventListener('click', doPlaceWord);
  }
  contentGroup.appendChild(cornerGroup);

  // --- Divider lines between margins and play area ---
  const divider = document.createElementNS(SVGNS, 'g');
  const hLine = document.createElementNS(SVGNS, 'line');
  hLine.setAttribute('x1', 0); hLine.setAttribute('x2', GRID_W * CELL);
  hLine.setAttribute('y1', gridPxY0); hLine.setAttribute('y2', gridPxY0);
  hLine.setAttribute('class', 'marginDivider');
  divider.appendChild(hLine);
  const vLine = document.createElementNS(SVGNS, 'line');
  vLine.setAttribute('x1', rightMarginPxX0); vLine.setAttribute('x2', rightMarginPxX0);
  vLine.setAttribute('y1', 0); vLine.setAttribute('y2', H - LABEL_STRIP);
  vLine.setAttribute('class', 'marginDivider');
  divider.appendChild(vLine);
  contentGroup.appendChild(divider);

  // --- Play grid ---
  const gridGroup = document.createElementNS(SVGNS, 'g');
  gridGroup.setAttribute('transform', `translate(0, ${gridPxY0})`);
  gridGroup.setAttribute('id', 'playGridGroup');

  // grid lines
  for (let c = 0; c <= GRID_W; c++) {
    const l = document.createElementNS(SVGNS, 'line');
    l.setAttribute('x1', c * CELL); l.setAttribute('x2', c * CELL);
    l.setAttribute('y1', 0); l.setAttribute('y2', GRID_H * CELL);
    l.setAttribute('class', 'gridLine');
    gridGroup.appendChild(l);
  }
  for (let r = 0; r <= GRID_H; r++) {
    const l = document.createElementNS(SVGNS, 'line');
    l.setAttribute('x1', 0); l.setAttribute('x2', GRID_W * CELL);
    l.setAttribute('y1', r * CELL); l.setAttribute('y2', r * CELL);
    l.setAttribute('class', 'gridLine');
    gridGroup.appendChild(l);
  }

  // anchor cell fills
  for (const k of state.board.anchor) {
    const [x, y] = k.split(',').map(Number);
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('x', x * CELL);
    rect.setAttribute('y', y * CELL);
    rect.setAttribute('width', CELL);
    rect.setAttribute('height', CELL);
    rect.setAttribute('class', 'anchorCellRect');
    gridGroup.appendChild(rect);
  }

  // anchor boundary outline (perimeter edges only)
  drawAnchorBoundary(gridGroup);

  // letters
  for (const [k, letter] of state.board.cells) {
    const [x, y] = k.split(',').map(Number);
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', x * CELL + CELL / 2);
    t.setAttribute('y', y * CELL + CELL / 2 + 1);
    t.setAttribute('font-size', CELL * 0.55);
    t.setAttribute('class', 'cellText');
    t.textContent = letter;
    gridGroup.appendChild(t);
  }

  // match-highlight cells (when user has selected a candidate letter, before anchor point chosen)
  if (state.selectedLetterIdx !== null && !state.anchorPoint) {
    const letter = state.candidateWord[state.selectedLetterIdx];
    for (const k of state.board.anchor) {
      const [x, y] = k.split(',').map(Number);
      if (state.board.getLetter(x, y) === letter) {
        const rect = document.createElementNS(SVGNS, 'rect');
        rect.setAttribute('x', x * CELL);
        rect.setAttribute('y', y * CELL);
        rect.setAttribute('width', CELL);
        rect.setAttribute('height', CELL);
        rect.setAttribute('class', 'matchHighlight pickTarget');
        rect.dataset.x = x; rect.dataset.y = y;
        rect.addEventListener('click', onAnchorCellPicked);
        gridGroup.appendChild(rect);
      }
    }
  }

  // ghost preview of placement in progress (validation already computed above)
  if (state.anchorPoint && state.selectedLetterIdx !== null && state._lastValidation) {
    drawGhostPreview(gridGroup);
  }

  contentGroup.appendChild(gridGroup);
  svg.appendChild(contentGroup);

  // --- Coordinate labels (column letters above the play grid, row numbers to its left) ---
  // Uses the bottom-left-origin convention (row 1 at the bottom) agreed for describing the board.
  const labelGroup = document.createElementNS(SVGNS, 'g');
  labelGroup.setAttribute('id', 'coordLabels');
  if (SHOW_COORDS) {
  const gridScreenY0 = LABEL_STRIP + gridPxY0; // where the play grid's row 0 (top) sits in final SVG space
  for (let c = 0; c < GRID_W; c++) {
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', LABEL_STRIP + c * CELL + CELL / 2);
    t.setAttribute('y', LABEL_STRIP - 4);
    t.setAttribute('class', 'coordLabelText');
    t.textContent = colLetter(c);
    labelGroup.appendChild(t);
  }
  for (let r = 0; r < GRID_H; r++) {
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', LABEL_STRIP - 4);
    t.setAttribute('y', gridScreenY0 + r * CELL + CELL / 2 + 1);
    t.setAttribute('class', 'coordLabelText coordLabelRow');
    t.textContent = rowNumber(r);
    labelGroup.appendChild(t);
  }
  svg.appendChild(labelGroup);
  }

  host.appendChild(svg);
  updateScoreLabels();
  updatePlaceButtonState();
}

function drawPositiveTallies(group, posRows) {
  const fullBoxes = Math.floor(state.posScore / POS_BOX_CAPACITY);
  const remainder = state.posScore % POS_BOX_CAPACITY;

  let boxIndex = 0;
  for (let r = 0; r < posRows; r++) {
    for (let c = 0; c < GRID_W; c++) {
      let marks = 0;
      if (boxIndex < fullBoxes) marks = POS_BOX_CAPACITY;
      else if (boxIndex === fullBoxes) marks = remainder;
      if (marks > 0) drawTallyMarksInBox(group, c * CELL, r * CELL, marks, false);
      boxIndex++;
    }
  }
}

function drawNegativeTallies(group) {
  const totalRows = GRID_H;
  const fullBoxes = Math.floor(state.negScore / NEG_BOX_CAPACITY);
  const remainder = state.negScore % NEG_BOX_CAPACITY;

  let boxIndex = 0;
  for (let r = 0; r < totalRows; r++) {
    for (let c = 0; c < RIGHT_MARGIN_COLS; c++) {
      let marks = 0;
      if (boxIndex < fullBoxes) marks = NEG_BOX_CAPACITY;
      else if (boxIndex === fullBoxes) marks = remainder;
      if (marks > 0) drawTallyMarksInBox(group, c * CELL, r * CELL, marks, true);
      boxIndex++;
    }
  }
}

function drawTallyMarksInBox(group, px, py, count, negative) {
  const pad = CELL * 0.2;
  const usableW = CELL - pad * 2;
  const n = Math.min(count, 5);
  const spacing = usableW / 4;
  for (let i = 0; i < Math.min(n, 4); i++) {
    const lx = px + pad + i * spacing;
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', lx); line.setAttribute('x2', lx);
    line.setAttribute('y1', py + pad); line.setAttribute('y2', py + CELL - pad);
    line.setAttribute('class', negative ? 'tallyMarkNeg' : 'tallyMark');
    group.appendChild(line);
  }
  if (n === 5) {
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', px + pad - 2); line.setAttribute('x2', px + CELL - pad + 2);
    line.setAttribute('y1', py + CELL - pad); line.setAttribute('y2', py + pad);
    line.setAttribute('class', negative ? 'tallyMarkNeg' : 'tallyMark');
    group.appendChild(line);
  }
}

function drawAnchorBoundary(group) {
  for (const k of state.board.anchor) {
    const [x, y] = k.split(',').map(Number);
    const edges = [
      { has: !state.board.isAnchor(x, y - 1), x1: x, y1: y, x2: x + 1, y2: y },
      { has: !state.board.isAnchor(x, y + 1), x1: x, y1: y + 1, x2: x + 1, y2: y + 1 },
      { has: !state.board.isAnchor(x - 1, y), x1: x, y1: y, x2: x, y2: y + 1 },
      { has: !state.board.isAnchor(x + 1, y), x1: x + 1, y1: y, x2: x + 1, y2: y + 1 },
    ];
    for (const e of edges) {
      if (!e.has) continue;
      const line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('x1', e.x1 * CELL);
      line.setAttribute('y1', e.y1 * CELL);
      line.setAttribute('x2', e.x2 * CELL);
      line.setAttribute('y2', e.y2 * CELL);
      line.setAttribute('class', 'anchorBoundary');
      group.appendChild(line);
    }
  }
}

function computeCurrentValidation() {
  const word = state.reversed ? [...state.candidateWord].reverse().join('') : state.candidateWord;
  const anchorIdxInWord = state.reversed ? (word.length - 1 - state.selectedLetterIdx) : state.selectedLetterIdx;
  const { dx, dy } = DIRS[state.dirIdx];
  const x0 = state.anchorPoint.x - dx * anchorIdxInWord;
  const y0 = state.anchorPoint.y - dy * anchorIdxInWord;
  state._lastValidation = state.board.validatePlacement(state.candidateWord, x0, y0, state.dirIdx, state.reversed);
  state._lastPlacementOrigin = { x0, y0 };
}

function drawGhostPreview(group) {
  const word = state.reversed ? [...state.candidateWord].reverse().join('') : state.candidateWord;
  const { dx, dy } = DIRS[state.dirIdx];
  const { x0, y0 } = state._lastPlacementOrigin;
  const result = state._lastValidation;

  for (let i = 0; i < word.length; i++) {
    const x = x0 + dx * i;
    const y = y0 + dy * i;
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) continue;
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('x', x * CELL);
    rect.setAttribute('y', y * CELL);
    rect.setAttribute('width', CELL);
    rect.setAttribute('height', CELL);
    rect.setAttribute('class', result.valid ? 'ghostCell' : 'ghostCellBad');
    group.appendChild(rect);

    const existing = state.board.getLetter(x, y);
    if (existing === null) {
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', x * CELL + CELL / 2);
      t.setAttribute('y', y * CELL + CELL / 2 + 1);
      t.setAttribute('font-size', CELL * 0.55);
      t.setAttribute('class', 'ghostText');
      t.textContent = word[i];
      group.appendChild(t);
    }
  }

  if (!result.valid) {
    setStatus(result.reason, 'error');
  } else if (result.isOverlay) {
    setStatus('Overlay: extends the anchor area, scores 0 points.', 'ok');
  } else {
    setStatus(`Valid placement: ${result.score} point${result.score === 1 ? '' : 's'}.`, 'ok');
  }
}

// ---------- Interaction ----------
function renderCandidateWord() {
  const container = document.getElementById('candidateWord');
  container.innerHTML = '';
  const word = state.candidateWord;
  for (let i = 0; i < word.length; i++) {
    const div = document.createElement('div');
    div.className = 'candLetter' + (state.selectedLetterIdx === i ? ' selected' : '');
    div.textContent = word[i];
    div.addEventListener('click', () => onCandidateLetterClicked(i));
    container.appendChild(div);
  }
}

function onCandidateLetterClicked(i) {
  if (state.gameOver) return;
  if (state.anchorPoint) return;
  state.selectedLetterIdx = i;
  renderCandidateWord();
  render();
  setStatus('Tap a highlighted letter on the board to connect to it.', '');
}

function onAnchorCellPicked(evt) {
  const x = Number(evt.currentTarget.dataset.x);
  const y = Number(evt.currentTarget.dataset.y);
  state.anchorPoint = { x, y };
  render();
  updateDirLabel();
}

function cycleDirection(delta) {
  if (!state.anchorPoint) return;
  state.dirIdx = (state.dirIdx + delta + DIRS.length) % DIRS.length;
  render();
  updateDirLabel();
}

const DIR_LABELS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
function updateDirLabel() {
  document.getElementById('dirLabel').textContent = DIR_LABELS[state.dirIdx] + (state.reversed ? ' (rev)' : '');
}

function updatePlaceButtonState() {
  const btn = document.getElementById('placeBtn');
  const ready = canPlaceNow();
  btn.disabled = !ready;
}

function canPlaceNow() {
  return !!(state.anchorPoint && state._lastValidation && state._lastValidation.valid);
}

function resetPlacementSelection() {
  state.selectedLetterIdx = null;
  state.anchorPoint = null;
  state.dirIdx = DIRS.findIndex(d => d.dx === 1 && d.dy === 0);
  state.reversed = false;
  state._lastValidation = null;
  renderCandidateWord();
  updateDirLabel();
  updatePlaceButtonState();
}

// ---------- Move history (undo/redo) ----------
// Full-state snapshots are simplest and safest here - the board/anchor/score state is small,
// and re-deriving an "inverse" of every operation (especially auto-expansion cascades) would be
// a second, error-prone implementation of the same rules. A snapshot is taken before every move
// that changes state (place, discard, and the start of a new game); undo/redo just moves a
// pointer through that history and restores the board/scores at that point.
let history = [];
let historyIndex = -1; // points at the snapshot representing the CURRENT state

function snapshotState() {
  return {
    cells: [...state.board.cells.entries()],
    anchor: [...state.board.anchor],
    posTallyRows: state.posTallyRows,
    posScore: state.posScore,
    negScore: state.negScore,
    candidateWord: state.candidateWord,
    gameOver: state.gameOver,
    moveLabel: state._pendingMoveLabel || 'Start',
  };
}

function restoreFromSnapshot(snap) {
  state.board = new Board(GRID_W, GRID_H);
  for (const [k, letter] of snap.cells) state.board.cells.set(k, letter);
  for (const k of snap.anchor) state.board.anchor.add(k);
  state.posTallyRows = snap.posTallyRows;
  state.posScore = snap.posScore;
  state.negScore = snap.negScore;
  state.candidateWord = snap.candidateWord;
  state.gameOver = snap.gameOver;
}

// Call this right after any change that should become a new, undoable step
// (i.e. at the end of doPlaceWord / doDiscardWord, and once after a new game starts).
function pushHistory(label) {
  state._pendingMoveLabel = label;
  // if we'd undone some moves and then made a new move, the redo branch is discarded
  history = history.slice(0, historyIndex + 1);
  history.push(snapshotState());
  historyIndex = history.length - 1;
  updateHistoryButtons();
}

function canUndo() { return historyIndex > 0; }
function canRedo() { return historyIndex < history.length - 1; }

function doUndo() {
  if (!canUndo()) return;
  historyIndex--;
  restoreFromSnapshot(history[historyIndex]);
  resetPlacementSelection();
  setStatus('Undid: ' + (history[historyIndex + 1].moveLabel || 'move'), '');
  render();
  updateHistoryButtons();
}

function doRedo() {
  if (!canRedo()) return;
  historyIndex++;
  restoreFromSnapshot(history[historyIndex]);
  resetPlacementSelection();
  setStatus('Redid: ' + (history[historyIndex].moveLabel || 'move'), '');
  render();
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  if (undoBtn) undoBtn.disabled = !canUndo();
  if (redoBtn) redoBtn.disabled = !canRedo();
}

function setStatus(msg, cls) {
  const el = document.getElementById('statusLine');
  el.textContent = msg;
  el.className = cls || '';
}

function doPlaceWord() {
  if (!state._lastValidation || !state._lastValidation.valid) return;
  const result = state._lastValidation;
  const placedWord = state.candidateWord;
  state.board.applyPlacement(result);
  state.posScore += result.score;
  maybeGrowPositiveMargin();

  if (result.isOverlay) {
    setStatus('Anchor area extended (0 points).', 'ok');
  } else {
    setStatus(`Placed for ${result.score} point${result.score === 1 ? '' : 's'}.`, 'ok');
  }

  nextCandidateWord();
  resetPlacementSelection();
  pushHistory('Placed ' + placedWord);
  render();
}

function doDiscardWord() {
  if (state.gameOver) return;
  const discardedWord = state.candidateWord;
  state.negScore += 1;
  setStatus('Word discarded (−1).', 'error');
  nextCandidateWord();
  resetPlacementSelection();
  checkGameOver();
  pushHistory('Discarded ' + discardedWord);
  render();
}

function nextCandidateWord() {
  state.candidateWord = randomWordAnyLen();
}

function maybeGrowPositiveMargin() {
  const capacity = state.posTallyRows * GRID_W * POS_BOX_CAPACITY;
  if (state.posScore >= capacity) {
    state.posTallyRows += 1;
  }
}

function checkGameOver() {
  const capacity = RIGHT_MARGIN_COLS * GRID_H * NEG_BOX_CAPACITY;
  if (state.negScore >= capacity) {
    state.gameOver = true;
    showGameOverModal();
  }
}

function showGameOverModal() {
  const modal = document.getElementById('modalContent');
  const final = state.posScore - state.negScore;
  modal.innerHTML = `
    <h2>Game over</h2>
    <p>The discard margin is full.</p>
    <p style="font-family:'Space Mono',monospace;font-size:15px;color:var(--ink)">
      Positive: +${state.posScore}<br>
      Negative: \u2212${state.negScore}<br>
      <strong>Final score: ${final}</strong>
    </p>
    <div class="modalActions">
      <button class="primary" id="modalNewGameBtn">New game</button>
    </div>
  `;
  document.getElementById('overlayScreen').classList.remove('hidden');
  document.getElementById('modalNewGameBtn').addEventListener('click', () => {
    document.getElementById('overlayScreen').classList.add('hidden');
    startNewGame();
  });
}

function updateScoreLabels() {
  document.getElementById('posScoreLabel').textContent = '+' + state.posScore;
  document.getElementById('negScoreLabel').textContent = '\u2212' + state.negScore;
}

function startNewGame() {
  state = newGameState();
  history = [];
  historyIndex = -1;
  buildStaticSvgSkeleton();
  renderCandidateWord();
  resetPlacementSelection();
  setStatus('Tap a letter in the current word to begin.', '');
  pushHistory('Start');
  render();
}

// ---------- Wire up controls ----------
document.getElementById('rotateCW').addEventListener('click', () => cycleDirection(1));
document.getElementById('rotateCCW').addEventListener('click', () => cycleDirection(-1));
document.getElementById('flipBtn').addEventListener('click', () => {
  if (!state.anchorPoint) return;
  state.reversed = !state.reversed;
  render();
  updateDirLabel();
});
document.getElementById('placeBtn').addEventListener('click', doPlaceWord);
document.getElementById('discardBtn').addEventListener('click', doDiscardWord);
document.getElementById('undoBtn').addEventListener('click', doUndo);
document.getElementById('redoBtn').addEventListener('click', doRedo);
document.getElementById('newGameBtn').addEventListener('click', () => {
  if (confirm('Start a new game? Current progress will be lost.')) startNewGame();
});

// ---------- How-to-play sheet ----------
// Shown automatically on a device's first visit (remembered in localStorage), and reopenable any time
// from the "How to play" button. Storage can be blocked (private browsing etc.), so every access is guarded.
const HELP_SEEN_KEY = 'anchorword_help_seen_v1';

function showHelp() {
  document.getElementById('helpScreen').classList.remove('hidden');
  document.getElementById('helpBody').scrollTop = 0;
}
function hideHelp() {
  document.getElementById('helpScreen').classList.add('hidden');
  try { localStorage.setItem(HELP_SEEN_KEY, '1'); } catch (e) { /* storage unavailable - fine */ }
}
function helpAlreadySeen() {
  try { return localStorage.getItem(HELP_SEEN_KEY) === '1'; } catch (e) { return false; }
}

document.getElementById('helpBtn').addEventListener('click', showHelp);
document.getElementById('helpCloseBtn').addEventListener('click', hideHelp);
document.getElementById('helpScreen').addEventListener('click', (e) => {
  if (e.target.id === 'helpScreen') hideHelp(); // tap outside the sheet to close
});
if (IS_TEST_MODE) document.getElementById('testBadge').hidden = false;

startNewGame();
if (!helpAlreadySeen()) showHelp();
