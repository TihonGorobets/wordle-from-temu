/* ===================================================
   WORDLE – Game Logic
   =================================================== */

const WORD_LENGTH = 5;
const MAX_GUESSES = 6;

// ── State ──────────────────────────────────────────
let targetWord = '';
let currentRow = 0;
let currentCol = 0;
let currentGuess = [];
let gameOver = false;
let hardMode = false;
let revealedLetters = {}; // {letter: 'correct'|'present'|'absent'}

// Hard-mode constraint tracking
let hardConstraints = {
  exactPositions: {},  // pos -> letter  (green)
  mustContain: []      // [{letter, minCount}]
};

// ── Persistence keys ──────────────────────────────
const STORAGE_KEY_STATE  = 'wordle_state';
const STORAGE_KEY_STATS  = 'wordle_stats';

// ── Statistics ────────────────────────────────────
let stats = {
  played: 0,
  wins: 0,
  streak: 0,
  maxStreak: 0,
  distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
};

// ── Settings ──────────────────────────────────────
let darkMode = true;
let highContrast = false;
let practiceMode = false;  // true after a reset (uses random word instead of daily)

/* ===================================================
   INIT
   =================================================== */
function init() {
  loadSettings();
  loadStats();
  buildBoard();
  pickWord();
  loadState();
  attachKeyboard();
  attachModalControls();
  syncSettingsUI();
  renderStats();

  // Show help on first visit — open it without blocking the keyboard
  // (user can always re-open it via the ? button)
  if (!localStorage.getItem('wordle_visited')) {
    localStorage.setItem('wordle_visited', '1');
    setTimeout(() => openModal('help-modal'), 400);
  }

  // If game already ended show stats, but ALSO show the reset hint
  if (gameOver) {
    document.getElementById('btn-reset').classList.add('game-over');
    showToast('Game over — press ↺ to play again', 4000);
    setTimeout(() => openModal('stats-modal'), 1600);
  }
}

/* ===================================================
   BOARD
   =================================================== */
function buildBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  for (let r = 0; r < MAX_GUESSES; r++) {
    const rowEl = document.createElement('div');
    rowEl.classList.add('row');
    rowEl.id = `row-${r}`;
    for (let c = 0; c < WORD_LENGTH; c++) {
      const tile = document.createElement('div');
      tile.classList.add('tile');
      tile.id = `tile-${r}-${c}`;
      rowEl.appendChild(tile);
    }
    board.appendChild(rowEl);
  }
}

function getTile(r, c) {
  return document.getElementById(`tile-${r}-${c}`);
}

function getRow(r) {
  return document.getElementById(`row-${r}`);
}

/* ===================================================
   WORD SELECTION
   =================================================== */
function pickWord() {
  if (practiceMode) {
    // Random word for practice games (after reset)
    const idx = Math.floor(Math.random() * ANSWERS.length);
    targetWord = ANSWERS[idx].toUpperCase();
  } else {
    // Date-based seed so everyone gets the same word each day
    const now = new Date();
    const epochDay = Math.floor(
      (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(2021, 5, 19)) /
      86400000
    );
    const idx = ((epochDay % ANSWERS.length) + ANSWERS.length) % ANSWERS.length;
    targetWord = ANSWERS[idx].toUpperCase();
  }
}

/* ===================================================
   KEYBOARD
   =================================================== */
function attachKeyboard() {
  // Virtual keyboard
  document.querySelectorAll('.key').forEach(key => {
    key.addEventListener('click', () => handleKey(key.dataset.key));
  });

  // Physical keyboard
  // Use capture phase so the game still receives keys even if a focused control
  // (button/toggle) stops propagation.
  window.addEventListener('keydown', e => {
    // Avoid handling the same event twice if other listeners call into us.
    if (e.wordleHandled) return;

    // Don't steal keypresses from text inputs (e.g. multiplayer name/code fields)
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      e.wordleHandled = true;
      handleKey('Enter');
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      e.wordleHandled = true;
      handleKey('Backspace');
    } else if (/^[a-zA-Z]$/.test(e.key)) {
      e.wordleHandled = true;
      handleKey(e.key.toLowerCase());
    }
  }, true);
}

/* ===================================================
   KEY HANDLER
   =================================================== */
function handleKey(key) {
  if (gameOver) return;
  if (isModalOpen()) {
    // Make the game resilient: if any modal is open and the user presses a game
    // key, close modals and allow the keypress to go through.
    if (key === 'Enter' || key === 'Backspace' || (/^[a-z]$/i.test(key) && key.length === 1)) {
      document.querySelectorAll('.modal-overlay.open').forEach(m => closeModal(m.id));
    } else {
      return;
    }
  }

  if (key === 'Enter') {
    submitGuess();
  } else if (key === 'Backspace') {
    deleteLetter();
  } else if (/^[a-z]$/i.test(key) && key.length === 1) {
    addLetter(key.toUpperCase());
  }
}

function addLetter(letter) {
  if (currentCol >= WORD_LENGTH) return;
  const tile = getTile(currentRow, currentCol);
  tile.textContent = letter;
  tile.dataset.state = 'tbd';
  currentGuess.push(letter);
  currentCol++;
  mpSyncTyping(currentGuess);
}

function deleteLetter() {
  if (currentCol <= 0) return;
  currentCol--;
  currentGuess.pop();
  const tile = getTile(currentRow, currentCol);
  tile.textContent = '';
  tile.dataset.state = '';
  mpSyncTyping(currentGuess);
}

/* ===================================================
   SUBMIT GUESS
   =================================================== */
function submitGuess() {
  if (currentCol < WORD_LENGTH) {
    showToast('Not enough letters');
    shakeRow(currentRow);
    return;
  }

  const guessWord = currentGuess.join('');

  // Clear live typing indicator immediately when a guess is submitted
  mpClearTyping();

  // Validate word
  if (!isValidWord(guessWord)) {
    showToast('Not in word list');
    shakeRow(currentRow);
    return;
  }

  // Hard mode validation
  if (hardMode) {
    const hardError = checkHardMode(guessWord);
    if (hardError) {
      showToast(hardError);
      shakeRow(currentRow);
      return;
    }
  }

  // Evaluate
  const result = evaluateGuess(guessWord, targetWord);
  const submittedRow = currentRow; // capture before reveal callback increments it
  revealRow(currentRow, guessWord, result, () => {
    updateKeyboard(guessWord, result);
    updateHardConstraints(guessWord, result);
    saveState();
    mpRecordGuess(guessWord, result, submittedRow); // multiplayer: sync guess

    if (result.every(r => r === 'correct')) {
      const msgs = ['Genius!', 'Magnificent!', 'Impressive!', 'Splendid!', 'Great!', 'Phew!'];
      const msg = msgs[Math.min(currentRow, msgs.length - 1)];
      bounceRow(currentRow);
      gameOver = true;
      currentRow++;
      if (mpShouldSuppressSoloEnd()) {
        showToast(msg, 2000);
        mpMarkDone(true);
      } else {
        showToast(msg, 2000);
        recordResult(true, currentRow);
        document.getElementById('btn-reset').classList.add('game-over');
        setTimeout(() => openModal('stats-modal'), 2200);
      }
    } else {
      currentRow++;
      currentCol = 0;
      currentGuess = [];
      if (currentRow >= MAX_GUESSES) {
        gameOver = true;
        if (mpShouldSuppressSoloEnd()) {
          showToast(targetWord, 3000);
          mpMarkDone(false);
        } else {
          showToast(targetWord, 5000);
          recordResult(false, 0);
          document.getElementById('btn-reset').classList.add('game-over');
          setTimeout(() => openModal('stats-modal'), 2200);
        }
      }
    }
  });
}

/* ===================================================
   EVALUATE
   =================================================== */
function evaluateGuess(guess, target) {
  const result = Array(WORD_LENGTH).fill('absent');
  const targetArr = target.split('');
  const guessArr  = guess.split('');

  // First pass: correct
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guessArr[i] === targetArr[i]) {
      result[i] = 'correct';
      targetArr[i] = null;
      guessArr[i] = null;
    }
  }

  // Second pass: present
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guessArr[i] === null) continue;
    const idx = targetArr.indexOf(guessArr[i]);
    if (idx !== -1) {
      result[i] = 'present';
      targetArr[idx] = null;
    }
  }

  return result;
}

/* ===================================================
   WORD VALIDATION
   =================================================== */
// Use Set for O(1) lookup — ANSWERS is already inside ALL_VALID_WORDS
function isValidWord(word) {
  return ALL_VALID_WORDS.has(word.toLowerCase());
}

/* ===================================================
   HARD MODE CONSTRAINTS
   =================================================== */
function updateHardConstraints(guess, result) {
  // Track exact positions (green)
  result.forEach((r, i) => {
    if (r === 'correct') hardConstraints.exactPositions[i] = guess[i];
  });

  // Track must-contain letters (green + yellow)
  const freqMap = {};
  result.forEach((r, i) => {
    if (r === 'correct' || r === 'present') {
      freqMap[guess[i]] = (freqMap[guess[i]] || 0) + 1;
    }
  });

  for (const [letter, count] of Object.entries(freqMap)) {
    const existing = hardConstraints.mustContain.find(c => c.letter === letter);
    if (!existing) {
      hardConstraints.mustContain.push({ letter, minCount: count });
    } else {
      existing.minCount = Math.max(existing.minCount, count);
    }
  }
}

function checkHardMode(guessWord) {
  // Check exact positions
  for (const [pos, letter] of Object.entries(hardConstraints.exactPositions)) {
    if (guessWord[+pos] !== letter) {
      return `${ordinal(+pos + 1)} letter must be ${letter}`;
    }
  }

  // Check must-contain letters
  for (const { letter, minCount } of hardConstraints.mustContain) {
    const count = guessWord.split('').filter(l => l === letter).length;
    if (count < minCount) {
      return `Guess must contain ${letter}`;
    }
  }

  return null;
}

function ordinal(n) {
  return ['1st','2nd','3rd','4th','5th'][n - 1] || `${n}th`;
}

/* ===================================================
   ANIMATIONS
   =================================================== */
function revealRow(rowIdx, guess, result, callback) {
  const FLIP_DURATION = 500;
  const STAGGER = 300;

  result.forEach((state, i) => {
    const tile = getTile(rowIdx, i);
    setTimeout(() => {
      tile.classList.add('flip');

      // Change state at midpoint of flip
      setTimeout(() => {
        tile.dataset.state = state;
      }, FLIP_DURATION / 2);

      tile.addEventListener('animationend', () => {
        tile.classList.remove('flip');
      }, { once: true });
    }, i * STAGGER);
  });

  // Callback after all tiles revealed
  setTimeout(callback, WORD_LENGTH * STAGGER + FLIP_DURATION);
}

function shakeRow(rowIdx) {
  const row = getRow(rowIdx);
  row.classList.add('shake');
  // Use setTimeout instead of animationend to avoid bubbled tile events
  // consuming the listener prematurely (shake-row is 0.6s)
  setTimeout(() => row.classList.remove('shake'), 650);
}

function bounceRow(rowIdx) {
  for (let c = 0; c < WORD_LENGTH; c++) {
    const tile = getTile(rowIdx, c);
    setTimeout(() => {
      tile.classList.add('bounce');
      tile.addEventListener('animationend', () => tile.classList.remove('bounce'), { once: true });
    }, c * 100);
  }
}

/* ===================================================
   KEYBOARD COLORING
   =================================================== */
const STATE_PRIORITY = { correct: 3, present: 2, absent: 1 };

function updateKeyboard(guess, result) {
  result.forEach((state, i) => {
    const letter = guess[i].toLowerCase();
    const keyEl = document.querySelector(`.key[data-key="${letter}"]`);
    if (!keyEl) return;

    const current = keyEl.dataset.state;
    const currentPriority = STATE_PRIORITY[current] || 0;
    if (STATE_PRIORITY[state] > currentPriority) {
      keyEl.dataset.state = state;
      revealedLetters[letter] = state;
    }
  });
}

/* ===================================================
   TOAST
   =================================================== */
function showToast(message, duration = 1200) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.classList.add('toast');
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, duration);
}

/* ===================================================
   MODALS
   =================================================== */
function attachModalControls() {
  // Open buttons
  document.getElementById('btn-help').addEventListener('click', () => openModal('help-modal'));
  document.getElementById('btn-stats').addEventListener('click', () => { renderStats(); openModal('stats-modal'); });
  document.getElementById('btn-settings').addEventListener('click', () => openModal('settings-modal'));

  // Close buttons (data-close attribute)
  document.querySelectorAll('.close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.close) closeModal(btn.dataset.close);
    });
  });

  // Overlay click to close (but not MP lobby/word/results — use Leave button)
  const MP_NO_CLICK_CLOSE = new Set(['mp-lobby-modal','mp-word-modal','mp-results-modal']);
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay && !MP_NO_CLICK_CLOSE.has(overlay.id)) closeModal(overlay.id);
    });
  });

  // Theme toggle (header button)
  document.getElementById('btn-theme').addEventListener('click', () => {
    darkMode = !darkMode;
    applyTheme();
    document.getElementById('dark-mode-toggle').checked = darkMode;
    saveSettings();
  });

  // Settings toggles
  document.getElementById('hard-mode-toggle').addEventListener('change', e => {
    if (currentRow > 0 && !gameOver) {
      showToast('Hard mode can only be turned on before a game starts');
      e.target.checked = !e.target.checked;
      return;
    }
    hardMode = e.target.checked;
    saveSettings();
    applySettings();
  });

  document.getElementById('dark-mode-toggle').addEventListener('change', e => {
    darkMode = e.target.checked;
    applyTheme();
    saveSettings();
  });

  document.getElementById('contrast-toggle').addEventListener('change', e => {
    highContrast = e.target.checked;
    applyContrast();
    saveSettings();
  });

  // Share button
  document.getElementById('share-btn').addEventListener('click', shareResult);

  // Reset / new game button
  document.getElementById('btn-reset').addEventListener('click', resetGame);

  // Multiplayer button
  document.getElementById('btn-multiplayer').addEventListener('click', openMpMenu);

  // Multiplayer modal actions (bound in JS to avoid inline handlers)
  document.getElementById('mp-create-btn').addEventListener('click', createParty);
  document.getElementById('mp-join-btn').addEventListener('click', joinParty);
  document.getElementById('mp-lobby-close-btn').addEventListener('click', leaveParty);
  document.getElementById('mp-lobby-start').addEventListener('click', mpHostStart);
  document.getElementById('mp-lobby-leave-btn').addEventListener('click', leaveParty);
  document.getElementById('mp-submit-word-btn').addEventListener('click', mpSubmitSecretWord);
  document.getElementById('mp-play-again-btn').addEventListener('click', mpPlayAgain);
  document.getElementById('mp-back-lobby-btn').addEventListener('click', mpReturnToLobby);
  document.getElementById('mp-results-leave-btn').addEventListener('click', leaveParty);
  document.getElementById('mp-mode-classic').addEventListener('change', () => mpSelectMode('classic'));
  document.getElementById('mp-mode-custom').addEventListener('change', () => mpSelectMode('custom'));

  document.getElementById('mp-copy-code-btn').addEventListener('click', () => {
    const code = document.getElementById('mp-lobby-code').textContent;
    navigator.clipboard.writeText(code).then(() => {
      showToast('Code copied!');
    }).catch(() => {
      showToast('Failed to copy code');
    });
  });

  // Escape key — don't auto-close MP lobby/word/results without proper cleanup
  const MP_PERSISTENT_MODALS = new Set(['mp-lobby-modal','mp-word-modal','mp-results-modal']);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.open').forEach(m => {
        if (!MP_PERSISTENT_MODALS.has(m.id)) closeModal(m.id);
      });
    }
  });
}

/* ===================================================
   RESET / NEW GAME
   =================================================== */
function resetGame() {
  practiceMode = true;
  startGame();
}

function startGame() {
  // Close any open modals so isModalOpen() doesn't block typing
  document.querySelectorAll('.modal-overlay.open').forEach(m => closeModal(m.id));

  // If a control is focused (e.g. header button, toggle), blur it so subsequent
  // keystrokes are reliably delivered to the game.
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }

  // Clear board state and reset all variables
  localStorage.removeItem(STORAGE_KEY_STATE);
  currentRow = 0; currentCol = 0; currentGuess = []; gameOver = false;
  hardConstraints = { exactPositions: {}, mustContain: [] };
  revealedLetters = {};
  buildBoard();
  document.querySelectorAll('.key').forEach(k => delete k.dataset.state);
  document.getElementById('btn-reset').classList.remove('game-over');

  pickWord();
  practiceMode = false;
}

function openModal(id) {
  if (id === 'stats-modal') renderStats();
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('open');
}

function isModalOpen() {
  return [...document.querySelectorAll('.modal-overlay')].some(m => m.classList.contains('open'));
}

/* ===================================================
   STATS
   =================================================== */
function recordResult(won, rowUsed) {
  stats.played++;
  if (won) {
    stats.wins++;
    stats.streak++;
    stats.maxStreak = Math.max(stats.maxStreak, stats.streak);
    stats.distribution[rowUsed]++;
  } else {
    stats.streak = 0;
  }
  saveStats();
  renderStats();
  if (gameOver) startTimer();
}

function renderStats() {
  document.getElementById('stat-played').textContent   = stats.played;
  document.getElementById('stat-winpct').textContent   = stats.played ? Math.round(stats.wins / stats.played * 100) : 0;
  document.getElementById('stat-streak').textContent   = stats.streak;
  document.getElementById('stat-maxstreak').textContent = stats.maxStreak;

  const maxCount = Math.max(1, ...Object.values(stats.distribution));
  const container = document.getElementById('guess-distribution');
  container.innerHTML = '';

  for (let i = 1; i <= MAX_GUESSES; i++) {
    const count = stats.distribution[i] || 0;
    const pct   = Math.max(7, Math.round((count / maxCount) * 100));
    const isHighlight = gameOver && currentRow === i;

    const row = document.createElement('div');
    row.classList.add('bar-row');

    const label = document.createElement('span');
    label.classList.add('bar-label');
    label.textContent = i;

    const track = document.createElement('div');
    track.classList.add('bar-track');

    const fill = document.createElement('div');
    fill.classList.add('bar-fill');
    if (isHighlight) fill.classList.add('highlight');
    fill.style.width = `${pct}%`;
    fill.textContent = count;

    track.appendChild(fill);
    row.appendChild(label);
    row.appendChild(track);
    container.appendChild(row);
  }

  document.getElementById('stats-footer').style.display = gameOver ? '' : 'none';
  if (gameOver) startTimer();
}

/* ===================================================
   COUNTDOWN TIMER
   =================================================== */
let timerInterval = null;

function startTimer() {
  if (timerInterval) return;
  timerInterval = setInterval(updateTimer, 1000);
  updateTimer();
}

function updateTimer() {
  const timerEl = document.getElementById('next-timer');
  if (!timerEl) return;

  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  const diff = tomorrow - now;

  const h = String(Math.floor(diff / 3600000)).padStart(2, '0');
  const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
  timerEl.textContent = `${h}:${m}:${s}`;
}

/* ===================================================
   SHARE
   =================================================== */
function shareResult() {
  const emojiMap = { correct: '🟩', present: '🟨', absent: '⬛' };

  // Re-evaluate all submitted rows from board tiles
  let rows = [];
  for (let r = 0; r < Math.min(currentRow, MAX_GUESSES); r++) {
    let rowStr = '';
    for (let c = 0; c < WORD_LENGTH; c++) {
      const tile = getTile(r, c);
      rowStr += emojiMap[tile.dataset.state] || '⬜';
    }
    rows.push(rowStr);
  }

  const winRow = rows.length <= MAX_GUESSES && rows[rows.length - 1] === '🟩🟩🟩🟩🟩'
    ? rows.length
    : 'X';

  const today  = new Date();
  const day    = Math.floor((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(2021,5,19)) / 86400000);
  const text   = `Wordle ${day} ${winRow}/${MAX_GUESSES}\n\n${rows.join('\n')}`;

  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied to clipboard!');
  }).catch(() => {
    showToast('Could not copy');
  });
}

/* ===================================================
   SETTINGS
   =================================================== */
function loadSettings() {
  const saved = JSON.parse(localStorage.getItem('wordle_settings') || '{}');
  darkMode     = saved.darkMode     !== undefined ? saved.darkMode     : true;
  highContrast = saved.highContrast !== undefined ? saved.highContrast : false;
  hardMode     = saved.hardMode     !== undefined ? saved.hardMode     : false;
  applyTheme();
  applyContrast();
}

function saveSettings() {
  localStorage.setItem('wordle_settings', JSON.stringify({ darkMode, highContrast, hardMode }));
}

function syncSettingsUI() {
  document.getElementById('dark-mode-toggle').checked    = darkMode;
  document.getElementById('contrast-toggle').checked     = highContrast;
  document.getElementById('hard-mode-toggle').checked    = hardMode;
}

function applyTheme() {
  document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
  const iconDark  = document.getElementById('theme-icon-dark');
  const iconLight = document.getElementById('theme-icon-light');
  if (darkMode) {
    iconDark.style.display  = '';
    iconLight.style.display = 'none';
  } else {
    iconDark.style.display  = 'none';
    iconLight.style.display = '';
  }
}

function applyContrast() {
  document.documentElement.dataset.contrast = highContrast ? 'true' : 'false';
}

function applySettings() {
  applyTheme();
  applyContrast();
}

/* ===================================================
   STATE PERSISTENCE (today's game)
   =================================================== */
function saveState() {
  const today = todayString();
  const tiles = [];
  for (let r = 0; r < MAX_GUESSES; r++) {
    const rowTiles = [];
    for (let c = 0; c < WORD_LENGTH; c++) {
      const t = getTile(r, c);
      rowTiles.push({ letter: t.textContent, state: t.dataset.state || '' });
    }
    tiles.push(rowTiles);
  }

  const keyStates = {};
  document.querySelectorAll('.key[data-key]').forEach(k => {
    keyStates[k.dataset.key] = k.dataset.state || '';
  });

  localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify({
    date: today, currentRow, currentCol, gameOver,
    currentGuess, hardConstraints, revealedLetters,
    tiles, keyStates
  }));
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY_STATE);
  if (!raw) return;

  let state;
  try { state = JSON.parse(raw); } catch { return; }
  if (state.date !== todayString()) return; // Old state from a previous day

  // Restore tile content & states
  state.tiles.forEach((rowTiles, r) => {
    rowTiles.forEach((td, c) => {
      const tile = getTile(r, c);
      tile.textContent = td.letter;
      if (td.state) tile.dataset.state = td.state;
    });
  });

  // Restore key states
  if (state.keyStates) {
    Object.entries(state.keyStates).forEach(([key, s]) => {
      const keyEl = document.querySelector(`.key[data-key="${key}"]`);
      if (keyEl && s) keyEl.dataset.state = s;
    });
  }

  currentRow        = state.currentRow || 0;
  currentCol        = state.currentCol || 0;
  gameOver          = state.gameOver   || false;
  currentGuess      = state.currentGuess || [];
  hardConstraints   = state.hardConstraints || { exactPositions: {}, mustContain: [] };
  revealedLetters   = state.revealedLetters || {};
}

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/* ===================================================
   STAT PERSISTENCE
   =================================================== */
function loadStats() {
  const raw = localStorage.getItem(STORAGE_KEY_STATS);
  if (raw) {
    try {
      const s = JSON.parse(raw);
      stats = { ...stats, ...s };
    } catch { /* ignore */ }
  }
}

function saveStats() {
  localStorage.setItem(STORAGE_KEY_STATS, JSON.stringify(stats));
}

/* ===================================================
   START
   =================================================== */
document.addEventListener('DOMContentLoaded', init);
