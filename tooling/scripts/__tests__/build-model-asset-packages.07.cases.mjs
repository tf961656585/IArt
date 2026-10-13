import { assert, fs, path, makeTempDir, runBuildScript, serialTest, withRequiredRuntime, withTestLocales, writeDefaultLocalizationFiles, writeJson } from './build-model-asset-packages.test-helpers.mjs';

serialTest('build-model-asset-packages: mode=sync 时声明 result_acquisition_strategy 应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-sync-with-acquisition');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-sync-with-acquisition',
      entry_model: {
        model_id: 'bad-sync-with-acquisition-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(
      path.join(sourceDir, 'runtime_model.json'),
      withRequiredRuntime('bad-sync-with-acquisition-model', {
        capability: {
          input_modalities: ['text'],
          output_modalities: ['text'],
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
        result_rule: {
          mode: 'sync',
        },
        result_acquisition_strategy: {
          acquisition_mode: 'use_query_response',
        },
      }),
    );
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'mode=sync + result_acquisition_strategy 应阻断打包');
    assert.match(result.stderr, /runtime_model\.sync_mode_result_acquisition_strategy_not_allowed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: mode=async 缺少 request_strategy 应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-async-missing-request');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-async-missing-request',
      entry_model: {
        model_id: 'bad-async-missing-request-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(
      path.join(sourceDir, 'runtime_model.json'),
      withRequiredRuntime('bad-async-missing-request-model', {
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
        request_strategy: undefined,
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
          mode: 'async',
        },
      }),
    );
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'mode=async 缺少 request_strategy 应阻断打包');
    assert.match(result.stderr, /runtime_model\.task_execution_plan_request_strategy_missing/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: mode=async 缺少 polling_strategy 应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-async-missing-polling');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-async-missing-polling',
      entry_model: {
        model_id: 'bad-async-missing-polling-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(
      path.join(sourceDir, 'runtime_model.json'),
      withRequiredRuntime('bad-async-missing-polling-model', {
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
        request_strategy: {
          request_stage: 'submit',
          protocol: 'http',
          endpoint: '/v1/tasks',
          method: 'POST',
        },
        result_rule: {
          mode: 'async',
        },
      }),
    );
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'mode=async 缺少 polling_strategy 应阻断打包');
    assert.match(result.stderr, /runtime_model\.async_mode_polling_strategy_missing/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: mode=sync 且有输出模态时缺少 result_output_mapping 应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-sync-missing-output-mapping');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-sync-missing-output-mapping',
      entry_model: {
        model_id: 'bad-sync-missing-output-mapping-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(
      path.join(sourceDir, 'runtime_model.json'),
      withRequiredRuntime('bad-sync-missing-output-mapping-model', {
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
        result_output_mapping: undefined,
      }),
    );
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'mode=sync 缺少 result_output_mapping 应阻断打包');
    assert.match(result.stderr, /runtime_model\.result_output_mapping_missing/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: result_acquisition_strategy 使用 use_query_response 应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-acquisition-use-query');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-acquisition-use-query',
      entry_model: {
        model_id: 'bad-acquisition-use-query-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(
      path.join(sourceDir, 'runtime_model.json'),
      withRequiredRuntime('bad-acquisition-use-query-model', {
        capability: {
          input_modalities: ['text'],
          output_modalities: ['video'],
          supports_async_task: true,
        },
        execution_profile: {
          task_type: 'video',
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
          mode: 'async',
        },
        result_acquisition_strategy: {
          acquisition_mode: 'use_query_response',
        },
      }),
    );
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'use_query_response 不得作为 acquisition 正式口径');
    assert.match(result.stderr, /runtime_model\.result_acquisition_strategy_mode_invalid:use_query_response/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: supports_async_task=false 但 result_rule.mode=async 应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-async-capability-mismatch');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-async-capability-mismatch',
      entry_model: {
        model_id: 'bad-async-capability-mismatch-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(
      path.join(sourceDir, 'runtime_model.json'),
      withRequiredRuntime('bad-async-capability-mismatch-model', {
        capability: {
          input_modalities: ['text'],
          output_modalities: ['video'],
          supports_async_task: false,
        },
        execution_profile: {
          task_type: 'video',
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
          mode: 'async',
        },
      }),
    );
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'supports_async_task=false + mode=async 应阻断打包');
    assert.match(result.stderr, /runtime_model\.capability_supports_async_task_mode_mismatch/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: request_strategy.async_mode 作为重复事实源应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-request-async-mode');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-request-async-mode',
      entry_model: {
        model_id: 'bad-request-async-mode-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(
      path.join(sourceDir, 'runtime_model.json'),
      withRequiredRuntime('bad-request-async-mode-model', {
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
          async_mode: 'sync',
        },
      }),
    );
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'request_strategy.async_mode 应阻断打包');
    assert.match(result.stderr, /runtime_model\.request_strategy_async_mode_not_allowed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: 支持 when/compute payload rule DSL', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'dsl-ok');
    writeJson(path.join(sourceDir, 'manifest.json'), withTestLocales({
      package_id: 'dsl-ok',
      entry_model: {
        model_id: 'dsl-ok-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    }));
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('dsl-ok-model', {
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
          {
            field_key: 'watermark',
            component: 'switch',
            required: false,
          },
        ],
      },
      prompt_field: {
        field_key: '__prompt',
        required: true,
        validation_rules: [],
      },
      runtime: {
        execution_driver: 'http_formal_task',
        capabilities: {
          task_group: 'image-pro',
          media_input_mode: 'image+text',
          ui_guards: ['requiresPrompt'],
          execution_traits: ['nonBlocking'],
        },
        payload_rules: {
          'body.prompt': {
            kind: 'field',
            field_key: '__prompt',
            transforms: ['trim'],
          },
          'body.watermark': {
            kind: 'when',
            condition: {
              op: 'truthy',
              field: 'watermark',
            },
            truthy: {
              kind: 'literal',
              value: true,
            },
            falsy: {
              kind: 'literal',
              value: false,
            },
          },
          'meta.promptTag': {
            kind: 'compute',
            operator: 'concat',
            args: [
              {
                kind: 'literal',
                value: 'tag:',
              },
              {
                kind: 'field',
                field_key: '__prompt',
                transforms: ['trim'],
              },
            ],
          },
        },
      },
    }));
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });
    writeDefaultLocalizationFiles(
      sourceDir,
      JSON.parse(fs.readFileSync(path.join(sourceDir, 'runtime_model.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(sourceDir, 'node_definition.json'), 'utf8')),
    );

    const result = runBuildScript(tempDir);
    assert.equal(result.status, 0, `DSL 合法场景不应阻断: ${result.stderr || result.stdout}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: capabilities 非法结构应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-capabilities');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-capabilities',
      entry_model: {
        model_id: 'bad-capabilities-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('bad-capabilities-model', {
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
        execution_driver: 'http_formal_task',
        capabilities: {
          task_group: '',
          ui_guards: 'requiresPrompt',
        },
      },
    }));
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'capabilities 非法结构应阻断打包');
    assert.match(result.stderr, /runtime_model\.runtime\.capabilities_/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
