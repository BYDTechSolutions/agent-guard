import type { AuditRecord, Decision } from './types.js';

/** Counts per decision. */
export type DecisionCounts = Record<Decision, number>;

/** What {@link summarizeAudit} returns. */
export interface AuditSummary {
  /** Policy decisions (`event: "check"`). */
  checks: number;
  byDecision: DecisionCounts;
  /** Per tool, sorted by name. */
  byTool: { tool: string; counts: DecisionCounts; total: number }[];
  /** Answers to `approve` decisions. */
  approvals: { approved: number; declined: number };
  /** Denials (policy and declined approvals) grouped by tool and reason, most frequent first. */
  denials: { tool: string; rule: string; reason: string; count: number }[];
  /** Earliest and latest `time` seen. */
  from?: string;
  to?: string;
  /** Line numbers (1-based) that were not audit records. */
  invalidLines: number[];
}

const emptyCounts = (): DecisionCounts => ({ allow: 0, deny: 0, approve: 0 });

function isAuditRecord(value: unknown): value is AuditRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.tool === 'string' &&
    (r.decision === 'allow' || r.decision === 'deny' || r.decision === 'approve') &&
    (r.event === 'check' || r.event === 'approval') &&
    typeof r.reason === 'string'
  );
}

/** Parses JSONL text into audit records, noting lines that are not records. */
export function parseAuditLog(text: string): { records: AuditRecord[]; invalidLines: number[] } {
  const records: AuditRecord[] = [];
  const invalidLines: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      if (isAuditRecord(value)) records.push(value);
      else invalidLines.push(i + 1);
    } catch {
      invalidLines.push(i + 1);
    }
  });
  return { records, invalidLines };
}

/** Summarizes audit records: counts by decision and tool, approvals, and denial reasons. */
export function summarizeAudit(records: AuditRecord[], invalidLines: number[] = []): AuditSummary {
  const byDecision = emptyCounts();
  const tools = new Map<string, DecisionCounts>();
  const approvals = { approved: 0, declined: 0 };
  const denials = new Map<string, { tool: string; rule: string; reason: string; count: number }>();
  let checks = 0;
  let from: string | undefined;
  let to: string | undefined;

  for (const r of records) {
    if (typeof r.time === 'string') {
      if (!from || r.time < from) from = r.time;
      if (!to || r.time > to) to = r.time;
    }
    if (r.event === 'approval') {
      if (r.decision === 'allow') approvals.approved++;
      else approvals.declined++;
    } else {
      checks++;
      byDecision[r.decision]++;
      let counts = tools.get(r.tool);
      if (!counts) tools.set(r.tool, (counts = emptyCounts()));
      counts[r.decision]++;
    }
    if (r.decision === 'deny') {
      const key = `${r.tool}\0${r.rule}\0${r.reason}`;
      const entry = denials.get(key);
      if (entry) entry.count++;
      else denials.set(key, { tool: r.tool, rule: String(r.rule), reason: r.reason, count: 1 });
    }
  }

  return {
    checks,
    byDecision,
    byTool: [...tools.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([tool, counts]) => ({ tool, counts, total: counts.allow + counts.deny + counts.approve })),
    approvals,
    denials: [...denials.values()].sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    invalidLines,
  };
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join('  ').trimEnd()).join('\n');
}

/** Renders a summary as plain text for a terminal. */
export function formatAuditSummary(s: AuditSummary): string {
  const lines: string[] = [];
  lines.push(`${s.checks} decision${s.checks === 1 ? '' : 's'}: ${s.byDecision.allow} allowed, ${s.byDecision.deny} denied, ${s.byDecision.approve} sent for approval`);
  if (s.from && s.to) lines.push(`from ${s.from} to ${s.to}`);
  if (s.approvals.approved || s.approvals.declined) {
    lines.push(`approvals: ${s.approvals.approved} approved, ${s.approvals.declined} declined`);
  }
  if (s.byTool.length) {
    lines.push('', table([
      ['tool', 'allow', 'deny', 'approve', 'total'],
      ...s.byTool.map((t) => [t.tool, String(t.counts.allow), String(t.counts.deny), String(t.counts.approve), String(t.total)]),
    ]));
  }
  if (s.denials.length) {
    lines.push('', 'denials:');
    for (const d of s.denials) lines.push(`  ${String(d.count).padStart(4)}  ${d.tool} [${d.rule}] ${d.reason}`);
  }
  if (s.invalidLines.length) {
    const shown = s.invalidLines.slice(0, 10).join(', ');
    lines.push('', `skipped ${s.invalidLines.length} line${s.invalidLines.length === 1 ? '' : 's'} that are not audit records: ${shown}${s.invalidLines.length > 10 ? ', ...' : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
