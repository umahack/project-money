import { useCallback, useEffect, useRef, useState } from 'react';

const W = 360;
const H = 520;
const KEY = 'mv-coin-best';

interface Drop {
  x: number;
  y: number;
  vy: number;
  kind: 'coin' | 'gold' | 'bill';
}

function readBest(): number {
  const n = Number(localStorage.getItem(KEY));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function CoinCatcher() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'idle' | 'playing' | 'over'>('idle');
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [best, setBest] = useState(readBest);
  const game = useRef({ px: W / 2, keys: { l: false, r: false }, drops: [] as Drop[], score: 0, lives: 3, t: 0, spawn: 0, running: false });

  const start = useCallback(() => {
    const g = game.current;
    g.px = W / 2;
    g.drops = [];
    g.score = 0;
    g.lives = 3;
    g.t = 0;
    g.spawn = 0;
    g.running = true;
    setScore(0);
    setLives(3);
    setState('playing');
  }, []);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = W * dpr;
    cv.height = H * dpr;
    ctx.scale(dpr, dpr);
    let raf = 0;
    let last = performance.now();

    const draw = () => {
      const g = game.current;
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#1b1450');
      grad.addColorStop(1, '#0a1d3a');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const d of g.drops) {
        ctx.font = `${d.kind === 'gold' ? 34 : 28}px serif`;
        ctx.fillText(d.kind === 'bill' ? '💸' : d.kind === 'gold' ? '💰' : '🪙', d.x, d.y);
      }
      ctx.font = '40px serif';
      ctx.fillText('👛', g.px, H - 36);
    };

    const tick = (now: number) => {
      const g = game.current;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (g.running) {
        g.t += dt;
        const speed = 260;
        if (g.keys.l) g.px -= speed * dt * 1.6;
        if (g.keys.r) g.px += speed * dt * 1.6;
        g.px = Math.max(24, Math.min(W - 24, g.px));
        g.spawn -= dt;
        if (g.spawn <= 0) {
          g.spawn = Math.max(0.28, 0.85 - g.t * 0.012);
          const r = Math.random();
          g.drops.push({
            x: 20 + Math.random() * (W - 40),
            y: -20,
            vy: 120 + Math.random() * 80 + g.t * 3,
            kind: r < 0.18 ? 'bill' : r < 0.3 ? 'gold' : 'coin',
          });
        }
        let changed = false;
        g.drops = g.drops.filter((d) => {
          d.y += d.vy * dt;
          const caught = d.y > H - 62 && d.y < H - 12 && Math.abs(d.x - g.px) < 36;
          if (caught) {
            if (d.kind === 'bill') g.lives--;
            else g.score += d.kind === 'gold' ? 5 : 1;
            changed = true;
            return false;
          }
          if (d.y > H + 20) {
            if (d.kind !== 'bill') {
              g.lives--;
              changed = true;
            }
            return false;
          }
          return true;
        });
        if (changed) {
          setScore(g.score);
          setLives(Math.max(0, g.lives));
          if (g.lives <= 0) {
            g.running = false;
            setState('over');
            const prev = readBest();
            if (g.score > prev) {
              localStorage.setItem(KEY, String(g.score));
              setBest(g.score);
            }
          }
        }
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const keyHandler = (down: boolean) => (e: KeyboardEvent) => {
      const g = game.current;
      if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') { g.keys.l = down; if (g.running) e.preventDefault(); }
      if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') { g.keys.r = down; if (g.running) e.preventDefault(); }
    };
    const kd = keyHandler(true);
    const ku = keyHandler(false);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      cancelAnimationFrame(raf);
      game.current.running = false;
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, []);

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    game.current.px = ((e.clientX - r.left) / r.width) * W;
  };

  return (
    <div className="game">
      <div className="game-hud">
        <span>🪙 {score}</span>
        <span>{'❤️'.repeat(lives) || '💔'}</span>
        <span>🏆 {best}</span>
      </div>
      <div className="game-stage">
        <canvas ref={canvas} style={{ touchAction: 'none' }} onPointerMove={move} onPointerDown={move} aria-label="Coin catcher game" />
        {state !== 'playing' && (
          <div className="game-overlay">
            <h3>{state === 'over' ? 'Wallet is empty!' : 'Coin Catcher'}</h3>
            {state === 'over' && <p>You caught <b>{score}</b> {score === 1 ? 'coin' : 'coins'}.</p>}
            <p className="muted small">Move your finger, mouse or ← → to catch coins. Dodge 💸 bills. Missing a coin costs a life.</p>
            <button className="btn primary" onClick={start}>{state === 'over' ? 'Play again' : 'Start'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
