import LinkedInAutomation from './LinkedInAutomation';
import RedditPostingPage from './RedditPostingPage';
import RedditContentFeeder from './RedditContentFeeder';
import AISEO from './AISEO';

export type MarketingSub = 'linkedin' | 'redditPosting' | 'redditFeeder' | 'insta' | 'meta' | 'aiseo';

export const marketingTools: { id: MarketingSub; label: string; icon: string }[] = [
  { id: 'linkedin', label: 'LinkedIn Automation', icon: '💼' },
  { id: 'redditPosting', label: 'Reddit Posting', icon: '📮' },
  { id: 'redditFeeder', label: 'Reddit Content Feeder', icon: '🗂️' },
  { id: 'insta', label: 'Insta Reel Generator', icon: '🎬' },
  { id: 'meta', label: 'Meta Ad Creator', icon: '📢' },
  { id: 'aiseo', label: 'AI SEO', icon: '🔍' },
];

const ComingSoon = ({ label, icon }: { label: string; icon: string }) => (
  <div className="empty-state">
    <div className="empty-state-icon">{icon}</div>
    <h3>{label}</h3>
    <p>This tool is still being built out. Check back soon.</p>
    <span className="badge-soon">Coming soon</span>
  </div>
);

const MarketingDashboard = ({ activeTool }: { activeTool: MarketingSub }) => {
  const renderTool = () => {
    switch (activeTool) {
      case 'linkedin':
        return <LinkedInAutomation />;
      case 'redditPosting':
        return <RedditPostingPage />;
      case 'redditFeeder':
        return <RedditContentFeeder />;
      case 'aiseo':
        return <AISEO />;
      case 'insta':
        return <ComingSoon label="Insta Reel Generator" icon="🎬" />;
      case 'meta':
        return <ComingSoon label="Meta Ad Creator" icon="📢" />;
      default:
        return null;
    }
  };

  return (
    <div className="marketing-dashboard">
      <header>
        <h2>Marketing & Digital Presence</h2>
        <p>Choose a tool from the panel to open LinkedIn, Instagram, Reddit, Ads, or SEO automation.</p>
      </header>

      <div className="marketing-content">{renderTool()}</div>
    </div>
  );
};

export default MarketingDashboard;
