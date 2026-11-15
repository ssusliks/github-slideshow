import './ui/style.css';
import { App } from './ui/app';

const app = new App();
(window as any).__app = app; // debugging / automated tests
app.boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('boot');
  if (el) el.textContent = 'Failed to start. Please restart the game.';
});
