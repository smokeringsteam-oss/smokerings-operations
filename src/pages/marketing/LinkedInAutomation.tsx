import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FC, KeyboardEvent } from 'react';

const LOCAL_STORAGE_KEY = 'linkedin-content-studio-draft-v1';

type ChatRole = 'user' | 'assistant';

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
};

type MediaAsset = {
  id: string;
  name: string;
  type: string;
  kind: 'image' | 'video';
  preview: string;
  file?: File | null;
};

type DraftData = {
  chatMessages: ChatMessage[];
  title: string;
  body: string;
  hashtags: string[];
  media: MediaAsset[];
};

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const LinkedInAutomation: FC = () => {
  const [step, setStep] = useState(1);

  // Step 1: brainstorm chat
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState('');
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Step 2: draft
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState('');

  // Step 3: media
  const [media, setMedia] = useState<MediaAsset[]>([]);

  const [copyStatus, setCopyStatus] = useState('');

  useEffect(() => {
    const stored = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!stored) return;
    try {
      const parsed: DraftData = JSON.parse(stored);
      setChatMessages(parsed.chatMessages || []);
      setTitle(parsed.title || '');
      setBody(parsed.body || '');
      setHashtags(parsed.hashtags || []);
      setMedia((parsed.media || []).map((m) => ({ ...m, file: null })));
    } catch {
      window.localStorage.removeItem(LOCAL_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    const draft: DraftData = {
      chatMessages,
      title,
      body,
      hashtags,
      media: media.map(({ id, name, type, kind, preview }) => ({ id, name, type, kind, preview })),
    };
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(draft));
  }, [chatMessages, title, body, hashtags, media]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, chatLoading]);

  // Agent 2 works from this conversation, so it needs at least one exchange
  // to have anything to synthesize a brief from.
  const hasAssistantReply = useMemo(() => chatMessages.some((m) => m.role === 'assistant'), [chatMessages]);

  const sendChatMessage = async () => {
    const trimmed = chatInput.trim();
    if (!trimmed || chatLoading) return;

    const userMessage: ChatMessage = { id: makeId(), role: 'user', content: trimmed };
    const nextMessages = [...chatMessages, userMessage];
    setChatMessages(nextMessages);
    setChatInput('');
    setChatError('');
    setChatLoading(true);

    try {
      const resp = await fetch('/api/gemini/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Gemini request failed.');
      setChatMessages((current) => [...current, { id: makeId(), role: 'assistant', content: data.reply }]);
    } catch (err) {
      setChatError(String((err as Error).message || err));
    } finally {
      setChatLoading(false);
    }
  };

  const handleChatKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage();
    }
  };

  // Pulls the last week of commits/closed issues/PRs from the configured
  // GitHub repo and drops them into the chat input as the "what happened"
  // input for a build-in-public recap post — review/edit before sending.
  const pullGithubActivity = async () => {
    setGithubLoading(true);
    setGithubError('');
    try {
      const resp = await fetch('/api/github/recent-activity?days=7');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not fetch GitHub activity.');
      setChatInput(
        `What happened: here's what happened in our repo this past week —\n\n${data.summaryText}\n\nPost angle: a numbers-transparency / behind-the-scenes update.\nCTA target: fellow founders.`,
      );
    } catch (err) {
      setGithubError(String((err as Error).message || err));
    } finally {
      setGithubLoading(false);
    }
  };

  const generateDraft = async () => {
    setDraftLoading(true);
    setDraftError('');
    try {
      // Agent 2 is a multi-step pipeline (brief -> insights -> draft ->
      // refine-if-needed) that works from this chat conversation — send the
      // full transcript so it has the actual topic/details/CTA to work with.
      const resp = await fetch('/api/gemini/generate-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: chatMessages.map(({ role, content }) => ({ role, content })),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Gemini request failed.');
      setTitle(data.title || '');
      setBody(data.body || '');
      setHashtags(data.hashtags || []);
      setStep(2);
    } catch (err) {
      setDraftError(String((err as Error).message || err));
    } finally {
      setDraftLoading(false);
    }
  };

  const handleMediaUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (!files.length) return;

    const newAssets = await Promise.all(
      files.map(async (file) => {
        const preview = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        return {
          id: makeId(),
          name: file.name,
          type: file.type,
          kind: (file.type.startsWith('video/') ? 'video' : 'image') as MediaAsset['kind'],
          preview,
          file,
        };
      }),
    );

    setMedia((current) => [...current, ...newAssets]);
    event.target.value = '';
  };

  const handleRemoveMedia = (id: string) => {
    setMedia((current) => current.filter((asset) => asset.id !== id));
  };

  const handleStartOver = () => {
    window.localStorage.removeItem(LOCAL_STORAGE_KEY);
    setChatMessages([]);
    setChatInput('');
    setChatError('');
    setTitle('');
    setBody('');
    setHashtags([]);
    setDraftError('');
    setMedia([]);
    setCopyStatus('');
    setStep(1);
  };

  const fullPostText = useMemo(() => {
    const tagLine = hashtags.length ? `\n\n${hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ')}` : '';
    return `${title}\n\n${body}${tagLine}`.trim();
  }, [title, body, hashtags]);

  const handleCopyPost = async () => {
    try {
      await navigator.clipboard.writeText(fullPostText);
      setCopyStatus('Post copied to clipboard.');
    } catch {
      setCopyStatus('Could not copy automatically — select and copy the text below.');
    }
  };

  const missingMediaFiles = media.length > 0 && media.every((asset) => !asset.file);

  return (
    <div className="wizard-page">
      <div className="wizard-header">
        <h1>LinkedIn Automation — Content Studio</h1>
        <p>Chat with Gemini to figure out what to post about, then a multi-step agent turns it into a draft, attach your photo or video, then review before posting.</p>
      </div>

      <div className="wizard-shell">
        <div className="wizard-steps">
          <div className={`wizard-step ${step === 1 ? 'active' : ''}`}>1. Chat</div>
          <div className={`wizard-step ${step === 2 ? 'active' : ''}`}>2. Draft</div>
          <div className={`wizard-step ${step === 3 ? 'active' : ''}`}>3. Media</div>
          <div className={`wizard-step ${step === 4 ? 'active' : ''}`}>4. Review</div>
        </div>

        <div className="wizard-card">
          {step === 1 && (
            <div>
              <h2>Step 1: Chat with Gemini</h2>
              <p>
                Talk it through like you would with a sharp colleague — describe an idea, react to something that happened, or paste in
                context. Once you've landed on a direction, hand it off to the post-writing agent below.
              </p>

              <div className="chat-window">
                {chatMessages.length === 0 && (
                  <div className="chat-empty">Try: "We just added a new smoked brisket sandwich, help me brainstorm a post."</div>
                )}
                {chatMessages.map((message) => (
                  <div key={message.id} className={`chat-message ${message.role}`}>
                    <div className="chat-message-role">{message.role === 'user' ? 'You' : 'Gemini'}</div>
                    <div className="chat-message-bubble">{message.content}</div>
                  </div>
                ))}
                {chatLoading && (
                  <div className="chat-message assistant">
                    <div className="chat-message-role">Gemini</div>
                    <div className="chat-message-bubble chat-typing">Thinking…</div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {chatError && <p className="status-message chat-error">{chatError}</p>}

              <div className="wizard-actions-top">
                <button type="button" className="secondary-button" onClick={pullGithubActivity} disabled={githubLoading}>
                  {githubLoading ? 'Pulling last week from GitHub…' : "📋 Summarize last week's GitHub activity"}
                </button>
              </div>
              {githubError && <p className="status-message chat-error">{githubError}</p>}

              <div className="chat-input-row">
                <textarea
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  onKeyDown={handleChatKeyDown}
                  placeholder="Type an idea for Gemini to brainstorm... (Enter to send, Shift+Enter for a new line)"
                  rows={2}
                />
                <button type="button" className="primary-button" onClick={sendChatMessage} disabled={chatLoading || !chatInput.trim()}>
                  Send
                </button>
              </div>

              {draftError && <p className="status-message chat-error">{draftError}</p>}

              <div className="wizard-actions-top">
                <button
                  type="button"
                  className="primary-button"
                  onClick={generateDraft}
                  disabled={!hasAssistantReply || chatLoading || draftLoading}
                >
                  {draftLoading ? 'Writing…' : 'Hand off to the post-writing agent →'}
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2>Step 2: Review and edit the short post</h2>
              <p>
                A multi-step agent read your chat, distilled it into a brief, pulled out the most endearing detail, and wrote it up as
                a founder-voice post capped at 400 characters. Edit anything before moving on.
              </p>
              <label>
                Opening line (optional — the short post below is usually meant to stand alone)
                <input
                  type="text"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Leave blank unless you want a separate hook line"
                />
              </label>
              <label>
                Post body
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="Full post text"
                  rows={10}
                />
                <span className={`char-counter ${body.length > 400 ? 'char-counter-over' : ''}`}>{body.length} / 400 characters</span>
              </label>
              <label>
                Hashtags (comma separated)
                <input
                  type="text"
                  value={hashtags.join(', ')}
                  onChange={(event) =>
                    setHashtags(
                      event.target.value
                        .split(',')
                        .map((tag) => tag.trim().replace(/^#/, ''))
                        .filter(Boolean),
                    )
                  }
                  placeholder="bbq, smokerings, localfood"
                />
              </label>
              <div className="wizard-actions-top">
                <button type="button" className="secondary-button" onClick={generateDraft} disabled={draftLoading}>
                  {draftLoading ? 'Regenerating…' : 'Regenerate from chat'}
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2>Step 3: Add a photo or video</h2>
              <p>Attach the media that matches this story.</p>
              <label>
                Upload photo or video
                <input type="file" accept="image/*,video/*" multiple onChange={handleMediaUpload} />
              </label>
              {media.length > 0 && (
                <div className="image-preview-grid">
                  {media.map((asset) => (
                    <div key={asset.id} className="image-preview-card">
                      {asset.kind === 'video' ? (
                        <video src={asset.preview} controls muted />
                      ) : (
                        <img src={asset.preview} alt={asset.name} />
                      )}
                      <div className="image-preview-label">{asset.name}</div>
                      <button type="button" className="remove-image-button" onClick={() => handleRemoveMedia(asset.id)}>
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === 4 && (
            <div>
              <h2>Step 4: Review</h2>
              <div className="review-block">
                <h3>Post preview</h3>
                <div className="review-text review-title">{title || '(no hook line)'}</div>
                <div className="review-text">{body || '(no body)'}</div>
                {hashtags.length > 0 && (
                  <p className="chat-hashtags">{hashtags.map((h) => `#${h}`).join(' ')}</p>
                )}
                <p>
                  <strong>Media:</strong>{' '}
                  {media.length
                    ? media.map((asset) => asset.name).join(', ')
                    : 'None attached.'}
                </p>
                {missingMediaFiles && (
                  <p className="status-message chat-error">
                    Media previews were restored from a saved draft; re-upload the files before posting.
                  </p>
                )}
              </div>
              <div className="wizard-actions-top">
                <button type="button" className="primary-button" onClick={handleCopyPost}>
                  Copy post text
                </button>
              </div>
              {copyStatus && <p className="status-message">{copyStatus}</p>}
              <p className="status-message">
                Automated publishing to LinkedIn isn't wired up yet — copy the text above (and download the media) to post manually,
                the same way Reddit posting started as a manual flow before automation was added.
              </p>
            </div>
          )}

          <div className="wizard-actions-bottom">
            <button type="button" className="secondary-button" onClick={handleStartOver}>
              Start over
            </button>
          </div>
        </div>

        <div className="wizard-actions">
          {step > 1 && (
            <button type="button" className="secondary-button" onClick={() => setStep((current) => current - 1)}>
              Back
            </button>
          )}
          {step === 2 && (
            <button type="button" className="primary-button" onClick={() => setStep(3)}>
              Next
            </button>
          )}
          {step === 3 && (
            <button type="button" className="primary-button" onClick={() => setStep(4)}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default LinkedInAutomation;
