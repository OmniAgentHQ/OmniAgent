import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Tip = { text: string; rect: DOMRect };

const GAP = 9;
const EDGE = 8;

function tipText(element: HTMLElement) {
  const title = element.getAttribute('title');
  if (title) {
    element.dataset.tip = title;
    element.removeAttribute('title');
    if (!element.hasAttribute('aria-label') && !element.textContent?.trim()) element.setAttribute('aria-label', title);
  }
  return (element.dataset.tip ?? '').trim();
}

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let anchor: HTMLElement | null = null;
    let timer = 0;
    let visible = false;
    const hide = () => {
      window.clearTimeout(timer);
      anchor = null;
      if (visible) { visible = false; setTip(null); }
    };
    const over = (event: PointerEvent) => {
      const target = (event.target instanceof Element ? event.target.closest('[title], [data-tip]') : null) as HTMLElement | null;
      if (target === anchor) return;
      window.clearTimeout(timer);
      const text = target ? tipText(target) : '';
      if (!target || !text) { hide(); return; }
      anchor = target;
      timer = window.setTimeout(() => {
        if (anchor !== target || !target.isConnected) return;
        visible = true;
        setTip({ text, rect: target.getBoundingClientRect() });
      }, visible ? 60 : 420);
    };
    const out = (event: PointerEvent) => { if (!event.relatedTarget) hide(); };
    const scrolled = (event: Event) => { if (anchor && event.target instanceof Node && event.target.contains(anchor)) hide(); };
    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('blur', hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      document.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!tip || !bubble) return;
    const { width, height } = bubble.getBoundingClientRect();
    const center = tip.rect.left + tip.rect.width / 2;
    const below = tip.rect.top - height - GAP < EDGE;
    const left = Math.min(Math.max(center - width / 2, EDGE), window.innerWidth - width - EDGE);
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(below ? tip.rect.bottom + GAP : tip.rect.top - height - GAP)}px`;
    bubble.style.setProperty('--arrow-x', `${Math.round(Math.min(Math.max(center - left, 12), width - 12))}px`);
    bubble.dataset.side = below ? 'below' : 'above';
    bubble.classList.add('shown');
  }, [tip]);

  if (!tip) return null;
  return createPortal(<div className="app-tip" role="tooltip" ref={bubbleRef} key={`${tip.text}-${tip.rect.left}-${tip.rect.top}`}>{tip.text}</div>, document.body);
}
