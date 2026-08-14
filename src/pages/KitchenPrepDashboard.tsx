import WeekendPrepPlanner from './WeekendPrepPlanner';

export type KitchenPrepSub = 'weekendPrep';

export const kitchenPrepTools: { id: KitchenPrepSub; label: string; icon: string }[] = [
  { id: 'weekendPrep', label: 'Weekend Prep Planner', icon: '🍖' },
];

const KitchenPrepDashboard = ({ activeTool }: { activeTool: KitchenPrepSub }) => {
  const renderTool = () => {
    switch (activeTool) {
      case 'weekendPrep':
        return <WeekendPrepPlanner />;
      default:
        return null;
    }
  };

  return (
    <div className="marketing-dashboard">
      <header>
        <h2>Kitchen Prep Automation</h2>
        <p>Log weekend orders and turn them into a meat weight and inventory shopping list for the kitchen.</p>
      </header>

      <div className="marketing-content">{renderTool()}</div>
    </div>
  );
};

export default KitchenPrepDashboard;
