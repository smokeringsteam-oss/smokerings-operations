import MarketingROI from './MarketingROI';
import QRLinkBuilder from './QRLinkBuilder';
import CustomerMap from './CustomerMap';
import InstaReelGenerator from './InstaReelGenerator';

export type MarketingSub = 'roi' | 'customerMap' | 'qrLinks' | 'insta';

export const marketingTools: { id: MarketingSub; label: string; icon: string }[] = [
  { id: 'roi', label: 'Marketing ROI', icon: '📈' },
  { id: 'customerMap', label: 'Customer Map', icon: '📍' },
  { id: 'qrLinks', label: 'QR & Link Builder', icon: '🔗' },
  { id: 'insta', label: 'Insta Reel Generator', icon: '🎬' },
];

const MarketingDashboard = ({ activeTool }: { activeTool: MarketingSub }) => {
  const renderTool = () => {
    switch (activeTool) {
      case 'roi':
        return <MarketingROI />;
      case 'customerMap':
        return <CustomerMap />;
      case 'qrLinks':
        return <QRLinkBuilder />;
      case 'insta':
        return <InstaReelGenerator />;
      default:
        return null;
    }
  };

  return (
    <div className="marketing-dashboard">
      <header>
        <h2>Marketing & Digital Presence</h2>
        <p>
          Choose a tool from the panel — Marketing ROI for what each channel earned against what it cost, the
          Customer Map for where those orders came from, the QR & Link Builder for tagging what we publish so it can
          be counted, or the Insta Reel Generator.
        </p>
      </header>

      <div className="marketing-content">{renderTool()}</div>
    </div>
  );
};

export default MarketingDashboard;
