import React, { useEffect, useMemo, useState } from 'react';

const LOCAL_STORAGE_KEY = 'reddit-posting-draft-v2';

const defaultGroups = [
  { id: 'bangalore', label: '/bangalore' },
  { id: 'bangalorefoodies', label: 'r/bangalorefoodies' },
  { id: 'bangaloremalayalis', label: 'r/BangaloreMalayalis' },
  { id: 'bangaloremarketplace', label: 'r/BangaloreMarketplace' },
  { id: 'bangaloresocial', label: 'r/BangaloreSocial' },
  { id: 'indiranagar', label: 'r/indiranagar' },
  { id: 'boredinbangalore', label: 'r/BoredInBangalore' },
];

type UploadedImage = {
  id: string;
  name: string;
  type: string;
  preview: string;
  file?: File | null;
};

type Group = {
  id: string;
  label: string;
};

type DraftData = {
  postText: string;
  groups: Group[];
  selectedGroups: string[];
  images: UploadedImage[];
  profilePath: string;
};

const RedditPostingPage: React.FC = () => {
  const [step, setStep] = useState(1);
  const [postText, setPostText] = useState('');
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [groups, setGroups] = useState<Group[]>(defaultGroups);
  const [selectedGroups, setSelectedGroups] = useState<string[]>(['smokeringsbbq']);
  const [newGroupLabel, setNewGroupLabel] = useState('');
  const [profilePath, setProfilePath] = useState('');
  const [status, setStatus] = useState('');
  const [isPosting, setIsPosting] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!stored) {
      return;
    }

    try {
      const parsed: DraftData = JSON.parse(stored);
      setPostText(parsed.postText || '');
      setGroups(parsed.groups?.length ? parsed.groups : defaultGroups);
      setSelectedGroups(parsed.selectedGroups || ['smokeringsbbq']);
      setImages(parsed.images || []);
      setProfilePath(parsed.profilePath || '');
    } catch {
      window.localStorage.removeItem(LOCAL_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    const draft: DraftData = {
      postText,
      groups,
      selectedGroups,
      images: images.map(({ id, name, type, preview }) => ({ id, name, type, preview })),
      profilePath,
    };
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(draft));
  }, [postText, groups, selectedGroups, images, profilePath]);

  const selectedLabels = useMemo(
    () => groups.filter((group) => selectedGroups.includes(group.id)).map((group) => group.label),
    [groups, selectedGroups],
  );

  const handleToggleGroup = (groupId: string) => {
    setSelectedGroups((current) =>
      current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId],
    );
  };

  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (!files.length) {
      return;
    }

    const newImages = await Promise.all(
      files.map(async (file) => {
        const preview = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });

        return {
          id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          type: file.type,
          preview,
          file,
        };
      }),
    );

    setImages((current) => [...current, ...newImages]);
    if (step === 1 && images.length === 0) {
      setStep(2);
    }
  };

  const handleRemoveImage = (imageId: string) => {
    setImages((current) => current.filter((image) => image.id !== imageId));
  };

  const handleClearDraft = () => {
    window.localStorage.removeItem(LOCAL_STORAGE_KEY);
    setPostText('');
    setSelectedGroups(['smokeringsbbq']);
    setImages([]);
    setStatus('Draft cleared.');
    setStep(1);
  };

  const handleNext = () => {
    if (step === 1) {
      setStep(2);
    } else if (step === 2) {
      setStep(3);
    }
  };

  const handleBack = () => {
    setStatus('');
    setStep((current) => Math.max(1, current - 1));
  };

  const handlePost = () => {
    (async () => {
      setIsPosting(true);
      setStatus('Posting to local Reddit poster...');

      try {
        const selected = groups.filter((g) => selectedGroups.includes(g.id)).map((g) => g.label || g.id);
        const normalized = selected.map((s) => s.replace(/^\/?r\/?/i, '').replace(/\//g, '')).filter(Boolean);
        if (normalized.length === 0) {
          setStatus('Select at least one valid subreddit before posting.');
          setIsPosting(false);
          return;
        }

        const validImages = images.filter((img) => img.file);
        if (images.length > 0 && validImages.length === 0) {
          setStatus('Images are present as previews but not attached to the post. Re-upload the images before posting.');
          setIsPosting(false);
          return;
        }

        const form = new FormData();
        form.append('title', postText.slice(0, 300));
        form.append('text', postText);
        form.append('subreddits', JSON.stringify(normalized));
        form.append('profilePath', profilePath);

        validImages.forEach((img) => {
          form.append('images', img.file!, img.name);
        });

        const resp = await fetch('/api/post-reddit', {
          method: 'POST',
          body: form,
        });
        if (resp.ok) {
          setStatus('Post queued on local server. Browser will open for posting.');
        } else {
          const txt = await resp.text();
          setStatus('Server error: ' + txt);
        }
      } catch (err) {
        setStatus('Error sending to local server: ' + String(err));
      } finally {
        setIsPosting(false);
      }
    })();
  };

  return (
    <div className="wizard-page">
      <div className="wizard-header">
        <h1>Reddit Posting</h1>
        <p>Follow the three-step wizard to prepare your Reddit content and send it through the Claude Chrome extension.</p>
      </div>

      <div className="wizard-shell">
        <div className="wizard-actions-top">
          <button type="button" className="secondary-button" onClick={handleClearDraft}>
            Clear saved draft
          </button>
        </div>

        <div className="wizard-steps">
          <div className={`wizard-step ${step === 1 ? 'active' : ''}`}>1. Content</div>
          <div className={`wizard-step ${step === 2 ? 'active' : ''}`}>2. Groups</div>
          <div className={`wizard-step ${step === 3 ? 'active' : ''}`}>3. Post</div>
        </div>

        <div className="wizard-card">
          {step === 1 && (
            <div>
              <h2>Step 1: Add text and images</h2>
              <label>
                Post text
                <textarea
                  value={postText}
                  onChange={(event) => setPostText(event.target.value)}
                  placeholder="Write your Reddit post text here..."
                />
              </label>
              <label>
                Chrome profile path
                <input
                  type="text"
                  value={profilePath}
                  onChange={(event) => setProfilePath(event.target.value)}
                  placeholder="C:\\Users\\<you>\\AppData\\Local\\Google\\Chrome\\User Data\\Default"
                />
              </label>
              <label>
                Upload images
                <input type="file" accept="image/*" multiple onChange={handleImageUpload} />
              </label>
              {images.length > 0 && (
                <div className="image-preview-grid">
                  {images.map((image) => (
                    <div key={image.id} className="image-preview-card">
                      <img src={image.preview} alt={image.name} />
                      <div className="image-preview-label">{image.name}</div>
                      <button type="button" className="remove-image-button" onClick={() => handleRemoveImage(image.id)}>
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div>
              <h2>Step 2: Confirm Reddit groups</h2>
              <p>Select the target subreddits you want this post to go to, or add new ones.</p>
              <div className="add-group-row">
                <input
                  type="text"
                  value={newGroupLabel}
                  onChange={(event) => setNewGroupLabel(event.target.value)}
                  placeholder="Add subreddit label, e.g. r/newsubreddit"
                />
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    const trimmedLabel = newGroupLabel.trim();
                    if (!trimmedLabel) {
                      return;
                    }
                    const normalizedId = trimmedLabel.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
                    if (!normalizedId || groups.some((group) => group.id === normalizedId)) {
                      setNewGroupLabel('');
                      return;
                    }
                    setGroups((current) => [...current, { id: normalizedId, label: trimmedLabel }]);
                    setSelectedGroups((current) => [...current, normalizedId]);
                    setNewGroupLabel('');
                  }}
                >
                  Add group
                </button>
              </div>
              <div className="group-list">
                {groups.map((group) => (
                  <div key={group.id} className="group-item-row">
                    <label className="group-item">
                      <input
                        type="checkbox"
                        checked={selectedGroups.includes(group.id)}
                        onChange={() => handleToggleGroup(group.id)}
                      />
                      {group.label}
                    </label>
                    <button
                      type="button"
                      className="secondary-button small"
                      onClick={() => {
                        setGroups((current) => current.filter((item) => item.id !== group.id));
                        setSelectedGroups((current) => current.filter((id) => id !== group.id));
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
              <p className="group-summary">
                Selected groups: {selectedLabels.length ? selectedLabels.join(', ') : 'None selected'}
              </p>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2>Step 3: Post with Claude Chrome extension</h2>
              <p>
                This final step sends your Reddit content to the Claude Chrome extension. The extension will handle the actual posting flow.
              </p>
              <div className="review-block">
                <h3>Review</h3>
                <p>
                  <strong>Text:</strong> {postText || 'No text entered yet.'}
                </p>
                <div>
                  <strong>Images:</strong>
                  {images.length > 0 ? (
                    <ul className="review-images-list">
                      {images.map((image) => (
                        <li key={image.id}>{image.name}</li>
                      ))}
                    </ul>
                  ) : (
                    ' No images uploaded yet.'
                  )}
                </div>
                <p>
                  <strong>Groups:</strong> {selectedLabels.length ? selectedLabels.join(', ') : 'None selected'}
                </p>
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={handlePost}
                disabled={!selectedGroups.length || isPosting}
              >
                {isPosting ? 'Posting…' : 'Post to selected Reddit groups'}
              </button>
              {status && <p className="status-message">{status}</p>}
            </div>
          )}
        </div>

        <div className="wizard-actions">
          {step > 1 && (
            <button type="button" className="secondary-button" onClick={handleBack}>
              Back
            </button>
          )}
          {step < 3 && (
            <button type="button" className="primary-button" onClick={handleNext}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default RedditPostingPage;
