import { assert, fs, path, makeTempDir, runBuildScript, serialTest, withRequiredRuntime, writeJson, writeSourcePackage } from './build-model-asset-packages.test-helpers.mjs';

serialTest('build-model-asset-packages: 非法 Gemini 特殊 operator options 应在构建阶段阻断', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'broken-special-operator',
      modelId: 'broken-special-operator-model',
      runtimeModel: {
        capability: {
          input_modalities: ['text', 'image'],
          output_modalities: ['image'],
          supports_async_task: false,
        },
        parameter_schema: {
          fields: [
            {
              field_key: 'size',
              component: 'text',
              required: false,
            },
          ],
        },
        runtime: {
          default_task_type: 'image',
          mode: 'image',
          payload_rules: {
            'body.contents': {
              kind: 'compute',
              operator: 'build_content_blocks',
              options: {
                role: 'user',
                parts: [],
              },
            },
          },
        },
      },
    });

    const buildResult = runBuildScript(tempDir);
    assert.notEqual(buildResult.status, 0, '非法特殊 operator 不应通过构建');
    assert.match(
      buildResult.stderr || buildResult.stdout,
      /runtime_model\.runtime\.payload_rules_compute_build_content_blocks_parts_missing/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: node_definition.display_name 旧字段应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'legacy-node-display-name',
      modelId: 'legacy-node-display-name-model',
      runtimeModel: {
        capability: {
          input_modalities: ['text'],
          output_modalities: ['image'],
          supports_async_task: false,
        },
        parameter_schema: {
          fields: [
            {
              field_key: 'size',
              component: 'text',
              required: false,
            },
          ],
        },
      },
      nodeDefinition: {
        display_name: 'Legacy Node Name',
      },
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'node_definition.display_name 旧字段应阻断打包');
    assert.match(
      result.stderr || result.stdout,
      /node_definition\.display_name_legacy_key_not_allowed:display_name/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: manifest.display_name 旧字段应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'legacy-manifest-display-name');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'legacy-manifest-display-name',
      display_name: 'Legacy Manifest Name',
      entry_model: {
        model_id: 'legacy-manifest-display-name-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(
      path.join(sourceDir, 'runtime_model.json'),
      withRequiredRuntime('legacy-manifest-display-name-model', {
        capability: {
          input_modalities: ['text'],
          output_modalities: ['image'],
          supports_async_task: false,
        },
        parameter_schema: {
          fields: [
            {
              field_key: 'size',
              component: 'text',
              required: false,
            },
          ],
        },
      }),
    );
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'manifest.display_name 旧字段应阻断打包');
    assert.match(
      result.stderr || result.stdout,
      /manifest\.display_name_legacy_key_not_allowed:display_name/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: runtime_model.display.display_name 旧字段应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'legacy-runtime-display-name',
      modelId: 'legacy-runtime-display-name-model',
      runtimeModel: {
        capability: {
          input_modalities: ['text'],
          output_modalities: ['image'],
          supports_async_task: false,
        },
        parameter_schema: {
          fields: [
            {
              field_key: 'size',
              component: 'text',
              required: false,
            },
          ],
        },
        display: {
          display_name: 'Legacy Runtime Name',
        },
      },
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'runtime_model.display.display_name 旧字段应阻断打包');
    assert.match(
      result.stderr || result.stdout,
      /runtime_model\.display\.display_name_legacy_key_not_allowed:display_name/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: 包契约缺失时阻断并返回错误', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'broken');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'broken',
      entry_model: {
        model_id: 'broken-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('broken-model', {
      capability: {
        input_modalities: ['text'],
        output_modalities: ['image'],
        supports_async_task: false,
      },
    }));
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, '缺失参数 schema 时应阻断打包');
    assert.match(result.stderr, /runtime_model\.parameter_schema_missing/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
