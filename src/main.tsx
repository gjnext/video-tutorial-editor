import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { App } from './App';
import { Hud } from './Hud';

import { editor, useEditor } from './state/store';
import { playhead } from './state/playhead';
import { player } from './engine/player';
import * as actions from './state/actions';
import * as compose from '../shared/compose';
import * as geometry from '../shared/geometry';
import * as time from '../shared/time';
import { perf } from './engine/perf';

// Renderer-local debug handle (used by the automated e2e driver; grants no privileges).
(window as unknown as Record<string, unknown>).__studioDebug = { editor, useEditor, playhead, player, actions, compose, geometry, time, perf };

const isHud = location.hash === '#hud';
createRoot(document.getElementById('root')!).render(<StrictMode>{isHud ? <Hud /> : <App />}</StrictMode>);
