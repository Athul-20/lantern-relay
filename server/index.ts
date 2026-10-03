import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Socket } from 'node:net';
import { simulate } from '../src/game/simulate.ts';
import { PLAYER_COLORS, type Color, type Level } from '../src/game/levels.ts';
import { buildRoomLevel } from '../src/game/roomLevels.ts';
import { BONUS_TIMER_MS, mirrorTurnPar, starsForTurns } from '../src/game/scoring.ts';

type Player = { id: string; token: string; name: string; color: Color; seat: number; connected: boolean; host: boolean; leftAt?: number; expired?: boolean };
type Room = {
  code: string; players: Player[]; nextSeat: number; started: boolean; levelIndex: number; level: Level | null;
  mirrors: boolean[]; paused: boolean; gameFinished: boolean; solution: ReturnType<typeof simulate> | null;
  lastAction: { seat: number; mirrorIndex: number; at: number } | null; completionId: number; emptyAt: number | null;
  mirrorTurns: number; bonusTimerEndsAt: number | null; stars: number; bonusEarned: boolean;
};
type ClientMeta = { code: string; playerId: string };
type TextHandler = (text: string) => void;
type CloseHandler = () => void;
const OPEN = 1;

// Small RFC 6455 text-frame endpoint, kept dependency-free for the local play-test server.
class Peer {
  readyState = OPEN;
  private input = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private closeNotified = false;
  private textHandler: TextHandler = () => {};
  private closeHandler: CloseHandler = () => {};
  private socket: Socket;
  constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', chunk => { this.input = Buffer.concat([this.input, chunk]); this.readFrames(); });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }
  onMessage(handler: TextHandler) { this.textHandler = handler; }
  onClose(handler: CloseHandler) { this.closeHandler = handler; }
  send(text: string) { if (this.readyState === OPEN) this.writeFrame(1, Buffer.from(text)); }
  close(code = 1000, reason = '') {
    if (this.readyState !== OPEN) return;
    const text = Buffer.from(reason), body = Buffer.alloc(2 + Math.min(text.length, 120));
    body.writeUInt16BE(code, 0); text.copy(body, 2, 0, body.length - 2);
    this.writeFrame(8, body); this.readyState = 3; this.socket.end(); this.finish();
  }
  private finish() { if (this.closeNotified) return; this.readyState = 3; this.closeNotified = true; this.closeHandler(); }
  private writeFrame(opcode: number, body: Buffer) {
    let header: Buffer;
    if (body.length < 126) { header = Buffer.from([0x80 | opcode, body.length]); }
    else if (body.length <= 65535) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(body.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
    this.socket.write(Buffer.concat([header, body]));
  }
  private readFrames() {
    while (this.input.length >= 2 && this.readyState === OPEN) {
      const first = this.input[0], second = this.input[1], fin = (first & 0x80) !== 0, opcode = first & 0x0f, masked = (second & 0x80) !== 0;
      let length = second & 0x7f, offset = 2;
      if (length === 126) { if (this.input.length < 4) return; length = this.input.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.input.length < 10) return; const big = this.input.readBigUInt64BE(2); if (big > 1_000_000n) return this.close(1009, 'Message too large'); length = Number(big); offset = 10; }
      const maskBytes = masked ? 4 : 0;
      if (length > 1_000_000) return this.close(1009, 'Message too large');
      if (this.input.length < offset + maskBytes + length) return;
      const mask = masked ? this.input.subarray(offset, offset + 4) : null; offset += maskBytes;
      const payload = Buffer.from(this.input.subarray(offset, offset + length));
      this.input = this.input.subarray(offset + length);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 8) { this.close(); return; }
      if (opcode === 9) { this.writeFrame(10, payload); continue; }
      if (opcode === 10) continue;
      if (opcode === 1 && !fin) { this.fragmentOpcode = opcode; this.fragments = [payload]; continue; }
      if (opcode === 0 && this.fragmentOpcode) { this.fragments.push(payload); if (fin) { const body = Buffer.concat(this.fragments); this.fragments = []; this.fragmentOpcode = 0; this.textHandler(body.toString('utf8')); } continue; }
      if (opcode === 1 && fin) this.textHandler(payload.toString('utf8'));
    }
  }
}
const here = fileURLToPath(new URL('.', import.meta.url));
const distDir = resolve(here, '../dist');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const codeColor = (seat: number) => PLAYER_COLORS[seat];
const rooms = new Map<string, Room>();
const clients = new Map<Peer, ClientMeta>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function codeForRoom() {
  let code = '';
  do { code = Array.from(randomBytes(4), b => alphabet[b % alphabet.length]).join(''); } while (rooms.has(code));
  return code;
}
function safeName(value: unknown) {
  const name = String(value ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18);
  return name || 'Player';
}
function uniqueName(room: Room, requested: string) {
  const taken = new Set(room.players.map(p => p.name.toLocaleLowerCase()));
  if (!taken.has(requested.toLocaleLowerCase())) return requested;
  let suffix = 2, candidate = '';
  do { candidate = `${requested.slice(0, 14)} (${suffix++})`; } while (taken.has(candidate.toLocaleLowerCase()));
  return candidate;
}
function roomView(room: Room) {
  const sim = room.solution;
  return {
    code: room.code, players: room.players.map(({ id, name, color, seat, connected, host, expired }) => ({ id, name, color, seat, connected, host, expired: Boolean(expired) })),
    started: room.started, levelIndex: room.levelIndex, level: room.level, mirrors: room.mirrors,
    paused: room.paused, gameFinished: room.gameFinished, solved: Boolean(sim?.solved),
    segments: sim?.segments ?? [], lanternMasks: Object.fromEntries(sim?.lanternMasks ?? []),
    mixedCells: sim?.mixedCells ?? [],
    lastAction: room.lastAction, completionId: room.completionId,
    mirrorTurns: room.mirrorTurns, bonusTimerEndsAt: room.bonusTimerEndsAt, stars: room.stars, bonusEarned: room.bonusEarned,
    expiredPlayers: room.players.filter(p => p.expired && !p.connected).map(p => ({ id: p.id, name: p.name }))
  };
}
function send(ws: Peer, data: unknown) {
  if (ws.readyState === OPEN) ws.send(JSON.stringify(data));
}
function sendRoom(room: Room, event?: { type: string; [key: string]: unknown }) {
  const view = roomView(room);
  for (const [socket, meta] of clients) {
    if (meta.code !== room.code || socket.readyState !== OPEN) continue;
    const me = room.players.find(p => p.id === meta.playerId);
    send(socket, { type: 'snapshot', room: view, me: meta.playerId, token: me?.token, ...(event ? { event } : {}) });
  }
}
function emit(room: Room, type: string, details: Record<string, unknown> = {}) {
  const event = { type, ...details };
  for (const [socket, meta] of clients) if (meta.code === room.code) send(socket, { type: 'event', event });
}
function setNewBoard(room: Room, levelIndex: number) {
  const active = room.players.filter(p => p.connected && !p.expired).sort((a, b) => a.seat - b.seat);
  room.levelIndex = levelIndex;
  room.level = buildRoomLevel(levelIndex, active.map(p => ({ color: p.color, seat: p.seat })));
  room.mirrors = room.level.mirrors.map(m => m.slash);
  room.solution = simulate(room.level, room.mirrors);
  room.lastAction = null;
  room.mirrorTurns = 0; room.bonusTimerEndsAt = null; room.stars = 0; room.bonusEarned = false;
  room.paused = false;
  room.gameFinished = false;
}
function activePlayerCount(room: Room) { return room.players.filter(p => p.connected && !p.expired).length; }
function promoteHost(room: Room) {
  if (room.players.some(p => p.host && p.connected)) return;
  room.players.forEach(p => { p.host = false; });
  const next = room.players.filter(p => p.connected && !p.expired).sort((a, b) => a.seat - b.seat)[0];
  if (next) next.host = true;
}
function removeExpired(room: Room) {
  const removed = room.players.filter(p => p.expired && !p.connected);
  if (!removed.length) return false;
  room.players = room.players.filter(p => !removed.includes(p));
  promoteHost(room);
  return true;
}
function replyError(ws: Peer, code: string, message: string) { send(ws, { type: 'error', code, message }); }
function cancelExpiry(id: string) {
  const timer = expiryTimers.get(id);
  if (timer) clearTimeout(timer);
  expiryTimers.delete(id);
}
function setEmptyClock(room: Room) {
  if (room.players.length === 0 || room.players.every(p => !p.connected)) room.emptyAt ??= Date.now();
  else room.emptyAt = null;
}
function scheduleDisconnect(room: Room, player: Player) {
  player.connected = false;
  player.leftAt = Date.now();
  cancelExpiry(player.id);
  if (room.started && !room.gameFinished) room.paused = true;
  promoteHost(room);
  const name = player.name;
  const timer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);
    const currentPlayer = currentRoom?.players.find(p => p.id === player.id);
    if (!currentRoom || !currentPlayer || currentPlayer.connected) return;
    currentPlayer.expired = true;
    setEmptyClock(currentRoom);
    sendRoom(currentRoom);
  }, 60_000);
  expiryTimers.set(player.id, timer);
  setEmptyClock(room);
  emit(room, 'playerLeft', { name });
  sendRoom(room);
}
function rejoinRoom(ws: Peer, code: string, token: string) {
  const room = rooms.get(code);
  if (!room) return replyError(ws, 'not_found', 'Room not found. Check the code and try again.');
  const player = room.players.find(p => p.token === token);
  if (!player || (player.expired && !player.connected)) return replyError(ws, 'expired', 'Your seat has expired. Ask the host to start a new room.');
  // A page reload can reconnect before the old TCP close event is processed.
  // Replace that socket by its seat token so the player never loses their seat.
  for (const [oldSocket, meta] of clients) if (meta.playerId === player.id) {
    clients.delete(oldSocket);
    oldSocket.close(4001, 'Seat resumed in a new connection');
  }
  player.connected = true;
  delete player.leftAt;
  cancelExpiry(player.id);
  promoteHost(room);
  room.paused = room.started && room.players.some(p => !p.connected);
  room.emptyAt = null;
  clients.set(ws, { code, playerId: player.id });
  sendRoom(room);
  emit(room, 'playerRejoined', { name: player.name });
}

function handleMessage(ws: Peer, raw: string) {
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return replyError(ws, 'bad_message', 'That room request could not be read. Try again.'); }
  const known = clients.get(ws);
  if (msg.type === 'create') {
    const room: Room = { code: codeForRoom(), players: [], nextSeat: 0, started: false, levelIndex: 0, level: null, mirrors: [], paused: false, gameFinished: false, solution: null, lastAction: null, completionId: 0, emptyAt: null, mirrorTurns: 0, bonusTimerEndsAt: null, stars: 0, bonusEarned: false };
    const player: Player = { id: randomUUID(), token: randomBytes(24).toString('base64url'), name: safeName(msg.name), color: codeColor(0), seat: 0, connected: true, host: true };
    room.players.push(player); room.nextSeat = 1; rooms.set(room.code, room); clients.set(ws, { code: room.code, playerId: player.id });
    sendRoom(room); return;
  }
  if (msg.type === 'join') {
    const code = String(msg.code ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    const room = rooms.get(code);
    if (!room) return replyError(ws, 'not_found', 'Room not found. Check the code and try again.');
    if (room.started) return replyError(ws, 'started', 'This game has already started. Join the next room instead.');
    if (room.players.length >= 6) return replyError(ws, 'full', 'This room is full (6 players).');
    const usedSeats = new Set(room.players.map(p => p.seat));
    const seat = PLAYER_COLORS.findIndex((_, i) => !usedSeats.has(i));
    if (seat < 0) return replyError(ws, 'full', 'This room is full (6 players).');
    const player: Player = { id: randomUUID(), token: randomBytes(24).toString('base64url'), name: uniqueName(room, safeName(msg.name)), color: codeColor(seat), seat, connected: true, host: false };
    room.players.push(player); room.players.sort((a, b) => a.seat - b.seat); room.emptyAt = null; clients.set(ws, { code, playerId: player.id });
    emit(room, 'playerJoined', { name: player.name }); sendRoom(room); return;
  }
  if (msg.type === 'rejoin') return rejoinRoom(ws, String(msg.code ?? '').toUpperCase(), String(msg.token ?? ''));
  if (!known) return replyError(ws, 'not_in_room', 'Join a room before sending game actions.');
  const room = rooms.get(known.code), player = room?.players.find(p => p.id === known.playerId);
  if (!room || !player) { clients.delete(ws); return replyError(ws, 'not_found', 'Room not found. Check the code and try again.'); }
  if (msg.type === 'leave') {
    clients.delete(ws);
    if (room.started && !room.gameFinished) { scheduleDisconnect(room, player); return; }
    cancelExpiry(player.id); room.players = room.players.filter(p => p.id !== player.id);
    promoteHost(room); setEmptyClock(room); sendRoom(room); return;
  }
  if (msg.type === 'start') {
    if (!player.host) return replyError(ws, 'host_only', 'Only the host can start the game.');
    if (room.started) return replyError(ws, 'already_started', 'The game has already started.');
    if (activePlayerCount(room) < 2) return replyError(ws, 'need_players', 'Waiting for at least 2 players.');
    if (room.players.some(p => !p.connected && !p.expired)) return replyError(ws, 'waiting_for_player', 'Wait for a player to reconnect or continue without them.');
    if (room.players.some(p => !p.connected && p.expired)) return replyError(ws, 'expired_players', 'Continue without departed players before starting.');
    room.players.forEach((p, i) => { p.color = PLAYER_COLORS[i]; });
    room.players.forEach((p, i) => { if (p.seat !== i) p.seat = i; });
    room.started = true; setNewBoard(room, 0); sendRoom(room); return;
  }
  if (msg.type === 'rotate') {
    if (!room.started || !room.level || room.paused || room.gameFinished || room.solution?.solved) return replyError(ws, 'paused', 'The board is waiting for your team.');
    const index = Number(msg.mirrorIndex), mirror = room.level.mirrors[index];
    if (!Number.isInteger(index) || !mirror || mirror.ownerSeat !== player.seat) return replyError(ws, 'not_yours', 'You can only turn your own mirror.');
    room.mirrors[index] = !room.mirrors[index]; room.mirrorTurns++; room.lastAction = { seat: player.seat, mirrorIndex: index, at: Date.now() };
    const wasSolved = Boolean(room.solution?.solved); room.solution = simulate(room.level, room.mirrors);
    if (room.solution.solved && !wasSolved) { room.completionId++; room.stars = starsForTurns(room.mirrorTurns, mirrorTurnPar(room.levelIndex, activePlayerCount(room))); room.bonusEarned = room.bonusTimerEndsAt !== null && Date.now() <= room.bonusTimerEndsAt; emit(room, 'levelComplete', { completionId: room.completionId, at: Date.now() + 500, delayMs: 500 }); }
    sendRoom(room); return;
  }
  if (msg.type === 'restart') {
    if (!player.host) return replyError(ws, 'host_only', 'Only the host can restart a level.');
    if (!room.started || room.paused || !room.level) return replyError(ws, 'paused', 'The board is waiting for your team.');
    room.mirrors = room.level.mirrors.map(m => m.slash); room.lastAction = null; room.mirrorTurns = 0; room.bonusTimerEndsAt = null; room.stars = 0; room.bonusEarned = false; room.solution = simulate(room.level, room.mirrors); room.completionId++; sendRoom(room); return;
  }
  if (msg.type === 'startBonusTimer') {
    if (!player.host) return replyError(ws, 'host_only', 'Only the host can start the bonus timer.');
    if (!room.started || room.paused || !room.level || room.solution?.solved) return replyError(ws, 'paused', 'The bonus timer is not available right now.');
    if (room.bonusTimerEndsAt === null) { room.bonusTimerEndsAt = Date.now() + BONUS_TIMER_MS; sendRoom(room); }
    return;
  }
  if (msg.type === 'next') {
    if (!player.host) return replyError(ws, 'host_only', 'Only the host can move to the next level.');
    if (room.paused) return replyError(ws, 'paused', 'Wait for your partner to rejoin before moving on.');
    if (!room.solution?.solved) return replyError(ws, 'not_solved', 'Light every lantern before moving on.');
    if (room.levelIndex === 4) { room.gameFinished = true; sendRoom(room); return; }
    setNewBoard(room, room.levelIndex + 1); sendRoom(room); return;
  }
  if (msg.type === 'continueWithout') {
    if (!player.host) return replyError(ws, 'host_only', 'Only the host can choose how the room continues.');
    const removed = room.players.filter(p => p.expired && !p.connected);
    if (!removed.length) return replyError(ws, 'not_expired', 'A player needs more time to rejoin.');
    for (const gone of removed) cancelExpiry(gone.id);
    const names = removed.map(p => p.name); removeExpired(room);
    if (room.started && activePlayerCount(room) > 0) setNewBoard(room, room.levelIndex);
    emit(room, 'continued', { names }); sendRoom(room); return;
  }
  if (msg.type === 'endRoom') {
    if (!player.host) return replyError(ws, 'host_only', 'Only the host can end the room.');
    emit(room, 'roomClosed', {});
    for (const [socket, meta] of clients) if (meta.code === room.code) { clients.delete(socket); socket.close(1000, 'Room ended'); }
    for (const p of room.players) cancelExpiry(p.id);
    rooms.delete(room.code); return;
  }
  replyError(ws, 'unknown_action', 'That action is not available.');
}

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const http = createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let file = resolve(distDir, relative);
  if (!file.startsWith(distDir + sep) && file !== resolve(distDir, 'index.html')) { res.writeHead(403); res.end('Forbidden'); return; }
  try { await stat(file); } catch { file = resolve(distDir, 'index.html'); }
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' }); res.end(body); }
  catch { res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Lantern Relay</title><p>The game is waking up. Refresh in a moment.</p>'); }
});
http.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  if (request.url?.split('?')[0] !== '/ws' || typeof key !== 'string') { socket.destroy(); return; }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ws = new Peer(socket);
  ws.onMessage(raw => handleMessage(ws, raw));
  ws.onClose(() => {
    const meta = clients.get(ws); if (!meta) return;
    clients.delete(ws);
    const room = rooms.get(meta.code), player = room?.players.find(p => p.id === meta.playerId);
    if (room && player?.connected) scheduleDisconnect(room, player);
  });
});
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (room.emptyAt && now - room.emptyAt >= 10 * 60_000) {
    for (const player of room.players) cancelExpiry(player.id);
    rooms.delete(code);
  }
}, 30_000).unref();
const port = Number(process.env.PORT ?? 4173);
http.listen(port, '0.0.0.0', () => console.log(`Lantern Relay listening on http://localhost:${port}`));
