#!/usr/bin/env bash
# 检测 SQL 文件中残留的 snake_case 列名引用
# 规则：SQLite 列名统一使用 camelCase，表名保持 snake_case

set -euo pipefail

SCAN_DIRS=(
  "apps/desktop-shell/src/storage"
  "apps/backend/src/local-server"
)

# 排除的 snake_case 标识符（表名、索引名、meta key 等合法 snake_case）
EXCLUDE_PATTERNS=(
  # desktop-shell 表名
  "tasks"
  "task_outputs"
  "task_output"
  "media_assets"
  "task_events"
  "batches"
  "graph"
  "nodes"
  "edges"
  "package_entries"
  "package_entries_graph"
  "project_manifest"
  "project_pending_deltas"
  "meta"
  "project.sqlite"
  # desktop-shell 时间线表名
  "timeline_points"
  "timeline_items"
  # desktop-shell chat 表名
  "chat_sessions"
  "chat_messages"
  "chat_send_records"
  "chat_sessions_v"
  # desktop-shell agent 会话表名
  "agent_sessions"
  "agent_messages"
  "agent_tool_calls"
  "agent_send_records"
  # desktop-shell meta key 值
  "model_node_usage"
  "node_type_usage"
  "node_palette_pins"
  "character_pins"
  "schema_version"
  # desktop-shell 索引名前缀
  "project_pending_deltas_created"
  "task_outputs_task"
  "task_events_task"
  "batches_source"
  "timeline_graph"
  "timeline_points_timeline"
  "timeline_items_timeline"
  "chat_send_records_session"
  "chat_sessions_node"
  "chat_sessions_graph"
  "chat_messages_session"
  # desktop-shell agent 索引名前缀
  "agent_tool_calls_agent"
  "agent_send_records_agent"
  "agent_send_records_node"
  # desktop-shell system_prompts 表名
  "system_prompts"
  # backend 错误码枚举值（含 CREATE 等关键字被误匹配为 SQL）
  "create_failed"
  "file_too_large"
  "invalid_project"
  "internal_error"
  "project_not_found"
  # backend 表名
  "runtime_task_index"
  "runtime_task_outputs"
  "runtime_task_output_tombstones"
  "runtime_task_output_slot_tombstones"
  "api_key_group_catalog"
  "api_key_group_policies"
  "api_key_group_policy_groups"
  "api_key_group_policy_model_bindings"
)

FOUND=0

for STORAGE_DIR in "${SCAN_DIRS[@]}"; do
  for file in "$STORAGE_DIR"/*.cts "$STORAGE_DIR"/*.ts; do
    [ -f "$file" ] || continue

    while IFS= read -r line; do
      lineno=$(echo "$line" | cut -d: -f1)
      content=$(echo "$line" | cut -d: -f2-)

      if echo "$content" | grep -qE '^\s*(//|\*)'; then
        continue
      fi

      matches=$(echo "$content" | grep -oE '\b[a-z]+(_[a-z]+)+' || true)

      for match in $matches; do
        skip=false
        for t in "${EXCLUDE_PATTERNS[@]}"; do
          if [ "$match" = "$t" ]; then
            skip=true
            break
          fi
        done

        if [ "$skip" = false ]; then
          echo "${file}:${lineno}: ${match}"
          FOUND=1
        fi
      done
    done < <(grep -nE '(INSERT|SELECT|UPDATE|DELETE|CREATE|WHERE|ORDER BY|REFERENCES|ON\s+\w+\.\w+)' "$file" | grep -v '^\s*//' || true)
  done
done

if [ "$FOUND" -ne 0 ]; then
  echo ""
  echo "Found snake_case column name references in SQL statements."
  echo "Column names must use camelCase. Table names keep snake_case."
  exit 1
fi

echo "No snake_case column name residues found."
exit 0
