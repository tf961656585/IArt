import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { ModelAssetNodeProjection } from "@iart/contracts/model-asset-contract";
import { buildModelConfigsFromNodeProjections } from "../../modelAssetProjectionBridge";

type JsonRecord = Record<string, unknown>;

export const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonRecord = (content: string): JsonRecord => {
  const parsed: unknown = JSON.parse(content);
  if (!isJsonRecord(parsed)) {
    throw new Error("invalid_json_record");
  }
  return parsed;
};

export const buildSingleConfig = (
  projection: ModelAssetNodeProjection | null | undefined,
) => {
  expect(projection).toBeTruthy();
  if (!projection) {
    throw new Error("missing_projection");
  }
  const [config] = buildModelConfigsFromNodeProjections([projection]);
  if (!config) {
    throw new Error("missing_model_config");
  }
  return config;
};

export const loadPackageProjections = (): ModelAssetNodeProjection[] => {
  const packagesRoot = path.join(process.cwd(), ".model-assets", "packages");
  return fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageDir = path.join(packagesRoot, entry.name);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(packageDir, "manifest.json"), "utf-8"),
      ) as {
        package_id: string;
        entry_model: { relative_path: string };
        node_definition: { relative_path: string };
      };
      const runtimeModel = parseJsonRecord(
        fs.readFileSync(
          path.join(packageDir, manifest.entry_model.relative_path),
          "utf-8",
        ),
      );
      const nodeDefinition = parseJsonRecord(
        fs.readFileSync(
          path.join(packageDir, manifest.node_definition.relative_path),
          "utf-8",
        ),
      );
      const runtimeDisplay = readRecordProperty(runtimeModel, "display");

      return {
        package_id: manifest.package_id,
        model_id: String(runtimeModel["model_id"] ?? ""),
        node_type: "model",
        role: runtimeModel["role"] as ModelAssetNodeProjection["role"],
        description: String(nodeDefinition["description"] ?? ""),
        group_key: String(nodeDefinition["group_key"] ?? ""),
        capability: runtimeModel[
          "capability"
        ] as ModelAssetNodeProjection["capability"],
        ports: {
          inputs: (nodeDefinition["input_ports"] ??
            []) as ModelAssetNodeProjection["ports"]["inputs"],
          outputs: (nodeDefinition["output_ports"] ??
            []) as ModelAssetNodeProjection["ports"]["outputs"],
        },
        parameter_schema: runtimeModel[
          "parameter_schema"
        ] as ModelAssetNodeProjection["parameter_schema"],
        prompt_field: runtimeModel["prompt_field"] as
          | ModelAssetNodeProjection["prompt_field"]
          | undefined,
        execution_profile: runtimeModel[
          "execution_profile"
        ] as ModelAssetNodeProjection["execution_profile"],
        visibility: runtimeDisplay
          ? {
              visible: runtimeDisplay["visible"] !== false,
              order: Number(runtimeDisplay["order"] ?? 100),
            }
          : {
              visible: true,
              order: 100,
            },
        runtime: runtimeModel["runtime"] as ModelAssetNodeProjection["runtime"],
      } satisfies ModelAssetNodeProjection;
    });
};

export const FORMAL_UPLOAD_URL =
  "https://backend-owned.example/runtime-input.png";
export const EXPECTED_PUBLIC_RELAY_TARGET_TYPES: Record<
  string,
  "cloudflare_image_public_url" | "self_hosted_image_public_url"
> = {
  "doubao-seedance-1-5-pro-251215": "self_hosted_image_public_url",
  "doubao-seedance-2-0-260128": "cloudflare_image_public_url",
  "doubao-seedance-2-0-fast-260128": "cloudflare_image_public_url",
  "doubao-seedance-2-0-mini-260615": "cloudflare_image_public_url",
  "kling-v3-image2video": "self_hosted_image_public_url",
  "kling-v3-omni-video": "cloudflare_image_public_url",
};

export const readOptionalString = (
  value: unknown,
  key: string,
): string | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
};

export const readRecordProperty = (
  value: unknown,
  key: string,
): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  return candidate as Record<string, unknown>;
};

export { buildModelConfigsFromNodeProjections };
