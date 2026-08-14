import { useState } from 'react';
import WeeklySprintDashboard, { type WeeklySprintSub, weeklySprintTools } from './pages/WeeklySprintDashboard';
import MarketingDashboard, { type MarketingSub, marketingTools } from './pages/MarketingDashboard';
import KitchenPrepDashboard, { type KitchenPrepSub, kitchenPrepTools } from './pages/KitchenPrepDashboard';
import OpsDashboard, { type OpsSub, opsTools } from './pages/OpsDashboard';
import ToolsDashboard, { type ToolsSub, toolsTools } from './pages/ToolsDashboard';

type ActiveTool = WeeklySprintSub | MarketingSub | KitchenPrepSub | OpsSub | ToolsSub;

const isWeeklySprintTool = (tool: ActiveTool): tool is WeeklySprintSub =>
  weeklySprintTools.some((item) => item.id === tool);

const isMarketingTool = (tool: ActiveTool): tool is MarketingSub =>
  marketingTools.some((item) => item.id === tool);

const isOpsTool = (tool: ActiveTool): tool is OpsSub => opsTools.some((item) => item.id === tool);

const isToolsTool = (tool: ActiveTool): tool is ToolsSub => toolsTools.some((item) => item.id === tool);

const App = () => {
  const [activeTool, setActiveTool] = useState<ActiveTool>('dailyView');

  return (
    <div className="app-shell">
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

          <span className="sidebar-section-label">Ops Dashboard</span>
          <div className="sidebar-submenu open">
            <ul>
              {opsTools.map((tool) => (
                <li key={tool.id} className={activeTool === tool.id ? 'active' : ''}>
                  <button type="button" onClick={() => setActiveTool(tool.id)}>
                    <span>{tool.icon}</span>
                    {tool.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <span className="sidebar-section-label">Kitchen Prep Automation</span>
          <div className="sidebar-submenu open">
            <ul>
              {kitchenPrepTools.map((tool) => (
                <li key={tool.id} className={activeTool === tool.id ? 'active' : ''}>
                  <button type="button" onClick={() => setActiveTool(tool.id)}>
                    <span>{tool.icon}</span>
                    {tool.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <span className="sidebar-section-label">Weekly Sprint Tasks</span>
          <div className="sidebar-submenu open">
            <ul>
              {weeklySprintTools.map((tool) => (
                <li key={tool.id} className={activeTool === tool.id ? 'active' : ''}>
                  <button type="button" onClick={() => setActiveTool(tool.id)}>
                    <span>{tool.icon}</span>
                    {tool.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <span className="sidebar-section-label">Marketing</span>
          <div className="sidebar-submenu open">
            <ul>
              {marketingTools.map((tool) => (
                <li key={tool.id} className={activeTool === tool.id ? 'active' : ''}>
                  <button type="button" onClick={() => setActiveTool(tool.id)}>
                    <span>{tool.icon}</span>
                    {tool.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <span className="sidebar-section-label">Tools</span>
          <div className="sidebar-submenu open">
            <ul>
              {toolsTools.map((tool) => (
                <li key={tool.id} className={activeTool === tool.id ? 'active' : ''}>
                  <button type="button" onClick={() => setActiveTool(tool.id)}>
                    <span>{tool.icon}</span>
                    {tool.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
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
          ) : (
            <KitchenPrepDashboard activeTool={activeTool} />
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
