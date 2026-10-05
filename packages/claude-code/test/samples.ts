/** Invented payloads and transcript entries, shaped like those observed in the M0 spike. */
export const SESSION = '11111111-2222-4333-8444-555555555555';
export const PROMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const TOOL = 'toolu_01ExampleToolUseId0000';
export const AGENT_ID = 'a0123456789abcdef';
const CWD = '/work/demo';
const base = {
  session_id: SESSION,
  transcript_path: '/home/u/.claude/projects/-work-demo/x.jsonl',
  cwd: CWD,
};

export const payloads = {
  sessionStart: { ...base, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-x' },
  prompt: {
    ...base,
    prompt_id: PROMPT,
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Read note.txt',
  },
  preTool: {
    ...base,
    prompt_id: PROMPT,
    permission_mode: 'default',
    effort: { level: 'medium' },
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/work/demo/note.txt' },
    tool_use_id: TOOL,
  },
  postTool: {
    ...base,
    prompt_id: PROMPT,
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/work/demo/note.txt' },
    tool_response: { type: 'text', file: { content: 'hello' } },
    tool_use_id: TOOL,
    duration_ms: 4,
  },
  subagentStart: {
    ...base,
    prompt_id: PROMPT,
    agent_id: AGENT_ID,
    agent_type: 'general-purpose',
    hook_event_name: 'SubagentStart',
  },
  subagentStop: {
    ...base,
    prompt_id: PROMPT,
    agent_id: AGENT_ID,
    agent_type: 'general-purpose',
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    agent_transcript_path: '/x/subagents/agent-a0123456789abcdef.jsonl',
    last_assistant_message: 'done',
    background_tasks: [],
  },
  stop: {
    ...base,
    prompt_id: PROMPT,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'hello',
  },
  worktree: { ...base, hook_event_name: 'WorktreeCreate', name: 'wt' },
};

export function spoolText(
  payload: object,
  receivedAt = Date.UTC(2026, 9, 5, 12, 0, 0),
  item: string | null = null,
): string {
  return `${JSON.stringify({ spool: 'claude-code/0', received_at: receivedAt, host: 'host-1', lw_item: item })}\n${JSON.stringify(payload)}\n`;
}

const entry = (over: object) => ({
  parentUuid: null,
  isSidechain: false,
  userType: 'external',
  cwd: CWD,
  sessionId: SESSION,
  version: '2.1.289',
  gitBranch: 'demo-wo-001',
  ...over,
});

export const transcript = [
  { type: 'permission-mode', permissionMode: 'default', sessionId: SESSION },
  entry({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-10-05T12:00:01.000Z',
    promptId: PROMPT,
    message: { role: 'user', content: 'Read note.txt' },
  }),
  entry({
    type: 'assistant',
    uuid: 'a1',
    requestId: 'req_1',
    timestamp: '2026-10-05T12:00:02.000Z',
    message: {
      model: 'claude-x',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'tool_use', id: TOOL, name: 'Read', input: { file_path: '/work/demo/note.txt' } },
      ],
      usage: {
        input_tokens: 3,
        output_tokens: 7,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      },
    },
  }),
  entry({
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-10-05T12:00:03.000Z',
    promptId: PROMPT,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: TOOL, content: 'hello' }],
    },
    toolUseResult: {},
  }),
  entry({
    type: 'assistant',
    uuid: 'a2',
    requestId: 'req_2',
    timestamp: '2026-10-05T12:00:04.000Z',
    message: {
      model: 'claude-x',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  }),
  entry({
    type: 'attachment',
    uuid: 'h1',
    timestamp: '2026-10-05T12:00:05.000Z',
    attachment: { type: 'hook_cancelled', hookEvent: 'Stop', timedOut: true, timeoutMs: 2000 },
  }),
  entry({
    type: 'user',
    uuid: 'm1',
    timestamp: '2026-10-05T12:00:06.000Z',
    isMeta: true,
    message: { role: 'user', content: 'meta' },
  }),
];

export const subagentTranscript = [
  entry({
    type: 'user',
    uuid: 's1',
    isSidechain: true,
    agentId: AGENT_ID,
    timestamp: '2026-10-05T12:00:02.500Z',
    promptId: PROMPT,
    message: { role: 'user', content: 'Run pwd' },
  }),
];

export const lines = (entries: object[]) => entries.map((e) => JSON.stringify(e));
