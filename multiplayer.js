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
let mpAuthReadyPromise = null;
let mpLastAuthErrorMessage = '';

/* ===================================================
   FIREBASE INIT
   =================================================== */
function initFirebase() {
  if (db) return true;
  try {
    if (!firebaseConfig || typeof firebaseConfig !== 'object') {
      throw new Error('Missing firebaseConfig (config.js not loaded)');
    }
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

async function ensureFirebaseReady() {
  mpLastAuthErrorMessage = '';
  if (!initFirebase()) return false;
  try {
    if (!firebase.auth || typeof firebase.auth !== 'function') {
      throw new Error('Firebase Auth SDK is not loaded');
    }
    const auth = firebase.auth();

    const waitForCurrentUser = (timeoutMs = 10000) => new Promise((resolve, reject) => {
      if (auth.currentUser && auth.currentUser.uid) {
        resolve(auth.currentUser);
        return;
      }
      let done = false;
      let unsub = null;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        if (typeof unsub === 'function') unsub();
        reject(new Error('Authentication state did not become ready in time'));
      }, timeoutMs);

      unsub = auth.onAuthStateChanged(user => {
        if (done) return;
        if (user && user.uid) {
          done = true;
          clearTimeout(timer);
          if (typeof unsub === 'function') unsub();
          resolve(user);
        }
      }, err => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (typeof unsub === 'function') unsub();
        reject(err || new Error('Failed to observe authentication state'));
      });
    });

    if (auth.currentUser && auth.currentUser.uid) return true;

    if (!mpAuthReadyPromise) {
      const withTimeout = (promise, ms, label) => Promise.race([
        promise,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`${label} timed out`)), ms);
        })
      ]);

      // Retry up to 3 times with back-off + timeout — helps on flaky mobile connections.
      mpAuthReadyPromise = (async () => {
        const MAX_TRIES = 3;
        let lastErr;
        for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
          try {
            await withTimeout(auth.signInAnonymously(), 12000, 'Anonymous sign-in');
            await withTimeout(waitForCurrentUser(10000), 10000, 'Auth user readiness');
            return; // success
          } catch (err) {
            lastErr = err;
            // auth/operation-not-allowed → anonymous auth is disabled in Firebase Console;
            // retrying won't help, bail immediately with a clear message.
            if (err && err.code === 'auth/operation-not-allowed') {
              throw new Error(
                'Anonymous sign-in is disabled. ' +
                'Enable it in Firebase Console → Authentication → Sign-in method → Anonymous.'
              );
            }
            if (attempt < MAX_TRIES) {
              await new Promise(r => setTimeout(r, 1200 * attempt)); // 1.2s, 2.4s back-off
            }
          }
        }
        throw lastErr;
      })().catch(err => {
        mpAuthReadyPromise = null;
        throw err;
      });
    }
    await mpAuthReadyPromise;
    if (!auth.currentUser || !auth.currentUser.uid) {
      await waitForCurrentUser(10000);
    }
    return true;
  } catch (e) {
    console.error('Firebase auth failed:', e);
    mpLastAuthErrorMessage =
      e && e.message
        ? e.message
        : 'Failed to sign in to multiplayer. Check connection and try again.';
    return false;
  }
}

// Warm up Firebase auth silently on page load so mobile users don't
// pay the cold-start cost (and auth state restoration) at button-tap time.
function warmupFirebaseAuth() {
  if (!window.firebaseConfig) return;
  try {
    ensureFirebaseReady().catch(() => {});
  } catch (_) { /* ignore */ }
}

/* ===================================================
   PLAYER ID  (persisted for the browser session)
   =================================================== */
function getOrCreatePlayerId() {
  const authUid = firebase.auth && firebase.auth().currentUser
    ? firebase.auth().currentUser.uid
    : '';
  if (authUid) return authUid;

  let id = sessionStorage.getItem('mp_player_id');
  if (!id) {
    // Use crypto.getRandomValues for a cryptographically strong ID
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    id = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem('mp_player_id', id);
  }
  return id;
}

function generatePartyCode() {
  // Use crypto.getRandomValues — Math.random() is not cryptographically secure
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous chars (no 0/O, 1/I)
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

/* ===================================================
   OPEN MULTIPLAYER MENU
   =================================================== */
async function openMpMenu() {
  if (!(await ensureFirebaseReady())) {
    showToast(mpLastAuthErrorMessage || 'Multiplayer unavailable right now. Please refresh and try again.');
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
  if (!(await ensureFirebaseReady())) {
    showToast(mpLastAuthErrorMessage || 'Failed to connect to Firebase');
    return;
  }
  const rawName = document.getElementById('mp-name-input').value.trim();
  const name = sanitizePlayerName(rawName);
  if (!name) { showToast('Enter your name'); return; }
  document.getElementById('mp-name-input').value = name; // reflect cleaned name

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
  if (!(await ensureFirebaseReady())) {
    showToast(mpLastAuthErrorMessage || 'Failed to connect to Firebase');
    return;
  }
  const rawName = document.getElementById('mp-name-input').value.trim();
  const name = sanitizePlayerName(rawName);
  const code = document.getElementById('mp-code-input').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!name) { showToast('Enter your name'); return; }
  if (code.length !== 6) { showToast('Enter a valid 6-character party code'); return; }
  document.getElementById('mp-name-input').value = name; // reflect cleaned name

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

/* Strips anything that isn't a letter, digit, space, hyphen, or apostrophe
   and collapses multiple spaces, capped at 20 chars. */
function sanitizePlayerName(raw) {
  return raw.replace(/[^A-Za-z0-9 '\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
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
    // Non-setter: wait for status → 'playing'
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

  // Host relay: if the word setter is a non-host player, the host watches for their
  // proposed word and applies the game state on their behalf (DB rules only let the
  // host write targetWord / status / other players' fields).
  if (mpIsHost && !mpIsWordSetter) {
    const setterProposedRef = mpPartyRef.child(`players/${setterId}/proposedWord`);
    const relayFn = setterProposedRef.on('value', async snap => {
      const proposed = snap.val();
      if (!proposed || !/^[A-Za-z]{5}$/.test(proposed)) return;
      setterProposedRef.off('value', relayFn);

      const pSnap = await mpPartyRef.child('players').once('value');
      const ids   = Object.keys(pSnap.val() || {});
      const resets = {};
      ids.forEach(id => {
        resets[`players/${id}/done`]         = id === setterId;
        resets[`players/${id}/won`]          = false;
        resets[`players/${id}/guessCount`]   = 0;
        resets[`players/${id}/guesses`]      = {};
        resets[`players/${id}/isWordSetter`] = id === setterId;
        resets[`players/${id}/proposedWord`] = null; // clean up relay field
      });
      await mpPartyRef.update(resets);
      await mpPartyRef.update({ targetWord: proposed.toUpperCase(), status: 'playing' });
    });
    mpListeners.push(() => setterProposedRef.off('value', relayFn));
  }
}

async function mpSubmitSecretWord() {
  if (!(await ensureFirebaseReady())) {
    showToast(mpLastAuthErrorMessage || 'Multiplayer unavailable right now');
    return;
  }

  const authUid = firebase.auth && firebase.auth().currentUser
    ? firebase.auth().currentUser.uid
    : '';
  if (!authUid) {
    showToast('Multiplayer session unavailable. Please rejoin the party.');
    return;
  }

  // Always trust Firebase auth UID as the canonical identity.
  const previousPlayerId = mpPlayerId;
  mpPlayerId = authUid;

  // Re-check current setter from the server right before submit to avoid stale local state.
  let liveSetterId = '';
  try {
    const partySnap = await mpPartyRef.once('value');
    const party = partySnap.val() || {};
    const queue = party.wordQueue || {};
    const idx = party.wordSetterIndex || 0;
    liveSetterId = queue[idx] || '';
    mpIsWordSetter = (mpPlayerId === liveSetterId);
  } catch (e) {
    console.error('Failed to refresh chooser state:', e);
    showToast('Failed to validate chooser state. Please try again.');
    return;
  }

  if (!mpIsWordSetter) {
    if (previousPlayerId && previousPlayerId !== mpPlayerId && previousPlayerId === liveSetterId) {
      showToast('Session changed on this device. Rejoin the party to submit the word.');
      return;
    }
    showToast('Waiting for the selected player to submit the word');
    return;
  }

  const word = document.getElementById('mp-secret-word-input').value.trim().toUpperCase();
  if (word.length !== 5)      { showToast('Word must be exactly 5 letters'); return; }
  if (!/^[A-Z]+$/.test(word)) { showToast('Word must contain only letters'); return; }

  if (mpIsHost) {
    // Host can write game state directly
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
  } else {
    // Non-host setter: write only to own player record.
    // The host relay listener in handleChoosingPhase() picks this up and applies
    // targetWord + status changes using its host privileges.
    try {
      await mpPartyRef.child(`players/${authUid}/proposedWord`).set(word);
    } catch (e) {
      console.error('Failed to propose word:', e);
      if (e && (e.code === 'PERMISSION_DENIED' || e.code === 'permission-denied')) {
        showToast('Submission denied. Your phone session changed — rejoin the party and try again.');
      } else {
        showToast('Failed to submit word. Please try again.');
      }
      return;
    }

    // Switch modal to waiting state
    document.getElementById('mp-word-input-section').style.display = 'none';
    document.getElementById('mp-word-waiting-msg').style.display   = '';
    document.getElementById('mp-setter-label').textContent         = 'Word submitted! Starting round…';

    mpDone = true; // setter watches, doesn't guess

    // When host applies the state the status becomes 'playing' → switch to spectator view
    const statusRef = mpPartyRef.child('status');
    const fn = statusRef.on('value', snap => {
      if (snap.val() === 'playing') {
        statusRef.off('value', fn);
        closeModal('mp-word-modal');
        showMpWatchingOverlay();
      }
    });
    mpListeners.push(() => statusRef.off('value', fn));
  }
}

/* ===================================================
   WORD SETTER WATCHING OVERLAY  (spectator)
   =================================================== */
function showMpWatchingOverlay() {
  document.getElementById('mp-watching-overlay').classList.add('visible');

  // Show spectator live boards (word setter sees letters + live typing)
  startLiveBoardsListener(true);

  // BUG FIX: if this player is the host AND the word setter, nobody else would
  // be watching for all-done → write 'results'. Do it here.
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

  const statusRef = mpPartyRef.child('status');
  const fn = statusRef.on('value', snap => {
    if (snap.val() === 'results') {
      statusRef.off('value', fn);
      document.getElementById('mp-watching-overlay').classList.remove('visible');
      removeLiveBoards();
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

  // Start live mini-boards for all players (colors only, no letters)
  startLiveBoardsListener(false);

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
  // Clear any "waiting" toast and live boards
  document.querySelectorAll('.toast').forEach(t => t.remove());
  removeLiveBoards();

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
        const VALID_STATES = new Set(['correct', 'present', 'absent']);
        const resultArr = (g.result || '').split(',');
        resultArr.forEach(rawState => {
          const state = VALID_STATES.has(rawState) ? rawState : 'absent'; // reject unknown values
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

  // BUG FIX: all clients (including guests) listen for the host to kick off the
  // next round.  This is what makes Play Again / Return to Lobby work for guests.
  if (!mpPartyRef) return;
  const statusRef = mpPartyRef.child('status');
  const nextRoundFn = statusRef.on('value', snap => {
    const s = snap.val();
    if (s === 'playing') {
      statusRef.off('value', nextRoundFn);
      document.querySelectorAll('.toast').forEach(t => t.remove());
      closeModal('mp-results-modal');
      startMpRound();
    } else if (s === 'choosing') {
      statusRef.off('value', nextRoundFn);
      document.querySelectorAll('.toast').forEach(t => t.remove());
      closeModal('mp-results-modal');
      handleChoosingPhase();
    } else if (s === 'lobby') {
      statusRef.off('value', nextRoundFn);
      document.querySelectorAll('.toast').forEach(t => t.remove());
      closeModal('mp-results-modal');
      enterLobby();
    }
    // 'results' → ignore (already here)
  });
  mpListeners.push(() => statusRef.off('value', nextRoundFn));
}

/* ===================================================
   PLAY AGAIN  (host only)
   =================================================== */
async function mpPlayAgain() {
  // Don't close the modal here — the shared status listener in showMpResults()
  // will close it + navigate for ALL clients (including this host) once status changes.
  const snap = await mpPartyRef.child('players').once('value');
  const ids  = Object.keys(snap.val() || {});

  const resets = {};
  ids.forEach(id => {
    resets[`players/${id}/done`]         = false;
    resets[`players/${id}/won`]          = false;
    resets[`players/${id}/guessCount`]   = 0;
    resets[`players/${id}/guesses`]      = {};
    resets[`players/${id}/isWordSetter`] = false;
    resets[`players/${id}/typing`]       = '';
  });
  await mpPartyRef.update(resets);

  if (mpGameMode === 'classic') {
    const word = ANSWERS[Math.floor(Math.random() * ANSWERS.length)].toUpperCase();
    // Status change triggers the shared listener → all clients call startMpRound()
    await mpPartyRef.update({ status: 'playing', targetWord: word, round: firebase.database.ServerValue.increment(1) });
  } else {
    // Rotate to next setter
    const partySnap = await mpPartyRef.once('value');
    const party     = partySnap.val();
    const queueLen  = Object.keys(party.wordQueue || {}).length;
    const nextIdx   = ((party.wordSetterIndex || 0) + 1) % queueLen;
    // Status change triggers the shared listener → all clients call handleChoosingPhase()
    await mpPartyRef.update({ status: 'choosing', wordSetterIndex: nextIdx, targetWord: '', round: firebase.database.ServerValue.increment(1) });
  }
}

/* ===================================================
   RETURN TO LOBBY  (host only)
   =================================================== */
async function mpReturnToLobby() {
  // Status change triggers the shared listener → all clients call enterLobby()
  await mpPartyRef.update({ status: 'lobby', targetWord: '', wordQueue: {} });
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
  document.getElementById('mp-watching-overlay').classList.remove('visible');
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
  removeLiveBoards();
}

/* ===================================================
   LIVE TYPING SYNC
   =================================================== */
async function mpSyncTyping(letters) {
  if (!mpActive || mpDone || mpIsWordSetter || !mpPartyRef) return;
  try {
    await mpPartyRef.child(`players/${mpPlayerId}/typing`).set(letters.join(''));
  } catch (e) { /* non-critical */ }
}

async function mpClearTyping() {
  if (!mpActive || !mpPartyRef) return;
  try {
    await mpPartyRef.child(`players/${mpPlayerId}/typing`).set('');
  } catch (e) { /* non-critical */ }
}

/* ===================================================
   LIVE MINI-BOARDS
   spectatorMode=true  → word setter view (shows letters + live typing)
   spectatorMode=false → other players view (colors only)
   =================================================== */
function startLiveBoardsListener(spectatorMode) {
  const container = spectatorMode
    ? document.getElementById('mp-spectator-boards')
    : document.getElementById('mp-live-boards');
  if (!container) return;

  container.style.display = '';

  const playersRef = mpPartyRef.child('players');
  const fn = playersRef.on('value', snap => {
    renderLiveBoards(snap.val() || {}, spectatorMode, container);
  });
  mpListeners.push(() => {
    playersRef.off('value', fn);
    if (container) container.style.display = 'none';
  });
}

function renderLiveBoards(players, spectatorMode, container) {
  if (!container) return;
  container.innerHTML = '';

  const VALID_STATES = new Set(['correct', 'present', 'absent']);

  Object.entries(players).forEach(([id, player]) => {
    // In standard view, skip yourself; in spectator view show everyone else
    if (!spectatorMode && id === mpPlayerId) return;
    if (spectatorMode && id === mpPlayerId) return; // setter doesn't show themselves

    const card = document.createElement('div');
    card.classList.add('mp-live-card');

    // Player name + status badge
    const nameEl = document.createElement('div');
    nameEl.classList.add('mp-live-name');
    nameEl.textContent = player.name;
    if (player.done) {
      nameEl.classList.add(player.won ? 'mp-live-won' : 'mp-live-lost');
    }
    card.appendChild(nameEl);

    // Mini board grid
    const boardEl = document.createElement('div');
    boardEl.classList.add('mp-live-board');

    // Sort guesses by row index
    const guessEntries = Object.entries(player.guesses || {}).sort((a,b) => +a[0] - +b[0]);
    const guessCount = guessEntries.length;

    for (let r = 0; r < MAX_GUESSES; r++) {
      const rowEl = document.createElement('div');
      rowEl.classList.add('mp-live-row');

      if (r < guessCount) {
        // Submitted row — always show colored tiles
        const g = guessEntries[r][1];
        const resultArr = (g.result || '').split(',');
        const wordArr   = (g.word   || '').split('');
        for (let c = 0; c < WORD_LENGTH; c++) {
          const rawState = resultArr[c] || 'absent';
          const state = VALID_STATES.has(rawState) ? rawState : 'absent';
          const tile  = document.createElement('div');
          tile.classList.add('mp-live-tile', state);
          // Spectator sees real letters on submitted rows
          if (spectatorMode && wordArr[c]) tile.textContent = wordArr[c];
          rowEl.appendChild(tile);
        }
      } else if (r === guessCount && !player.done) {
        // Active row — spectator sees live typing; regular players see blank
        const typing = (player.typing || '');
        for (let c = 0; c < WORD_LENGTH; c++) {
          const tile = document.createElement('div');
          tile.classList.add('mp-live-tile');
          if (spectatorMode && typing[c]) {
            tile.textContent = typing[c];
            tile.classList.add('typing');
          } else if (typing[c]) {
            // Show a faint filled indicator but no letter
            tile.classList.add('typing-hidden');
          }
          rowEl.appendChild(tile);
        }
      } else {
        // Empty future rows
        for (let c = 0; c < WORD_LENGTH; c++) {
          const tile = document.createElement('div');
          tile.classList.add('mp-live-tile');
          rowEl.appendChild(tile);
        }
      }

      boardEl.appendChild(rowEl);
    }

    card.appendChild(boardEl);
    container.appendChild(card);
  });
}

function removeLiveBoards() {
  const a = document.getElementById('mp-live-boards');
  const b = document.getElementById('mp-spectator-boards');
  if (a) { a.innerHTML = ''; a.style.display = 'none'; }
  if (b) { b.innerHTML = ''; }
}
