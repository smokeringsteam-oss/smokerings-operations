import B2CDashboard from './b2c/B2CDashboard';
import B2BDashboard from './b2b/B2BDashboard';
import WhatsAppInbox from './shared/WhatsAppInbox';

// Ops is one sidebar section holding the two sides of the business as separate
// dashboards: B2C (the weekend consumer flow) and B2B (wholesale/corporate),
// plus the WhatsApp Inbox that cuts across both. This component owns those
// sidebar ids and just routes to the right child — each child renders its own
// header and module landing page.
export type OpsSub = 'b2cDashboard' | 'b2bDashboard' | 'whatsappInbox';

export const opsTools: { id: OpsSub; label: string; icon: string }[] = [
  { id: 'b2cDashboard', label: 'B2C Dashboard', icon: '🧭' },
  { id: 'b2bDashboard', label: 'B2B Dashboard', icon: '🏢' },
  // Sits alongside the two rather than inside either: a WhatsApp thread is a
  // customer waiting, and which side of the business they came from is not
  // something you know before opening it.
  { id: 'whatsappInbox', label: 'WhatsApp Inbox', icon: '💬' },
];

const OpsDashboard = ({ activeTool }: { activeTool: OpsSub }) => {
  switch (activeTool) {
    case 'b2bDashboard':
      return <B2BDashboard />;
    case 'whatsappInbox':
      return <WhatsAppInbox />;
    case 'b2cDashboard':
    default:
      return <B2CDashboard />;
  }
};

export default OpsDashboard;
