import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, Lightbulb, Moon, RotateCcw, Sparkles, Volume2, VolumeX, Wifi, WifiOff, X } from 'lucide-react';
import { COLOR_HEX, colorHex, colorName, levels, type Color, type Level } from '../game/levels';
import { simulate, type Simulation } from '../game/simulate';
import type { RoomPlayer, RoomSnapshot } from '../network/types';
import { BONUS_TIMER_MS, mirrorTurnPar, starsForTurns } from '../game/scoring';

type WireEvent = { type: string; name?: string; names?: string[]; completionId?: number; at?: number; delayMs?: number };
type ConnectionPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
type ConnectRequest = { type: 'create' | 'join' | 'rejoin'; name?: string; code?: string; token?: string };
const NAME_KEY = 'lantern-relay-name';
const ROOM_KEY = 'lantern-relay-room';
const TOKEN_KEY = 'lantern-relay-seat';

function tone(frequency: number, duration = .11, wave: OscillatorType = 'sine') {
  try { const Audio = window.AudioContext || (window as any).webkitAudioContext; if (!Audio) return; const ctx = new Audio(); const osc = ctx.createOscillator(); const gain = ctx.createGain(); osc.type = wave; osc.frequency.value = frequency; gain.gain.setValueAtTime(.045, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + duration); osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + duration); osc.onended = () => ctx.close(); } catch { /* sound is an optional flourish */ }
}
function safeJson(raw: string): any { try { return JSON.parse(raw); } catch { return null; } }
function socketUrl() { return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`; }

function App() {
  const [playing, setPlaying] = useState(false);
  const [levelIndex, setLevelIndex] = useState(0);
  const [orientations, setOrientations] = useState<boolean[]>(levels[0].mirrors.map(m => m.slash));
  const [mute, setMute] = useState(false);
  const [hint, setHint] = useState(false);
  const [tutorial, setTutorial] = useState(0);
  const [showDone, setShowDone] = useState(false);
  const [soloMirrorTurns, setSoloMirrorTurns] = useState(0);
  const [soloBonusTimerEndsAt, setSoloBonusTimerEndsAt] = useState<number | null>(null);
  const [timerPulse, setTimerPulse] = useState(Date.now());
  const [pendingModal, setPendingModal] = useState<'create' | 'join' | 'link' | null>(null);
  const [playerName, setPlayerName] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [formError, setFormError] = useState('');
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [myId, setMyId] = useState('');
  const [phase, setPhase] = useState<ConnectionPhase>('idle');
  const [serverError, setServerError] = useState('');
  const [toast, setToast] = useState('');
  const [copied, setCopied] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const roomRef = useRef<RoomSnapshot | null>(null);
  const intentRef = useRef(false);
  const retryRef = useRef<number | undefined>(undefined);
  const connectTimerRef = useRef<number | undefined>(undefined);
  const retryDeadlineRef = useRef(0);
  const activeRequestRef = useRef<ConnectRequest | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const completionTimerRef = useRef<number | undefined>(undefined);
  const seenCompletionRef = useRef(0);
  const priorWin = useRef(false);
  const priorLit = useRef(0);

  const onlineLevel = room?.level ?? null;
  const level = onlineLevel ?? levels[levelIndex];
  const sim: Simulation = useMemo(() => room ? {
    segments: room.segments,
    lanternMasks: new Map(Object.entries(room.lanternMasks).map(([cell, mask]) => [cell, Number(mask)])),
    mixedCells: room.mixedCells,
    solved: room.solved
  } : simulate(levels[levelIndex], orientations), [room, levelIndex, orientations]);
  const activeLevelIndex = room?.levelIndex ?? levelIndex;
  const colorCss = (color: Color | number) => typeof color === 'number' ? colorHex(color) : COLOR_HEX[color];
  const displayName = playerName.trim().slice(0, 18) || 'Player';

  function showToast(message: string) {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(''), 3000);
  }
  function clearRoomCredentials() {
    sessionStorage.removeItem(ROOM_KEY); sessionStorage.removeItem(TOKEN_KEY);
  }
  function abandonSocket() {
    intentRef.current = true;
    if (retryRef.current) window.clearTimeout(retryRef.current);
    if (connectTimerRef.current) window.clearTimeout(connectTimerRef.current);
    retryRef.current = undefined; connectTimerRef.current = undefined;
    socketRef.current?.close(); socketRef.current = null;
  }
  function openConnection(request: ConnectRequest, reconnect = false) {
    intentRef.current = false;
    activeRequestRef.current = request;
    setServerError('');
    setPhase(reconnect ? 'reconnecting' : 'connecting');
    let socket: WebSocket;
    try { socket = new WebSocket(socketUrl()); }
    catch { setPhase('failed'); setServerError('The room server could not be reached.'); return; }
    socketRef.current = socket;
    if (connectTimerRef.current) window.clearTimeout(connectTimerRef.current);
    connectTimerRef.current = window.setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) return;
      setPhase('failed'); setServerError('The room server is taking longer than usual to wake up.');
      socket.close();
    }, 9000);
    socket.onopen = () => {
      if (connectTimerRef.current) window.clearTimeout(connectTimerRef.current);
      connectTimerRef.current = undefined;
      setPhase('connected');
      socket.send(JSON.stringify(request));
    };
    socket.onmessage = event => {
      const packet = safeJson(String(event.data));
      if (!packet) return;
      if (packet.type === 'snapshot') {
        const nextRoom = packet.room as RoomSnapshot;
        const previousRoom = roomRef.current;
        if (previousRoom && (previousRoom.levelIndex !== nextRoom.levelIndex || (previousRoom.solved && !nextRoom.solved))) {
          if (completionTimerRef.current) window.clearTimeout(completionTimerRef.current);
          completionTimerRef.current = undefined; setShowDone(false);
        }
        if (nextRoom.gameFinished && !previousRoom?.gameFinished) setShowDone(true);
        roomRef.current = nextRoom; setRoom(nextRoom); setMyId(packet.me);
        setPhase('connected'); setServerError(''); setPendingModal(null); setFormError(''); setPlaying(false);
        sessionStorage.setItem(ROOM_KEY, nextRoom.code); if (packet.token) sessionStorage.setItem(TOKEN_KEY, packet.token);
        retryDeadlineRef.current = Date.now() + 65_000;
        if (nextRoom.completionId > seenCompletionRef.current && nextRoom.solved) {
          seenCompletionRef.current = nextRoom.completionId; setShowDone(true);
        }
        return;
      }
      if (packet.type === 'event') { handleRoomEvent(packet.event as WireEvent); return; }
      if (packet.type === 'error') {
        setServerError(packet.message ?? 'The room request could not be completed.');
        if (!roomRef.current && (request.type === 'create' || request.type === 'join')) {
          setPhase('idle'); setPendingModal(request.type); setFormError(packet.message ?? 'Try again.');
          if (request.type === 'join' && packet.code === 'not_found') setRoomCodeInput(String(request.code ?? ''));
          intentRef.current = true; socket.close();
        } else if (request.type === 'rejoin') {
          setPhase('failed'); clearRoomCredentials(); roomRef.current = null; setRoom(null);
        }
      }
    };
    socket.onerror = () => { /* close handler provides the recoverable state */ };
    socket.onclose = () => {
      if (connectTimerRef.current) window.clearTimeout(connectTimerRef.current);
      if (socketRef.current === socket) socketRef.current = null;
      if (intentRef.current) return;
      const savedCode = sessionStorage.getItem(ROOM_KEY), token = sessionStorage.getItem(TOKEN_KEY);
      if (savedCode && token && roomRef.current) {
        if (!reconnect) retryDeadlineRef.current = Date.now() + 65_000;
        if (Date.now() >= retryDeadlineRef.current) { setPhase('failed'); setServerError('Your 60-second reconnect window has ended. Ask the host to continue the room.'); return; }
        setPhase('reconnecting');
        if (retryRef.current) window.clearTimeout(retryRef.current);
        retryRef.current = window.setTimeout(() => openConnection({ type: 'rejoin', code: savedCode, token }, true), 1400);
      } else if (!roomRef.current) {
        setPhase('failed'); setServerError('The room server is unavailable right now.');
      } else if (phase !== 'failed') {
        setPhase('failed'); setServerError('The room server could not be reached.');
      }
    };
    if (reconnect && retryDeadlineRef.current === 0) retryDeadlineRef.current = Date.now() + 65_000;
  }
  function handleRoomEvent(event: WireEvent) {
    if (event.type === 'playerJoined') showToast(`${event.name ?? 'A player'} joined the room.`);
    else if (event.type === 'playerLeft') showToast(`${event.name ?? 'A player'} left the room.`);
    else if (event.type === 'playerRejoined') showToast(`${event.name ?? 'Your partner'} rejoined.`);
    else if (event.type === 'continued') showToast(`${(event.names ?? []).join(', ')} left the room.`);
    else if (event.type === 'levelComplete') {
      if (completionTimerRef.current) window.clearTimeout(completionTimerRef.current);
      const delay = Math.max(0, event.delayMs ?? ((event.at ?? Date.now()) - Date.now()));
      seenCompletionRef.current = event.completionId ?? seenCompletionRef.current + 1;
      completionTimerRef.current = window.setTimeout(() => { setShowDone(true); if (!mute) { tone(660, .22); window.setTimeout(() => tone(880, .38), 140); } }, delay);
    } else if (event.type === 'roomClosed') {
      abandonSocket(); clearRoomCredentials(); roomRef.current = null; setRoom(null); setMyId(''); setPhase('idle'); setShowDone(false); setPlaying(false); showToast('The host ended this room.');
    }
  }
  function sendAction(type: string, data: Record<string, unknown> = {}) {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...data }));
    else if (roomRef.current) showToast('Reconnecting… your move has not been sent yet.');
  }
  function startRoomRequest(type: 'create' | 'join') {
    setFormError(''); setServerError('');
    seenCompletionRef.current = 0; setShowDone(false);
    localStorage.setItem(NAME_KEY, displayName); setPlayerName(displayName);
    if (type === 'join') {
      const code = roomCodeInput.toUpperCase();
      if (code.length !== 4) { setFormError('Enter a 4-letter room code.'); return; }
      openConnection({ type, name: displayName, code });
    } else openConnection({ type, name: displayName });
  }
  function retryServer() {
    const savedCode = sessionStorage.getItem(ROOM_KEY), token = sessionStorage.getItem(TOKEN_KEY);
    if (savedCode && token) { retryDeadlineRef.current = Date.now() + 65_000; openConnection({ type: 'rejoin', code: savedCode, token }, true); }
    else if (activeRequestRef.current) openConnection(activeRequestRef.current);
    else setPendingModal('create');
  }
  function enterSolo() {
    if (room) { sendAction('leave'); abandonSocket(); clearRoomCredentials(); roomRef.current = null; setRoom(null); setMyId(''); }
    setPhase('idle'); setPlaying(true); setLevelIndex(0); setOrientations(levels[0].mirrors.map(m => m.slash)); setShowDone(false); setTutorial(0); setHint(false); setSoloMirrorTurns(0); setSoloBonusTimerEndsAt(null); priorWin.current = false; priorLit.current = 0;
  }
  function goHome() {
    if (room) { sendAction('leave'); abandonSocket(); clearRoomCredentials(); roomRef.current = null; setRoom(null); setMyId(''); }
    setPlaying(false); setShowDone(false); setPhase('idle'); setPendingModal(null);
  }
  function changeSoloLevel(index: number) { const next = Math.max(0, Math.min(levels.length - 1, index)); setLevelIndex(next); setOrientations(levels[next].mirrors.map(m => m.slash)); setHint(false); setShowDone(false); setTutorial(0); setSoloMirrorTurns(0); setSoloBonusTimerEndsAt(null); priorWin.current = false; priorLit.current = 0; }
  function rotate(index: number) {
    if (room) { sendAction('rotate', { mirrorIndex: index }); setHint(false); return; }
    setOrientations(old => old.map((value, i) => i === index ? !value : value)); setSoloMirrorTurns(n => n + 1); setHint(false);
    if (!mute) tone(420, .07, 'triangle'); if (tutorial < 3 && level.prompt) setTutorial(tutorial + 1);
  }
  function restart() {
    if (room) { sendAction('restart'); setHint(false); return; }
    setOrientations(level.mirrors.map(m => m.slash)); setSoloMirrorTurns(0); setSoloBonusTimerEndsAt(null); setHint(false); setShowDone(false); priorWin.current = false; priorLit.current = 0; if (!mute) tone(300, .08);
  }
  function startBonusTimer() {
    setTimerPulse(Date.now());
    if (room) sendAction('startBonusTimer');
    else if (soloBonusTimerEndsAt === null) setSoloBonusTimerEndsAt(Date.now() + BONUS_TIMER_MS);
  }
  function nextSoloLevel() { changeSoloLevel(levelIndex + 1); }
  async function copyLink() {
    if (!room) return;
    const url = `${location.origin}${location.pathname}?room=${room.code}`;
    try { await navigator.clipboard.writeText(url); setCopied(true); showToast('Room link copied. Send it to your team.'); window.setTimeout(() => setCopied(false), 1800); }
    catch {
      const field = document.createElement('textarea'); field.value = url; field.style.position = 'fixed'; field.style.opacity = '0';
      document.body.appendChild(field); field.select();
      const legacyCopied = document.execCommand('copy'); field.remove();
      if (legacyCopied) { setCopied(true); showToast('Room link copied. Send it to your team.'); window.setTimeout(() => setCopied(false), 1800); }
      else showToast(`Share this room code: ${room.code}`);
    }
  }

  useEffect(() => {
    const queryCode = new URLSearchParams(location.search).get('room')?.toUpperCase();
    const savedCode = sessionStorage.getItem(ROOM_KEY), token = sessionStorage.getItem(TOKEN_KEY);
    if (token && savedCode) { retryDeadlineRef.current = Date.now() + 65_000; openConnection({ type: 'rejoin', code: savedCode, token }, true); }
    else if (queryCode) {
      const code = queryCode.replace(/[^A-HJ-NP-Z]/g, '').slice(0, 4);
      setRoomCodeInput(code);
      const savedName = localStorage.getItem(NAME_KEY);
      if (savedName) openConnection({ type: 'join', code, name: savedName });
      else setPendingModal('link');
    }
    return () => { if (retryRef.current) window.clearTimeout(retryRef.current); if (connectTimerRef.current) window.clearTimeout(connectTimerRef.current); if (completionTimerRef.current) window.clearTimeout(completionTimerRef.current); };
  }, []);
  useEffect(() => { if (!room) return; roomRef.current = room; }, [room]);
  useEffect(() => {
    if (!(room?.bonusTimerEndsAt || soloBonusTimerEndsAt)) return;
    const interval = window.setInterval(() => setTimerPulse(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [room?.bonusTimerEndsAt, soloBonusTimerEndsAt]);
  useEffect(() => {
    if (room) return;
    const soloSim = simulate(levels[levelIndex], orientations);
    if (!mute && soloSim.solved && !priorWin.current) { tone(660, .22); window.setTimeout(() => tone(880, .38), 140); if (playing) setShowDone(true); }
    priorWin.current = soloSim.solved;
  }, [room, orientations, levelIndex, mute, playing]);
  useEffect(() => {
    if (room) return;
    const currentLevel = levels[levelIndex], soloSim = simulate(currentLevel, orientations);
    const lit = currentLevel.lanterns.filter(l => soloSim.lanternMasks.get(`${l.x},${l.y}`) === l.target).length;
    if (!mute && lit > priorLit.current && !soloSim.solved) tone(760, .18);
    priorLit.current = lit;
  }, [room, orientations, levelIndex, mute]);

  const disconnectedPlayers = room?.players.filter(p => !p.connected) ?? [];
  const expiredPlayers = room?.expiredPlayers ?? [];
  const lobby = Boolean(room && !room.started);
  const waking = phase === 'connecting' || phase === 'reconnecting' || (phase === 'failed' && !room);
  const simulation = sim;
  const shownOrientations = room?.mirrors ?? orientations;

  return <div className="app-shell">
    <div className="ambient ambient-one"/><div className="ambient ambient-two"/>
    <header className="topbar">
      <a className="brand" href="#home" onClick={e => { e.preventDefault(); goHome(); }}><span className="brand-mark"><span/></span><span>LANTERN<span className="brand-light"> RELAY</span></span></a>
      <div className="topbar-right"><span className="co-op-label"><span className="live-dot"/> A CO-OP LIGHT PUZZLE</span><button className="icon-button sound-button" aria-label={mute ? 'Unmute sounds' : 'Mute sounds'} onClick={() => setMute(!mute)}>{mute ? <VolumeX size={18}/> : <Volume2 size={18}/>}<span>{mute ? 'Sound off' : 'Sound on'}</span></button></div>
    </header>

    {waking ? <main className="waking-main"><div className="wake-icon"><Sparkles size={25}/></div><div className="eyebrow"><span className="live-dot"/> ROOM CONNECTION</div><h1>Waking the<br/><span>game server…</span></h1><p>{phase === 'reconnecting' ? 'Finding your seat and catching the board back up.' : 'Getting the room ready. This usually takes just a moment.'}</p><div className="wake-spinner"/>{serverError && <p className="wake-error">{serverError}</p>}<div className="wake-actions"><button className="button button-primary" onClick={retryServer}>Try again <RotateCcw size={15}/></button><button className="button button-secondary" onClick={enterSolo}>Play solo instead <ArrowRight size={15}/></button></div></main>
    : !playing && !room ? <HomeView onCreate={() => { setFormError(''); setPendingModal('create'); }} onJoin={() => { setFormError(''); setPendingModal('join'); }} onSolo={enterSolo}/>
    : lobby && room ? <LobbyView room={room} myId={myId} connected={phase === 'connected'} copied={copied} onCopy={copyLink} onStart={() => sendAction('start')} onLeave={goHome} onEnd={() => sendAction('endRoom')} onContinue={() => sendAction('continueWithout')} toast={toast}/>
    : <GameView level={level} levelIndex={activeLevelIndex} simulation={simulation} orientations={shownOrientations} room={room} myId={myId} connected={phase === 'connected'} disconnectedPlayers={disconnectedPlayers} expiredPlayers={expiredPlayers} mute={mute} setMute={setMute} hint={hint} setHint={setHint} tutorial={tutorial} setTutorial={setTutorial} showDone={showDone} setShowDone={setShowDone} onBack={goHome} onRotate={rotate} onRestart={restart} onNext={() => sendAction('next')} onSoloNext={nextSoloLevel} onContinue={() => sendAction('continueWithout')} onEnd={() => sendAction('endRoom')} onStartBonusTimer={startBonusTimer} mirrorTurns={room?.mirrorTurns ?? soloMirrorTurns} timerEndsAt={room?.bonusTimerEndsAt ?? soloBonusTimerEndsAt} timerPulse={timerPulse} toast={toast} colorCss={colorCss}/>}

    <footer className="site-footer"><span>© LANTERN RELAY</span><span>MADE OF LIGHT & A LITTLE TEAMWORK</span><span>V 1.1 <i/></span></footer>
    {pendingModal && <div className="modal-scrim" onClick={() => { setPendingModal(null); setFormError(''); }}><div className="room-modal" onClick={e => e.stopPropagation()}><button className="modal-close" onClick={() => setPendingModal(null)} aria-label="Close"><X size={17}/></button><div className="room-modal-icon"><Sparkles size={22}/></div><div className="eyebrow">NO LOGIN. JUST YOUR TEAM.</div><h3>{pendingModal === 'create' ? 'A place for your team.' : pendingModal === 'link' ? 'You’re invited.' : 'Find your little team.'}</h3><p>{pendingModal === 'create' ? 'We’ll make a private room and a short code to share.' : pendingModal === 'link' ? 'Choose a name and we’ll take you to the room.' : 'Enter the 4-letter code your friend shared.'}</p><label className="form-label">YOUR NAME<input autoComplete="nickname" maxLength={18} value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="Player" onKeyDown={e => { if (e.key === 'Enter') startRoomRequest(pendingModal === 'create' ? 'create' : 'join'); }}/></label>{pendingModal === 'join' && <label className="form-label code-label">ROOM CODE<input autoComplete="off" value={roomCodeInput} maxLength={4} onChange={e => setRoomCodeInput(e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z]/g, '').slice(0, 4))} placeholder="ABCD" className="code-input" onKeyDown={e => { if (e.key === 'Enter') startRoomRequest('join'); }}/></label>}{formError && <p className="form-error">{formError}</p>}<button className="button button-primary" onClick={() => startRoomRequest(pendingModal === 'create' ? 'create' : 'join')}>{pendingModal === 'create' ? 'Create room' : 'Join room'} <ArrowRight size={16}/></button></div></div>}
  </div>;
}

function HomeView({ onCreate, onJoin, onSolo }: { onCreate: () => void; onJoin: () => void; onSolo: () => void }) {
  return <main className="home-main" id="home">
    <section className="home-copy"><div className="eyebrow"><Sparkles size={14}/> TWO TO SIX PLAYERS. ONE LITTLE LIGHT.</div><h1>Find your way<br/>back <span>to the light.</span></h1><p className="home-lede">A tiny co-op puzzle about making light take the long way home.</p><div className="home-actions"><button className="button button-primary" onClick={onCreate}>Create room <ArrowRight size={17}/></button><button className="button button-secondary" onClick={onJoin}>Join room <span className="button-key">4-LETTER CODE</span></button><div className="action-divider"><span>OR TAKE A SOLO LAP</span></div><button className="button button-practice" onClick={onSolo}><span className="practice-icon"><Moon size={17}/></span> Try solo practice <ArrowRight size={16}/></button></div><div className="micro-note"><span className="note-check"><Check size={12}/></span> No account. No rush. Just a little teamwork.</div></section>
    <section className="home-art" aria-label="A preview of colored light traveling through mirrors to glowing lanterns"><div className="art-orbit orbit-a"/><div className="art-orbit orbit-b"/><svg className="art-lines" viewBox="0 0 600 500" aria-hidden="true"><path d="M60 335H210L300 245V115H465"/><path d="M530 390H385L300 305V245"/></svg><div className="art-beam red-beam"/><div className="art-beam blue-beam"/><div className="art-node node-red"><i/></div><div className="art-node node-blue"><i/></div><div className="art-mirror mirror-a"><span/></div><div className="art-mirror mirror-b"><span/></div><div className="art-lantern lantern-a"><Lightbulb size={22}/><i/></div><div className="art-lantern lantern-b"><Lightbulb size={22}/><i/></div><div className="art-caption cap-one"><b>01 / 02</b><span>LINE IT UP</span></div><div className="art-caption cap-two"><b>COLOR MIX</b><span>RED + BLUE</span></div><div className="art-center-star">✳</div></section>
    <section className="how-panel"><div className="how-title"><span className="how-icon"><Lightbulb size={16}/></span><div><b>How to play</b><span>A quick little field guide</span></div></div><div className="how-steps"><div><span>01</span><p>Take a color.<br/><b>Find your beam.</b></p></div><i/><div><span>02</span><p>Turn the mirrors.<br/><b>Share the path.</b></p></div><i/><div><span>03</span><p>Light every lantern.<br/><b>Make it home.</b></p></div></div><div className="color-pair"><i className="dot-red"/><b>+</b><i className="dot-blue"/><span>=</span><i className="dot-purple"/></div></section>
  </main>;
}

function ConnectionBadge({ connected }: { connected: boolean }) { return <span className={`connection-badge ${connected ? 'is-connected' : 'is-reconnecting'}`}>{connected ? <Wifi size={13}/> : <WifiOff size={13}/>} {connected ? 'CONNECTED' : 'RECONNECTING'}</span>; }
function LobbyView({ room, myId, connected, copied, onCopy, onStart, onLeave, onEnd, onContinue, toast }: { room: RoomSnapshot; myId: string; connected: boolean; copied: boolean; onCopy: () => void; onStart: () => void; onLeave: () => void; onEnd: () => void; onContinue: () => void; toast: string }) {
  const me = room.players.find(p => p.id === myId);
  const count = room.players.filter(p => p.connected && !p.expired).length;
  const expired = room.expiredPlayers.length > 0;
  return <main className="lobby-main"><div className="game-topline"><button className="back-link" onClick={onLeave}><ArrowLeft size={16}/> Leave room</button><ConnectionBadge connected={connected}/></div><div className="lobby-card"><div className="lobby-heading"><div className="eyebrow"><span className="live-dot"/> PRIVATE ROOM · {count}/6 PLAYERS</div><h1>Your little<br/><span>team is here.</span></h1><p>Share the code or link. Pick a name and bring your color.</p></div><div className="room-code-panel"><span>ROOM CODE</span><strong>{room.code.split('').map((char, i) => <i key={i}>{char}</i>)}</strong><button className="button button-secondary copy-link-button" onClick={onCopy}>{copied ? <Check size={15}/> : <Copy size={15}/>} {copied ? 'Link copied' : 'Copy invite link'}</button></div><div className="lobby-roster"><div className="side-heading"><span>PLAYERS IN THIS ROOM</span><span className="team-count">{count} / 6 SEATS</span></div><div className="roster-list">{room.players.map((p: RoomPlayer) => <div className={`roster-player ${!p.connected ? 'roster-away' : ''}`} key={p.id}><span className="player-avatar" style={{ background: `${COLOR_HEX[p.color]}20` }}><i style={{ background: COLOR_HEX[p.color], boxShadow: `0 0 9px ${COLOR_HEX[p.color]}` }}/></span><div className="player-name"><b>{p.name}{p.id === myId ? <span className="you-label">YOU</span> : null}</b><span>{p.color.toUpperCase()} BEAM · {p.host ? 'HOST' : 'PLAYER'}</span></div><span className={`player-state ${p.connected ? 'state-active' : ''}`}><i/>{p.connected ? (p.host ? 'HOST' : 'READY') : p.expired ? 'AWAY' : 'REJOINING'}</span></div>)}</div></div>{room.players.length < 6 && <div className="waiting-note"><div className="waiting-dots"><i/><i/><i/></div><div><b>{count < 2 ? 'Waiting for players…' : 'Your team is ready.'}</b><span>{count < 2 ? 'Invite one more player to unlock Start.' : 'The host can start whenever everyone is ready.'}</span></div></div>}{expired && me?.host && <div className="expired-actions"><p>{room.expiredPlayers.map(p => p.name).join(', ')} didn’t make it back in time.</p><button className="button button-secondary" onClick={onContinue}>Continue without them</button><button className="text-danger" onClick={onEnd}>End room</button></div>}<div className="lobby-actions">{me?.host ? <button className="button button-primary start-button" disabled={count < 2 || room.players.some(p => !p.connected)} onClick={onStart}>Start together <ArrowRight size={17}/></button> : <div className="waiting-host"><span className="live-dot"/> Waiting for the host to start…</div>}<button className="text-button" onClick={me?.host ? onEnd : onLeave}>{me?.host ? 'End room' : 'Leave room'}</button></div></div>{toast && <div className="toast"><Sparkles size={14}/>{toast}</div>}</main>;
}

type GameProps = { level: Level; levelIndex: number; simulation: Simulation; orientations: boolean[]; room: RoomSnapshot | null; myId: string; connected: boolean; disconnectedPlayers: RoomPlayer[]; expiredPlayers: RoomSnapshot['expiredPlayers']; mute: boolean; setMute: (value: boolean) => void; hint: boolean; setHint: (value: boolean) => void; tutorial: number; setTutorial: (value: number) => void; showDone: boolean; setShowDone: (value: boolean) => void; onBack: () => void; onRotate: (index: number) => void; onRestart: () => void; onNext: () => void; onSoloNext: () => void; onContinue: () => void; onEnd: () => void; onStartBonusTimer: () => void; mirrorTurns: number; timerEndsAt: number | null; timerPulse: number; toast: string; colorCss: (value: Color | number) => string };
function GameView(props: GameProps) {
  const { level, levelIndex, simulation, orientations, room, myId, connected, disconnectedPlayers, expiredPlayers, mute, setMute, hint, setHint, tutorial, setTutorial, showDone, setShowDone, onBack, onRotate, onRestart, onNext, onSoloNext, onContinue, onEnd, onStartBonusTimer, mirrorTurns, timerEndsAt, timerPulse, toast, colorCss } = props;
  const me = room?.players.find(p => p.id === myId);
  const host = me?.host ?? false;
  const solo = !room;
  const par = mirrorTurnPar(levelIndex, room?.players.length ?? 1);
  const stars = room?.stars || (simulation.solved ? starsForTurns(mirrorTurns, par) : 0);
  const secondsLeft = timerEndsAt === null ? null : Math.max(0, Math.ceil((timerEndsAt - timerPulse) / 1000));
  const bonusEarned = room ? room.bonusEarned : Boolean(simulation.solved && timerEndsAt !== null && timerPulse <= timerEndsAt);
  const litCount = level.lanterns.filter(l => simulation.lanternMasks.get(`${l.x},${l.y}`) === l.target).length;
  const otherAction = room?.lastAction && room.lastAction.seat !== me?.seat ? room.lastAction : null;
  const boardWidth = level.width > 10 ? `${level.width * 54}px` : undefined;
  const awayName = disconnectedPlayers[0]?.name ?? expiredPlayers[0]?.name ?? 'your partner';
  return <main className="game-main">
    <div className="game-topline"><button className="back-link" onClick={onBack}><ArrowLeft size={16}/> {room ? 'Leave room' : 'Back to the porch'}</button><div className="level-pips">{levels.map((_, i) => <span key={i} className={i === levelIndex ? 'pip active' : i < levelIndex ? 'pip complete' : 'pip'}>{i < levelIndex ? <Check size={10}/> : `0${i + 1}`}</span>)}</div>{room ? <ConnectionBadge connected={connected}/> : <button className="icon-button game-sound" aria-label={mute ? 'Unmute sounds' : 'Mute sounds'} onClick={() => setMute(!mute)}>{mute ? <VolumeX size={18}/> : <Volume2 size={18}/>}</button>}</div>
    {room && <div className="online-strip"><span>ROOM <b>{room.code}</b></span><span className="online-team">{room.players.map(p => <i key={p.id} title={`${p.name} · ${p.color}`} style={{ background: COLOR_HEX[p.color], opacity: p.connected ? 1 : .35 }}/>)}</span><span>{me?.name} · {me?.color.toUpperCase()}</span></div>}
    <div className="game-layout"><section className="board-column"><div className="board-heading"><div><div className="eyebrow"><span className="live-dot"/> LEVEL 0{levelIndex + 1} <span className="eyebrow-sep">/</span> 05{room ? <span className="eyebrow-sep"> · ROOM</span> : null}</div><h2>{level.name}</h2><p>{level.subtitle}</p></div>{solo || host ? <button className="icon-button reset-button" onClick={onRestart}><RotateCcw size={15}/><span>Restart level</span></button> : <span className="host-only-note">HOST CONTROLS RESTART</span>}</div>
      <div className="board-card"><div className="board-top"><span><i className="board-signal"/> YOUR SHARED BOARD</span><span className="board-status">{room?.paused ? 'WAITING FOR PARTNER' : simulation.solved ? 'ALL LANTERNS LIT' : 'BEAMS IN FLIGHT'}</span></div><div className="board-wrap"><svg className={`board ${level.width > 10 ? 'board-wide' : ''}`} style={boardWidth ? { width: boardWidth, maxWidth: 'none' } : undefined} viewBox={`0 0 ${level.width * 64} ${level.height * 64}`} role="img" aria-label={`${level.name} puzzle board`}>
        <defs><pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse"><path d="M64 0H0V64" fill="none" stroke="rgba(151,177,214,.12)" strokeWidth="1"/></pattern><filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect width="100%" height="100%" fill="url(#grid)"/>
        {simulation.segments.map((seg, i) => <g key={i}><line x1={(seg.x1 + .5) * 64} y1={(seg.y1 + .5) * 64} x2={(seg.x2 + .5) * 64} y2={(seg.y2 + .5) * 64} stroke={colorCss(seg.mask)} strokeWidth="13" opacity=".16" strokeLinecap="round" filter="url(#glow)"/><line x1={(seg.x1 + .5) * 64} y1={(seg.y1 + .5) * 64} x2={(seg.x2 + .5) * 64} y2={(seg.y2 + .5) * 64} stroke={colorCss(seg.mask)} strokeWidth="3" opacity=".9" strokeLinecap="round" className="beam-dash"/></g>)}
        {simulation.mixedCells.map(cell => { const [x,y] = cell.split(',').map(Number); return <circle key={`mix${cell}`} cx={(x+.5)*64} cy={(y+.5)*64} r="7" fill="#c17bff" opacity=".92" filter="url(#glow)"/>; })}
        {level.walls.map((w, i) => <g key={`w${i}`}><rect x={w.x*64+6} y={w.y*64+6} width="52" height="52" rx="12" className="wall-tile"/><path d={`M${w.x*64+18} ${w.y*64+24}h28M${w.x*64+18} ${w.y*64+34}h28M${w.x*64+18} ${w.y*64+44}h28`} className="wall-lines"/></g>)}
        {level.splitters.map((p, i) => <g key={`p${i}`} className="splitter"><circle cx={(p.x+.5)*64} cy={(p.y+.5)*64} r="16"/><path d={`M${p.x*64+24} ${p.y*64+40}l8-16 8 16M${p.x*64+32} ${p.y*64+27}v20`}/></g>)}
        {level.sources.map((source, i) => <g key={`s${i}`}><circle cx={(source.x+.5)*64} cy={(source.y+.5)*64} r="18" fill={COLOR_HEX[source.color]} opacity=".12"/><circle cx={(source.x+.5)*64} cy={(source.y+.5)*64} r="10" fill={COLOR_HEX[source.color]} opacity=".95"/><circle cx={(source.x+.5)*64} cy={(source.y+.5)*64} r="4" fill="#fff"/><text x={(source.x+.5)*64} y={(source.y+.5)*64+36} textAnchor="middle" className="source-label">{source.color.toUpperCase()}</text></g>)}
        {level.mirrors.map((m, i) => { const canTurn = solo || m.ownerSeat === me?.seat; const isHighlighted = otherAction?.mirrorIndex === i; const owner = room?.players.find(p => p.seat === m.ownerSeat); return <g key={`m${i}`} className={`mirror-control ${canTurn ? '' : 'mirror-locked'} ${isHighlighted ? 'mirror-other-turn' : ''}`} onClick={() => canTurn && !room?.paused && rotateSafe(onRotate, i)} onKeyDown={e => { if (canTurn && (e.key === 'Enter' || e.key === ' ')) rotateSafe(onRotate, i); }} tabIndex={canTurn ? 0 : -1} role="button" aria-label={canTurn ? `Rotate your mirror ${i+1}` : `Mirror controlled by ${owner?.name ?? 'another player'}`}><circle cx={(m.x+.5)*64} cy={(m.y+.5)*64} r="27" className="mirror-hit"/><rect x={m.x*64+9} y={m.y*64+9} width="46" height="46" rx="14" className="mirror-tile"/><path d={orientations[i] ? `M${m.x*64+20} ${m.y*64+44}L${m.x*64+44} ${m.y*64+20}` : `M${m.x*64+20} ${m.y*64+20}L${m.x*64+44} ${m.y*64+44}`} className="mirror-face"/><circle cx={(m.x+.5)*64} cy={(m.y+.5)*64} r="3" className="mirror-dot"/>{owner && <circle cx={(m.x+.5)*64+17} cy={(m.y+.5)*64-17} r="3.5" fill={COLOR_HEX[owner.color]} className="owner-dot"/>}</g>; })}
        {level.lanterns.map((l, i) => { const mask = simulation.lanternMasks.get(`${l.x},${l.y}`) ?? 0; const lit = mask === l.target; const lampColor = colorCss(l.target); return <g key={`l${i}`} className={lit ? 'lantern lit' : 'lantern'} style={{ '--lantern-color': lampColor } as React.CSSProperties}><circle cx={(l.x+.5)*64} cy={(l.y+.5)*64} r="24" fill={lit ? lampColor : '#8090ad'} opacity={lit ? '.14' : '.08'}/><circle cx={(l.x+.5)*64} cy={(l.y+.5)*64} r="15" className="lantern-glass"/><path d={`M${l.x*64+28} ${l.y*64+24}h8l5 6v10l-5 5h-8l-5-5V30z`} className="lantern-shape"/><path d={`M${l.x*64+29} ${l.y*64+47}h7m-6 3h5`} className="lantern-base"/><text x={(l.x+.5)*64} y={l.y*64+63} textAnchor="middle" className="lantern-label">{l.name.toUpperCase()} · {colorName(l.target)}</text><circle cx={(l.x+.5)*64} cy={(l.y+.5)*64} r="5" className="lantern-core"/></g>; })}
      </svg></div><div className="board-legend">{Array.from(new Set(level.sources.map(s => s.color))).map(color => <span key={color}><i style={{ background: COLOR_HEX[color], boxShadow: `0 0 8px ${COLOR_HEX[color]}` }}/>{color[0].toUpperCase()+color.slice(1)} light</span>)}{level.splitters.length > 0 && <span><i className="legend-split"/> Splitter</span>}<span className="tap-hint">↗ Tap your mirror to turn it</span></div></div>
      </section><aside className="side-column"><div className="team-card"><div className="side-heading"><span>THE LITTLE TEAM</span><span className="team-count">{room ? `${room.players.length} PLAYERS` : `${level.sources.length} COLORS`}</span></div><div className="team-players">{room ? room.players.map(p => <div className="player-row" key={p.id}><span className="player-avatar" style={{ background: `${COLOR_HEX[p.color]}20` }}><i style={{ background: COLOR_HEX[p.color], boxShadow: `0 0 9px ${COLOR_HEX[p.color]}` }}/></span><div className="player-name"><b>{p.name}{p.id === myId ? <span className="you-label">YOU</span> : null}</b><span>{p.color.toUpperCase()} BEAM{p.host ? ' · HOST' : ''}</span></div><span className={`player-state ${p.connected ? 'state-active' : ''}`}><i/>{p.connected ? 'READY' : 'AWAY'}</span></div>) : level.sources.map((s, i) => <div className="player-row" key={`${s.color}${i}`}><span className="player-avatar" style={{ background: `${COLOR_HEX[s.color]}20` }}><i style={{ background: COLOR_HEX[s.color], boxShadow: `0 0 9px ${COLOR_HEX[s.color]}` }}/></span><div className="player-name"><b>{s.color[0].toUpperCase()+s.color.slice(1)} beam</b><span>Light keeper</span></div><span className="player-state state-active"><i/>READY</span></div>)}</div></div>
        <div className="goal-card"><div className="side-heading"><span>LIGHT THE LANTERNS</span><span className="goal-count">{litCount}/{level.lanterns.length} LIT</span></div><div className="goal-list">{level.lanterns.map(l => { const lit = simulation.lanternMasks.get(`${l.x},${l.y}`) === l.target; return <div className={`goal-row ${lit ? 'goal-lit' : ''}`} key={l.name}><span className="goal-bulb"><Lightbulb size={15}/></span><span>{l.name}</span><i className="goal-color" style={{ background: colorCss(l.target) }}/><span className="goal-target">{colorName(l.target)}</span>{lit && <Check size={14} className="goal-check"/>}</div>; })}</div><div className="goal-progress"><i style={{ width: `${litCount / level.lanterns.length * 100}%` }}/></div></div>
        <div className="score-card"><div className="score-top"><span>REPLAY CHALLENGE</span><span>{simulation.solved ? `${stars} / 3 STARS · ${stars * 100 + (bonusEarned ? 100 : 0)} PTS` : `${mirrorTurns} / ${par} TURNS`}</span></div><div className="score-row"><span className="score-stars" aria-label={`${stars} stars`}>{[1,2,3].map(n => <i key={n} className={n <= stars ? 'earned' : ''}>★</i>)}</span><span className="score-turns">Mirror turns: {mirrorTurns}</span></div><div className="score-rule">3 stars at target · 2 within 2 extra turns · 1 for a solve</div><div className="bonus-row">{timerEndsAt === null ? <><span>A 90-second bonus clock is optional.</span>{solo || host ? <button onClick={onStartBonusTimer}>Start bonus timer</button> : <span>Host can start bonus timer</span>}</> : secondsLeft! > 0 ? <span>Bonus clock · {Math.floor(secondsLeft! / 60)}:{String(secondsLeft! % 60).padStart(2, '0')}</span> : simulation.solved && bonusEarned ? <span className="bonus-success">Bonus earned · +100 points</span> : <span>Bonus window ended · keep playing</span>}</div></div>
        <div className={`prompt-card ${hint ? 'hint-open' : ''}`}><div className="prompt-icon"><Lightbulb size={16}/></div><div><span>{hint ? 'A LITTLE HINT' : 'NEED A NUDGE?'}</span><p>{hint ? level.hint : 'There’s always a way through.'}</p>{!hint && <button onClick={() => setHint(true)}>Show me a hint <ArrowRight size={13}/></button>}</div></div>
        {solo && level.prompt && tutorial < 3 && <div className="tutorial-line"><span>TIP {tutorial+1} / 3</span><b>{level.prompt[tutorial]}</b><button onClick={() => setTutorial(3)} aria-label="Dismiss tip"><X size={13}/></button></div>}
        <div className="sidebar-foot"><span><i/>{room ? <><ConnectionBadge connected={connected}/></> : 'ALL CHANGES STAY ON THIS DEVICE'}</span><button onClick={() => setMute(!mute)}>{mute ? <VolumeX size={13}/> : <Volume2 size={13}/>} {mute ? 'Sound off' : 'Sound on'}</button></div>
      </aside></div>
    {room?.paused && <div className="pause-scrim"><div className="pause-card"><div className="pause-icon"><WifiOff size={20}/></div><div className="eyebrow">TEAM PAUSE</div><h3>Waiting for {awayName} to rejoin.</h3><p>The board is paused for everyone. Their seat and color are held for 60 seconds.</p>{expiredPlayers.length > 0 && host ? <div className="pause-actions"><button className="button button-primary" onClick={onContinue}>Continue without them</button><button className="text-danger" onClick={onEnd}>End room</button></div> : <div className="waiting-dots"><i/><i/><i/></div>}</div></div>}
    <footer className="game-footer"><span>TAKE YOUR TIME. LIGHT FINDS A WAY.</span><span>LEVEL {levelIndex+1} OF {levels.length}</span></footer>
    {showDone && <div className="modal-scrim"><div className="complete-modal"><button className="modal-close" onClick={() => setShowDone(false)} aria-label="Close"><X size={17}/></button><div className="complete-burst">✳</div><div className="eyebrow">A LITTLE LIGHT GOES A LONG WAY</div><h3>{room?.gameFinished || levelIndex === levels.length - 1 ? 'You brought them home.' : 'Every lantern, home.'}</h3><p>{levelIndex === levels.length - 1 ? 'Every color found its way. The whole sky is glowing.' : 'That’s the lovely thing about a good team. No light left behind.'}</p><div className="complete-score"><b>{'★'.repeat(stars)}{'☆'.repeat(3-stars)}</b><span>{stars * 100 + (bonusEarned ? 100 : 0)} points · {mirrorTurns} turns{bonusEarned ? ' · includes 100 timer bonus' : ''}</span></div>{room ? room.gameFinished ? <>{host && <button className="button button-primary" onClick={onEnd}>End room <ArrowRight size={16}/></button>}{!host && <div className="waiting-host"><span className="live-dot"/> The host is wrapping up the room.</div>}</> : host ? <button className="button button-primary" onClick={() => { setShowDone(false); onNext(); }}>Next level <ArrowRight size={16}/></button> : <div className="waiting-host"><span className="live-dot"/> Waiting for the host to continue…</div> : levelIndex < levels.length - 1 ? <button className="button button-primary" onClick={() => { setShowDone(false); setHint(false); onSoloNext(); }}>Next level <ArrowRight size={16}/></button> : <button className="button button-primary" onClick={onBack}>Back to the porch <ArrowRight size={16}/></button>}</div></div>}
    {room && toast && <div className="toast"><Sparkles size={14}/>{toast}</div>}
  </main>;
}
function rotateSafe(rotate: (index: number) => void, index: number) { rotate(index); }
export default App;
