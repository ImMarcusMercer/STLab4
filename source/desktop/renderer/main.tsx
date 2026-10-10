import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionApp } from './SessionApp';
import './styles.css';
import './liquid-glass.css';

createRoot(document.getElementById('root')!).render(<StrictMode><SessionApp /></StrictMode>);
