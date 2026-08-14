import SprintDashboard from './SprintDashboard';
import DailyView from './DailyView';

export type WeeklySprintSub = 'sprintBoard' | 'dailyView';

export const weeklySprintTools: { id: WeeklySprintSub; label: string; icon: string }[] = [
  { id: 'sprintBoard', label: 'Sprint Board', icon: '📊' },
  { id: 'dailyView', label: 'Daily View', icon: '📆' },
];

const WeeklySprintDashboard = ({ activeTool }: { activeTool: WeeklySprintSub }) => {
  const renderTool = () => {
    switch (activeTool) {
      case 'sprintBoard':
        return <SprintDashboard />;
      case 'dailyView':
        return <DailyView />;
      default:
        return null;
    }
  };

  return (
    <div className="marketing-dashboard">
      <header>
        <h2>Weekly Sprint Tasks</h2>
        <p>Pull this week's priorities from the backlog and track them here as they get done.</p>
      </header>

      <div className="marketing-content">{renderTool()}</div>
    </div>
  );
};

export default WeeklySprintDashboard;
