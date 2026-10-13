import { assert, fs, path, makeTempDir, runBuildScript, serialTest, withRequiredRuntime, writeJson, writeSourcePackage } from './build-model-asset-packages.test-helpers.mjs';

serialTest('build-model-asset-packages: 未知 execution_driver 时应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-adapter');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-adapter',
      entry_model: {
        model_id: 'bad-adapter-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('bad-adapter-model', {
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
      runtime: {
        execution_driver: 'vendor_private_task',
      },
    }));
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, '未知 execution_driver 应阻断打包');
    assert.match(result.stderr, /runtime_model\.runtime\.execution_driver_unknown:vendor_private_task/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: provider_id 格式非法时应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-provider');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-provider',
      entry_model: {
        model_id: 'bad-provider-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('bad-provider-model', {
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
      runtime: {
        provider_id: 'Not Registered!',
      },
    }));
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, '非法 provider_id 应阻断打包');
    assert.match(result.stderr, /runtime_model\.runtime\.provider_id_invalid:Not Registered!/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: 合法未知 provider_id 可通过打包', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'unknown-provider',
      modelId: 'unknown-provider-model',
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
        runtime: {
          provider_id: 'new-provider',
        },
      },
    });

    const result = runBuildScript(tempDir);
    assert.equal(result.status, 0, '合法未知 provider_id 不应阻断打包');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: runtime.polling 旧字段应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-polling');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-polling',
      entry_model: {
        model_id: 'bad-polling-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('bad-polling-model', {
      capability: {
        input_modalities: ['text'],
        output_modalities: ['video'],
        supports_async_task: true,
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
        polling: {
          enabled: true,
        },
      },
    }));
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'runtime.polling 旧字段应阻断打包');
    assert.match(result.stderr, /runtime_model\.runtime\.polling_not_supported/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: runtime.result_extractor 旧字段应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-result-extractor');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-result-extractor',
      entry_model: {
        model_id: 'bad-result-extractor-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('bad-result-extractor-model', {
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
      runtime: {
        result_extractor: {
          image_paths: ['data.images[0].url'],
        },
      },
    }));
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'runtime.result_extractor 旧字段应阻断打包');
    assert.match(result.stderr, /runtime_model\.runtime\.result_extractor_not_supported/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: mode=sync 时声明 polling_strategy 应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-sync-with-polling-strategy');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-sync-with-polling-strategy',
      entry_model: {
        model_id: 'bad-sync-with-polling-strategy-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(
      path.join(sourceDir, 'runtime_model.json'),
      withRequiredRuntime('bad-sync-with-polling-strategy-model', {
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
        request_strategy: {
          request_stage: 'submit',
          protocol: 'http',
          endpoint: '/v1/tasks',
          method: 'POST',
        },
        polling_strategy: {
          request: {
            url_template: '/v1/tasks/{id}',
            method: 'GET',
          },
          polling: {
            intervalMs: 1000,
            maxAttempts: 20,
          },
        },
        result_rule: {
          mode: 'sync',
        },
      }),
    );
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'mode=sync + polling_strategy 应阻断打包');
    assert.match(result.stderr, /runtime_model\.sync_mode_polling_strategy_not_allowed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
