/* ===================================================
   MULTIPLAYER – Firebase Realtime Database

   SETUP (required before multiplayer works):
   1. Go to https://console.firebase.google.com/
   2. Create a project → Add a web app → copy the config
   3. Enable "Realtime Database" in Build → Realtime Database
      and set rules to allow read/write (for testing use open rules;
      for production lock them down appropriately).
   4. Replace the placeholder values below with your own config.
   =================================================== */

// Firebase config is loaded from config.js (excluded from version control).
// See config.example.js for the required shape.
const firebaseConfig = window.firebaseConfig;

/* ===================================================
   MP STATE
   =================================================== */
let mpActive       = false;   // currently in a multiplayer session
let mpPartyCode    = '';
let mpPlayerId     = '';
let mpPlayerName   = '';
let mpIsHost       = false;
let mpGameMode     = 'classic'; // 'classic' | 'custom'
let mpPartyRef     = null;    // Firebase ref for this party
let mpListeners    = [];      // cleanup fns for all on() listeners
let mpLocalGuesses = [];      // [{word, result}] for this player this round
let mpDone         = false;   // this player finished the round
let mpIsWordSetter = false;   // custom-mode: this player chose the word this round
let db             = null;

/* ===================================================
   FIREBASE INIT
   =================================================== */
function initFirebase() {
  if (db) return true;
  try {
    if (!firebase.apps || !firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    db = firebase.database();
    return true;
  } catch (e) {
    console.error('Firebase init failed:', e);
    return false;
  }
}

/* ===================================================
   PLAYER ID  (persisted for the browser session)
   =================================================== */
function getOrCreatePlayerId() {
  let id = sessionStorage.getItem('mp_player_id');
  if (!id) {
    id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    sessionStorage.setItem('mp_player_id', id);
  }
  return id;
}

function generatePartyCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/* ===================================================
   OPEN MULTIPLAYER MENU
   =================================================== */
function openMpMenu() {
  if (!initFirebase()) {
    showToast('Firebase not configured — see multiplayer.js for setup instructions.');
    return;
  }
  // Pre-fill name if returning player
  const savedName = localStorage.getItem('mp_player_name');
  if (savedName) document.getElementById('mp-name-input').value = savedName;
  openModal('mp-join-modal');
}

/* ===================================================
   CREATE PARTY
   =================================================== */
async function createParty() {
  const name = document.getElementById('mp-name-input').value.trim();
  if (!name) { showToast('Enter your name'); return; }

  mpPlayerName = name;
  mpPlayerId   = getOrCreatePlayerId();
  mpIsHost     = true;
  mpPartyCode  = generatePartyCode();
  localStorage.setItem('mp_player_name', name);

  const partyData = {
    host:            mpPlayerId,
    status:          'lobby',
    gameMode:        'classic',
    round:           0,
    targetWord:      '',
    wordSetterIndex: 0,
    players: {
      [mpPlayerId]: mpPlayerObj(mpPlayerName)
    }
  };

  try {
    await db.ref(`parties/${mpPartyCode}`).set(partyData);
    mpPartyRef = db.ref(`parties/${mpPartyCode}`);
    closeModal('mp-join-modal');
    enterLobby();
  } catch (e) {
    console.error(e);
    showToast('Failed to create party');
  }
}

/* ===================================================
   JOIN PARTY
   =================================================== */
async function joinParty() {
  const name = document.getElementById('mp-name-input').value.trim();
  const code = document.getElementById('mp-code-input').value.trim().toUpperCase();

  if (!name) { showToast('Enter your name'); return; }
  if (code.length !== 6) { showToast('Enter a valid 6-character party code'); return; }

  mpPlayerName = name;
  mpPlayerId   = getOrCreatePlayerId();
  mpIsHost     = false;
  mpPartyCode  = code;
  localStorage.setItem('mp_player_name', name);

  try {
    const snap = await db.ref(`parties/${mpPartyCode}`).once('value');
    if (!snap.exists()) { showToast('Party not found'); return; }

    const party = snap.val();
    if (party.status !== 'lobby') { showToast('This game is already in progress'); return; }

    await db.ref(`parties/${mpPartyCode}/players/${mpPlayerId}`).set(mpPlayerObj(mpPlayerName));
    mpPartyRef = db.ref(`parties/${mpPartyCode}`);
    closeModal('mp-join-modal');
    enterLobby();
  } catch (e) {
    console.error(e);
    showToast('Failed to join party');
  }
}

function mpPlayerObj(name) {
  return { name, done: false, won: false, guessCount: 0, guesses: {}, isWordSetter: false };
}

/* ===================================================
   LOBBY
   =================================================== */
function enterLobby() {
  mpActive = true;
  document.getElementById('mp-lobby-code').textContent = mpPartyCode;

  // Host-only controls
  document.getElementById('mp-host-controls').style.display = mpIsHost ? '' : 'none';
  document.getElementById('mp-guest-waiting').style.display  = mpIsHost ? 'none' : '';

  openModal('mp-lobby-modal');
  listenLobby();
}

function listenLobby() {
  // Players list
  const playersRef = mpPartyRef.child('players');
  const fn1 = playersRef.on('value', snap => {
    renderLobbyPlayers(snap.val() || {});
  });
  mpListeners.push(() => playersRef.off('value', fn1));

  // Game mode sync (for non-host to see host's choice)
  const modeRef = mpPartyRef.child('gameMode');
  const fn2 = modeRef.on('value', snap => {
    const mode = snap.val();
    if (mode) {
      mpGameMode = mode;
      const el = document.getElementById(`mp-mode-${mode}`);
      if (el) el.checked = true;
    }
  });
  mpListeners.push(() => modeRef.off('value', fn2));

  // Status — transition out of lobby
  const statusRef = mpPartyRef.child('status');
  const fn3 = statusRef.on('value', snap => {
    const s = snap.val();
    if (s === 'choosing') {
      statusRef.off('value', fn3);
      closeModal('mp-lobby-modal');
      handleChoosingPhase();
    } else if (s === 'playing') {
      statusRef.off('value', fn3);
      closeModal('mp-lobby-modal');
      startMpRound();
    }
  });
  mpListeners.push(() => statusRef.off('value', fn3));
}

function renderLobbyPlayers(players) {
  const list  = document.getElementById('mp-lobby-players');
  const count = document.getElementById('mp-lobby-count');
  list.innerHTML = '';
  const arr = Object.values(players);
  arr.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.name;
    list.appendChild(li);
  });
  const n = arr.length;
  count.textContent = `${n} player${n !== 1 ? 's' : ''} in lobby`;
}

/* ===================================================
   MODE SELECT & START  (host only)
   =================================================== */
function mpSelectMode(mode) {
  mpGameMode = mode;
  if (mpPartyRef && mpIsHost) {
    mpPartyRef.update({ gameMode: mode });
  }
}

async function mpHostStart() {
  const snap = await mpPartyRef.child('players').once('value');
  const players = snap.val() || {};
  const ids     = Object.keys(players);

  if (ids.length < 2) { showToast('Need at least 2 players'); return; }

  // Reset all players
  const resets = {};
  ids.forEach(id => {
    resets[`players/${id}/done`]         = false;
    resets[`players/${id}/won`]          = false;
    resets[`players/${id}/guessCount`]   = 0;
    resets[`players/${id}/guesses`]      = {};
    resets[`players/${id}/isWordSetter`] = false;
  });
  await mpPartyRef.update(resets);

  if (mpGameMode === 'classic') {
    const word = ANSWERS[Math.floor(Math.random() * ANSWERS.length)].toUpperCase();
    await mpPartyRef.update({ status: 'playing', targetWord: word, round: firebase.database.ServerValue.increment(1) });
  } else {
    // Shuffle player order for word-setter queue
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    const wordQueue = {};
    shuffled.forEach((id, i) => { wordQueue[i] = id; });
    await mpPartyRef.update({
      status: 'choosing',
      wordQueue,
      wordSetterIndex: 0,
      targetWord: '',
      round: firebase.database.ServerValue.increment(1)
    });
  }
}

/* ===================================================
   CUSTOM MODE – CHOOSING PHASE
   =================================================== */
async function handleChoosingPhase() {
  const snap    = await mpPartyRef.once('value');
  const party   = snap.val();
  const queue   = party.wordQueue   || {};
  const idx     = party.wordSetterIndex || 0;
  const setterId = queue[idx];

  mpIsWordSetter = (mpPlayerId === setterId);

  if (mpIsWordSetter) {
    document.getElementById('mp-setter-label').textContent = 'You are choosing the secret word';
    document.getElementById('mp-word-input-section').style.display = '';
    document.getElementById('mp-word-waiting-msg').style.display   = 'none';
    document.getElementById('mp-secret-word-input').value = '';
  } else {
    const setterName = (party.players[setterId] || {}).name || 'Someone';
    document.getElementById('mp-setter-label').textContent = `${setterName} is choosing the secret word…`;
    document.getElementById('mp-word-input-section').style.display = 'none';
    document.getElementById('mp-word-waiting-msg').style.display   = '';
  }

  openModal('mp-word-modal');

  if (!mpIsWordSetter) {
    // Wait for status → 'playing'
    const statusRef = mpPartyRef.child('status');
    const fn = statusRef.on('value', snap => {
      if (snap.val() === 'playing') {
        statusRef.off('value', fn);
        closeModal('mp-word-modal');
        startMpRound();
      }
    });
    mpListeners.push(() => statusRef.off('value', fn));
  }
}

async function mpSubmitSecretWord() {
  const word = document.getElementById('mp-secret-word-input').value.trim().toUpperCase();
  if (word.length !== 5)    { showToast('Word must be 5 letters');  return; }
  if (!isValidWord(word))   { showToast('Not in word list');        return; }

  const snap = await mpPartyRef.child('players').once('value');
  const ids  = Object.keys(snap.val() || {});

  // Reset all players; mark setter as done (they watch this round)
  const resets = {};
  ids.forEach(id => {
    resets[`players/${id}/done`]         = id === mpPlayerId;
    resets[`players/${id}/won`]          = false;
    resets[`players/${id}/guessCount`]   = 0;
    resets[`players/${id}/guesses`]      = {};
    resets[`players/${id}/isWordSetter`] = id === mpPlayerId;
  });
  await mpPartyRef.update(resets);
  await mpPartyRef.update({ targetWord: word, status: 'playing' });

  closeModal('mp-word-modal');
  mpDone = true; // setter doesn't play this round
  showMpWatchingOverlay();
}

/* ===================================================
   WORD SETTER WATCHING OVERLAY
   =================================================== */
function showMpWatchingOverlay() {
  document.getElementById('mp-watching-overlay').style.display = 'flex';

  const statusRef = mpPartyRef.child('status');
  const fn = statusRef.on('value', snap => {
    if (snap.val() === 'results') {
      statusRef.off('value', fn);
      document.getElementById('mp-watching-overlay').style.display = 'none';
      showMpResults();
    }
  });
  mpListeners.push(() => statusRef.off('value', fn));
}

/* ===================================================
   START MP ROUND  (for players who guess)
   =================================================== */
async function startMpRound() {
  const snap  = await mpPartyRef.once('value');
  const party = snap.val();

  mpLocalGuesses = [];
  mpDone         = false;
  mpIsWordSetter = false;

  // Reset solo board (use practiceMode trick to avoid daily-word pick)
  practiceMode = true;
  startGame();
  practiceMode = false;

  // Override targetWord with the multiplayer word
  targetWord = party.targetWord;

  // Show banner
  renderMpBanner();

  // Start listening: host watches for all-done and triggers 'results'
  listenForRoundEnd();
}

function renderMpBanner() {
  let banner = document.getElementById('mp-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'mp-banner';
    document.querySelector('header').appendChild(banner);
  }
  const modeLabel = mpGameMode === 'classic' ? 'Classic' : 'Custom Word';
  banner.textContent = `🎮 ${mpPartyCode}  ·  ${modeLabel}`;
}

function removeMpBanner() {
  const el = document.getElementById('mp-banner');
  if (el) el.remove();
}

/* ===================================================
   ROUND END LISTENER
   =================================================== */
function listenForRoundEnd() {
  // Host: watch all players finished → write 'results' status
  if (mpIsHost) {
    const playersRef = mpPartyRef.child('players');
    const fn = playersRef.on('value', async snap => {
      const players = snap.val() || {};
      const all = Object.values(players);
      if (all.length > 0 && all.every(p => p.done)) {
        playersRef.off('value', fn);
        await mpPartyRef.update({ status: 'results' });
      }
    });
    mpListeners.push(() => playersRef.off('value', fn));
  }

  // Everyone: watch for 'results' status → show results screen
  const statusRef = mpPartyRef.child('status');
  const fn2 = statusRef.on('value', snap => {
    if (snap.val() === 'results') {
      statusRef.off('value', fn2);
      showMpResults();
    }
  });
  mpListeners.push(() => statusRef.off('value', fn2));
}

/* ===================================================
   HOOKS CALLED FROM script.js
   =================================================== */

// Called after each guess is revealed
async function mpRecordGuess(guessWord, result, rowIndex) {
  if (!mpActive || mpDone || mpIsWordSetter) return;
  mpLocalGuesses.push({ word: guessWord, result });
  await mpPartyRef.child(`players/${mpPlayerId}/guesses/${rowIndex}`).set({
    word:   guessWord,
    result: result.join(',')
  });
  await mpPartyRef.child(`players/${mpPlayerId}/guessCount`).set(mpLocalGuesses.length);
}

// Called when this player's round ends (win or lose)
async function mpMarkDone(won) {
  if (!mpActive || mpDone || mpIsWordSetter) return;
  mpDone = true;
  await mpPartyRef.child(`players/${mpPlayerId}`).update({
    done:       true,
    won,
    guessCount: mpLocalGuesses.length
  });
  showToast('Waiting for other players…', 60000);
}

// Returns true if multiplayer is active AND this player is done (to suppress solo UI)
function mpShouldSuppressSoloEnd() {
  return mpActive;
}

/* ===================================================
   RESULTS SCREEN
   =================================================== */
async function showMpResults() {
  // Clear any "waiting" toast
  document.querySelectorAll('.toast').forEach(t => t.remove());

  const snap  = await mpPartyRef.once('value');
  const party = snap.val();
  const players = party.players || {};
  const word    = party.targetWord || '';

  document.getElementById('mp-results-word').textContent = word;

  const tbody = document.getElementById('mp-results-tbody');
  tbody.innerHTML = '';

  const rows = Object.values(players)
    .sort((a, b) => {
      if (a.isWordSetter) return 1;
      if (b.isWordSetter) return -1;
      if (a.won && !b.won) return -1;
      if (!a.won && b.won)  return 1;
      return a.guessCount - b.guessCount;
    });

  rows.forEach(p => {
    const tr = document.createElement('tr');

    // Name (+ "📝 Word setter" tag for custom mode)
    const tdName = document.createElement('td');
    tdName.textContent = p.name;
    if (p.isWordSetter) {
      const tag = document.createElement('span');
      tag.classList.add('mp-tag');
      tag.textContent = 'Word setter';
      tdName.appendChild(tag);
    }

    // Guesses count
    const tdCount = document.createElement('td');
    tdCount.classList.add('mp-count-cell');
    if (p.isWordSetter) {
      tdCount.textContent = '—';
    } else {
      tdCount.textContent = p.won ? `${p.guessCount}/6` : 'X/6';
      tdCount.classList.add(p.won ? 'mp-won' : 'mp-lost');
    }

    // Guess history (mini emoji tiles)
    const tdHistory = document.createElement('td');
    tdHistory.classList.add('mp-history-cell');
    if (!p.isWordSetter) {
      const guesses = p.guesses ? Object.values(p.guesses) : [];
      guesses.forEach(g => {
        const rowDiv = document.createElement('div');
        rowDiv.classList.add('mp-mini-row');
        const resultArr = (g.result || '').split(',');
        resultArr.forEach(state => {
          const sq = document.createElement('span');
          sq.classList.add('mp-mini-tile', state);
          rowDiv.appendChild(sq);
        });
        tdHistory.appendChild(rowDiv);
      });
    }

    tr.appendChild(tdName);
    tr.appendChild(tdCount);
    tr.appendChild(tdHistory);
    tbody.appendChild(tr);
  });

  // Show play-again only for host
  document.getElementById('mp-results-host-controls').style.display = mpIsHost ? '' : 'none';
  document.getElementById('mp-results-guest-msg').style.display      = mpIsHost ? 'none' : '';

  openModal('mp-results-modal');
}

/* ===================================================
   PLAY AGAIN  (host only)
   =================================================== */
async function mpPlayAgain() {
  closeModal('mp-results-modal');

  const snap = await mpPartyRef.child('players').once('value');
  const ids  = Object.keys(snap.val() || {});

  const resets = {};
  ids.forEach(id => {
    resets[`players/${id}/done`]         = false;
    resets[`players/${id}/won`]          = false;
    resets[`players/${id}/guessCount`]   = 0;
    resets[`players/${id}/guesses`]      = {};
    resets[`players/${id}/isWordSetter`] = false;
  });
  await mpPartyRef.update(resets);

  if (mpGameMode === 'classic') {
    const word = ANSWERS[Math.floor(Math.random() * ANSWERS.length)].toUpperCase();
    await mpPartyRef.update({ status: 'playing', targetWord: word });
    startMpRound();
  } else {
    // Rotate to next setter in queue
    const partySnap  = await mpPartyRef.once('value');
    const party      = partySnap.val();
    const queueLen   = Object.keys(party.wordQueue || {}).length;
    const nextIdx    = ((party.wordSetterIndex || 0) + 1) % queueLen;
    await mpPartyRef.update({ status: 'choosing', wordSetterIndex: nextIdx, targetWord: '' });
    handleChoosingPhase();
  }
}

/* ===================================================
   RETURN TO LOBBY  (host only)
   =================================================== */
async function mpReturnToLobby() {
  closeModal('mp-results-modal');
  await mpPartyRef.update({ status: 'lobby', targetWord: '', wordQueue: {} });
  enterLobby();
}

/* ===================================================
   LEAVE PARTY
   =================================================== */
async function leaveParty() {
  if (mpPartyRef) {
    // If host, delete whole party; otherwise just remove self
    if (mpIsHost) {
      await mpPartyRef.remove();
    } else {
      await mpPartyRef.child(`players/${mpPlayerId}`).remove();
    }
  }
  cleanupMp();
  ['mp-join-modal','mp-lobby-modal','mp-word-modal','mp-results-modal'].forEach(closeModal);
  document.getElementById('mp-watching-overlay').style.display = 'none';
  removeMpBanner();
  showToast('Left party');
}

function cleanupMp() {
  mpListeners.forEach(fn => { try { fn(); } catch(e) {} });
  mpListeners    = [];
  mpActive       = false;
  mpPartyRef     = null;
  mpLocalGuesses = [];
  mpDone         = false;
  mpIsHost       = false;
  mpIsWordSetter = false;
}
