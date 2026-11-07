import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/martian-mono';
import './styles.css';
import { App } from './App';
import { Tooltips } from './Tooltips';
import { APP_NAME } from '../electron/shared';

document.documentElement.dataset.theme = window.omni?.initialTheme === 'dark' ? 'dark' : 'light';
document.title = APP_NAME;

createRoot(document.getElementById('root')!).render(<StrictMode><App /><Tooltips /></StrictMode>);
