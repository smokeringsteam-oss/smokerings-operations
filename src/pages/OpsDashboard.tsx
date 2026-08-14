import { useState } from 'react';
import WeeklyPurchasing from './WeeklyPurchasing';
import SmokingSession from './SmokingSession';

// Sidebar-level id — the Ops Dashboard is a single sidebar entry that opens
// onto a landing page of module "boxes" (Purchasing, Smoking, …), each of
// which swaps in its own view below. Sub-navigation between those modules
// lives entirely inside this component, not in the sidebar.
export type OpsSub = 'dashboard';

export const opsTools: { id: OpsSub; label: string; icon: string }[] = [{ id: 'dashboard', label: 'Dashboard', icon: '🧭' }];

type OpsModule = 'home' | 'weeklyPurchasing' | 'smoking';

const MODULES: { id: OpsModule; label: string; icon: string; description: string; soon?: boolean }[] = [
  {
    id: 'weeklyPurchasing',
    label: 'Weekly Purchasing',
    icon: '🛒',
    description: 'Log purchases from all three vendors, update inventory, and send a draft PO to Odoo.',
  },
  {
    id: 'smoking',
    label: 'Smoking Session',
    icon: '🔥',
    description: 'Start a session with raw weight, rub and pitmaster, then complete it with finished weight and quality notes.',
  },
];

const OpsDashboard = ({ activeTool: _activeTool }: { activeTool: OpsSub }) => {
  const [openModule, setOpenModule] = useState<OpsModule>('home');

  const renderModule = () => {
    switch (openModule) {
      case 'weeklyPurchasing':
        return <WeeklyPurchasing />;
      case 'smoking':
        return <SmokingSession />;
      default:
        return null;
    }
  };

  return (
    <div className="marketing-dashboard">
      <header>
        <h2>Ops Dashboard</h2>
        <p>Weekly purchasing, meat weight logs and smoking sessions — the day-to-day kitchen operations.</p>
      </header>

      <div className="marketing-content">
        {openModule === 'home' ? (
          <div className="ops-box-grid">
            {MODULES.map((mod) => (
              <button key={mod.id} type="button" className="ops-box" onClick={() => setOpenModule(mod.id)}>
                <span className="ops-box-icon">{mod.icon}</span>
                <span className="ops-box-title">
                  {mod.label}
                  {mod.soon && <span className="badge-soon ops-box-badge">Coming soon</span>}
                </span>
                <span className="ops-box-desc">{mod.description}</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <button type="button" className="ops-back-button" onClick={() => setOpenModule('home')}>
              ← Back to Ops Dashboard
            </button>
            {renderModule()}
          </>
        )}
      </div>
    </div>
  );
};

export default OpsDashboard;
