import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateModelPortCoverage } from '../../../../../../tooling/scripts/validate-model-ports';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-model-port-audit-'));
  tempDirs.push(tempDir);
  return tempDir;
};

const writeJson = (targetPath: string, data: unknown): void => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const writePackage = (
  packageRoot: string,
  packageId: string,
  runtimeModel: unknown,
  nodeDefinition: unknown,
): void => {
  const packageDir = path.join(packageRoot, packageId);
  writeJson(path.join(packageDir, 'manifest.json'), {
    package_id: packageId,
    entry_model: {
      relative_path: 'runtime_model.json',
    },
    node_definition: {
      relative_path: 'node_definition.json',
    },
  });
  writeJson(path.join(packageDir, 'runtime_model.json'), runtimeModel);
  writeJson(path.join(packageDir, 'node_definition.json'), nodeDefinition);
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('validate-model-ports', () => {
  it('直接审计模型资产包中的图像字段与节点端口一致性', async () => {
    const tempDir = makeTempDir();
    const packageRoot = path.join(tempDir, '.model-assets', 'packages');

    writePackage(
      packageRoot,
      'video-port-fixture',
      {
        parameter_schema: {
          fields: [
            {
              field_key: 'prompt',
              component: 'textarea',
            },
            {
              field_key: 'imageInput',
              component: 'imageUpload',
              component_props: {
                accept: 'image/*',
              },
            },
          ],
        },
        runtime: {
          payload_rules: {
            'body.image': {
              kind: 'field',
              field_key: 'imageInput',
            },
          },
        },
      },
      {
        input_ports: [
          {
            id: 'prompt',
            field_key: 'prompt',
            data_type: 'text',
          },
          {
            id: 'imageInput',
            field_key: 'imageInput',
            data_type: 'image',
          },
        ],
      },
    );

    await expect(validateModelPortCoverage(packageRoot)).resolves.toEqual([]);
  });

  it('payload 正式引用的图像字段缺失时应报错', async () => {
    const tempDir = makeTempDir();
    const packageRoot = path.join(tempDir, '.model-assets', 'packages');

    writePackage(
      packageRoot,
      'video-port-mismatch-fixture',
      {
        parameter_schema: {
          fields: [
            {
              field_key: 'imageReference',
              component: 'imageUpload',
              component_props: {
                accept: 'image/*',
              },
            },
          ],
        },
        runtime: {
          payload_rules: {
            'body.image': {
              kind: 'field',
              field_key: 'imageReference',
            },
          },
        },
      },
      {
        input_ports: [
          {
            id: 'referenceImage',
            field_key: 'referenceImage',
            data_type: 'image',
          },
        ],
      },
    );

    await expect(validateModelPortCoverage(packageRoot)).resolves.toEqual([
      'video-port-mismatch-fixture: 图像端口字段与正式 payload 不一致 | payload_image_fields=imageReference | declared_image_fields=referenceImage | missing_image_fields=imageReference | extra_image_fields=referenceImage',
    ]);
  });
});
