import { useEffect, useState } from 'react';
import { PlugZap, RotateCcw, X } from 'lucide-react';
import { RunBlock } from './RunView';
import { type AgentRunView, type FinisherRunView, type PulseView, type RunView } from '../electron/shared';

export const DEMO_WRITER = { handle: 'Claude2', provider: 'Claude' as const, model: 'Claude Sonnet', name: 'a second Claude' };

const W = DEMO_WRITER.handle;

export const DEMO_PROMPT = `@ChatGPT make a logo with a transparent background and 4 social images @Claude build the landing page with smooth scroll effects @${W} write the landing page copy`;

const at = (offset: number) => new Date(Date.now() + offset).toISOString();

function agent(agentId: string, handle: string, provider: AgentRunView['provider'], model: string, assignment: string): AgentRunView {
  return { agentId, handle, provider, model, assignment, status: 'queued', activity: 'Getting ready', reasoning: '', steps: [], messages: [], partial: '', final: '', error: '', turns: 1, startedAt: '', finishedAt: '' };
}

function initialRun(): RunView {
  return {
    id: 'demo-run',
    sessionId: 'demo',
    prompt: DEMO_PROMPT,
    attachments: [],
    tags: ['ChatGPT', 'Claude', W],
    status: 'running',
    agents: [
      agent('d1', 'ChatGPT', 'OpenAI', 'GPT-5.6-Sol', 'make a logo with a transparent background and 4 social images'),
      agent('d2', 'Claude', 'Claude', 'Claude Opus', 'build the landing page with smooth scroll effects'),
      agent('d3', W, DEMO_WRITER.provider, DEMO_WRITER.model, 'write the landing page copy')
    ],
    pulses: [],
    notes: [],
    followUps: [],
    finisher: null,
    files: [],
    loopIteration: 0,
    startedAt: at(0),
    finishedAt: ''
  };
}

type Frame = { after: number; apply: (run: RunView) => void; pulse?: boolean };

const find = (run: RunView, handle: string) => run.agents.find((item) => item.handle === handle)!;
const work = (run: RunView, handle: string, activity: string) => {
  const entry = find(run, handle);
  entry.status = 'working';
  entry.activity = activity;
  entry.startedAt ||= at(0);
};
const step = (run: RunView, handle: string, id: string, label: string, status: 'running' | 'ok' = 'running', durationMs?: number) => {
  const entry = find(run, handle);
  const existing = entry.steps.find((item) => item.id === id);
  if (existing) {
    existing.status = status;
    existing.durationMs = durationMs;
  } else {
    entry.steps.push({ id, name: label, label, status, durationMs, at: at(0) });
  }
};
const finish = (run: RunView, handle: string, final: string) => {
  const entry = find(run, handle);
  for (const item of entry.steps) item.status = 'ok';
  entry.status = 'done';
  entry.activity = 'Done';
  entry.final = final;
  entry.messages.push({ text: final, at: at(0) });
  entry.finishedAt = at(0);
};
const report = (run: RunView, handle: string, text: string) => {
  const pulse = run.pulses.at(-1) as PulseView;
  const entry = find(run, handle);
  pulse.awaiting = pulse.awaiting.filter((item) => item !== handle);
  pulse.reports.push({ agentId: entry.agentId, handle, provider: entry.provider, text, source: 'agent', at: at(0) });
};

const FRAMES: Frame[] = [
  { after: 700, apply: (run) => { work(run, 'ChatGPT', 'Reading the request'); work(run, 'Claude', 'Reading the request'); work(run, W, 'Reading the request'); } },
  { after: 1500, apply: (run) => { work(run, 'ChatGPT', 'Designing the logo'); step(run, 'ChatGPT', 'g1', 'Generating the logo'); work(run, 'Claude', 'Checking the team board'); step(run, 'Claude', 'c1', 'Reading the team board'); work(run, W, 'Drafting the headline'); step(run, W, 'k1', 'Writing copy.md'); } },
  { after: 1700, apply: (run) => { step(run, 'Claude', 'c1', 'Reading the team board', 'ok', 600); work(run, 'Claude', 'Writing the page structure'); step(run, 'Claude', 'c2', 'Writing index.html'); run.notes.push({ id: 'n1', handle: 'Claude', provider: 'Claude', to: 'ChatGPT', text: 'Is the logo ready yet? I need it for the header — a transparent PNG would be perfect.', at: at(0) }); } },
  { after: 1600, apply: (run) => { run.notes.push({ id: 'n2', handle: W, provider: DEMO_WRITER.provider, text: 'Headline is “Moon, but make it friendly.” Full copy lands in copy.md.', at: at(0) }); } },
  { after: 900, apply: (run) => { run.notes.push({ id: 'n3', handle: 'ChatGPT', provider: 'OpenAI', to: 'Claude', text: 'Yes — images/logo.png is ready, transparent and 1024×1024.', at: at(0) }); } },
  { after: 1500, apply: (run) => { step(run, 'ChatGPT', 'g1', 'Generating the logo', 'ok', 4100); find(run, 'ChatGPT').messages.push({ text: 'Logo saved as a transparent PNG. Starting the social images.', at: at(0) }); work(run, 'ChatGPT', 'Generating social image 2 of 4'); step(run, 'ChatGPT', 'g2', 'Generating social images'); } },
  { after: 1500, pulse: true, apply: (run) => { run.pulses.push({ id: 'p1', at: at(0), reports: [], awaiting: ['ChatGPT', 'Claude', W] }); } },
  { after: 1100, apply: (run) => report(run, W, 'Copy is nearly done — headline, three feature blocks and an FAQ.') },
  { after: 700, apply: (run) => report(run, 'ChatGPT', 'Logo is done and transparent; two of the four social images are ready.') },
  { after: 700, apply: (run) => report(run, 'Claude', 'The page is built; adding the scroll effects next.') },
  { after: 1300, apply: (run) => finish(run, W, 'Wrote the landing page copy — headline, three feature blocks and an FAQ, saved as `copy.md`.') },
  { after: 1300, apply: (run) => { step(run, 'Claude', 'c2', 'Writing index.html', 'ok', 5200); step(run, 'Claude', 'c3', 'Adding scroll effects'); work(run, 'Claude', 'Wiring in the copy and the logo'); find(run, 'Claude').partial = `Pulling ${W}’s copy into the hero and adding a fade-in for each section…`; } },
  { after: 1700, apply: (run) => { step(run, 'ChatGPT', 'g2', 'Generating social images', 'ok', 6400); finish(run, 'ChatGPT', 'Made the logo and 4 social images at 1:1 in `images/`.'); } },
  { after: 1500, apply: (run) => { find(run, 'Claude').partial = ''; finish(run, 'Claude', 'Built the landing page — `site/index.html` with a parallax hero, scroll reveals and the real copy.'); } },
  { after: 600, apply: (run) => {
    run.status = 'finishing';
    run.finisher = { provider: 'Claude', model: 'Claude Opus', round: 1, rounds: 2, status: 'working', activity: 'Opening the page in a browser', steps: [{ id: 'f1', name: 'open_page', label: 'Opening the page in a browser', status: 'running', at: at(0) }], partial: '', final: '', verdict: '', fixes: [], error: '', startedAt: at(0), finishedAt: '' } satisfies FinisherRunView;
  } },
  { after: 1600, apply: (run) => { const finisher = run.finisher!; finisher.steps[0].status = 'ok'; finisher.steps.push({ id: 'f2', name: 'verify_image', label: 'Checking the images are transparent and 1:1', status: 'running', at: at(0) }); finisher.activity = 'Checking the images'; } },
  { after: 1500, apply: (run) => { const finisher = run.finisher!; finisher.steps[1].status = 'ok'; finisher.steps.push({ id: 'f3', name: 'edit_file', label: 'Replacing placeholder text in the hero', status: 'running', at: at(0) }); finisher.activity = 'Fixing a placeholder in the hero'; } },
  { after: 1500, apply: (run) => {
    const finisher = run.finisher!;
    for (const item of finisher.steps) item.status = 'ok';
    finisher.status = 'done';
    finisher.verdict = 'fixed';
    finisher.activity = 'Check complete';
    finisher.final = `Everything you asked for is here:\n\n- **Logo and 4 social images** — transparent, 1:1\n- **Landing page** — scroll effects, real copy, the new logo\n- **Fixed:** the hero still had placeholder text, so I swapped in ${W}’s headline`;
    finisher.finishedAt = at(0);
    run.status = 'done';
    run.finishedAt = at(0);
    run.files = ['images/logo.png', 'images/social-1.png', 'images/social-2.png', 'images/social-3.png', 'images/social-4.png', 'site/index.html', 'site/styles.css', 'copy.md'];
  } }
];

export function DemoStage({ connected, onClose, onTryForReal, onConnect, onAdvance }: { connected: boolean; onClose: () => void; onTryForReal: () => void; onConnect: () => void; onAdvance: () => void }) {
  const [run, setRun] = useState<RunView>(initialRun);
  const [pulseKey, setPulseKey] = useState('');
  const [round, setRound] = useState(0);

  useEffect(() => {
    setRun(initialRun());
    setPulseKey('');
    const timers: number[] = [];
    let elapsed = 0;
    for (const frame of FRAMES) {
      elapsed += frame.after;
      timers.push(window.setTimeout(() => {
        setRun((current) => {
          const next = structuredClone(current);
          frame.apply(next);
          return next;
        });
        if (frame.pulse) {
          setPulseKey(`demo-pulse-${round}`);
          timers.push(window.setTimeout(() => setPulseKey(''), 3_400));
        }
      }, elapsed));
    }
    return () => { for (const timer of timers) window.clearTimeout(timer); };
  }, [round]);

  useEffect(() => { onAdvance(); }, [run, onAdvance]);

  const done = run.status === 'done';
  return <div className="demo">
    <div className="demo-bar">
      <span className="demo-tag">Demo</span>
      <span className="demo-note">This is a recording of how a run looks. Nothing is running on your computer.</span>
      <span className="spacer" />
      <button type="button" className="btn small" onClick={() => setRound((value) => value + 1)}><RotateCcw size={13} />Replay</button>
      <button type="button" className="icon-btn small" title="Close the demo" onClick={onClose}><X size={14} /></button>
    </div>
    <RunBlock run={run} workspace="" pulseKey={pulseKey} demo />
    {done ? <div className="demo-end">
      <strong>That’s it — one message, three agents, one finished result.</strong>
      {connected
        ? <button type="button" className="btn-primary" onClick={onTryForReal}>Do this for real</button>
        : <button type="button" className="btn-primary" onClick={onConnect}><PlugZap size={15} />Connect an AI to do it for real</button>}
    </div> : null}
  </div>;
}
