import { useState } from 'react';
import B2BClients from './B2BClients';
import B2BSales from './B2BSales';
import SmokingSession from '../shared/SmokingSession';
import WeeklyPurchasing from '../shared/WeeklyPurchasing';

// The other dashboard under Ops (see OpsDashboard.tsx, which owns the sidebar
// ids). Landing page of module "boxes", exactly like the B2C Dashboard.
type B2BModule = 'home' | 'clients' | 'sales' | 'weeklyPurchasing' | 'smoking';

// The B2B side of the business: wholesale/corporate accounts rather than the
// weekend consumer orders the B2C dashboard runs. Two modules are B2B's own —
// Clients, the account book with its meat demand and the Sampling/Onboarding
// stages (B2BClients.tsx), and Sales & Payments, the revenue and receivables
// book behind it (B2BSales.tsx), which exists here and not on the B2C side
// because only wholesale gets paid on a cycle rather than at checkout. The
// other two are the same components the B2C dashboard runs, handed
// channel="B2B". That's the whole difference: B2B purchases and
// cooks go through identical flows into the same purchase_log.csv and
// smoking_log.csv, each row tagged with the channel so the two sides can
// still be told apart and totalled apart. What the channel changes is narrow
// and per-module — which purchases the spend panel counts
// (server/ops/shared/purchasing.js) and what a session defaults its purpose to
// (server/ops/shared/smoking.js). Orders are not run from here: the packing
// board lives on the B2C dashboard only.
const MODULES: { id: B2BModule; label: string; icon: string; stage: string; description: string }[] = [
  {
    id: 'clients',
    label: 'Clients',
    icon: '🤝',
    stage: 'Accounts',
    description:
      'Every wholesale and corporate account: contact details, the meat they want each week, and where they are in the Lead → Sampling → Onboarding → Active pipeline.',
  },
  {
    id: 'weeklyPurchasing',
    label: 'Weekly Purchasing',
    icon: '🛒',
    stage: 'Buy',
    description:
      'Log what was bought for B2B against the shared vendor and materials catalog, and send a draft PO to Odoo. Same stock pool as B2C — the channel tag is who the buy was for, not a separate cupboard.',
  },
  {
    id: 'smoking',
    label: 'Smoking Session',
    icon: '🔥',
    stage: 'Kitchen',
    description:
      'Sample trays and practice cooks for B2B accounts, through the same brine → rub → smoke → rest → shred stages as the weekend service. Every stage change is logged.',
  },
  {
    id: 'sales',
    label: 'Sales & Payments',
    icon: '💰',
    stage: 'Money',
    description:
      'What each account was billed and what has actually come in. Every delivery is due 15 days later by default, so the list doubles as the chase sheet: overdue first, longest overdue at the top.',
  },
];

const B2BDashboard = () => {
  const [openModule, setOpenModule] = useState<B2BModule>('home');

  const renderModule = () => {
    switch (openModule) {
      case 'clients':
        return <B2BClients />;
      case 'sales':
        return <B2BSales />;
      case 'weeklyPurchasing':
        return <WeeklyPurchasing channel="B2B" />;
      case 'smoking':
        return <SmokingSession channel="B2B" />;
      default:
        return null;
    }
  };

  return (
    <div className="marketing-dashboard">
      <header>
        <h2>B2B Dashboard</h2>
        <p>The wholesale and corporate side: who the accounts are, what meat they want, and how they get won.</p>
      </header>

      <div className="marketing-content">
        {openModule === 'home' ? (
          <div className="ops-flow-grid">
            {MODULES.map((mod) => (
              <button
                key={mod.label}
                type="button"
                className="ops-box"
                onClick={() => setOpenModule(mod.id)}
              >
                <span className="ops-box-step">{mod.stage}</span>
                <span className="ops-box-icon">{mod.icon}</span>
                <span className="ops-box-title">{mod.label}</span>
                <span className="ops-box-desc">{mod.description}</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <button type="button" className="ops-back-button" onClick={() => setOpenModule('home')}>
              ← Back to B2B Dashboard
            </button>
            {renderModule()}
          </>
        )}
      </div>
    </div>
  );
};

export default B2BDashboard;
