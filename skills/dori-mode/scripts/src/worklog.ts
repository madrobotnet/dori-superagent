import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export type WorklogItem = {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly openedAt: string;
  readonly next?: string;
  readonly notes: readonly { readonly at: string; readonly text: string }[];
  readonly closedAt?: string;
  readonly result?: string;
};
type Event =
  | { readonly op: "add"; readonly id: string; readonly at: string; readonly title: string; readonly source: string }
  | { readonly op: "next"; readonly id: string; readonly at: string; readonly text: string }
  | { readonly op: "note"; readonly id: string; readonly at: string; readonly text: string }
  | { readonly op: "close"; readonly id: string; readonly at: string; readonly result: string };
export type WorklogRead = { readonly items: WorklogItem[]; readonly problems: string[] };
export class WorklogError extends Error {}

/** First line of a worklog.md this module wrote. A file without it is someone's notes and is never replaced. */
export const WORKLOG_MARKER = "<!-- written by dori worklog from worklog.jsonl; change it with the command -->";

const ID = /^[0-9a-f]{8}$/;
const singleLine = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const isoTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

const parseEvent = (value: unknown): Event => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorklogError("worklog record must be a JSON object");
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !ID.test(record.id)) throw new WorklogError('worklog field "id" must be 8 lowercase hex digits');
  if (!isoTime(record.at)) throw new WorklogError('worklog field "at" must be an ISO time as toISOString writes it');
  const fields: Record<string, Record<string, number>> = { add: { title: 200, source: 400 }, next: { text: 1000 }, note: { text: 1000 }, close: { result: 1000 } };
  const wanted = typeof record.op === "string" ? fields[record.op] : undefined;
  if (!wanted) throw new WorklogError('worklog field "op" must be add, next, note or close');
  const unknown = Object.keys(record).find((name) => !["op", "id", "at", ...Object.keys(wanted)].includes(name));
  if (unknown !== undefined) throw new WorklogError(`unknown worklog field "${unknown}"`);
  for (const [name, max] of Object.entries(wanted)) {
    if (!singleLine(record[name], max)) throw new WorklogError(`worklog field "${name}" must be one nonempty line of at most ${max} characters`);
  }
  return record as Event;
};

/**
 * The lead's list of owner requests. worklog.jsonl is the record: one O_APPEND write per change, so concurrent
 * writers never lose each other's lines. worklog.md is rendered from it after every change for the lead to read.
 */
export class Worklog {
  readonly path: string;
  readonly markdownPath: string;

  constructor(readonly stateDir: string) {
    this.path = join(stateDir, "worklog.jsonl");
    this.markdownPath = join(stateDir, "worklog.md");
  }

  read(): WorklogRead {
    return this.fold(existsSync(this.path) ? readFileSync(this.path, "utf8") : "");
  }

  open(): WorklogItem[] {
    return this.read().items.filter((item) => item.closedAt === undefined);
  }

  add(title: string, source: string, now: number): WorklogItem {
    const known = new Set(this.read().items.map((item) => item.id));
    let id = randomBytes(4).toString("hex");
    while (known.has(id)) id = randomBytes(4).toString("hex");
    return this.write({ op: "add", id, at: new Date(now).toISOString(), title: title.trim(), source: source.trim() });
  }

  next(id: string, text: string, now: number): WorklogItem {
    this.openItem(id);
    return this.write({ op: "next", id, at: new Date(now).toISOString(), text: text.trim() });
  }

  note(id: string, text: string, now: number): WorklogItem {
    this.openItem(id);
    return this.write({ op: "note", id, at: new Date(now).toISOString(), text: text.trim() });
  }

  close(id: string, result: string, now: number): WorklogItem {
    this.openItem(id);
    return this.write({ op: "close", id, at: new Date(now).toISOString(), result: result.trim() });
  }

  private openItem(id: string): WorklogItem {
    const item = this.read().items.find((candidate) => candidate.id === id);
    if (!item) throw new WorklogError(`worklog item not found: ${id}`);
    if (item.closedAt !== undefined) throw new WorklogError(`worklog item ${id} is closed: ${item.result ?? ""}`);
    return item;
  }

  private fold(text: string): WorklogRead {
    const items = new Map<string, WorklogItem>();
    const problems: string[] = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const event = parseEvent(JSON.parse(line));
        const item = items.get(event.id);
        if (event.op === "add") {
          if (item) throw new WorklogError(`worklog item ${event.id} was already added`);
          items.set(event.id, { id: event.id, title: event.title, source: event.source, openedAt: event.at, notes: [] });
          continue;
        }
        if (!item) throw new WorklogError(`worklog item ${event.id} was never added`);
        if (event.op === "next") items.set(event.id, { ...item, next: event.text });
        else if (event.op === "note") items.set(event.id, { ...item, notes: [...item.notes, { at: event.at, text: event.text }] });
        else items.set(event.id, { ...item, closedAt: event.at, result: event.result });
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof WorklogError)) throw error;
        problems.push(`${this.path}:${index + 1}: ${error.message}`);
      }
    }
    return { items: [...items.values()], problems };
  }

  private write(event: Event): WorklogItem {
    parseEvent(event);
    mkdirSync(this.stateDir, { recursive: true });
    // Check before the append, so a refused render leaves the record unchanged too.
    this.ensureOwnedMarkdown();
    const fd = openSync(this.path, "a+", 0o600);
    try {
      // A writer that stopped mid-record left no newline: start on a fresh line so only the torn line is damaged.
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
      writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(event)}\n`);
    } finally {
      closeSync(fd);
    }
    const item = this.render().items.find((candidate) => candidate.id === event.id);
    if (!item) throw new WorklogError(`worklog item ${event.id} did not read back`);
    return item;
  }

  private ensureOwnedMarkdown(): void {
    if (!existsSync(this.markdownPath)) return;
    const first = readFileSync(this.markdownPath, "utf8").split("\n", 1)[0];
    if (first !== WORKLOG_MARKER) throw new WorklogError(`${this.markdownPath} was not written by dori worklog; move it aside before using the command`);
  }

  /** Rewrite worklog.md from the whole record: temp file + rename, so a reader never sees half a file. */
  private render(): WorklogRead {
    const text = renderUntilStable(() => readFileSync(this.path, "utf8"), (record) => {
      const tmp = `${this.markdownPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, renderWorklog(this.fold(record).items), { encoding: "utf8", mode: 0o600 });
        renameSync(tmp, this.markdownPath);
      } finally {
        rmSync(tmp, { force: true });
      }
    }, () => statSync(this.path).size);
    return this.fold(text);
  }
}

/**
 * Publish a view of an append-only record until the record stopped growing during the publish. Another writer that
 * appended meanwhile may have published before us, leaving our older view last, so we publish again. The last publish
 * to finish therefore always holds every record, without a lock.
 */
export const renderUntilStable = (read: () => string, publish: (record: string) => void, size: () => number): string => {
  for (;;) {
    const record = read();
    publish(record);
    if (size() === Buffer.byteLength(record)) return record;
  }
};

const itemBlock = (item: WorklogItem): string => [
  `### ${item.id} ${item.title}`,
  `- Source: ${item.source}`,
  `- Opened: ${item.openedAt}`,
  `- Next: ${item.next ?? "(none yet)"}`,
  ...(item.notes.length ? ["- Notes:", ...item.notes.map((note) => `  - ${note.at} ${note.text}`)] : []),
  ...(item.closedAt !== undefined ? [`- Closed: ${item.closedAt}`, `- Result: ${item.result ?? ""}`] : []),
].join("\n");

export const renderWorklog = (items: readonly WorklogItem[]): string => {
  const open = items.filter((item) => item.closedAt === undefined);
  const closed = items.filter((item) => item.closedAt !== undefined).reverse();
  const section = (title: string, list: readonly WorklogItem[]) => `## ${title}\n\n${list.length ? list.map(itemBlock).join("\n\n") : "(none)"}\n`;
  return `${WORKLOG_MARKER}\n# Worklog\n\n${section("Open", open)}\n${section("Closed", closed)}`;
};

export const worklogLines = (items: readonly WorklogItem[]): string[] => {
  const open = items.filter((item) => item.closedAt === undefined);
  return [
    `WORKLOG open=${open.length}`,
    ...open.map((item) => `OPEN ${item.id} ${JSON.stringify(item.title)} source=${item.source} next=${JSON.stringify(item.next ?? "")}`),
  ];
};
