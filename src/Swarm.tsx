import { useEffect, useRef } from 'react';
import logo from './assets/logo.png';
import { PROVIDER_LOGOS } from './ui';
import { PROVIDER_INFO, type Provider } from '../electron/shared';

const CREW: Provider[] = ['Claude', 'OpenAI', 'Claude', 'OpenAI', 'Claude', 'OpenAI'];

const W = 1000;
const H = 560;
const CENTER = { x: W / 2, y: H / 2 };

const SPOTS = CREW.map((provider, index) => {
  const angle = -Math.PI / 2 + index * 2 * Math.PI / CREW.length;
  return { provider, x: CENTER.x + Math.cos(angle) * 400, y: CENTER.y + Math.sin(angle) * 218 };
});

function nodeLabel(index: number) {
  const { provider } = SPOTS[index];
  const count = SPOTS.slice(0, index + 1).filter((spot) => spot.provider === provider).length;
  return `${PROVIDER_INFO[provider].label}${count > 1 ? ` ${count}` : ''}`;
}

function wirePath(spot: { x: number; y: number }) {
  const bend = Math.abs(spot.x - CENTER.x) < 1 ? 70 : 0;
  const controlX = (spot.x + CENTER.x) / 2 + bend;
  const controlY = bend ? (spot.y + CENTER.y) / 2 : spot.y;
  return `M ${spot.x} ${spot.y} Q ${controlX} ${controlY} ${CENTER.x} ${CENTER.y}`;
}

const ease = (value: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, value)), 3);

export function Swarm() {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = box.current;
    if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const paths = [...root.querySelectorAll<SVGPathElement>('path')];
    const nodes = [...root.querySelectorAll<HTMLElement>('.swarm-node')];
    const core = root.querySelector<HTMLElement>('.swarm-core');
    const spark = root.querySelector<HTMLElement>('.swarm-spark');
    const chip = root.querySelector<HTMLElement>('.swarm-chip');
    const chipLogos = chip ? [...chip.querySelectorAll('img')] : [];
    if (!core || !spark || !chip) return;
    let alive = true;
    let last = -1;
    const place = (point: DOMPoint) => {
      for (const element of [spark, chip]) {
        element.style.left = `${point.x / W * 100}%`;
        element.style.top = `${point.y / H * 100}%`;
      }
    };
    const travel = (path: SVGPathElement, duration: number, reverse: boolean) => new Promise<void>((resolve) => {
      const length = path.getTotalLength();
      const start = performance.now();
      const step = (now: number) => {
        if (!alive) { resolve(); return; }
        const progress = ease((now - start) / duration);
        place(path.getPointAtLength((reverse ? 1 - progress : progress) * length));
        if (progress < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    const wait = (milliseconds: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, milliseconds); });
    const send = async () => {
      let from = Math.floor(Math.random() * SPOTS.length);
      if (from === last) from = (from + 3) % SPOTS.length;
      const to = (from + 2 + Math.floor(Math.random() * (SPOTS.length - 3))) % SPOTS.length;
      last = to;
      chipLogos[0].src = PROVIDER_LOGOS[SPOTS[from].provider];
      chipLogos[1].src = PROVIDER_LOGOS[SPOTS[to].provider];
      nodes[from].classList.add('talking');
      paths[from].classList.add('flow');
      spark.classList.add('on');
      chip.classList.add('on');
      await travel(paths[from], 1300, false);
      paths[from].classList.remove('flow');
      nodes[from].classList.remove('talking');
      core.classList.remove('go');
      void core.offsetWidth;
      core.classList.add('go');
      await wait(260);
      paths[to].classList.add('flow');
      await travel(paths[to], 1300, true);
      spark.classList.remove('on');
      chip.classList.remove('on');
      nodes[to].classList.add('heard');
      await wait(700);
      paths[to].classList.remove('flow');
      nodes[to].classList.remove('heard');
    };
    void (async () => {
      await wait(500);
      while (alive) {
        await send();
        await wait(900);
      }
    })();
    return () => { alive = false; };
  }, []);

  return <div className="swarm" ref={box} aria-hidden="true">
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="swarmGrad" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#0b5cff" />
          <stop offset="1" stopColor="#46d1ff" />
        </linearGradient>
      </defs>
      {SPOTS.map((spot, index) => <path key={index} d={wirePath(spot)} />)}
    </svg>
    <div className="swarm-core"><img src={logo} alt="" /></div>
    {SPOTS.map((spot, index) => <div className="swarm-node" key={index} style={{ left: `${spot.x / W * 100}%`, top: `${spot.y / H * 100}%` }}>
      <span className="swarm-orb"><img src={PROVIDER_LOGOS[spot.provider]} alt="" draggable={false} /></span>
      <b>{nodeLabel(index)}</b>
    </div>)}
    <i className="swarm-spark" />
    <span className="swarm-chip"><img alt="" /><i>→</i><img alt="" /></span>
  </div>;
}
