import { Fragment, useState } from 'react';
import WeekendPrepPlanner from './WeekendPrepPlanner';
import WeeklyPurchasing from './WeeklyPurchasing';
import SmokingSession from './SmokingSession';
import OrderPacking from './OrderPacking';
import ServiceWeeks from './ServiceWeeks';
import MenuItems from './MenuItems';

// One of the two dashboards under Ops (see OpsDashboard.tsx, which owns the
// sidebar ids). Opens onto a landing page of module "boxes" (Weekend Prep,
// Purchasing, Smoking, …), each of which swaps in its own view below —
// sub-navigation between those modules lives entirely inside this component.
type B2CModule = 'home' | 'weekendPrep' | 'weeklyPurchasing' | 'smoking' | 'orderPacking';

// The B2C weekend flow, in the order it actually happens: plan the weekend's
// orders and shopping list, buy against that list, smoke on Friday, then pack
// and serve Sat/Sun. `day` is shown on each box so the sequence reads at a
// glance without leaving the landing page.
const MODULES: { id: B2CModule; label: string; icon: string; day: string; description: string; soon?: boolean }[] = [
  {
    id: 'weekendPrep',
    label: 'Weekend Prep Planner',
    icon: '🍖',
    day: 'Fri (plan)',
    description: 'Pull confirmed Sat/Sun orders from Odoo and turn them into a meat weight and shopping list for the weekend.',
  },
  {
    id: 'weeklyPurchasing',
    label: 'Weekly Purchasing',
    icon: '🛒',
    day: 'Fri (buy)',
    description: 'Log purchases from all three vendors against that shopping list, update inventory, and send a draft PO to Odoo.',
  },
  {
    id: 'smoking',
    label: 'Smoking Session',
    icon: '🔥',
    day: 'Fri (smoke)',
    description: 'Start a session with raw weight, rub and pitmaster, then complete it with finished weight and quality notes.',
  },
  {
    id: 'orderPacking',
    label: 'Order Packing',
    icon: '📦',
    day: 'Sat–Sun (serve)',
    description: 'Sat/Sun Lunch & Dinner orders, what to pack for each item, pack order, and which orders to combine.',
  },
];

const B2CDashboard = () => {
  const [openModule, setOpenModule] = useState<B2CModule>('home');

  const renderModule = () => {
    switch (openModule) {
      case 'weekendPrep':
        return <WeekendPrepPlanner />;
      case 'weeklyPurchasing':
        return <WeeklyPurchasing />;
      case 'smoking':
        return <SmokingSession />;
      case 'orderPacking':
        return <OrderPacking />;
      default:
        return null;
    }
  };

  return (
    <div className="marketing-dashboard">
      <header>
        <h2>B2C Dashboard</h2>
        <p>The B2C weekend flow, start to finish: plan orders, buy against them, smoke, then pack and serve.</p>
      </header>

      <div className="marketing-content">
        {openModule === 'home' ? (
          <>
            {/* Whether the week is serviceable at all gates every step below
                it, so it sits above the flow rather than inside one module. */}
            <ServiceWeeks />
            {/* The dishes themselves, one tier below "is the week open at
                all" — catalog upkeep rather than part of the weekend flow.
                Scoped to the B2C channel, so the bulk wholesale products
                (Finished Products / B2B Wholesale in Odoo) stay off this
                editor and belong to the B2B dashboard instead. */}
            <MenuItems channel="b2c" />
            <div className="ops-flow-grid">
              {MODULES.map((mod, index) => (
                <Fragment key={mod.id}>
                  <button type="button" className="ops-box" onClick={() => setOpenModule(mod.id)}>
                    <span className="ops-box-step">
                      Step {index + 1} · {mod.day}
                    </span>
                    <span className="ops-box-icon">{mod.icon}</span>
                    <span className="ops-box-title">
                      {mod.label}
                      {mod.soon && <span className="badge-soon ops-box-badge">Coming soon</span>}
                    </span>
                    <span className="ops-box-desc">{mod.description}</span>
                  </button>
                  {index < MODULES.length - 1 && (
                    <span className="ops-flow-arrow" aria-hidden="true">
                      →
                    </span>
                  )}
                </Fragment>
              ))}
            </div>
          </>
        ) : (
          <>
            <button type="button" className="ops-back-button" onClick={() => setOpenModule('home')}>
              ← Back to B2C Dashboard
            </button>
            {renderModule()}
          </>
        )}
      </div>
    </div>
  );
};

export default B2CDashboard;
