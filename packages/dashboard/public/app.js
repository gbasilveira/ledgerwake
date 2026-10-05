// Ledgerwake dashboard: a read-only view over the local API (`lw serve`). No framework, no build.
// Every value from the API is inserted as text (never as HTML).

const main = document.getElementById('main');
const nav = document.getElementById('nav');

/** Creates an element. Children that are strings become text nodes. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style')
      el.style.cssText = v; // CSSOM, allowed by the page's style-src 'self'
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Replaces an element's children, flattening arrays and skipping empty values. */
function fill(el, ...children) {
  el.replaceChildren(
    ...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  );
}

async function api(path) {
  const response = await fetch(`/api/${path}`);
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return response.headers.get('content-type')?.startsWith('application/json')
    ? response.json()
    : response.text();
}

const enc = encodeURIComponent;
const itemHref = (qid) => `#/item/${qid.split('/').map(enc).join('/')}`;
const sessionHref = (id) => `#/session/${enc(id)}`;
const itemLink = (qid) => h('a', { href: itemHref(qid) }, qid);
const status = (s) =>
  s ? h('span', { class: `status ${s}` }, s) : h('span', { class: 'muted' }, '—');
const usd = (n) => (n === null || n === undefined ? '—' : `$${n.toFixed(n < 1 ? 4 : 2)}`);
const int = (n) => Number(n ?? 0).toLocaleString('en-GB');
const when = (ts) => (ts ? ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—');
const card = (label, value) =>
  h(
    'div',
    { class: 'card' },
    h('div', { class: 'value' }, value),
    h('div', { class: 'label' }, label),
  );

function table(columns, rows, empty = 'Nothing yet.') {
  if (rows.length === 0) return h('p', { class: 'muted' }, empty);
  return h(
    'table',
    {},
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        columns.map((c) => h('th', { class: c.num ? 'num' : undefined }, c.label)),
      ),
    ),
    h(
      'tbody',
      {},
      rows.map((row) =>
        h(
          'tr',
          {},
          columns.map((c) => h('td', { class: c.num ? 'num' : undefined }, c.value(row))),
        ),
      ),
    ),
  );
}

const PALETTE = ['var(--ok)', 'var(--accent)', 'var(--warn)', 'var(--bad)', 'var(--muted)'];
function statusBar(byStatus) {
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0) || 1;
  const order = Object.keys(byStatus).sort();
  return h(
    'div',
    { class: 'bar', title: order.map((s) => `${s}: ${byStatus[s]}`).join(', ') },
    order.map((s, i) =>
      h('span', {
        style: `width:${(100 * byStatus[s]) / total}%;background:${statusColour(s, i)}`,
      }),
    ),
  );
}
function statusColour(s, i) {
  if (s === 'ACCEPTED' || s === 'DONE') return 'var(--ok)';
  if (s === 'READY' || s === 'IN PROGRESS' || s === 'IN REVIEW') return 'var(--accent)';
  if (s === 'BLOCKED' || s === 'CHANGES REQUESTED') return 'var(--bad)';
  if (s === 'PARTIAL') return 'var(--warn)';
  if (s === 'DRAFT' || s === '(none)') return 'var(--line)';
  return PALETTE[(i % 3) + 1];
}

function setNav(active) {
  const links = [
    ['#/', 'Projects'],
    ['#/sessions', 'Sessions'],
    ['#/cost', 'Cost'],
    ['#/tools', 'Tools'],
  ];
  nav.replaceChildren(
    ...links.map(([href, label]) =>
      h('a', { href, class: href === active ? 'active' : undefined }, label),
    ),
  );
}

// ------------------------------------------------------------------------------ views

async function projectsView() {
  setNav('#/');
  const [projects, cost] = await Promise.all([api('projects'), api('cost')]);
  return [
    h('h1', {}, 'Projects'),
    h(
      'div',
      { class: 'cards' },
      card('projects', int(projects.length)),
      card('items', int(projects.reduce((a, p) => a + p.items, 0))),
      card('API requests', int(cost.total.requests)),
      card('cost (priced requests)', usd(cost.total.cost_usd)),
    ),
    h('h2', {}, 'Registered projects'),
    table(
      [
        { label: 'Project', value: (p) => h('a', { href: `#/project/${enc(p.slug)}` }, p.slug) },
        { label: 'Adapter', value: (p) => p.adapter },
        { label: 'Items', num: true, value: (p) => int(p.items) },
        { label: 'Errors', num: true, value: (p) => int(p.errors) },
        { label: 'Warnings', num: true, value: (p) => int(p.warnings) },
        { label: 'Root', value: (p) => h('span', { class: 'mono' }, p.root) },
      ],
      projects,
      'No projects registered. Run: lw project add <repository>',
    ),
  ];
}

async function projectView(slug) {
  setNav('');
  const [o, index, cost] = await Promise.all([
    api(`projects/${enc(slug)}/overview`),
    api(`projects/${enc(slug)}`),
    api(`cost?project=${enc(slug)}`),
  ]);
  const types = Object.keys(o.types);
  let typeFilter = types.includes('wo') ? 'wo' : types[0];
  let timelineShown = 60;
  const itemsBox = h('div');
  const timelineBox = h('div');

  const renderItems = () => {
    const items = index.items.filter((i) => i.type === typeFilter);
    const has = (f) =>
      items.some(
        (i) => i[f] !== null && i[f] !== undefined && !(Array.isArray(i[f]) && i[f].length === 0),
      );
    const columns = [
      { label: 'Key', value: (i) => itemLink(i.qid) },
      { label: 'Title', value: (i) => i.title ?? '' },
      has('status') && { label: 'Status', value: (i) => status(i.status) },
      has('phase') && { label: 'Phase', value: (i) => i.phase ?? '' },
      has('date') && { label: 'Date', value: (i) => i.date ?? '' },
      has('tasks') && {
        label: 'Tasks',
        num: true,
        value: (i) => (i.tasks ? `${i.tasks.done}/${i.tasks.total}` : ''),
      },
      has('depends_on') && {
        label: 'Depends on',
        value: (i) => i.depends_on.map((d) => d.split('/')[1]).join(', '),
      },
      has('branch') && {
        label: 'Branch',
        value: (i) => h('span', { class: 'mono' }, i.branch ?? ''),
      },
    ].filter(Boolean);
    fill(
      itemsBox,
      h(
        'div',
        { class: 'filters' },
        types.map((t) =>
          h(
            'button',
            {
              class: t === typeFilter ? 'on' : undefined,
              onclick: () => ((typeFilter = t), renderItems()),
            },
            `${t} (${index.items.filter((i) => i.type === t).length})`,
          ),
        ),
      ),
      table(columns, items),
    );
  };
  const renderTimeline = () => {
    const rows = o.timeline.slice(0, timelineShown);
    fill(
      timelineBox,
      table(
        [
          { label: 'When', value: (t) => h('span', { class: 'mono' }, when(t.ts)) },
          { label: 'Kind', value: (t) => t.kind },
          {
            label: 'What',
            value: (t) =>
              t.kind === 'session'
                ? h('a', { href: sessionHref(t.label) }, t.label.slice(0, 8))
                : h('span', { class: 'mono' }, t.label),
          },
          { label: 'Detail', value: (t) => t.text },
          {
            label: 'Items',
            value: (t) => t.items.slice(0, 4).map((q, i) => [i ? ', ' : '', itemLink(q)]),
          },
        ],
        rows,
      ),
      o.timeline.length > timelineShown
        ? h(
            'div',
            { class: 'filters' },
            h(
              'button',
              { onclick: () => ((timelineShown += 100), renderTimeline()) },
              `Show more (${o.timeline.length - timelineShown} left)`,
            ),
          )
        : null,
    );
  };
  renderItems();
  renderTimeline();
  return [
    h('h1', {}, slug),
    h(
      'p',
      { class: 'muted' },
      `${o.adapter} adapter · ${o.errors} error(s), ${o.warnings} warning(s) from lw check`,
    ),
    h(
      'div',
      { class: 'cards' },
      Object.entries(o.types).map(([t, m]) =>
        card(`${t} items`, int(Object.values(m).reduce((a, b) => a + b, 0))),
      ),
      card('sessions', int(o.sessions)),
      card('cost', usd(cost.total.cost_usd)),
    ),
    o.phases.length
      ? [
          h('h2', {}, 'Phases'),
          table(
            [
              { label: 'Phase', value: (p) => p.phase },
              { label: 'Items', num: true, value: (p) => int(p.total) },
              { label: 'Progress', value: (p) => statusBar(p.by_status) },
              {
                label: 'By status',
                value: (p) =>
                  Object.entries(p.by_status)
                    .map(([s, n]) => `${s} ${n}`)
                    .join(' · '),
              },
            ],
            o.phases,
          ),
        ]
      : null,
    h('h2', {}, 'Items'),
    itemsBox,
    h('h2', {}, 'Timeline'),
    timelineBox,
  ];
}

async function itemView(qid) {
  setNav('');
  const [found, cost] = await Promise.all([
    api(`items/${qid.split('/').map(enc).join('/')}`),
    api(`cost?item=${enc(qid)}`),
  ]);
  const { item, sessions, commits } = found;
  const fields = [
    ['Type', item.type],
    ['Status', status(item.status)],
    item.header_status && item.header_status !== item.status
      ? ['Header status (not canonical)', item.header_status]
      : null,
    item.phase !== null ? ['Phase', item.phase] : null,
    item.date ? ['Date', item.date] : null,
    item.branch ? ['Branch', h('span', { class: 'mono' }, item.branch)] : null,
    item.tasks ? ['Tasks', `${item.tasks.done} of ${item.tasks.total} ticked`] : null,
    [
      'Depends on',
      item.depends_on.length ? item.depends_on.map((d, i) => [i ? ', ' : '', itemLink(d)]) : '—',
    ],
    ['Files', item.occurrences.map((o) => h('div', { class: 'mono' }, `${o.path}:${o.line}`))],
    ['Id', h('span', { class: 'mono' }, `${item.id} (${item.id_source})`)],
  ].filter(Boolean);
  return [
    h(
      'p',
      {},
      h('a', { href: `#/project/${enc(item.qid.split('/')[0])}` }, `← ${item.qid.split('/')[0]}`),
    ),
    h('h1', {}, `${item.key} — ${item.title ?? ''}`),
    table(
      [
        { label: 'Field', value: (f) => f[0] },
        { label: 'Value', value: (f) => f[1] },
      ],
      fields,
    ),
    h(
      'div',
      { class: 'cards', style: 'margin-top:1rem' },
      card('sessions', int(sessions.length)),
      card('commits', int(commits.length)),
      card('cost', usd(cost.total.cost_usd)),
      card('API requests', int(cost.total.requests)),
    ),
    h('h2', {}, 'Sessions'),
    sessionTable(sessions, qid),
    h('h2', {}, 'Commits'),
    table(
      [
        { label: 'When', value: (c) => h('span', { class: 'mono' }, when(c.ts)) },
        { label: 'Commit', value: (c) => h('span', { class: 'mono' }, c.sha.slice(0, 10)) },
        { label: 'Subject', value: (c) => c.subject },
        { label: 'Lines', num: true, value: (c) => `+${int(c.insertions)} −${int(c.deletions)}` },
        { label: 'Agent', value: (c) => c.agent_trailers.join(', ') },
        { label: 'Link', value: (c) => c.links.find((l) => l.item === qid)?.rule ?? '' },
      ],
      commits,
    ),
  ];
}

function sessionTable(sessions, qid) {
  return table(
    [
      {
        label: 'Session',
        value: (s) =>
          h('a', { href: sessionHref(s.session), class: 'mono' }, s.session.slice(0, 8)),
      },
      { label: 'Started', value: (s) => h('span', { class: 'mono' }, when(s.first_ts)) },
      { label: 'Project', value: (s) => s.project ?? '—' },
      { label: 'Prompts', num: true, value: (s) => int(s.prompts) },
      { label: 'Tools', num: true, value: (s) => int(s.tool_calls) },
      { label: 'Sub-agents', num: true, value: (s) => int(s.agents) },
      {
        label: qid ? 'Linked by' : 'Items',
        value: (s) =>
          qid
            ? (s.links.find((l) => l.item === qid)?.rule ?? '')
            : s.links.map((l, i) => [i ? ', ' : '', itemLink(l.item), ` (${l.rule})`]),
      },
      { label: 'Directory', value: (s) => h('span', { class: 'mono' }, s.cwd ?? '') },
    ],
    sessions,
    'No sessions captured yet. Install the hook with lw hooks install, then run lw forward.',
  );
}

async function sessionsView() {
  setNav('#/sessions');
  const sessions = (await api('sessions')).slice().reverse();
  return [h('h1', {}, 'Sessions'), sessionTable(sessions)];
}

function describe(e) {
  const d = e.data ?? {};
  const parts = [
    d.tool_name,
    d.agent_type,
    d.source,
    d.reason,
    d.model,
    d.type,
    d['skill.name'],
    d.hook_event,
  ];
  if (d.success === false) parts.push('failed');
  if (d.cost_usd !== undefined) parts.push(usd(d.cost_usd));
  if (d.input_tokens !== undefined && d.input_tokens !== null)
    parts.push(`in ${int(d.input_tokens)} / out ${int(d.output_tokens)}`);
  if (d.status_code !== undefined) parts.push(`HTTP ${d.status_code}`);
  if (d.redacted) parts.push('(thinking text not recorded)');
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join(' · ');
}

async function sessionView(id) {
  setNav('#/sessions');
  const [{ session, events }, cost] = await Promise.all([
    api(`sessions/${enc(id)}`),
    api(`cost?session=${enc(id)}`),
  ]);
  let hidden = new Set(['usage']);
  const box = h('div');
  const kinds = [...new Set(events.map((e) => e.kind))].sort();
  const render = () => {
    fill(box, [
      h(
        'div',
        { class: 'filters' },
        kinds.map((k) =>
          h(
            'button',
            {
              class: hidden.has(k) ? undefined : 'on',
              onclick: () => (hidden.has(k) ? hidden.delete(k) : hidden.add(k), render()),
            },
            k,
          ),
        ),
      ),
      events
        .filter((e) => !hidden.has(e.kind))
        .map((e) => {
          const ref = e.content?.ref;
          const detail = ref
            ? h(
                'details',
                {
                  ontoggle: async (ev) => {
                    const el = ev.currentTarget;
                    if (!el.open || el.dataset.loaded) return;
                    el.dataset.loaded = '1';
                    try {
                      el.append(h('pre', {}, await api(`content/${enc(ref)}`)));
                    } catch (error) {
                      el.append(
                        h('p', { class: 'muted' }, `Content not available: ${error.message}`),
                      );
                    }
                  },
                },
                h('summary', {}, describe(e) || 'content'),
              )
            : h('div', {}, describe(e));
          return h(
            'div',
            { class: e.agent_id ? 'event sub' : 'event' },
            h('span', { class: 'mono muted' }, when(e.ts).slice(11)),
            h(
              'span',
              { class: 'kind' },
              e.kind,
              h('div', { class: 'muted' }, e.source?.channel ?? ''),
            ),
            h(
              'div',
              {},
              e.agent_id ? h('div', { class: 'muted mono' }, `sub-agent ${e.agent_id}`) : null,
              detail,
            ),
          );
        }),
    ]);
  };
  render();
  return [
    h('h1', {}, `Session ${session.session}`),
    h('p', { class: 'muted mono' }, session.cwd ?? ''),
    h(
      'div',
      { class: 'cards' },
      card('project', session.project ?? '—'),
      card('prompts', int(session.prompts)),
      card('tool calls', int(session.tool_calls)),
      card('sub-agents', int(session.agents)),
      card('cost', usd(cost.total.cost_usd)),
    ),
    session.links.length
      ? h(
          'p',
          {},
          'Linked to ',
          session.links.map((l, i) => [i ? ', ' : '', itemLink(l.item), ` (${l.rule})`]),
        )
      : null,
    h('h2', {}, 'Replay'),
    box,
  ];
}

function costTable(groups, label, linker = (k) => k) {
  return table(
    [
      { label, value: (g) => linker(g.key) },
      { label: 'Requests', num: true, value: (g) => int(g.requests) },
      {
        label: 'Cost',
        num: true,
        value: (g) => (g.unpriced === g.requests ? '—' : usd(g.cost_usd)),
      },
      { label: 'Unpriced', num: true, value: (g) => int(g.unpriced) },
      { label: 'Input', num: true, value: (g) => int(g.input_tokens) },
      { label: 'Output', num: true, value: (g) => int(g.output_tokens) },
      { label: 'Cache read', num: true, value: (g) => int(g.cache_read_tokens) },
    ],
    groups,
  );
}

async function costView(query) {
  setNav('#/cost');
  const cost = await api(`cost${query}`);
  return [
    h('h1', {}, 'Cost'),
    h(
      'p',
      { class: 'notice' },
      'Cost comes from OpenTelemetry (lw receive). Requests seen only in transcripts have tokens but no cost and are counted as unpriced.',
    ),
    h(
      'div',
      { class: 'cards' },
      card('cost', usd(cost.total.cost_usd)),
      card('requests', int(cost.total.requests)),
      card('unpriced', int(cost.total.unpriced)),
      card('output tokens', int(cost.total.output_tokens)),
    ),
    h('h2', {}, 'By model'),
    costTable(cost.by_model, 'Model'),
    h('h2', {}, 'By agent'),
    costTable(cost.by_agent, 'Agent'),
    h('h2', {}, 'By item'),
    costTable(cost.by_item, 'Item', (k) => (k.includes('/') ? itemLink(k) : k)),
    h('h2', {}, 'By session'),
    costTable(cost.by_session.slice(0, 50), 'Session', (k) =>
      h('a', { href: sessionHref(k), class: 'mono' }, k.slice(0, 8)),
    ),
  ];
}

async function toolsView(query) {
  setNav('#/tools');
  const t = await api(`tools${query}`);
  const list = (rows, label) =>
    table(
      [
        { label, value: (r) => r.key },
        { label: 'Calls', num: true, value: (r) => int(r.calls) },
      ],
      rows,
    );
  return [
    h('h1', {}, 'Tools, MCP servers and skills'),
    h(
      'div',
      { class: 'cards' },
      card('tool calls', int(t.tools.reduce((a, r) => a + r.calls, 0))),
      card('MCP servers used', int(t.mcp_servers.length)),
      card('MCP connections', int(t.mcp_connections)),
      card('skills used', int(t.skills.length)),
    ),
    h('h2', {}, 'MCP servers'),
    list(t.mcp_servers, 'Server'),
    h('h2', {}, 'Skills'),
    list(t.skills, 'Skill'),
    h('h2', {}, 'Tools'),
    list(t.tools, 'Tool'),
  ];
}

// ----------------------------------------------------------------------------- router

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, search = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const query = search ? `?${search}` : '';
  try {
    let view;
    if (parts.length === 0) view = await projectsView();
    else if (parts[0] === 'project' && parts[1]) view = await projectView(parts[1]);
    else if (parts[0] === 'item' && parts.length >= 3)
      view = await itemView(parts.slice(1).join('/'));
    else if (parts[0] === 'sessions') view = await sessionsView();
    else if (parts[0] === 'session' && parts[1]) view = await sessionView(parts[1]);
    else if (parts[0] === 'cost') view = await costView(query);
    else if (parts[0] === 'tools') view = await toolsView(query);
    else view = [h('h1', {}, 'Not found'), h('p', {}, h('a', { href: '#/' }, 'Back to projects'))];
    fill(main, view);
    window.scrollTo(0, 0);
  } catch (error) {
    main.replaceChildren(h('h1', {}, 'Could not load'), h('p', { class: 'notice' }, error.message));
  }
}

window.addEventListener('hashchange', route);
route();
