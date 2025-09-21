import React from 'react';
import './index.css'; // tailwind styles
import { createRoot } from 'react-dom/client';

function App() {
  return (
    <div style={{ padding: 16 }}>
      <h1>Workspace</h1>
      <p>Edit this app as your workspace content.</p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

