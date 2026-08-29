import B2CDashboard from './b2c/B2CDashboard';
import B2BDashboard from './b2b/B2BDashboard';

// Ops is one sidebar section holding the two sides of the business as separate
// dashboards: B2C (the weekend consumer flow) and B2B (wholesale/corporate).
// This component owns both sidebar ids and just routes to the right child —
// each child renders its own header and module landing page.
export type OpsSub = 'b2cDashboard' | 'b2bDashboard';

export const opsTools: { id: OpsSub; label: string; icon: string }[] = [
  { id: 'b2cDashboard', label: 'B2C Dashboard', icon: '🧭' },
  { id: 'b2bDashboard', label: 'B2B Dashboard', icon: '🏢' },
];

const OpsDashboard = ({ activeTool }: { activeTool: OpsSub }) => {
  switch (activeTool) {
    case 'b2bDashboard':
      return <B2BDashboard />;
    case 'b2cDashboard':
    default:
      return <B2CDashboard />;
  }
};

export default OpsDashboard;
