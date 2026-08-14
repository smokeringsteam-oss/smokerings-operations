import React, { useState } from 'react';
import './App.css';
import RedditPostingPage from './pages/RedditPostingPage';

const App = () => {
  const [showWizard, setShowWizard] = useState(false);

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <div className="brand-badge">SB</div>
          <div>
            <h1>Smoke Rings BBQ</h1>
            <p>Automation</p>
          </div>
        </div>

        <div className="sidebar-menu">
          <span className="sidebar-label">Menu</span>
          <button
            className={`sidebar-button ${showWizard ? 'active' : ''}`}
            type="button"
            onClick={() => setShowWizard(true)}
          >
            Reddit posting
          </button>
        </div>
      </aside>

      <main className="app-main">
        {showWizard ? (
          <RedditPostingPage />
        ) : (
          <div className="page-content">
            <h2>Reddit posting</h2>
            <p>Click the Reddit posting button in the left panel to start the 3-step wizard.</p>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
