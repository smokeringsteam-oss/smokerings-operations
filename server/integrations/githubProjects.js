const GRAPHQL_URL = 'https://api.github.com/graphql';

function getConfig() {
  const owner = process.env.GITHUB_OWNER || '';
  const repo = process.env.GITHUB_REPO || '';
  const projectNumber = Number(process.env.GITHUB_PROJECT_NUMBER || 0);
  const token = process.env.GITHUB_TOKEN || '';
  return {
    owner,
    repo,
    projectNumber,
    hasToken: Boolean(token),
    // "configured" means we have enough to talk to the project board.
    // repo is only required once we need to migrate drafts / read real issues.
    configured: Boolean(token && owner && projectNumber),
    repoConfigured: Boolean(token && owner && repo && projectNumber),
  };
}

async function graphql(query, variables) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    const err = new Error('GITHUB_TOKEN is not set.');
    err.status = 500;
    throw err;
  }
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await resp.json();
  if (json.errors && json.errors.length) {
    const messages = json.errors.map((e) => e.message).join('; ');
    const needsScope = /INSUFFICIENT_SCOPES|FORBIDDEN/i.test(json.errors.map((e) => e.type).join(','));
    const err = new Error(
      needsScope
        ? `GitHub token is missing a required scope: ${messages}`
        : `GitHub API error: ${messages}`,
    );
    err.status = needsScope ? 403 : 502;
    throw err;
  }
  return json.data;
}

let projectIdCache = null;
async function getProjectId() {
  if (projectIdCache) return projectIdCache;
  const { owner, projectNumber } = getConfig();
  const data = await graphql(
    `query($login: String!, $number: Int!) {
      user(login: $login) { projectV2(number: $number) { id } }
    }`,
    { login: owner, number: projectNumber },
  );
  const id = data?.user?.projectV2?.id;
  if (!id) {
    const err = new Error(`Project not found for ${owner} #${projectNumber}`);
    err.status = 404;
    throw err;
  }
  projectIdCache = id;
  return id;
}

const ASSIGNED_TO_FIELD_NAME = 'Assigned To';

async function getFields() {
  const projectId = await getProjectId();
  const data = await graphql(
    `query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 30) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2SingleSelectField { id name options { id name color } }
              ... on ProjectV2IterationField {
                id
                name
                configuration {
                  iterations { id title startDate duration }
                  completedIterations { id title startDate duration }
                }
              }
            }
          }
        }
      }
    }`,
    { projectId },
  );
  return data?.node?.fields?.nodes || [];
}

const SPRINT_FIELD_NAME = 'Sprint';

// The Sprint iteration field's current entry — the one whose [startDate, startDate+duration)
// window contains today. Falls back to null if no iteration covers today (e.g. between sprints).
async function getCurrentSprint() {
  const fields = await getFields();
  const sprintField = fields.find((f) => f.name === SPRINT_FIELD_NAME && f.__typename === 'ProjectV2IterationField');
  if (!sprintField) return null;

  const allIterations = [
    ...(sprintField.configuration?.iterations || []),
    ...(sprintField.configuration?.completedIterations || []),
  ];
  const todayMs = Date.now();
  const current = allIterations.find((it) => {
    const startMs = new Date(`${it.startDate}T00:00:00Z`).getTime();
    const endMs = startMs + it.duration * 24 * 60 * 60 * 1000;
    return todayMs >= startMs && todayMs < endMs;
  });
  if (!current) return null;

  const startMs = new Date(`${current.startDate}T00:00:00Z`).getTime();
  const endMs = startMs + current.duration * 24 * 60 * 60 * 1000 - 1;
  return {
    id: current.id,
    title: current.title,
    startDate: current.startDate,
    endDate: new Date(endMs).toISOString().slice(0, 10),
  };
}

async function ensureAssignedToField() {
  const fields = await getFields();
  const existing = fields.find((f) => f.name === ASSIGNED_TO_FIELD_NAME);
  if (existing) return existing;

  const projectId = await getProjectId();
  const data = await graphql(
    `mutation($projectId: ID!, $name: String!) {
      createProjectV2Field(input: { projectId: $projectId dataType: TEXT name: $name }) {
        projectV2Field { ... on ProjectV2FieldCommon { id name } }
      }
    }`,
    { projectId, name: ASSIGNED_TO_FIELD_NAME },
  );
  return data.createProjectV2Field.projectV2Field;
}

const DAY_FIELD_NAME = 'Day';
// All 7 days — Sprint Board cards can now be scheduled on weekends too, not just
// the office work week.
const WEEKDAY_OPTIONS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAY_COLORS = ['BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'PURPLE', 'RED', 'GRAY'];

async function ensureDayField() {
  const fields = await getFields();
  const existing = fields.find((f) => f.name === DAY_FIELD_NAME && f.__typename === 'ProjectV2SingleSelectField');

  if (existing) {
    const missing = WEEKDAY_OPTIONS.filter((name) => !(existing.options || []).some((o) => o.name === name));
    if (!missing.length) return existing;

    // The field already exists but predates one of the WEEKDAY_OPTIONS entries (e.g.
    // Saturday/Sunday added later) — replace the option set, keeping every existing
    // option by id (so cards already set to it stay set) and appending what's missing.
    const data = await graphql(
      `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
        updateProjectV2Field(input: { fieldId: $fieldId singleSelectOptions: $options }) {
          projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name color } } }
        }
      }`,
      {
        fieldId: existing.id,
        options: [
          ...existing.options.map((o) => ({ id: o.id, name: o.name, color: o.color, description: '' })),
          ...missing.map((name) => ({
            name,
            color: WEEKDAY_COLORS[WEEKDAY_OPTIONS.indexOf(name)] || 'GRAY',
            description: '',
          })),
        ],
      },
    );
    return data.updateProjectV2Field.projectV2Field;
  }

  const projectId = await getProjectId();
  const data = await graphql(
    `mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
      createProjectV2Field(input: { projectId: $projectId dataType: SINGLE_SELECT name: $name singleSelectOptions: $options }) {
        projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name color } } }
      }
    }`,
    {
      projectId,
      name: DAY_FIELD_NAME,
      options: WEEKDAY_OPTIONS.map((name, i) => ({ name, color: WEEKDAY_COLORS[i], description: '' })),
    },
  );
  return data.createProjectV2Field.projectV2Field;
}

const ITEMS_QUERY = `
  query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100) {
          nodes {
            id
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldIterationValue {
                  title
                  startDate
                  duration
                  field { ... on ProjectV2FieldCommon { name } }
                }
              }
            }
            content {
              __typename
              ... on Issue {
                id title number url state
                assignees(first: 5) { nodes { login } }
                parent { number title }
              }
              ... on DraftIssue { title body }
            }
          }
        }
      }
    }
  }
`;

function simplifyItem(node) {
  let status = null;
  let assignedTo = '';
  let sprintTitle = null;
  let day = null;
  node.fieldValues.nodes.forEach((fv) => {
    const fieldName = fv.field?.name;
    if (fieldName === 'Status') status = fv.name || null;
    if (fieldName === ASSIGNED_TO_FIELD_NAME) assignedTo = fv.text || '';
    if (fieldName === SPRINT_FIELD_NAME) sprintTitle = fv.title || null;
    if (fieldName === DAY_FIELD_NAME) day = fv.name || null;
  });

  const content = node.content || {};
  const isDraft = content.__typename === 'DraftIssue';

  return {
    id: node.id,
    // The issue's own GraphQL node id — distinct from `id` above (the project *item* id).
    // Needed as the parent/child argument to the addSubIssue mutation.
    issueId: isDraft ? null : content.id ?? null,
    status,
    assignedTo,
    sprintTitle,
    day,
    isDraft,
    title: content.title || '(untitled)',
    body: isDraft ? content.body || '' : undefined,
    number: isDraft ? null : content.number ?? null,
    url: isDraft ? null : content.url ?? null,
    state: isDraft ? null : content.state ?? null,
    assignees: isDraft ? [] : (content.assignees?.nodes || []).map((a) => a.login),
    parentNumber: isDraft ? null : content.parent?.number ?? null,
    parentTitle: isDraft ? null : content.parent?.title ?? null,
  };
}

async function getAllBoardItems() {
  const projectId = await getProjectId();
  const data = await graphql(ITEMS_QUERY, { projectId });
  const nodes = data?.node?.items?.nodes || [];
  return nodes.map(simplifyItem);
}

async function getSprintBoard() {
  return getAllBoardItems();
}

// The board is scoped to whichever Sprint iteration covers today — "every week we
// should track only that". Items with no Sprint value set, or set to a different
// iteration, don't show up here (they're still visible/editable on github.com).
async function getCurrentSprintBoard() {
  const sprint = await getCurrentSprint();
  const allItems = await getAllBoardItems();
  const items = sprint ? allItems.filter((item) => item.sprintTitle === sprint.title) : [];
  return { sprint, items };
}

async function setItemStatus(itemId, statusName) {
  const projectId = await getProjectId();
  const fields = await getFields();
  const statusField = fields.find((f) => f.name === 'Status');
  if (!statusField) {
    const err = new Error('This project has no "Status" field.');
    err.status = 404;
    throw err;
  }
  const option = (statusField.options || []).find((o) => o.name === statusName);
  if (!option) {
    const err = new Error(
      `"${statusName}" is not a valid Status option (available: ${(statusField.options || []).map((o) => o.name).join(', ')}).`,
    );
    err.status = 400;
    throw err;
  }
  await graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(
        input: { projectId: $projectId itemId: $itemId fieldId: $fieldId value: { singleSelectOptionId: $optionId } }
      ) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId: statusField.id, optionId: option.id },
  );
}

async function setItemAssignedTo(itemId, assignedTo) {
  const projectId = await getProjectId();
  const field = await ensureAssignedToField();
  await graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
      updateProjectV2ItemFieldValue(
        input: { projectId: $projectId itemId: $itemId fieldId: $fieldId value: { text: $text } }
      ) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId: field.id, text: assignedTo },
  );
}

// dayName === '' clears the field (moving a card back to "unscheduled") rather
// than erroring — every other value must match one of Monday-Friday exactly.
async function setItemDay(itemId, dayName) {
  const projectId = await getProjectId();
  const field = await ensureDayField();

  if (!dayName) {
    await graphql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
        clearProjectV2ItemFieldValue(input: { projectId: $projectId itemId: $itemId fieldId: $fieldId }) {
          projectV2Item { id }
        }
      }`,
      { projectId, itemId, fieldId: field.id },
    );
    return;
  }

  const option = (field.options || []).find((o) => o.name === dayName);
  if (!option) {
    const err = new Error(`"${dayName}" is not a valid Day (available: ${WEEKDAY_OPTIONS.join(', ')}).`);
    err.status = 400;
    throw err;
  }
  await graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(
        input: { projectId: $projectId itemId: $itemId fieldId: $fieldId value: { singleSelectOptionId: $optionId } }
      ) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId: field.id, optionId: option.id },
  );
}

// Puts an item into a specific Sprint iteration — used when filing a new task so it
// shows up on the current-sprint board immediately instead of landing in limbo.
async function setItemSprint(itemId, iterationId) {
  const projectId = await getProjectId();
  const fields = await getFields();
  const sprintField = fields.find((f) => f.name === SPRINT_FIELD_NAME && f.__typename === 'ProjectV2IterationField');
  if (!sprintField) {
    const err = new Error('This project has no "Sprint" iteration field.');
    err.status = 404;
    throw err;
  }
  await graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $iterationId: String!) {
      updateProjectV2ItemFieldValue(
        input: { projectId: $projectId itemId: $itemId fieldId: $fieldId value: { iterationId: $iterationId } }
      ) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId: sprintField.id, iterationId },
  );
}

// Real GitHub assignees live on the Issue itself, not the project item — PATCH replaces
// the full assignee list in one call (unlike the assignees-add REST endpoint, which only adds).
async function setItemAssignees(issueNumber, logins) {
  const { owner, repo, repoConfigured } = getConfig();
  if (!repoConfigured) {
    const err = new Error('GITHUB_REPO is not set — cannot set assignees.');
    err.status = 400;
    throw err;
  }
  await githubRest(`/repos/${owner}/${repo}/issues/${issueNumber}`, {}, { method: 'PATCH', body: { assignees: logins } });
}

// Collaborators with at least push access are who GitHub actually allows as assignees.
// Excludes the automation account itself so the dropdown only lists real teammates.
async function getAssignableUsers() {
  const { owner, repo, repoConfigured } = getConfig();
  if (!repoConfigured) return [];
  const collaborators = await githubRest(`/repos/${owner}/${repo}/collaborators`);
  return collaborators.filter((c) => c.permissions?.push && c.login !== owner).map((c) => c.login);
}

async function addDraftItem({ title, body = '', status, assignedTo }) {
  const projectId = await getProjectId();
  const data = await graphql(
    `mutation($projectId: ID!, $title: String!, $body: String) {
      addProjectV2DraftIssue(input: { projectId: $projectId title: $title body: $body }) {
        projectItem { id }
      }
    }`,
    { projectId, title, body },
  );
  const itemId = data.addProjectV2DraftIssue.projectItem.id;

  if (status) await setItemStatus(itemId, status);
  if (assignedTo) await setItemAssignedTo(itemId, assignedTo);

  return { id: itemId, title, body, status: status || null, assignedTo: assignedTo || '' };
}

let repoIdCache = null;
async function getRepositoryId() {
  if (repoIdCache) return repoIdCache;
  const { owner, repo } = getConfig();
  const data = await graphql(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { id }
    }`,
    { owner, name: repo },
  );
  const id = data?.repository?.id;
  if (!id) {
    const err = new Error(`Repository not found: ${owner}/${repo}`);
    err.status = 404;
    throw err;
  }
  repoIdCache = id;
  return id;
}

async function migrateDraftsToIssues() {
  const { repoConfigured } = getConfig();
  if (!repoConfigured) {
    const err = new Error('GITHUB_REPO is not set yet — nothing to migrate into.');
    err.status = 400;
    throw err;
  }
  const repositoryId = await getRepositoryId();
  const board = await getSprintBoard();
  const drafts = board.filter((item) => item.isDraft);

  const results = [];
  for (const draft of drafts) {
    try {
      const data = await graphql(
        `mutation($itemId: ID!, $repositoryId: ID!) {
          convertProjectV2DraftIssueItemToIssue(input: { itemId: $itemId repositoryId: $repositoryId }) {
            item {
              id
              content { ... on Issue { id number url title } }
            }
          }
        }`,
        { itemId: draft.id, repositoryId },
      );
      results.push({ title: draft.title, ok: true, issue: data.convertProjectV2DraftIssueItemToIssue.item.content });
    } catch (err) {
      results.push({ title: draft.title, ok: false, error: err.message });
    }
  }
  return results;
}

// Files a brand-new task as a real Issue, nests it under an existing top-level item via
// GitHub's sub-issue relationship, adds it to the board, and drops it straight into the
// current Sprint iteration — the one-shot version of what would otherwise be four manual
// steps on github.com (new issue, parent it, add to project, set Sprint).
async function createSubIssueTask({ parentIssueId, title, body = '', status, assignee }) {
  const { repoConfigured } = getConfig();
  if (!repoConfigured) {
    const err = new Error('GITHUB_REPO is not set — cannot create a real issue for a sub-task.');
    err.status = 400;
    throw err;
  }
  if (!parentIssueId) {
    const err = new Error('parentIssueId is required.');
    err.status = 400;
    throw err;
  }

  const sprint = await getCurrentSprint();
  if (!sprint) {
    const err = new Error('No Sprint iteration covers today — add one on the project\'s "Sprint" field first.');
    err.status = 400;
    throw err;
  }

  const repositoryId = await getRepositoryId();
  const projectId = await getProjectId();

  const created = await graphql(
    `mutation($repositoryId: ID!, $title: String!, $body: String) {
      createIssue(input: { repositoryId: $repositoryId title: $title body: $body }) {
        issue { id number url title state }
      }
    }`,
    { repositoryId, title, body },
  );
  const issue = created.createIssue.issue;

  await graphql(
    `mutation($issueId: ID!, $subIssueId: ID!) {
      addSubIssue(input: { issueId: $issueId subIssueId: $subIssueId }) {
        issue { id }
      }
    }`,
    { issueId: parentIssueId, subIssueId: issue.id },
  );

  const added = await graphql(
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId contentId: $contentId }) {
        item { id }
      }
    }`,
    { projectId, contentId: issue.id },
  );
  const itemId = added.addProjectV2ItemById.item.id;

  const finalStatus = status || 'Backlog';
  await setItemStatus(itemId, finalStatus);
  await setItemSprint(itemId, sprint.id);
  // Real GitHub assignee (same field the card's own "Assigned to" dropdown edits),
  // not the custom "Assigned To" text field — keeps a new task consistent with
  // every other card on the board.
  if (assignee) await setItemAssignees(issue.number, [assignee]);

  return {
    id: itemId,
    issueId: issue.id,
    title: issue.title,
    number: issue.number,
    url: issue.url,
    state: issue.state,
    status: finalStatus,
    assignedTo: '',
    sprintTitle: sprint.title,
    day: null,
    isDraft: false,
    assignees: assignee ? [assignee] : [],
  };
}

async function githubRest(path, params = {}, { method = 'GET', body } = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    const err = new Error('GITHUB_TOKEN is not set.');
    err.status = 500;
    throw err;
  }
  const url = new URL(`https://api.github.com${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) url.searchParams.set(key, value);
  });
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    // Empty repos 409 on the commits endpoint — callers treat that as "no activity".
    if (resp.status === 409) return [];
    const body = await resp.text().catch(() => '');
    const err = new Error(`GitHub API error (${resp.status}): ${body.slice(0, 300)}`);
    err.status = resp.status === 404 ? 404 : 502;
    throw err;
  }
  return resp.json();
}

export {
  getConfig,
  ensureDayField,
  getSprintBoard,
  getCurrentSprintBoard,
  setItemStatus,
  setItemAssignedTo,
  setItemDay,
  setItemAssignees,
  getAssignableUsers,
  addDraftItem,
  createSubIssueTask,
  migrateDraftsToIssues,
};
