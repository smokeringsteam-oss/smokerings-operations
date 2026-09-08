import { Fragment } from 'react';
import { usePersistedChoice } from '../../../lib/usePersistedChoice';
import WeekendPrepPlanner from './WeekendPrepPlanner';
import WeeklyPurchasing from '../shared/WeeklyPurchasing';
import SmokingSession from '../shared/SmokingSession';
import SmokerStatus from '../shared/SmokerStatus';
import OrderManagement from '../shared/OrderManagement';
import ServiceWeeks from './ServiceWeeks';
import MenuItems from '../menu/MenuItems';

// One of the two dashboards under Ops (see OpsDashboard.tsx, which owns the
// sidebar ids). Opens onto a landing page of three choices — Service Weeks,
// Edit Menu, Start Prep — each of which swaps in its own view below.
// Sub-navigation between all of them lives entirely inside this component.
//
// The landing page used to render Service Weeks and the menu editor inline
// above the flow, which meant every visit scrolled past a month grid and a
// menu panel to reach the weekend flow. They're choices now, combined into
// the same box grid the flow steps use, so the three things you can start
// from the B2C dashboard read as one set.
type SetupView = 'serviceWeeks' | 'menu';
type FlowModule = 'weekendPrep' | 'weeklyPurchasing' | 'smoking' | 'smokerStatus' | 'orderManagement';
type B2CView = 'home' | SetupView | 'prep' | FlowModule;

// The three ways into the B2C dashboard. The first two are setup — which
// weekends are open, and what the dishes are — and the third opens the
// weekend flow itself (MODULES below).
const OPTIONS: { id: SetupView | 'prep'; label: string; icon: string; tag: string; description: string }[] = [
  {
    id: 'serviceWeeks',
    label: 'Service Weeks',
    icon: '🗓',
    tag: 'Setup',
    description:
      'Which weekends the kitchen is open for, and the menu each one sells. Gates everything below it — a closed week has no orders to plan for.',
  },
  {
    id: 'menu',
    label: 'Edit Menu',
    icon: '🍽',
    tag: 'Setup',
    description:
      'The dishes themselves — name, price, description, picture and availability — written straight to the Odoo product. B2C only; bulk wholesale lives on the B2B dashboard.',
  },
  {
    id: 'prep',
    label: 'Start Prep',
    icon: '🍖',
    tag: 'Weekend flow',
    description:
      'The five-step weekend run: plan Sat/Sun orders, buy against the list, smoke on Friday, put the day’s meat on, then pack and serve.',
  },
];

// The B2C weekend flow, in the order it actually happens: plan the weekend's
// orders and shopping list, buy against that list, smoke on Friday, then pack
// and serve Sat/Sun. `day` is shown on each box so the sequence reads at a
// glance without leaving the flow page.
const MODULES: { id: FlowModule; label: string; icon: string; day: string; description: string; soon?: boolean }[] = [
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
    id: 'smokerStatus',
    label: 'Set Smoker Status',
    icon: '🔥',
    day: 'Sat–Sun (light)',
    description:
      'Put the day’s meat on — one switch for pork and one for beef, separately for Saturday’s and Sunday’s orders, moving every order carrying that meat to IN_SMOKER.',
  },
  {
    id: 'orderManagement',
    label: 'Order Management',
    icon: '📦',
    day: 'Sat–Sun (serve)',
    description: 'Sat/Sun Lunch & Dinner orders and their fulfilment status, from prepping through packing to delivery.',
  },
];

// Where each view's back button goes, and what it says. A flow module steps
// back to the flow it was opened from rather than all the way home, so
// leaving Smoking Session doesn't cost a second click to get to Purchasing.
const BACK_TO: Record<Exclude<B2CView, 'home'>, { view: B2CView; label: string }> = {
  serviceWeeks: { view: 'home', label: '← Back to B2C Dashboard' },
  menu: { view: 'home', label: '← Back to B2C Dashboard' },
  prep: { view: 'home', label: '← Back to B2C Dashboard' },
  weekendPrep: { view: 'prep', label: '← Back to Prep steps' },
  weeklyPurchasing: { view: 'prep', label: '← Back to Prep steps' },
  smoking: { view: 'prep', label: '← Back to Prep steps' },
  smokerStatus: { view: 'prep', label: '← Back to Prep steps' },
  orderManagement: { view: 'prep', label: '← Back to Prep steps' },
};

// BACK_TO already names every view that is not 'home', so the list of valid
// views comes from it rather than being spelled out a second time and left to
// drift.
const B2C_VIEWS = ['home', ...(Object.keys(BACK_TO) as Exclude<B2CView, 'home'>[])] as B2CView[];

const B2CDashboard = () => {
  // Which step you were on, kept across a reload — see usePersistedChoice.
  // Going back to 'home' is stored too: it is a choice like any other, and a
  // reload after stepping out should not drop you back into the module you
  // just left.
  const [view, setView] = usePersistedChoice<B2CView>('smokerings.b2c.view', 'home', B2C_VIEWS);

  const renderFlowGrid = () => (
    <div className="ops-flow-grid">
      {MODULES.map((mod, index) => (
        <Fragment key={mod.id}>
          <button type="button" className="ops-box" onClick={() => setView(mod.id)}>
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
  );

  const renderView = () => {
    switch (view) {
      case 'serviceWeeks':
        return <ServiceWeeks />;
      case 'menu':
        return <MenuItems channel="b2c" />;
      case 'prep':
        return renderFlowGrid();
      case 'weekendPrep':
        return <WeekendPrepPlanner />;
      case 'weeklyPurchasing':
        return <WeeklyPurchasing />;
      case 'smoking':
        return <SmokingSession />;
      case 'smokerStatus':
        return <SmokerStatus />;
      case 'orderManagement':
        return <OrderManagement />;
      default:
        return null;
    }
  };

  const back = view === 'home' ? null : BACK_TO[view];

  return (
    <div className="marketing-dashboard">
      <header>
        <h2>B2C Dashboard</h2>
        <p>The B2C weekend flow, start to finish: plan orders, buy against them, smoke, then pack and serve.</p>
      </header>

      <div className="marketing-content">
        {view === 'home' ? (
          <div className="ops-flow-grid">
            {OPTIONS.map((option) => (
              <button key={option.id} type="button" className="ops-box" onClick={() => setView(option.id)}>
                <span className="ops-box-step">{option.tag}</span>
                <span className="ops-box-icon">{option.icon}</span>
                <span className="ops-box-title">{option.label}</span>
                <span className="ops-box-desc">{option.description}</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            {back && (
              <button type="button" className="ops-back-button" onClick={() => setView(back.view)}>
                {back.label}
              </button>
            )}
            {renderView()}
          </>
        )}
      </div>
    </div>
  );
};

export default B2CDashboard;
