import { useEffect, useState } from 'react';
import WeeklySprintDashboard, { type WeeklySprintSub, weeklySprintTools } from './pages/sprint/WeeklySprintDashboard';
import MarketingDashboard, { type MarketingSub, marketingTools } from './pages/marketing/MarketingDashboard';
import OpsDashboard, { type OpsSub, opsTools } from './pages/ops/OpsDashboard';
import FinanceDashboard, { type FinanceSub, financeTools } from './pages/finance/FinanceDashboard';
import Overview from './pages/overview/Overview';
import IdeaBoard from './pages/overview/IdeaBoard';
import { usePersistedChoice } from './lib/usePersistedChoice';
import { useWhatsappAttentionCount } from './lib/useWhatsappAttention';
import NotesBubble from './components/NotesBubble';
import VoiceCommand from './components/VoiceCommand';
import WhatsappAlarm from './components/WhatsappAlarm';

// Weekend Prep Planner used to be its own top-level "Kitchen Prep Automation"
// sidebar entry; it now lives as the first step inside the B2C Dashboard's
// sequential weekend flow (see B2CDashboard.tsx) so the whole Fri plan → buy
// → smoke / Sat-Sun serve pipeline is one unified view.
type ActiveTool = 'overview' | 'ideaBoard' | WeeklySprintSub | MarketingSub | OpsSub | FinanceSub;

const isWeeklySprintTool = (tool: ActiveTool): tool is WeeklySprintSub =>
  weeklySprintTools.some((item) => item.id === tool);

const isMarketingTool = (tool: ActiveTool): tool is MarketingSub =>
  marketingTools.some((item) => item.id === tool);

const isOpsTool = (tool: ActiveTool): tool is OpsSub => opsTools.some((item) => item.id === tool);

const isFinanceTool = (tool: ActiveTool): tool is FinanceSub =>
  financeTools.some((item) => item.id === tool);

const menuSections: { label: string; tools: { id: ActiveTool; label: string; icon: string }[] }[] = [
  // First, because it is where the app opens: the one-page answer to "how are
  // we doing", with a way into each screen behind it.
  {
    label: 'Overview',
    tools: [
      { id: 'overview', label: 'Overview', icon: '🏠' },
      { id: 'ideaBoard', label: 'Idea Board', icon: '💡' },
    ],
  },
  { label: 'Ops Dashboard', tools: opsTools },
  { label: 'Weekly Sprint Tasks', tools: weeklySprintTools },
  { label: 'Marketing', tools: marketingTools },
  // Finance sits below the two halves of the business it adds up — the order
  // the sections are read in.
  { label: 'Finance', tools: financeTools },
];

// Every sidebar id there is, derived from the sections rather than written
// out again — a tool added to a section is a tool this will accept back from
// storage, with nothing to keep in step.
const ALL_TOOL_IDS = menuSections.flatMap((section) => section.tools.map((tool) => tool.id));

const ACTIVE_TOOL_KEY = 'smokerings.activeTool';

// Sidebar entries that carry a live count. The bubble has to live out here
// rather than inside the screen it belongs to: a customer waiting on WhatsApp
// is worth seeing while you are on the packing board or halfway through a
// smoking session, which is exactly when nobody is looking at the inbox. The
// count comes from a single app-wide poll (see useWhatsappAttention.ts), so
// the bubble and the list behind it can never disagree.
const BADGED_TOOL: ActiveTool = 'whatsappInbox';

const App = () => {
  // Which screen you were on, remembered for this tab only. Opening the app
  // fresh — a new tab, the Android app relaunched — lands on the Overview; a
  // reload, or a phone bringing a discarded tab back, keeps you where you were.
  const [activeTool, setActiveTool] = usePersistedChoice<ActiveTool>(ACTIVE_TOOL_KEY, 'overview', ALL_TOOL_IDS, 'session');
  // Drawer state only matters at <= 720px, where the sidebar is off-canvas.
  const [menuOpen, setMenuOpen] = useState(false);
  // Conversations still waiting on a reply, polled for the whole session.
  const whatsappAttention = useWhatsappAttentionCount();
  // A day someone asked the mic to show ("what's left today?").
  // `at` makes asking for the same day twice a new request, so Daily View
  // jumps back to it even after a tab has been clicked in between.
  const [dailyFocus, setDailyFocus] = useState<{ date: string; at: number } | null>(null);

  const activeLabel =
    menuSections.flatMap((section) => section.tools).find((tool) => tool.id === activeTool)?.label ?? 'Menu';

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  return (
    <div className={`app-shell${menuOpen ? ' menu-open' : ''}`}>
      <header className="mobile-topbar">
        <button
          type="button"
          className="mobile-menu-toggle"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">{menuOpen ? '✕' : '☰'}</span>
        </button>
        <span className="mobile-topbar-title">{activeLabel}</span>
        {/* On a phone the sidebar is off-canvas, so the bubble on the menu
            entry is invisible until you go looking. This is the same count on
            the button that opens it. */}
        {whatsappAttention > 0 ? (
          <span
            className="wa-bubble wa-bubble-topbar"
            aria-label={`${whatsappAttention} WhatsApp ${whatsappAttention === 1 ? 'conversation' : 'conversations'} needing attention`}
          >
            {whatsappAttention > 99 ? '99+' : whatsappAttention}
          </span>
        ) : null}
      </header>

      <div
        className="sidebar-backdrop"
        role="presentation"
        onClick={() => setMenuOpen(false)}
      />

      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <div className="brand-badge">🔥</div>
          <div>
            <h1>Smoke Rings BBQ</h1>
            <p>Automation</p>
          </div>
        </div>

        <div className="sidebar-menu">
          <span className="sidebar-label">Menu</span>

          {menuSections.map((section) => (
            <div key={section.label}>
              <span className="sidebar-section-label">{section.label}</span>
              <div className="sidebar-submenu open">
                <ul>
                  {section.tools.map((tool) => (
                    <li key={tool.id} className={activeTool === tool.id ? 'active' : ''}>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveTool(tool.id);
                          setMenuOpen(false);
                        }}
                      >
                        <span>{tool.icon}</span>
                        <span className="sidebar-item-label">{tool.label}</span>
                        {tool.id === BADGED_TOOL && whatsappAttention > 0 ? (
                          <span
                            className="wa-bubble"
                            aria-label={`${whatsappAttention} WhatsApp ${whatsappAttention === 1 ? 'conversation' : 'conversations'} needing attention`}
                          >
                            {whatsappAttention > 99 ? '99+' : whatsappAttention}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <main className="app-main">
        <div className="page-area">
          {activeTool === 'overview' ? (
            <Overview onOpen={(tool) => setActiveTool(tool)} />
          ) : activeTool === 'ideaBoard' ? (
            <IdeaBoard />
          ) : isWeeklySprintTool(activeTool) ? (
            <WeeklySprintDashboard activeTool={activeTool} dailyFocus={dailyFocus} />
          ) : isMarketingTool(activeTool) ? (
            <MarketingDashboard activeTool={activeTool} />
          ) : isOpsTool(activeTool) ? (
            <OpsDashboard activeTool={activeTool} />
          ) : isFinanceTool(activeTool) ? (
            <FinanceDashboard activeTool={activeTool} />
          ) : null}
        </div>
      </main>

      {/* Pinned to the top-right of the viewport rather than dropped into the
          topbar, because the topbar only exists on a phone — on a desktop the
          sidebar is the chrome and there is nothing across the top to sit in.
          Fixed, so the same bubble is in the same corner on both, and so a
          note stays one tap away however far down a page you have scrolled. */}
      <NotesBubble />

      {/* The mic beside it: say a purchase or a to-do instead of typing it, or
          ask what is on for a day and land on Daily View. */}
      <VoiceCommand
        onShowTasks={(date) => {
          setActiveTool('dailyView');
          setMenuOpen(false);
          setDailyFocus({ date, at: Date.now() });
        }}
      />

      {/* Renders nothing until a WhatsApp alarm is actually sounding. Mounted
          at the shell for the same reason the badge is: the message that needs
          answering never arrives while you are on the inbox screen. Opening
          the inbox from it switches tools AND stops the noise — see the
          component. */}
      <WhatsappAlarm onOpenInbox={() => setActiveTool(BADGED_TOOL)} />
    </div>
  );
};

export default App;
