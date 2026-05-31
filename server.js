const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

// ─── Firebase 초기화 ───────────────────────────────────────
let db;
try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require('./firebase-key.json');
  }
  const databaseURL = process.env.FIREBASE_DATABASE_URL ||
    `https://${serviceAccount.project_id}-default-rtdb.asia-southeast1.firebasedatabase.app`;

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL
  });
  db = admin.database();
  console.log('Firebase connected');
} catch (e) {
  console.warn('Firebase not available:', e.message);
  db = null;
}

async function saveRoom(roomId, data) {
  if (!db) return;
  try {
    await db.ref(`rooms/${roomId}`).set({
      players: data.players,
      phase: data.phase,
      createdAt: Date.now()
    });
  } catch (e) { console.warn('Firebase save error:', e.message); }
}

async function deleteRoom(roomId) {
  if (!db) return;
  try { await db.ref(`rooms/${roomId}`).remove(); }
  catch (e) { console.warn('Firebase delete error:', e.message); }
}

async function loadRoom(roomId) {
  if (!db) return null;
  try {
    const snap = await db.ref(`rooms/${roomId}`).once('value');
    return snap.val();
  } catch (e) { return null; }
}

// 오래된 방 정리 (1시간 이상된 방)
async function cleanOldRooms() {
  if (!db) return;
  try {
    const snap = await db.ref('rooms').once('value');
    const allRooms = snap.val();
    if (!allRooms) return;
    const now = Date.now();
    for (const [id, room] of Object.entries(allRooms)) {
      if (now - room.createdAt > 60 * 60 * 1000) {
        await db.ref(`rooms/${id}`).remove();
      }
    }
  } catch (e) {}
}
setInterval(cleanOldRooms, 30 * 60 * 1000);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['polling', 'websocket']
});

app.use(express.static(path.join(__dirname, 'public')));

const STROKES_PER_PLAYER = 3; // 1인당 획 수

const WORD_PAIRS = {
  '동물': [
    ['강아지', '고양이'], ['호랑이', '사자'], ['코끼리', '하마'],
    ['토끼', '햄스터'], ['독수리', '매'], ['상어', '돌고래'],
    ['펭귄', '북극곰'], ['기린', '낙타']
  ],
  '음식': [
    ['피자', '햄버거'], ['김치찌개', '된장찌개'], ['초밥', '회'],
    ['아이스크림', '빙수'], ['라면', '우동'], ['케이크', '쿠키'],
    ['치킨', '삼겹살'], ['커피', '녹차']
  ],
  '사물': [
    ['자전거', '킥보드'], ['우산', '선풍기'], ['안경', '렌즈'],
    ['시계', '달력'], ['가방', '지갑'], ['칫솔', '빗'],
    ['전화기', '태블릿'], ['책상', '의자']
  ],
  '장소': [
    ['학교', '도서관'], ['병원', '약국'], ['공항', '기차역'],
    ['놀이공원', '동물원'], ['카페', '레스토랑'], ['산', '바다'],
    ['영화관', '공연장'], ['마트', '편의점']
  ],
  '스포츠': [
    ['축구', '농구'], ['야구', '소프트볼'], ['수영', '다이빙'],
    ['테니스', '배드민턴'], ['볼링', '당구'], ['스키', '스노보드']
  ]
};

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function pickWordPair() {
  const categories = Object.keys(WORD_PAIRS);
  const cat = categories[Math.floor(Math.random() * categories.length)];
  const pairs = WORD_PAIRS[cat];
  const pair = pairs[Math.floor(Math.random() * pairs.length)];
  return Math.random() < 0.5 ? pair : [pair[1], pair[0]];
}

function clearTimer(roomId) {
  if (rooms[roomId]?.roundTimer) {
    clearInterval(rooms[roomId].roundTimer);
    rooms[roomId].roundTimer = null;
  }
}

function startTurnTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  clearTimer(roomId);
  let sec = 20;
  io.to(roomId).emit('timer_update', { seconds: sec });
  room.roundTimer = setInterval(() => {
    sec--;
    io.to(roomId).emit('timer_update', { seconds: sec });
    if (sec <= 0) {
      clearTimer(roomId);
      advanceTurn(roomId);
    }
  }, 1000);
}

function getTotalStrokes(room) {
  return room.players.length * STROKES_PER_PLAYER;
}

function advanceTurn(roomId) {
  const room = rooms[roomId];
  if (!room || room.phase !== 'playing') return;

  room.strokeCount = (room.strokeCount || 0) + 1;
  const totalNeeded = getTotalStrokes(room);

  // 1인당 3획 다 채웠으면 자동 투표
  if (room.strokeCount >= totalNeeded) {
    triggerVote(roomId);
    return;
  }

  room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
  const currentPlayerId = room.turnOrder[room.currentTurnIndex];
  io.to(roomId).emit('turn_changed', {
    currentPlayerId,
    currentTurnIndex: room.currentTurnIndex,
    strokeCount: room.strokeCount,
    totalStrokes: totalNeeded
  });
  startTurnTimer(roomId);
}

function triggerVote(roomId) {
  const room = rooms[roomId];
  if (!room || room.phase !== 'playing') return;
  clearTimer(roomId);
  room.phase = 'voting';
  room.votes = {};

  let sec = 60;
  io.to(roomId).emit('vote_started', { players: room.players, seconds: sec });
  room.roundTimer = setInterval(() => {
    sec--;
    io.to(roomId).emit('vote_timer', { seconds: sec });
    if (sec <= 0) {
      clearTimer(roomId);
      resolveVotes(roomId);
    }
  }, 1000);
}

io.on('connection', (socket) => {

  socket.on('create_room', async ({ name }) => {
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    rooms[code] = {
      players: [{ id: socket.id, name, isHost: true }],
      phase: 'waiting',
      citizenWord: null, mafiaWord: null, mafiaId: null,
      turnOrder: [], currentTurnIndex: 0,
      strokeCount: 0,
      strokes: [],
      votes: {},
      roundTimer: null,
      pendingRemovals: {}
    };

    await saveRoom(code, rooms[code]);

    socket.join(code);
    socket.roomId = code;
    socket.emit('room_created', { roomId: code, playerId: socket.id, players: rooms[code].players });
  });

  socket.on('join_room', async ({ roomId, name }) => {
    let room = rooms[roomId];

    // 메모리에 없으면 Firebase에서 복원
    if (!room) {
      const saved = await loadRoom(roomId);
      if (!saved) return socket.emit('error', { message: '존재하지 않는 방 코드입니다.' });
      if (saved.phase !== 'waiting') return socket.emit('error', { message: '이미 게임이 시작된 방입니다.' });

      // 방 복원 (플레이어 목록은 유지, 소켓 연결은 새로 시작)
      rooms[roomId] = {
        players: saved.players.map((p, i) => ({ ...p, id: i === 0 ? socket.id : `offline_${i}`, isHost: i === 0 })),
        phase: 'waiting',
        citizenWord: null, mafiaWord: null, mafiaId: null,
        turnOrder: [], currentTurnIndex: 0,
        strokeCount: 0, strokes: [], votes: {},
        roundTimer: null
      };
      room = rooms[roomId];
    }

    if (room.phase !== 'waiting') return socket.emit('error', { message: '이미 게임이 시작된 방입니다.' });
    if (room.players.length >= 8) return socket.emit('error', { message: '방이 가득 찼습니다. (최대 8명)' });

    room.players.push({ id: socket.id, name, isHost: false });
    await saveRoom(roomId, room);

    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit('room_joined', { roomId, playerId: socket.id, players: room.players });
    socket.to(roomId).emit('player_joined', { players: room.players });
  });

  socket.on('start_game', () => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    if (room.players.length < 3) return socket.emit('error', { message: '최소 3명이 필요합니다.' });

    const [citizenWord, mafiaWord] = pickWordPair();
    const mafiaIndex = Math.floor(Math.random() * room.players.length);
    const mafiaId = room.players[mafiaIndex].id;

    room.citizenWord = citizenWord;
    room.mafiaWord = mafiaWord;
    room.mafiaId = mafiaId;
    room.phase = 'playing';
    room.strokes = [];
    room.votes = {};
    room.strokeCount = 0;
    room.turnOrder = room.players.map(p => p.id);
    room.currentTurnIndex = 0;

    const totalStrokes = getTotalStrokes(room);

    room.players.forEach(p => {
      const word = p.id === mafiaId ? mafiaWord : citizenWord;
      io.to(p.id).emit('game_started', {
        word,
        isMafia: p.id === mafiaId,
        turnOrder: room.turnOrder,
        currentPlayerId: room.turnOrder[0],
        players: room.players,
        strokeCount: 0,
        totalStrokes
      });
    });

    startTurnTimer(roomId);
  });

  socket.on('draw_stroke', ({ points, color, size }) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || room.phase !== 'playing') return;
    if (room.turnOrder[room.currentTurnIndex] !== socket.id) return;

    const stroke = { points, color, size, playerId: socket.id };
    room.strokes.push(stroke);
    socket.to(roomId).emit('stroke_drawn', stroke);

    clearTimer(roomId);
    advanceTurn(roomId);
  });

  // 방장 조기 투표
  socket.on('start_vote', () => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    triggerVote(roomId);
  });

  socket.on('cast_vote', ({ targetId }) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || room.phase !== 'voting') return;

    room.votes[socket.id] = targetId;
    const voteCount = countVotes(room);
    io.to(roomId).emit('vote_updated', { voteCount });

    if (Object.keys(room.votes).length >= room.players.length) {
      clearTimer(roomId);
      resolveVotes(roomId);
    }
  });

  // 채팅
  socket.on('chat_message', ({ message }) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const msg = message.trim().slice(0, 100);
    if (!msg) return;
    io.to(roomId).emit('chat_message', {
      playerId: socket.id,
      name: player.name,
      message: msg
    });
  });

  // 재연결: 끊겼던 플레이어가 같은 방으로 복귀
  socket.on('rejoin_room', async ({ roomId, name, oldPlayerId }) => {
    let room = rooms[roomId];

    // 메모리에 없으면 Firebase에서 복원 시도
    if (!room) {
      const saved = await loadRoom(roomId);
      if (!saved) return socket.emit('rejoin_failed', {});
      // 대기 상태만 복원 가능 (게임 중 상태는 메모리에만 있음)
      rooms[roomId] = {
        players: saved.players,
        phase: saved.phase,
        citizenWord: null, mafiaWord: null, mafiaId: null,
        turnOrder: [], currentTurnIndex: 0,
        strokeCount: 0, strokes: [], votes: {},
        roundTimer: null, pendingRemovals: {}
      };
      room = rooms[roomId];
    }

    // 끊긴 자리(유예 중)가 있으면 그걸로 복구
    const pending = room.pendingRemovals && room.pendingRemovals[oldPlayerId];
    if (pending) {
      clearTimeout(pending.timer);
      delete room.pendingRemovals[oldPlayerId];
    }

    // 기존 플레이어 객체 찾기 (oldPlayerId 기준)
    let player = room.players.find(p => p.id === oldPlayerId);
    if (player) {
      // socket id 갱신
      player.id = socket.id;
    } else {
      // 못 찾으면 새로 추가 (대기 중일 때만)
      if (room.phase !== 'waiting' && room.players.length >= 8) {
        return socket.emit('rejoin_failed', {});
      }
      player = { id: socket.id, name, isHost: room.players.length === 0 };
      room.players.push(player);
    }

    // turnOrder에서도 id 갱신
    if (room.turnOrder && oldPlayerId) {
      const idx = room.turnOrder.indexOf(oldPlayerId);
      if (idx !== -1) room.turnOrder[idx] = socket.id;
    }
    if (room.mafiaId === oldPlayerId) room.mafiaId = socket.id;

    socket.join(roomId);
    socket.roomId = roomId;

    const totalStrokes = getTotalStrokes(room);
    const currentPlayerId = room.turnOrder[room.currentTurnIndex];

    socket.emit('rejoin_success', {
      roomId,
      playerId: socket.id,
      players: room.players,
      phase: room.phase,
      word: player.id === room.mafiaId ? room.mafiaWord : room.citizenWord,
      isMafia: player.id === room.mafiaId,
      turnOrder: room.turnOrder,
      currentPlayerId,
      strokes: room.strokes,
      strokeCount: room.strokeCount,
      totalStrokes
    });

    // 다른 사람들에게 갱신된 플레이어 목록 알림
    io.to(roomId).emit('player_joined', { players: room.players });
    await saveRoom(roomId, room);
  });

  socket.on('disconnect', async () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    // 바로 지우지 않고 15초 유예 — 그 안에 재연결하면 복구
    if (!room.pendingRemovals) room.pendingRemovals = {};
    const leavingId = socket.id;

    const timer = setTimeout(async () => {
      // 유예 시간 안에 안 돌아왔으면 진짜 제거
      if (!rooms[roomId]) return;
      const r = rooms[roomId];
      r.players = r.players.filter(p => p.id !== leavingId);
      delete r.pendingRemovals[leavingId];

      if (r.players.length === 0) {
        clearTimer(roomId);
        delete rooms[roomId];
        await deleteRoom(roomId);
        return;
      }
      if (!r.players.find(p => p.isHost)) {
        r.players[0].isHost = true;
      }
      await saveRoom(roomId, r);
      io.to(roomId).emit('player_left', { players: r.players, leftId: leavingId });
    }, 15000);

    room.pendingRemovals[leavingId] = { timer, name: socket.id };
  });
});

function countVotes(room) {
  const count = {};
  room.players.forEach(p => { count[p.id] = 0; });
  Object.values(room.votes).forEach(targetId => {
    if (count[targetId] !== undefined) count[targetId]++;
  });
  return count;
}

function resolveVotes(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const voteCount = countVotes(room);
  let maxVotes = 0;
  let eliminated = null;
  let isTie = false;

  Object.entries(voteCount).forEach(([id, cnt]) => {
    if (cnt > maxVotes) {
      maxVotes = cnt;
      eliminated = id;
      isTie = false;
    } else if (cnt === maxVotes && maxVotes > 0) {
      isTie = true;
    }
  });

  if (isTie) eliminated = null;

  const mafiaFound = !isTie && eliminated === room.mafiaId;
  room.phase = 'result';

  io.to(roomId).emit('game_result', {
    mafiaFound,
    isTie,
    mafiaId: room.mafiaId,
    eliminatedId: eliminated,
    citizenWord: room.citizenWord,
    mafiaWord: room.mafiaWord,
    voteCount,
    players: room.players
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`DrawMafia server running on http://localhost:${PORT}`));
