import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { addDays, isoDay, parseIsoDay, todayIso } from '../../lib/localDay';
import { usePersistedChoice } from '../../lib/usePersistedChoice';
import { readNotesAuthor, useSharedNotes } from '../../lib/useSharedNotes';
import { useTodayTasks } from '../../lib/useTodayTasks';

// The Overview — the screen the app opens on. Tasks per person, the orders and
// the meat in them, the money, and the site's traffic, for one week or one
// month. Every figure is read through the screen that owns it (see
// server/overview/overview.js), so this page only ever summarises; the
// buttons under each card go to the screen that explains.

type View = 'week' | 'month';

type Task = {
  id: string;
  label: string;
  category: string;
  time: string;
  done: boolean;
};
type Todo = {
  id: number;
  body: string;
  dueDate: string;
  overdue: boolean;
  fromAlert?: boolean;
  done?: boolean;
};
type Person = {
  name: string;
  today: Task[];
  todayDone: number;
  week: { done: number; total: number };
  todos: Todo[];
};
type Failed = { error: string; configured?: undefined };
// `unassigned`: to-dos a push alert filed, before anyone has taken them.
type Tasks = {
  weekday: string;
  today: string;
  people: Person[];
  unassigned?: Todo[];
};

type Meat = {
  animal: string;
  portions: number;
  wholesale: Record<string, number>;
  cuts: { cut: string; portions: number; wholesale: Record<string, number> }[];
  dishes: { name: string; channel: string; units: number; unitLabel: string }[];
};
type Orders = {
  error: string;
  odooConfigured: boolean;
  orders: number;
  b2cOrders: number;
  b2bOrders: number;
  b2cPortions: number;
  revenue: number;
  b2cRevenue: number;
  b2bRevenue: number;
  meats: Meat[];
  meatlessItems: number;
  topDishes: { name: string; units: number; revenue: number }[];
};

type MoneyFigures = {
  spend: number;
  sales: number;
  net: number;
  investment: number;
  investmentBuys: number;
  practice: number;
  materials: number;
  marketing: number;
  labour: number;
  misc: number;
  services: number;
  uncategorised: number;
};
type Money = {
  error: string;
  covered: { from: string; to: string };
  period: MoneyFigures;
  weeks: { weekStart: string; label: string; spend: number; sales: number }[];
  sinceLaunch: (MoneyFigures & { from: string; truncated: boolean }) | null;
};

type TrafficTotals = {
  sessions: number;
  users: number;
  newUsers: number;
  keyEvents: number;
};
type Traffic =
  | { configured: false; error: string }
  | { configured: true; future: true }
  | {
      configured: true;
      future?: undefined;
      through: string;
      totals: TrafficTotals;
      previous: TrafficTotals;
      previousSpan: { from: string; to: string };
      sources: { label: string; sessions: number; rawSources: string[] }[];
      places: {
        city: string;
        country: string;
        users: number;
        sessions: number;
      }[];
      daily: { date: string; users: number; sessions: number }[];
      landingPages: { page: string; users: number; sessions: number }[];
    };

type OverviewData = {
  period: { view: View; from: string; to: string; label: string };
  tasks: Tasks | Failed;
  orders: Orders | Failed;
  money: Money | Failed;
  traffic: Traffic | Failed;
  fetchedAt: string;
};

export type OverviewTarget = 'dailyView' | 'itemSales' | 'spendVsSales' | 'roi';

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
// For the phone tab bar, where a figure gets a quarter of the width: ₹1.2L, ₹45k.
const inrShort = (n: number) => {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(abs >= 1000000 ? 0 : 1)}L`;
  if (abs >= 1000) return `${sign}₹${Math.round(abs / 1000)}k`;
  return `${sign}₹${Math.round(abs)}`;
};
const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
// A section the server could not build comes back as nothing but its error;
// a built one can carry an `error` too (Odoo down, the B2B half still there),
// alongside its figures.
const isFailed = (section: unknown): section is Failed =>
  Boolean(section && typeof section === 'object' && Object.keys(section).length === 1 && 'error' in section);

const shortDay = (iso: string) =>
  parseIsoDay(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  });

// One step back or forward from the period on screen. A month steps from its
// 1st, so stepping out of the 31st cannot skip a short month.
function shift(anchor: string, view: View, direction: -1 | 1): string {
  if (view === 'week') return addDays(anchor, 7 * direction);
  const day = parseIsoDay(anchor);
  return isoDay(new Date(day.getFullYear(), day.getMonth() + direction, 1, 12));
}

const wholesaleText = (wholesale: Record<string, number>) =>
  Object.entries(wholesale)
    .map(([unit, amount]) => `${qty(amount)} ${unit}`)
    .join(' + ');

// ---- Small pieces -----------------------------------------------------------

const SectionError = ({ what, error }: { what: string; error: string }) => (
  <div className="mkt-alert mkt-alert-warn">
    Couldn&apos;t load {what}: {error}
  </div>
);

const Tile = ({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) => (
  <div className="mkt-tile">
    <span className="mkt-tile-label">{label}</span>
    <span className={`mkt-tile-value${tone === 'good' ? ' is-good' : tone === 'bad' ? ' is-bad' : ''}`}>{value}</span>
    {sub ? <span className="mkt-tile-sub">{sub}</span> : null}
  </div>
);

// A ranked list as horizontal bars. One series, so one colour and no legend;
// every bar carries its own number, so the length is never the only reading.
const BarList = ({ rows, unit }: { rows: { label: string; value: number; hint?: string }[]; unit: string }) => {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul className="ov-bars">
      {rows.map((row) => (
        <li key={row.label} title={row.hint || `${row.label}: ${row.value} ${unit}`}>
          <span className="ov-bar-label">{row.label}</span>
          <span className="ov-bar-track">
            <span className="ov-bar-fill" style={{ width: `${(row.value / max) * 100}%` }} />
          </span>
          <span className="ov-bar-value">{qty(row.value)}</span>
        </li>
      ))}
    </ul>
  );
};

// Secondary detail. On a desktop it is simply there (the wrapper is
// `display: contents`, so a grid lays its children out as its own); on a phone
// it folds behind one button, so each section opens on its headline figures.
const More = ({ children }: { children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="ov-more-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Less detail' : 'More detail'}
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      <div className={`ov-more${open ? ' is-open' : ''}`}>{children}</div>
    </>
  );
};

// ---- Tasks ------------------------------------------------------------------

type PersonCardProps = {
  person: Person;
  weekday: string;
  // Phone only: the cards fold to their header so three people fit on one
  // screen. On a desktop every card is always open and the header is inert.
  open: boolean;
  onToggle: () => void;
  onTask: (task: Task) => void;
  onTodo: (todo: Todo, person: Person) => void;
};

const PersonCard = ({ person, weekday, open, onToggle, onTask, onTodo }: PersonCardProps) => {
  const openTodos = person.todos.filter((todo) => !todo.done).length;
  const overdue = person.todos.filter((todo) => todo.overdue && !todo.done).length;
  const weekPct = person.week.total ? Math.round((person.week.done / person.week.total) * 100) : 0;
  const allDone = person.today.length > 0 && person.todayDone >= person.today.length;
  return (
    <div className={`mkt-panel ov-person${open ? ' is-open' : ''}`}>
      <button type="button" className="ov-person-head" aria-expanded={open} onClick={onToggle}>
        <span className="ov-avatar" aria-hidden="true">
          {person.name.slice(0, 1)}
        </span>
        <span className="ov-person-name">
          <strong className="ov-person-title">{person.name}</strong>
          <span className="mkt-tile-sub ov-person-sub">
            {person.todayDone} of {person.today.length} done today
            <span className="ov-person-week">
              {' '}
              · This week {person.week.done}/{person.week.total}
            </span>
          </span>
        </span>
        <span className="ov-person-badges">
          {overdue ? <span className="ov-badge is-bad">{overdue} overdue</span> : null}
          {allDone ? (
            <span className="ov-badge is-good">Done ✓</span>
          ) : openTodos ? (
            <span className="ov-badge">{openTodos} to-do</span>
          ) : null}
          <span className="ov-chevron" aria-hidden="true">
            ▾
          </span>
        </span>
      </button>
      <div
        className="ov-progress"
        role="progressbar"
        aria-label={`${person.name}'s week`}
        aria-valuenow={weekPct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${weekPct}%` }} />
      </div>

      <div className="ov-person-body">
        <h5 className="ov-subhead ov-cadence-head">{weekday}&apos;s cadence</h5>
        {person.today.length ? (
          <ul className="ov-checklist">
            {person.today.map((task) => (
              <li key={task.id} className={task.done ? 'is-done' : ''}>
                <button
                  type="button"
                  className="ov-tick"
                  aria-pressed={task.done}
                  aria-label={`${task.done ? 'Untick' : 'Tick'} "${task.label}"`}
                  onClick={() => onTask(task)}
                >
                  {task.done ? '✅' : '⬜'}
                </button>
                <span className="ov-check-text">
                  {task.label}
                  {task.time ? <span className="ov-check-meta"> · {task.time}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mkt-muted ov-empty">Nothing on the cadence today.</p>
        )}

        <h5 className="ov-subhead">Open to-dos ({openTodos})</h5>
        {person.todos.length ? (
          <ul className="ov-checklist">
            {person.todos.slice(0, 6).map((todo) => (
              <li key={todo.id} className={todo.done ? 'is-done' : ''}>
                <button
                  type="button"
                  className="ov-tick"
                  aria-pressed={!!todo.done}
                  aria-label={`${todo.done ? 'Untick' : 'Tick'} "${todo.body}"`}
                  onClick={() => onTodo(todo, person)}
                >
                  {todo.done ? '✅' : '⬜'}
                </button>
                <span className="ov-check-text">
                  {todo.body}
                  {todo.dueDate ? (
                    <span className={`ov-due${todo.overdue ? ' is-overdue' : ''}`}>
                      {todo.overdue ? 'Overdue · ' : 'Due '}
                      {shortDay(todo.dueDate)}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
            {person.todos.length > 6 ? <li className="mkt-muted">+ {person.todos.length - 6} more</li> : null}
          </ul>
        ) : (
          <p className="mkt-muted ov-empty">No open to-dos.</p>
        )}
      </div>
    </div>
  );
};

// Alerts that left a job and nobody has taken it yet — a WhatsApp message to
// answer, a delivery to sort out. Tick it, or hand it to someone.
const UnassignedCard = ({
  todos,
  people,
  onTodo,
  onAssign,
}: {
  todos: Todo[];
  people: string[];
  onTodo: (todo: Todo) => void;
  onAssign: (todo: Todo, name: string) => void;
}) => (
  <div className="mkt-panel ov-person ov-unassigned">
    <div className="ov-person-head">
      <span className="ov-avatar" aria-hidden="true">
        🔔
      </span>
      <div>
        <h4>From alerts</h4>
        <span className="mkt-tile-sub ov-person-sub">{todos.filter((todo) => !todo.done).length} open · nobody on them yet</span>
      </div>
    </div>
    <ul className="ov-checklist">
      {todos.map((todo) => (
        <li key={todo.id} className={todo.done ? 'is-done' : ''}>
          <button
            type="button"
            className="ov-tick"
            aria-pressed={!!todo.done}
            aria-label={`${todo.done ? 'Untick' : 'Tick'} "${todo.body}"`}
            onClick={() => onTodo(todo)}
          >
            {todo.done ? '✅' : '⬜'}
          </button>
          <span className="ov-check-text">
            {todo.body}
            {todo.dueDate ? (
              <span className={`ov-due${todo.overdue ? ' is-overdue' : ''}`}>
                {todo.overdue ? 'Overdue · ' : 'Due '}
                {shortDay(todo.dueDate)}
              </span>
            ) : null}
            {todo.done ? null : (
              <span className="ov-assign">
                {people.map((name) => (
                  <button key={name} type="button" className="mkt-chip" onClick={() => onAssign(todo, name)}>
                    → {name}
                  </button>
                ))}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  </div>
);

// ---- Money ------------------------------------------------------------------

const SPEND_COLOR = '#2f6db5';
const SALES_COLOR = '#c98a12';

// Spend against sales, week by week. Two series on one scale (both rupees),
// paired bars rather than a dual axis; a legend because there are two, and a
// number on every bar because the ember fails 3:1 on white by a hair.
const WeekBars = ({ weeks }: { weeks: Money['weeks'] }) => {
  const max = Math.max(1, ...weeks.flatMap((week) => [week.spend, week.sales]));
  return (
    <div className="ov-weekbars">
      <div className="ov-legend">
        <span>
          <i style={{ background: SALES_COLOR }} /> Sales
        </span>
        <span>
          <i style={{ background: SPEND_COLOR }} /> Spend
        </span>
      </div>
      {weeks.map((week) => (
        <div className="ov-weekrow" key={week.weekStart}>
          <span className="ov-weekrow-label">{week.label}</span>
          <div className="ov-weekrow-bars">
            {(
              [
                ['Sales', week.sales, SALES_COLOR],
                ['Spend', week.spend, SPEND_COLOR],
              ] as const
            ).map(([name, value, color]) => (
              <div className="ov-pair" key={name} title={`${week.label} · ${name}: ${inr(value)}`}>
                <span className="ov-bar-track">
                  <span
                    className="ov-bar-fill"
                    style={{
                      width: `${(value / max) * 100}%`,
                      background: color,
                    }}
                  />
                </span>
                <span className="ov-bar-value">{inr(value)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

// ---- Traffic ----------------------------------------------------------------

// People per day. One series: a column chart with a hover readout, the
// number for the hovered day shown above the plot rather than in a floating
// tooltip that a phone thumb would cover.
const DailyChart = ({
  daily,
  from,
  to,
}: {
  daily: { date: string; users: number; sessions: number }[];
  from: string;
  to: string;
}) => {
  const [hover, setHover] = useState<string | null>(null);
  // Every day of the period through the last reported one, zero-filled: GA
  // omits days with nobody, and a gap is not the same as a missing bar.
  const byDate = new Map(daily.map((day) => [day.date, day]));
  const days: { date: string; users: number; sessions: number }[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push(byDate.get(day) || { date: day, users: 0, sessions: 0 });
  }
  const max = Math.max(1, ...days.map((day) => day.users));
  const shown = days.find((day) => day.date === hover);
  return (
    <div className="ov-daily">
      <div className="ov-daily-readout">
        {shown ? (
          <>
            <strong>
              {parseIsoDay(shown.date).toLocaleDateString('en-IN', {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
              })}
            </strong>
            {' · '}
            {shown.users} {shown.users === 1 ? 'person' : 'people'} · {shown.sessions} visits
          </>
        ) : (
          <span className="mkt-muted">People per day — hover or tap a bar</span>
        )}
      </div>
      <div className="ov-daily-plot" onMouseLeave={() => setHover(null)}>
        {days.map((day) => (
          <button
            type="button"
            key={day.date}
            className={`ov-daily-col${hover === day.date ? ' is-hover' : ''}`}
            onMouseEnter={() => setHover(day.date)}
            onFocus={() => setHover(day.date)}
            onClick={() => setHover(day.date)}
            aria-label={`${day.date}: ${day.users} people, ${day.sessions} visits`}
          >
            <span
              style={{
                height: `${Math.max(day.users ? 4 : 0, (day.users / max) * 100)}%`,
              }}
            />
          </button>
        ))}
      </div>
      <div className="ov-daily-axis">
        <span>{shortDay(from)}</span>
        <span>{shortDay(to)}</span>
      </div>
    </div>
  );
};

const delta = (now: number, before: number, span: { from: string; to: string }) => {
  const against = `${shortDay(span.from)}–${shortDay(span.to)}`;
  if (!before) return now ? `none ${against}` : '';
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs ${against}`;
};

// ---- The page ---------------------------------------------------------------

// On a phone the page shows one section at a time; these are its tabs. Each
// carries the section's headline figure, so the bar alone answers "how are we
// doing" before anything is tapped. A desktop shows every section at once.
const SECTIONS = ['tasks', 'orders', 'money', 'traffic'] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_KEY = 'smokerings.overview.section';

function headline(section: Section, data: OverviewData): string {
  const { tasks, orders, money, traffic } = data;
  if (section === 'tasks') {
    if (isFailed(tasks)) return '—';
    const people = (tasks as Tasks).people;
    const done = people.reduce((sum, person) => sum + person.todayDone, 0);
    const total = people.reduce((sum, person) => sum + person.today.length, 0);
    return `${done}/${total}`;
  }
  if (section === 'orders') return isFailed(orders) ? '—' : String((orders as Orders).orders);
  if (section === 'money') return isFailed(money) ? '—' : inrShort((money as Money).period.net);
  return 'totals' in traffic ? String(traffic.totals.users) : '—';
}

const TAB_LABELS: Record<Section, [string, string]> = {
  tasks: ['👥', 'Today'],
  orders: ['🍖', 'Orders'],
  money: ['💰', 'Net'],
  traffic: ['🌐', 'Visitors'],
};

const Overview = ({ onOpen }: { onOpen: (target: OverviewTarget) => void }) => {
  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(todayIso);
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [section, setSection] = usePersistedChoice<Section>(SECTION_KEY, 'tasks', SECTIONS, 'session');
  // Whose card is unfolded on a phone: whoever is signed in to the notes, else
  // the first person. '' once they fold it, so it stays folded.
  const [openPerson, setOpenPerson] = useState<string | null>(() => readNotesAuthor() || null);

  const pickSection = (next: Section) => {
    setSection(next);
    document.querySelector('.ov-page')?.scrollIntoView({ block: 'start' });
  };

  const [tickError, setTickError] = useState('');
  // The same writes the note bubble and Daily View make, through the same
  // stores — so a tick here shows up there (and on the sprint dashboard) too.
  const { setTaskDone } = useTodayTasks(false);
  const { setDone: setNoteDone, assignNote } = useSharedNotes();

  // `quiet` refreshes without dimming the page — used after a tick, where the
  // box has already moved and a flash would only read as "it didn't take".
  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setError('');
      try {
        const resp = await fetch(`/api/overview?view=${view}&date=${anchor}`);
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [view, anchor],
  );

  useEffect(() => {
    load();
  }, [load]);

  const patchTasks = (fn: (tasks: Tasks) => Tasks) =>
    setData((current) => {
      if (!current || !current.tasks || isFailed(current.tasks)) return current;
      return { ...current, tasks: fn(current.tasks as Tasks) };
    });
  const patchPeople = (fn: (person: Person) => Person) =>
    patchTasks((tasks) => ({ ...tasks, people: tasks.people.map(fn) }));

  // Moves the box first, then writes; a refusal puts it back via the reload.
  const toggleTask = async (task: Task) => {
    const done = !task.done;
    const delta = done ? 1 : -1;
    setTickError('');
    patchPeople((person) =>
      person.today.some((t) => t.id === task.id)
        ? {
            ...person,
            today: person.today.map((t) => (t.id === task.id ? { ...t, done } : t)),
            todayDone: person.todayDone + delta,
            week: { ...person.week, done: person.week.done + delta },
          }
        : person,
    );
    try {
      await setTaskDone(task.id, done);
    } catch (err) {
      setTickError(err instanceof Error ? err.message : String(err));
    }
    void load(true);
  };

  // A ticked to-do stays on the card, struck through, until the next load —
  // so a mis-tap can be taken back from where it was made.
  const toggleTodo = async (todo: Todo, owner?: Person) => {
    const done = !todo.done;
    const mark = (value: boolean) => {
      const flip = (list: Todo[]) => list.map((t) => (t.id === todo.id ? { ...t, done: value } : t));
      patchTasks((tasks) => ({
        ...tasks,
        people: tasks.people.map((person) => ({
          ...person,
          todos: flip(person.todos),
        })),
        unassigned: tasks.unassigned ? flip(tasks.unassigned) : tasks.unassigned,
      }));
    };
    setTickError('');
    mark(done);
    try {
      await setNoteDone(todo.id, done, readNotesAuthor() || owner?.name || '');
    } catch (err) {
      mark(!done);
      setTickError(err instanceof Error ? err.message : String(err));
    }
  };

  // Hands an alert's to-do to someone; it moves onto their card.
  const assignTodo = async (todo: Todo, name: string) => {
    setTickError('');
    patchTasks((tasks) => ({
      ...tasks,
      unassigned: (tasks.unassigned || []).filter((t) => t.id !== todo.id),
      people: tasks.people.map((person) =>
        person.name === name ? { ...person, todos: [...person.todos, todo] } : person,
      ),
    }));
    try {
      await assignNote(todo.id, name);
    } catch (err) {
      setTickError(err instanceof Error ? err.message : String(err));
    }
    void load(true);
  };

  const today = todayIso();
  const isCurrent = data ? data.period.from <= today && today <= data.period.to : true;
  const periodWord = view === 'week' ? 'week' : 'month';

  const { tasks, orders, money, traffic } = data || {};
  const people = tasks && !isFailed(tasks) ? (tasks as Tasks).people : [];
  const unfolded =
    openPerson === '' || people.some((person) => person.name === openPerson) ? openPerson : people[0]?.name;

  return (
    <div className="marketing-dashboard ov-page">
      <header>
        <h2>Overview</h2>
        <p>Who&apos;s doing what, what sold, where the money stands, and who found the site.</p>
      </header>

      {/* On a phone the Tasks tab hides the period: tasks are always today. */}
      <div className={`ov-controls${section === 'tasks' ? ' is-tasks' : ''}`}>
        <div className="mkt-toolbar ov-toolbar">
          <div className="mkt-tabs" role="tablist" aria-label="Period">
            {(['week', 'month'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={view === option}
                className={`mkt-tab${view === option ? ' is-active' : ''}`}
                onClick={() => setView(option)}
              >
                {option === 'week' ? 'Week' : 'Month'}
              </button>
            ))}
          </div>
          <div className="ov-stepper">
            <button
              type="button"
              className="mkt-chip"
              aria-label={`Previous ${periodWord}`}
              onClick={() => setAnchor(shift(data?.period.from || anchor, view, -1))}
            >
              ‹
            </button>
            <strong className="ov-period-label">{data?.period.label || '…'}</strong>
            <button
              type="button"
              className="mkt-chip"
              aria-label={`Next ${periodWord}`}
              onClick={() => setAnchor(shift(data?.period.from || anchor, view, 1))}
            >
              ›
            </button>
            {!isCurrent ? (
              <button type="button" className="mkt-chip" onClick={() => setAnchor(todayIso())}>
                This {periodWord}
              </button>
            ) : null}
            <button type="button" className="mkt-chip" onClick={() => load()} disabled={loading} aria-label="Refresh">
              <span aria-hidden="true">↻</span>
              <span className="ov-refresh-word">{loading ? ' Loading…' : ' Refresh'}</span>
            </button>
          </div>
        </div>
        {/* Phone only: one section on screen at a time, picked here. */}
        <nav className="ov-tabs" aria-label="Sections">
          {SECTIONS.map((id) => (
            <button
              key={id}
              type="button"
              className={`ov-tabbtn${section === id ? ' is-active' : ''}`}
              aria-pressed={section === id}
              onClick={() => pickSection(id)}
            >
              <span className="ov-tabbtn-figure">{data ? headline(id, data) : '…'}</span>
              <span className="ov-tabbtn-label">
                <span aria-hidden="true">{TAB_LABELS[id][0]}</span> {TAB_LABELS[id][1]}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {error ? <SectionError what="the overview" error={error} /> : null}
      {!data && loading ? <p className="mkt-muted">Loading the overview…</p> : null}

      {data ? (
        <div className={`ov-grid${loading ? ' is-loading' : ''}`}>
          {/* ---- Tasks ---- */}
          <section className={`ov-section ov-span-2${section === 'tasks' ? ' is-shown' : ''}`} id="ov-tasks">
            <div className="mkt-panel-head">
              <h3>👥 Tasks</h3>
              <button type="button" className="mkt-chip" onClick={() => onOpen('dailyView')}>
                Open Daily View →
              </button>
            </div>
            {tasks && isFailed(tasks) ? (
              <SectionError what="tasks" error={tasks.error} />
            ) : tasks ? (
              <>
                <p className="mkt-muted ov-note">Always today and this week, whichever period is picked above.</p>
                {tickError ? <SectionError what="that tick" error={tickError} /> : null}
                <div className="ov-people">
                  {(tasks as Tasks).people.map((person) => (
                    <PersonCard
                      key={person.name}
                      person={person}
                      weekday={(tasks as Tasks).weekday}
                      open={unfolded === person.name}
                      onToggle={() => setOpenPerson(unfolded === person.name ? '' : person.name)}
                      onTask={toggleTask}
                      onTodo={toggleTodo}
                    />
                  ))}
                  {(tasks as Tasks).unassigned?.length ? (
                    <UnassignedCard
                      todos={(tasks as Tasks).unassigned || []}
                      people={(tasks as Tasks).people.map((person) => person.name)}
                      onTodo={(todo) => toggleTodo(todo)}
                      onAssign={assignTodo}
                    />
                  ) : null}
                </div>
              </>
            ) : null}
          </section>

          {/* ---- Orders ---- */}
          <section className={`ov-section${section === 'orders' ? ' is-shown' : ''}`} id="ov-orders">
            <div className="mkt-panel-head">
              <h3>🍖 Orders &amp; meat</h3>
              <button type="button" className="mkt-chip" onClick={() => onOpen('itemSales')}>
                Sales by Item →
              </button>
            </div>
            {orders && isFailed(orders) ? (
              <SectionError what="orders" error={orders.error} />
            ) : orders ? (
              (() => {
                const o = orders as Orders;
                return (
                  <>
                    {o.error ? <SectionError what="the B2C orders from Odoo" error={o.error} /> : null}
                    <div className="mkt-tiles">
                      <Tile label="Orders" value={String(o.orders)} sub={`${o.b2cOrders} B2C · ${o.b2bOrders} B2B`} />
                      <Tile label="Dishes sold" value={qty(o.b2cPortions)} sub="B2C portions" />
                      <Tile
                        label="Revenue"
                        value={inr(o.revenue)}
                        sub={`B2C ${inr(o.b2cRevenue)} · B2B ${inr(o.b2bRevenue)}`}
                      />
                    </div>
                    <div className="mkt-panel ov-inner">
                      <h4>By meat</h4>
                      {o.meats.length ? (
                        <>
                          <BarList
                            unit="portions"
                            rows={o.meats.map((meat) => ({
                              label: meat.animal,
                              value: meat.portions,
                            }))}
                          />
                          <More>
                            <ul className="ov-meat-detail">
                              {o.meats.map((meat) => (
                                <li key={meat.animal}>
                                  <strong>{meat.animal}</strong>
                                  {': '}
                                  {meat.cuts
                                    .map((cut) =>
                                      [
                                        cut.portions ? `${cut.cut} ${qty(cut.portions)}` : '',
                                        Object.keys(cut.wholesale).length
                                          ? `${cut.portions ? '' : `${cut.cut} `}${wholesaleText(cut.wholesale)} wholesale`
                                          : '',
                                      ]
                                        .filter(Boolean)
                                        .join(' + '),
                                    )
                                    .join(' · ')}
                                </li>
                              ))}
                            </ul>
                            <p className="mkt-muted ov-note">
                              Bars are B2C portions; a dish with two meats counts under each. Wholesale is in its billed
                              unit.
                            </p>
                          </More>
                        </>
                      ) : (
                        <p className="mkt-muted ov-empty">No orders in this {periodWord}.</p>
                      )}
                    </div>
                    {o.topDishes.length ? (
                      <div className="mkt-panel ov-inner ov-phone-hide">
                        <h4>Top dishes</h4>
                        <BarList
                          unit="sold"
                          rows={o.topDishes.map((dish) => ({
                            label: dish.name,
                            value: dish.units,
                            hint: `${dish.name}: ${dish.units} sold · ${inr(dish.revenue)}`,
                          }))}
                        />
                      </div>
                    ) : null}
                  </>
                );
              })()
            ) : null}
          </section>

          {/* ---- Money ---- */}
          <section className={`ov-section${section === 'money' ? ' is-shown' : ''}`} id="ov-money">
            <div className="mkt-panel-head">
              <h3>💰 Money</h3>
              <button type="button" className="mkt-chip" onClick={() => onOpen('spendVsSales')}>
                Spending vs Sales →
              </button>
            </div>
            {money && isFailed(money) ? (
              <SectionError what="the money" error={money.error} />
            ) : money ? (
              (() => {
                const m = money as Money;
                const launch = m.sinceLaunch;
                return (
                  <>
                    {m.error ? <SectionError what="the B2C sales from Odoo" error={m.error} /> : null}
                    {launch ? (
                      <div className="ov-launch">
                        <h5 className="ov-subhead">
                          Since {shortDay(launch.from)} (all time
                          {launch.truncated ? ', last 2 years' : ''})
                        </h5>
                        <div className="mkt-tiles">
                          <Tile
                            label="Invested"
                            value={inr(launch.investment)}
                            sub={`${inr(launch.spend)} running · ${inr(launch.investmentBuys)} equipment · ${inr(launch.practice)} practice`}
                          />
                          <Tile label="Sales" value={inr(launch.sales)} sub="B2C + B2B" />
                          <Tile
                            label="Recovered"
                            value={launch.investment ? `${Math.round((launch.sales / launch.investment) * 100)}%` : '—'}
                            sub={`${launch.sales >= launch.investment ? 'ahead by' : 'still to recover'} ${inr(Math.abs(launch.sales - launch.investment))}`}
                            tone={launch.sales >= launch.investment ? 'good' : undefined}
                          />
                        </div>
                      </div>
                    ) : null}
                    <h5 className="ov-subhead">
                      This {periodWord}
                      {view === 'month'
                        ? ` (Mon–Sun weeks ${shortDay(m.covered.from)} – ${shortDay(m.covered.to)})`
                        : ''}
                    </h5>
                    <div className="mkt-tiles">
                      <Tile
                        label="Spent"
                        value={inr(m.period.spend)}
                        sub={`Materials ${inr(m.period.materials)} · Labour ${inr(m.period.labour)} · Marketing ${inr(m.period.marketing)}`}
                      />
                      <Tile label="Sales" value={inr(m.period.sales)} />
                      <Tile
                        label="Net"
                        value={inr(m.period.net)}
                        tone={m.period.net > 0 ? 'good' : m.period.net < 0 ? 'bad' : undefined}
                        sub={
                          m.period.investmentBuys
                            ? `+ ${inr(m.period.investmentBuys)} equipment, not in spend`
                            : 'Recorded spend, not a full P&L'
                        }
                      />
                    </div>
                    {m.weeks.length > 1 ? (
                      <div className="mkt-panel ov-inner">
                        <h4>Week by week</h4>
                        <WeekBars weeks={m.weeks} />
                      </div>
                    ) : null}
                  </>
                );
              })()
            ) : null}
          </section>

          {/* ---- Traffic ---- */}
          <section className={`ov-section ov-span-2${section === 'traffic' ? ' is-shown' : ''}`} id="ov-traffic">
            <div className="mkt-panel-head">
              <h3>🌐 Website visitors</h3>
              <button type="button" className="mkt-chip" onClick={() => onOpen('roi')}>
                Marketing ROI →
              </button>
            </div>
            {traffic && isFailed(traffic) ? (
              <SectionError what="site traffic" error={traffic.error} />
            ) : traffic && 'configured' in traffic && !traffic.configured ? (
              <div className="mkt-alert">Google Analytics isn&apos;t set up: {traffic.error}</div>
            ) : traffic && 'future' in traffic && traffic.future ? (
              <p className="mkt-muted ov-empty">This {periodWord} hasn&apos;t started yet.</p>
            ) : traffic && 'totals' in traffic ? (
              <>
                <div className="mkt-tiles">
                  <Tile
                    label="People"
                    value={String(traffic.totals.users)}
                    sub={delta(traffic.totals.users, traffic.previous.users, traffic.previousSpan)}
                  />
                  <Tile
                    label="Visits"
                    value={String(traffic.totals.sessions)}
                    sub={delta(traffic.totals.sessions, traffic.previous.sessions, traffic.previousSpan)}
                  />
                  <Tile
                    label="New visitors"
                    value={String(traffic.totals.newUsers)}
                    sub={`${traffic.totals.users - traffic.totals.newUsers} returning`}
                  />
                  <Tile label="Key events" value={String(traffic.totals.keyEvents)} sub="Order clicks GA counted" />
                </div>
                <div className="ov-traffic">
                  <div className="mkt-panel ov-inner ov-traffic-wide">
                    <h4>Day by day</h4>
                    <DailyChart daily={traffic.daily} from={data.period.from} to={traffic.through} />
                  </div>
                  <More>
                    <div className="mkt-panel ov-inner">
                      <h4>Where they came from</h4>
                      <BarList
                        unit="visits"
                        rows={traffic.sources.map((row) => ({
                          label: row.label,
                          value: row.sessions,
                          hint: `${row.label}: ${row.sessions} visits (GA source: ${row.rawSources.join(', ')})`,
                        }))}
                      />
                      <p className="mkt-muted ov-note">Visits per source.</p>
                    </div>
                    <div className="mkt-panel ov-inner">
                      <h4>Where they are</h4>
                      <BarList
                        unit="people"
                        rows={traffic.places.map((row) => ({
                          label: row.country && row.country !== 'India' ? `${row.city}, ${row.country}` : row.city,
                          value: row.users,
                        }))}
                      />
                      <p className="mkt-muted ov-note">People per city.</p>
                    </div>
                    <div className="mkt-panel ov-inner">
                      <h4>Pages they landed on</h4>
                      <BarList
                        unit="people"
                        rows={traffic.landingPages.map((row) => ({
                          label: row.page,
                          value: row.users,
                        }))}
                      />
                    </div>
                  </More>
                </div>
              </>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
};

export default Overview;
