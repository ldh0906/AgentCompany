import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import { applyTheme, savedTheme } from './theme.ts';

// 그리기 전에 테마를 정한다(다크를 고른 사람에게 화이트가 한 번 번쩍이지 않게)
applyTheme(savedTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
