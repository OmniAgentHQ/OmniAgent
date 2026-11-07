import agents from './assets/icons/agents.png';
import analytics from './assets/icons/analytics.png';
import automation from './assets/icons/automation.png';
import completed from './assets/icons/completed.png';
import connectAi from './assets/icons/connect-ai.png';
import data from './assets/icons/data.png';
import failed from './assets/icons/failed.png';
import fixDebug from './assets/icons/fix-debug.png';
import history from './assets/icons/history.png';
import graphics from './assets/icons/graphics.png';
import launch from './assets/icons/launch.png';
import memory from './assets/icons/memory.png';
import openFolder from './assets/icons/open-folder.png';
import processor from './assets/icons/processor.png';
import settings from './assets/icons/settings.png';
import stopped from './assets/icons/stopped.png';
import system from './assets/icons/system.png';

export const GLYPHS = {
  agents,
  analytics,
  automation,
  completed,
  connectAi,
  data,
  failed,
  fixDebug,
  history,
  graphics,
  launch,
  memory,
  openFolder,
  processor,
  settings,
  stopped,
  system
};

export type GlyphName = keyof typeof GLYPHS;

export function Glyph({ name, size = 18, className = '' }: { name: GlyphName; size?: number; className?: string }) {
  return <img className={`glyph ${className}`} src={GLYPHS[name]} width={size} height={size} alt="" draggable={false} />;
}
