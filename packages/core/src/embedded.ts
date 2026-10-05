export interface EmbeddedBlock {
  id: string;
  type: string;
  /** 1-based line of the begin marker. */
  line: number;
  endLine: number;
  body: string;
}

export interface EmbeddedProblem {
  line: number;
  message: string;
}

const BEGIN = /<!--\s*lw:begin\s+id=(\S+)\s+type=(\S+)\s*-->/;
const END = /<!--\s*lw:end\s+id=(\S+)\s*-->/;

/** Finds `<!-- lw:begin … -->` / `<!-- lw:end … -->` blocks (SPEC §3). Blocks do not nest. */
export function findEmbeddedBlocks(text: string): {
  blocks: EmbeddedBlock[];
  problems: EmbeddedProblem[];
} {
  const lines = text.split(/\r?\n/);
  const blocks: EmbeddedBlock[] = [];
  const problems: EmbeddedProblem[] = [];
  let open: { id: string; type: string; line: number } | null = null;
  lines.forEach((content, i) => {
    const line = i + 1;
    const begin = BEGIN.exec(content);
    const end = END.exec(content);
    if (begin) {
      if (open) problems.push({ line: open.line, message: `block ${open.id} is not closed` });
      open = { id: begin[1]!, type: begin[2]!, line };
    } else if (end) {
      if (!open) {
        problems.push({ line, message: `end marker for ${end[1]} without a begin marker` });
      } else if (open.id !== end[1]) {
        problems.push({ line, message: `end marker for ${end[1]} closes block ${open.id}` });
        open = null;
      } else {
        const body = lines.slice(open.line, i).join('\n');
        blocks.push({ ...open, endLine: line, body });
        open = null;
      }
    }
  });
  if (open) {
    const unclosed: { id: string; line: number } = open;
    problems.push({ line: unclosed.line, message: `block ${unclosed.id} is not closed` });
  }
  return { blocks, problems };
}
