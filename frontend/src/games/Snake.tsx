import { useCallback, useEffect, useRef, useState } from 'react';

const N = 18;
const CELL = 20;
const SIZE = N * CELL;
const KEY = 'mv-snake-best';

type Dir = 'U' | 'D' | 'L' | 'R';
const DELTA: Record<Dir, [number, number]> = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
const OPPOSITE: Record<Dir, Dir> = { U: 'D', D: 'U', L: 'R', R: 'L' };

interface P { x: number; y: number }

function readBest(): number {
  const n = Number(localStorage.getItem(KEY));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function placeFood(snake: P[]): P {
  const taken = new Set(snake.map((p) => `${p.x},${p.y}`));
  for (let i = 0; i < 500; i++) {
    const p = { x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) };
    if (!taken.has(`${p.x},${p.y}`)) return p;
  }
  return { x: 0, y: 0 };
}

export function Snake() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'idle' | 'playing' | 'over'>('idle');
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(readBest);
  const g = useRef({ snake: [{ x: 9, y: 9 }] as P[], dir: 'R' as Dir, queue: [] as Dir[], food: { x: 4, y: 4 }, score: 0, running: false, acc: 0 });

  const turn = useCallback((d: Dir) => {
    const s = g.current;
    const last = s.queue[s.queue.length - 1] ?? s.dir;
    if (d !== OPPOSITE[last] && d !== last && s.queue.length < 3) s.queue.push(d);
  }, []);

  const start = useCallback(() => {
    const s = g.current;
    s.snake = [{ x: 9, y: 9 }, { x: 8, y: 9 }, { x: 7, y: 9 }];
    s.dir = 'R';
    s.queue = [];
    s.food = placeFood(s.snake);
    s.score = 0;
    s.acc = 0;
    s.running = true;
    setScore(0);
    setState('playing');
  }, []);

  useEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = SIZE * dpr;
    cv.height = SIZE * dpr;
    ctx.scale(dpr, dpr);
    let raf = 0;
    let last = performance.now();

    const draw = () => {
      const s = g.current;
      ctx.fillStyle = '#0d0f2b';
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      for (let i = 1; i < N; i++) {
        ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, SIZE); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * CELL); ctx.lineTo(SIZE, i * CELL); ctx.stroke();
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${CELL - 2}px serif`;
      ctx.fillText('🪙', s.food.x * CELL + CELL / 2, s.food.y * CELL + CELL / 2 + 1);
      s.snake.forEach((p, i) => {
        ctx.fillStyle = i === 0 ? '#18e0b5' : `hsl(${165 - i * 3}, 80%, ${55 - Math.min(i, 20)}%)`;
        ctx.beginPath();
        ctx.roundRect(p.x * CELL + 1, p.y * CELL + 1, CELL - 2, CELL - 2, 6);
        ctx.fill();
      });
    };

    const tick = (now: number) => {
      const s = g.current;
      const dt = Math.min(now - last, 100);
      last = now;
      if (s.running) {
        s.acc += dt;
        const step = Math.max(65, 140 - s.score * 3);
        while (s.acc >= step && s.running) {
          s.acc -= step;
          const nd = s.queue.shift();
          if (nd) s.dir = nd;
          const [dx, dy] = DELTA[s.dir];
          const head = s.snake[0]!;
          const nh = { x: head.x + dx, y: head.y + dy };
          const eats = nh.x === s.food.x && nh.y === s.food.y;
          const body = eats ? s.snake : s.snake.slice(0, -1);
          if (nh.x < 0 || nh.y < 0 || nh.x >= N || nh.y >= N || body.some((p) => p.x === nh.x && p.y === nh.y)) {
            s.running = false;
            setState('over');
            if (s.score > readBest()) {
              localStorage.setItem(KEY, String(s.score));
              setBest(s.score);
            }
            break;
          }
          s.snake.unshift(nh);
          if (eats) {
            s.score++;
            setScore(s.score);
            s.food = placeFood(s.snake);
          } else s.snake.pop();
        }
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, Dir> = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R', w: 'U', s: 'D', a: 'L', d: 'R' };
      const dir = map[e.key] ?? map[e.key.toLowerCase()];
      if (dir && g.current.running) {
        e.preventDefault();
        turn(dir);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      g.current.running = false;
      window.removeEventListener('keydown', onKey);
    };
  }, [turn]);

  // Swipe controls for phones.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onDown = (e: React.PointerEvent) => { touch.current = { x: e.clientX, y: e.clientY }; };
  const onUp = (e: React.PointerEvent) => {
    const t = touch.current;
    touch.current = null;
    if (!t) return;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
    turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : dy > 0 ? 'D' : 'U');
  };

  return (
    <div className="game">
      <div className="game-hud">
        <span>🪙 {score}</span>
        <span>Snake Saver</span>
        <span>🏆 {best}</span>
      </div>
      <div className="game-stage square">
        <canvas ref={canvas} style={{ touchAction: 'none' }} onPointerDown={onDown} onPointerUp={onUp} aria-label="Snake game" />
        {state !== 'playing' && (
          <div className="game-overlay">
            <h3>{state === 'over' ? 'Game over' : 'Snake Saver'}</h3>
            {state === 'over' && <p>Saved <b>{score}</b> {score === 1 ? 'coin' : 'coins'}.</p>}
            <p className="muted small">Arrow keys / WASD, or swipe. Collect coins, avoid walls and yourself.</p>
            <button className="btn primary" onClick={start}>{state === 'over' ? 'Play again' : 'Start'}</button>
          </div>
        )}
      </div>
      <div className="dpad mobile-only" aria-label="Directional controls">
        <button onClick={() => turn('U')} aria-label="Up">▲</button>
        <div>
          <button onClick={() => turn('L')} aria-label="Left">◀</button>
          <button onClick={() => turn('D')} aria-label="Down">▼</button>
          <button onClick={() => turn('R')} aria-label="Right">▶</button>
        </div>
      </div>
    </div>
  );
}
