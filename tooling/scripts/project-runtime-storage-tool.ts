import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

type TaskRowDump = {
  rowid: number;
  taskId: string | null;
  requestJson: string | null;
  metadataJson: string | null;
};

const action = process.argv[2];
const projectPath = process.argv[3];
const requireFromHere = createRequire(import.meta.url);
const projectorModule = requireFromHere("../../apps/backend/src/local-server/task-storage-summary-projector.cts") as {
  projectRuntimeTaskMetadataSummary: (metadata: unknown, request: unknown) => Record<string, unknown> | null;
  projectRuntimeTaskRequestSummary: (request: unknown, metadata: unknown) => Record<string, unknown> | null;
};
const projectRuntimeTaskMetadataSummary = projectorModule.projectRuntimeTaskMetadataSummary;
const projectRuntimeTaskRequestSummary = projectorModule.projectRuntimeTaskRequestSummary;

const usage = (): never => {
  console.error("usage: pnpm exec tsx tooling/scripts/project-runtime-storage-tool.ts <inspect|compact> <projectPath>");
  process.exit(1);
};

if (!action || !projectPath) {
  usage();
}

const requireStringArg = (value: string | undefined): string => {
  if (!value) {
    throw new Error("missing_required_argument");
  }
  return value;
};

const checkedProjectPath = requireStringArg(projectPath);

const walkSize = (targetPath: string) => {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    total += walkSize(path.join(targetPath, entry.name));
  }
  return total;
};

const runPythonJson = (script: string, args: string[]) => {
  const output = execFileSync("python3", ["-c", script, ...args], {
    encoding: "utf-8",
  });
  return JSON.parse(output) as unknown;
};

const loadTaskRows = (dbPath: string) => {
  const dumpPath = path.join(os.tmpdir(), `runtime-storage-rows-${Date.now()}.json`);
  execFileSync(
    "python3",
    [
      "-c",
      [
        "import json, sqlite3, sys",
        "db = sqlite3.connect(sys.argv[1])",
        "db.row_factory = sqlite3.Row",
        "rows = db.execute('select rowid, taskId, requestJson, metadataJson from tasks').fetchall()",
        "with open(sys.argv[2], 'w', encoding='utf-8') as fh:",
        "  json.dump([dict(row) for row in rows], fh, ensure_ascii=False)",
      ].join("\n"),
      dbPath,
      dumpPath,
    ],
    { encoding: "utf-8" },
  );
  try {
    return JSON.parse(fs.readFileSync(dumpPath, "utf-8")) as TaskRowDump[];
  } finally {
    fs.rmSync(dumpPath, { force: true });
  }
};

const writeTaskRows = (dbPath: string, updatesPath: string) => {
  execFileSync(
    "python3",
    [
      "-c",
      [
        "import json, sqlite3, sys",
        "db = sqlite3.connect(sys.argv[1])",
        "updates = json.load(open(sys.argv[2], 'r', encoding='utf-8'))",
        "db.executemany('update tasks set requestJson = ?, metadataJson = ? where rowid = ?', [(item['requestJson'], item['metadataJson'], item['rowid']) for item in updates])",
        "db.commit()",
        "db.execute('pragma wal_checkpoint(TRUNCATE)')",
        "db.execute('vacuum')",
        "db.close()",
      ].join("; "),
      dbPath,
      updatesPath,
    ],
    { encoding: "utf-8" },
  );
};

const queryInspection = (dbPath: string) =>
  runPythonJson(
    [
      "import json, sqlite3, sys",
      "def parse_json(text):",
      "  if text is None or text == '': return None",
      "  try: return json.loads(text)",
      "  except Exception: return None",
      "def has_key(value, target):",
      "  if isinstance(value, dict):",
      "    if target in value: return True",
      "    return any(has_key(v, target) for v in value.values())",
      "  if isinstance(value, list):",
      "    return any(has_key(v, target) for v in value)",
      "  return False",
      "def has_submit_request_body(value):",
      "  if isinstance(value, dict):",
      "    submit_request = value.get('submit_request')",
      "    if isinstance(submit_request, dict) and 'body' in submit_request: return True",
      "    task_plan = value.get('taskExecutionPlan')",
      "    if isinstance(task_plan, dict) and has_submit_request_body(task_plan): return True",
      "    return any(has_submit_request_body(v) for v in value.values())",
      "  if isinstance(value, list):",
      "    return any(has_submit_request_body(v) for v in value)",
      "  return False",
      "db = sqlite3.connect(sys.argv[1])",
      "db.row_factory = sqlite3.Row",
      "rows = db.execute('select requestJson, metadataJson from tasks').fetchall()",
      "task_count = len(rows)",
      "request_lengths = [len(row['requestJson']) if row['requestJson'] else 0 for row in rows]",
      "metadata_lengths = [len(row['metadataJson']) if row['metadataJson'] else 0 for row in rows]",
      "data_base64_count = 0",
      "__form_data_count = 0",
      "submit_request_body_count = 0",
      "for row in rows:",
      "  request_obj = parse_json(row['requestJson'])",
      "  metadata_obj = parse_json(row['metadataJson'])",
      "  combined = [request_obj, metadata_obj]",
      "  if any(has_key(item, 'dataBase64') for item in combined): data_base64_count += 1",
      "  if any(has_key(item, '__formData') for item in combined): __form_data_count += 1",
      "  if any(has_submit_request_body(item) for item in combined): submit_request_body_count += 1",
      "statuses = db.execute('select status, count(*) as count from tasks group by status order by status').fetchall()",
      "table_sizes = []",
      "try:",
      "  dbstat_rows = db.execute('select name, sum(pgsize) as bytes from dbstat group by name order by bytes desc').fetchall()",
      "  table_sizes = [{'name': row['name'], 'bytes': row['bytes']} for row in dbstat_rows]",
      "except Exception:",
      "  table_sizes = []",
      "print(json.dumps({",
      "  'taskCount': task_count,",
      "  'tasksRequestBytes': sum(request_lengths),",
      "  'tasksRequestMaxBytes': max(request_lengths) if request_lengths else 0,",
      "  'tasksMetadataBytes': sum(metadata_lengths),",
      "  'tasksMetadataMaxBytes': max(metadata_lengths) if metadata_lengths else 0,",
      "  'tasksContainingDataBase64': data_base64_count,",
      "  'tasksContainingFormData': __form_data_count,",
      "  'tasksContainingSubmitRequestBody': submit_request_body_count,",
      "  'statuses': [{'status': row['status'], 'count': row['count']} for row in statuses],",
      "  'sqliteTableBytesApprox': table_sizes",
      "}, ensure_ascii=False))",
    ].join("\n"),
    [dbPath],
  ) as {
    taskCount: number;
    tasksRequestBytes: number;
    tasksRequestMaxBytes: number;
    tasksMetadataBytes: number;
    tasksMetadataMaxBytes: number;
    tasksContainingDataBase64: number;
    tasksContainingFormData: number;
    tasksContainingSubmitRequestBody: number;
    statuses: Array<{ status: string; count: number }>;
    sqliteTableBytesApprox: Array<{ name: string; bytes: number }>;
  };

const parseJsonText = (value: string | null) => {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const compactProjectRuntimeStorage = (targetProjectPath: string) => {
  const rows = loadTaskRows(path.join(targetProjectPath, "project.sqlite"));
  const updates: Array<{ rowid: number; requestJson: string | null; metadataJson: string | null }> = [];
  for (const row of rows) {
    const requestObject = parseJsonText(row.requestJson);
    const metadataObject = parseJsonText(row.metadataJson);
    const requestSummary =
      requestObject && typeof requestObject === "object"
        ? projectRuntimeTaskRequestSummary(requestObject, metadataObject)
        : null;
    const metadataSummary =
      metadataObject && typeof metadataObject === "object"
        ? projectRuntimeTaskMetadataSummary(metadataObject, requestObject)
        : null;
    const nextRequestJson = requestSummary ? JSON.stringify(requestSummary) : null;
    const nextMetadataJson = metadataSummary ? JSON.stringify(metadataSummary) : null;
    if (nextRequestJson === row.requestJson && nextMetadataJson === row.metadataJson) {
      continue;
    }
    updates.push({
      rowid: row.rowid,
      requestJson: nextRequestJson,
      metadataJson: nextMetadataJson,
    });
  }

  if (updates.length > 0) {
    const tempPath = path.join(os.tmpdir(), `runtime-storage-updates-${Date.now()}.json`);
    fs.writeFileSync(tempPath, JSON.stringify(updates), "utf-8");
    try {
      writeTaskRows(path.join(targetProjectPath, "project.sqlite"), tempPath);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  } else {
    execFileSync(
      "python3",
      [
        "-c",
        [
          "import sqlite3, sys",
          "db = sqlite3.connect(sys.argv[1])",
          "db.execute('pragma wal_checkpoint(TRUNCATE)')",
          "db.execute('vacuum')",
          "db.close()",
        ].join("; "),
        path.join(targetProjectPath, "project.sqlite"),
      ],
      { encoding: "utf-8" },
    );
  }

  return {
    ok: true,
    projectPath: targetProjectPath,
    sqlitePath: path.join(targetProjectPath, "project.sqlite"),
    rewrittenTaskCount: updates.length,
    taskArchivesPath: path.join(targetProjectPath, ".iartstudio", "task-archives"),
    legacyTaskArchivesPath: path.join(targetProjectPath, "task-archives"),
  };
};

const inspectProjectStorage = (targetProjectPath: string) => {
  const inspection = queryInspection(path.join(targetProjectPath, "project.sqlite"));
  return {
    projectPath: targetProjectPath,
    totalBytes: walkSize(targetProjectPath),
    taskArchivesBytes: walkSize(path.join(targetProjectPath, ".iartstudio", "task-archives")),
    legacyTaskArchivesBytes: walkSize(path.join(targetProjectPath, "task-archives")),
    mediaBytes: walkSize(path.join(targetProjectPath, "media")),
    sqliteBytes: walkSize(path.join(targetProjectPath, "project.sqlite")),
    sqliteWalBytes: walkSize(path.join(targetProjectPath, "project.sqlite-wal")),
    legacyTaskArchivesPresent: fs.existsSync(path.join(targetProjectPath, "task-archives")),
    ...inspection,
  };
};

if (action === "inspect") {
  console.log(JSON.stringify(inspectProjectStorage(checkedProjectPath), null, 2));
} else if (action === "compact") {
  console.log(JSON.stringify(compactProjectRuntimeStorage(checkedProjectPath), null, 2));
} else {
  usage();
}
