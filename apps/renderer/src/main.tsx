import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyTheme, readTheme } from './theme';
import './styles.css';

// 在首帧之前落主题，避免深色用户看到一闪而过的白屏
applyTheme(readTheme());

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
