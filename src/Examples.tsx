import { ArrowUpRight } from 'lucide-react';
import { Glyph, type GlyphName } from './Glyph';
import { PROVIDER_LOGOS } from './ui';
import { DEMO_WRITER } from './Demo';
import { PROVIDER_INFO, type Provider, type TeamConfig } from '../electron/shared';

type Example = { title: string; description: string; icon: GlyphName; text: string };

export function examplesFor(team: TeamConfig): Example[] {
  const handle = (index: number, fallback: Provider) => team.agents[index]?.handle ?? PROVIDER_INFO[fallback].handle;
  const first = handle(0, 'OpenAI');
  const second = handle(1, 'Claude');
  const third = team.agents[2]?.handle ?? '';
  return [
    {
      title: 'Launch a product',
      description: 'Logo, images, website and copy',
      icon: 'automation',
      text: `@${first} make a logo with a transparent background and a few launch images, save them in the workspace under images @${second} build the website in plain JavaScript with smooth effects${third ? ` @${third} write the landing page copy` : ' and write the landing page copy'}`
    },
    {
      title: 'Research and report',
      description: 'Find the facts, get a polished PDF',
      icon: 'data',
      text: `@${first} research the five best-reviewed standing desks under $500 and save a comparison table @${second} turn the table into a one-page buyer’s guide PDF`
    },
    {
      title: 'Fix up a project',
      description: 'Find and fix what is broken',
      icon: 'fixDebug',
      text: '@all audit this project folder: find bugs, add tests for what is untested, and fix what you find'
    }
  ];
}

export function Starter({ team, onPick, onDemo }: { team: TeamConfig; onPick: (text: string) => void; onDemo?: () => void }) {
  return <div className="starter">
    <div className="starter-inner">
      {onDemo ? <button type="button" className="demo-strip" onClick={onDemo}>
        <span className="demo-play"><Glyph name="launch" size={38} /></span>
        <span className="demo-copy">
          <strong>Watch it work</strong>
          <span>See ChatGPT, Claude and {DEMO_WRITER.name} build a launch kit together in about 25 seconds.</span>
        </span>
        <span className="logo-stack">{(['OpenAI', 'Claude', DEMO_WRITER.provider] as Provider[]).map((provider, index) => <img key={index} src={PROVIDER_LOGOS[provider]} alt={PROVIDER_INFO[provider].label} />)}</span>
        <span className="demo-badge">No setup needed</span>
      </button> : null}
      <span className="label">Or start from an example</span>
      <div className="examples">
        {examplesFor(team).map((example) => <button type="button" className="example" key={example.title} onClick={() => onPick(example.text)}>
          <span className="example-head">
            <Glyph name={example.icon} size={26} />
            <strong>{example.title}</strong>
            <ArrowUpRight size={15} className="example-arrow" />
          </span>
          <span className="example-text">{example.description}</span>
        </button>)}
      </div>
    </div>
  </div>;
}
