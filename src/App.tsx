import { useEffect, useState } from 'react';
import WeeklySprintDashboard, { type WeeklySprintSub, weeklySprintTools } from './pages/sprint/WeeklySprintDashboard';
import MarketingDashboard, { type MarketingSub, marketingTools } from './pages/marketing/MarketingDashboard';
import OpsDashboard, { type OpsSub, opsTools } from './pages/ops/OpsDashboard';
import ToolsDashboard, { type ToolsSub, toolsTools } from './pages/tools/ToolsDashboard';

// Weekend Prep Planner used to be its own top-level "Kitchen Prep Automation"
// sidebar entry; it now lives as the first step inside the B2C Dashboard's
// sequential weekend flow (see B2CDashboard.tsx) so the whole Fri plan → buy
// → smoke / Sat-Sun serve pipeline is one unified view.
type ActiveTool = WeeklySprintSub | MarketingSub | OpsSub | ToolsSub;

const isWeeklySprintTool = (tool: ActiveTool): tool is WeeklySprintSub =>
  weeklySprintTools.some((item) => item.id === tool);

const isMarketingTool = (tool: ActiveTool): tool is MarketingSub =>
  marketingTools.some((item) => item.id === tool);

const isOpsTool = (tool: ActiveTool): tool is OpsSub => opsTools.some((item) => item.id === tool);

const isToolsTool = (tool: ActiveTool): tool is ToolsSub => toolsTools.some((item) => item.id === tool);

const menuSections: { label: string; tools: { id: ActiveTool; label: string; icon: string }[] }[] = [
  { label: 'Ops Dashboard', tools: opsTools },
  { label: 'Weekly Sprint Tasks', tools: weeklySprintTools },
  { label: 'Marketing', tools: marketingTools },
  { label: 'Tools', tools: toolsTools },
];

const App = () => {
  const [activeTool, setActiveTool] = useState<ActiveTool>('dailyView');
  // Drawer state only matters at <= 720px, where the sidebar is off-canvas.
  const [menuOpen, setMenuOpen] = useState(false);

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
                        {tool.label}
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
          {isWeeklySprintTool(activeTool) ? (
            <WeeklySprintDashboard activeTool={activeTool} />
          ) : isMarketingTool(activeTool) ? (
            <MarketingDashboard activeTool={activeTool} />
          ) : isOpsTool(activeTool) ? (
            <OpsDashboard activeTool={activeTool} />
          ) : isToolsTool(activeTool) ? (
            <ToolsDashboard activeTool={activeTool} />
          ) : null}
        </div>
      </main>
    </div>
  );
};

export default App;
