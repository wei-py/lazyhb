import { CLICancelledError, HXClient, redactCLIText, type Command } from "./hx.js";

export interface TaskRecord {
  id: number;
  label: string;
  project?: string;
  target?: string;
  state: "running" | "stopping" | "succeeded" | "failed" | "cancelled";
  lines: string[];
  exitCode?: number;
  error?: string;
}

interface TaskExecution {
  record: TaskRecord;
  client?: HXClient;
  completion: Promise<void>;
  stopping?: Promise<void>;
  stopRequested: boolean;
  errorText: (error: unknown) => string;
}

const LINE_LIMIT = 2000;
const HISTORY_LIMIT = 100;

/** Each invocation owns its client, cancellation and bounded output history. */
export class TaskRunner {
  private readonly records: TaskRecord[] = [];
  private readonly executions = new Map<number, TaskExecution>();
  private nextId = 1;

  constructor(private readonly onChange: () => void) {}

  get tasks(): readonly TaskRecord[] {
    return this.records;
  }

  get active(): boolean {
    return this.executions.size > 0;
  }

  start(
    client: HXClient,
    command: Command,
    parameters: Record<string, string>,
    options: { allowSensitive?: boolean; packConfiguration?: Record<string, unknown>; project?: string },
    metadata: { label: string; project?: string; target?: string },
  ): TaskRecord {
    const capturedParameters = { ...parameters };
    const capturedOptions = { ...options };
    const record: TaskRecord = {
      id: this.nextId++,
      label: redactCLIText(metadata.label, capturedParameters, capturedOptions.packConfiguration),
      project: metadata.project === undefined ? undefined : redactCLIText(metadata.project, capturedParameters, capturedOptions.packConfiguration),
      target: metadata.target === undefined ? undefined : redactCLIText(metadata.target, capturedParameters, capturedOptions.packConfiguration),
      state: "running",
      lines: [],
    };
    const errorText = (error: unknown): string => redactCLIText(
      error instanceof Error ? error.message : typeof error === "string" ? error : "CLI 执行失败",
      capturedParameters,
      capturedOptions.packConfiguration,
    );
    let execution: TaskExecution;
    // Defer even fork/validation failures until the caller receives its record.
    const completion = Promise.resolve().then(async () => {
      try {
        if (execution.stopRequested) {
          record.state = "cancelled";
          return;
        }
        execution.client = client.fork();
        const code = await execution.client.run(command, capturedParameters, (line) => {
          record.lines.push(line);
          if (record.lines.length > LINE_LIMIT)
            record.lines.splice(0, record.lines.length - LINE_LIMIT);
          this.onChange();
        }, capturedOptions);
        record.exitCode = code;
        record.state = code === 0 ? "succeeded" : "failed";
      } catch (error) {
        record.state = error instanceof CLICancelledError ? "cancelled" : "failed";
        if (!(error instanceof CLICancelledError)) record.error = errorText(error);
      } finally {
        this.executions.delete(record.id);
        // Never evict running tasks to make room for completed history.
        let completed = this.records.length - this.executions.size;
        for (let index = 0; completed > HISTORY_LIMIT && index < this.records.length;) {
          if (this.executions.has(this.records[index].id)) index++;
          else {
            this.records.splice(index, 1);
            completed--;
          }
        }
        this.onChange();
      }
    });
    execution = { record, completion, stopRequested: false, errorText };
    this.records.push(record);
    this.executions.set(record.id, execution);
    this.onChange();
    return record;
  }

  stop(id: number): Promise<void> {
    const execution = this.executions.get(id);
    if (!execution) return Promise.resolve();
    if (execution.stopping) return execution.stopping;
    execution.stopRequested = true;
    execution.record.state = "stopping";
    const stopping = Promise.resolve().then(async () => {
      let failure: string | undefined;
      try {
        await execution.client?.cancel();
      } catch (error) {
        failure = execution.errorText(error);
      }
      await execution.completion;
      if (failure !== undefined) {
        execution.record.state = "failed";
        execution.record.error = failure;
        this.onChange();
      }
    });
    execution.stopping = stopping;
    this.onChange();
    return stopping;
  }

  async stopAll(): Promise<void> {
    while (this.executions.size)
      await Promise.all([...this.executions.keys()].map((id) => this.stop(id)));
  }
}
